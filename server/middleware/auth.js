import { anonClient, authedClient, serviceClient } from '../app.js';
import { subscriptionExpiredFor } from '../utils/subscription.js';
import { findSessionByToken, updateSessionTokens, revokeSession } from '../utils/sessions.js';

const PAGE_LOGIN_REDIRECT = '/PartPublic/connexion.html';
const OWNER_TYPES = ['proprietaire', 'agence', 'entreprise'];
const ABSOLUTE_SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const mfaCache = new Map();
const mfaInFlight = new Map();
const MFA_CACHE_TTL_MS = 15000;

function setAuthCookie(res, token) {
  if (!token) return;
  res.cookie('mim_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: ABSOLUTE_SESSION_TTL,
    path: '/',
  });
}

export function isBannedValue(value) {
  if (!value) return false;
  const ts = typeof value === 'number' ? value * 1000 : Date.parse(String(value));
  return !Number.isNaN(ts) && ts > Date.now();
}

export async function banStatusOf(userId) {
  try {
    const { data, error } = await serviceClient().auth.admin.getUserById(userId);
    if (error || !data?.user) return 'deleted';
    return isBannedValue(data.user.banned_until) ? 'suspended' : 'active';
  } catch (err) {
    console.warn('[auth] banStatusOf :', err.message);
    return 'suspended';
  }
}

export async function businessAccountActive(userId, accountType) {
  if (!['locataire', 'employe'].includes(accountType)) return true;
  const table = accountType === 'locataire' ? 'locataires' : 'employes';
  try {
    const { data, error } = await serviceClient()
      .from(table)
      .select('id, statut, user_id')
      .eq('account_uid', userId)
      .maybeSingle();
    return !error && Boolean(data) && data.statut === 'actif';
  } catch (err) {
    console.warn('[auth] businessAccountActive :', err.message);
    return false;
  }
}

export async function ownerSuspendedFor(userId, accountType) {
  if (!['locataire', 'employe'].includes(accountType)) return false;
  const table = accountType === 'locataire' ? 'locataires' : 'employes';
  try {
    const { data, error } = await serviceClient()
      .from(table)
      .select('user_id')
      .eq('account_uid', userId)
      .maybeSingle();
    if (error || !data?.user_id) return true;
    return (await banStatusOf(data.user_id)) === 'suspended';
  } catch (err) {
    console.warn('[auth] ownerSuspendedFor :', err.message);
    return true;
  }
}

function tokenHasAal2(accessToken) {
  if (!accessToken) return false;
  try {
    const part = String(accessToken).split('.')[1];
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    const aal = String(payload.aal || '').toLowerCase();
    const amr = Array.isArray(payload.amr) ? payload.amr.map((v) => String(v).toLowerCase()) : [];
    return aal === 'aal2' || amr.includes('aal2') || amr.includes('mfa');
  } catch {
    return false;
  }
}

export function invalidateMfaCache(userId = null) {
  if (userId) mfaCache.delete(userId);
  else mfaCache.clear();
}

async function mfaFactors(userId, accessToken) {
  const cached = mfaCache.get(userId);
  if (cached && Date.now() - cached.at < MFA_CACHE_TTL_MS) return cached.factors;
  const inFlight = mfaInFlight.get(userId);
  if (inFlight) return inFlight;

  const request = (async () => {
    const { data, error } = await serviceClient().auth.admin.getUserById(userId);
    if (error || !data?.user) throw new Error(error?.message || 'Compte Auth introuvable');
    if (Array.isArray(data.user.factors)) {
      mfaCache.set(userId, { at: Date.now(), factors: data.user.factors });
      return data.user.factors;
    }
    const { data: factorData, error: factorError } = await authedClient(accessToken).auth.mfa.listFactors();
    if (factorError) throw new Error(factorError.message);
    const factors = factorData?.all || [];
    mfaCache.set(userId, { at: Date.now(), factors });
    return factors;
  })();
  mfaInFlight.set(userId, request);
  try {
    return await request;
  } finally {
    mfaInFlight.delete(userId);
  }
}

async function verifyToken(req) {
  const token = req.cookies?.mim_token || req.headers?.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return null;

  let session;
  try {
    session = await findSessionByToken(token);
  } catch (err) {
    console.warn('[auth] session lookup :', err.message);
    return null;
  }
  if (!session) return null;

  let accessToken = session.supabase_access_token;
  let refreshToken = session.supabase_refresh_token;
  const expiresAt = session.supabase_expires_at ? new Date(session.supabase_expires_at).getTime() : 0;
  if (!accessToken || expiresAt <= Date.now() + 300000) {
    if (!refreshToken) return null;
    try {
      const { data, error } = await anonClient().auth.refreshSession({ refresh_token: refreshToken });
      if (error || !data?.session || data.session.user?.id !== session.user_id) {
        await revokeSession(session.id, session.user_id, 'refresh_failed').catch(() => {});
        return null;
      }
      accessToken = data.session.access_token;
      refreshToken = data.session.refresh_token || refreshToken;
      await updateSessionTokens(session.id, data.session);
    } catch (err) {
      await revokeSession(session.id, session.user_id, 'refresh_failed').catch(() => {});
      console.warn('[auth] refresh session :', err.message);
      return null;
    }
  }

  let profile;
  try {
    const result = await serviceClient()
      .from('profiles')
      .select('account_type, must_change_password')
      .eq('id', session.user_id)
      .maybeSingle();
    if (result.error || !result.data) return null;
    profile = result.data;
  } catch (err) {
    console.warn('[auth] profile revalidation :', err.message);
    return null;
  }

  const ownStatus = await banStatusOf(session.user_id);
  if (ownStatus === 'deleted') return null;

  const reasons = [];
  if (ownStatus === 'suspended') reasons.push('banned');
  if (await ownerSuspendedFor(session.user_id, profile.account_type)) reasons.push('owner_suspended');
  if (profile.account_type === 'locataire' || profile.account_type === 'employe') {
    if (!(await businessAccountActive(session.user_id, profile.account_type))) reasons.push('account_inactive');
  }
  if (await subscriptionExpiredFor(session.user_id, profile.account_type)) reasons.push('subscription_expired');

  let factors = [];
  try {
    factors = await mfaFactors(session.user_id, accessToken);
  } catch (err) {
    console.warn('[auth] MFA revalidation :', err.message);
    return null;
  }
  if (factors.some((factor) => factor.status === 'verified') && !tokenHasAal2(accessToken)) {
    reasons.push('mfa_required');
  }

  return {
    user: {
      id: session.user_id,
      account_type: profile.account_type,
      must_change_password: Boolean(profile.must_change_password),
      supabase_token: accessToken,
      refresh_token: refreshToken,
      supabase_expires_at: session.supabase_expires_at,
      session_id: session.id,
      session_token: token,
      suspendedReasons: reasons,
    },
    suspended: reasons.length > 0,
  };
}

// Monté sur toutes les routes métier (app.js) et sur les écritures
// sensibles de /api/auth (routes/auth.js). requireActive ne lit QUE
// req.user.suspended : il suppose authenticate en amont. /login ne peut
// pas l'utiliser (pas encore de req.user) mais refuse à la source les
// mêmes motifs (banni, propriétaire suspendu, compte inactif).
export function requireActive(req, res, next) {
  if (!req.user?.suspended) return next();
  const reasons = Array.isArray(req.user.suspendedReasons) ? req.user.suspendedReasons : [];
  if (reasons.includes('mfa_required')) {
    return res.status(401).json({ success: false, code: 'MFA_REQUIRED', message: 'La vérification à deux facteurs est requise.' });
  }
  const onlySubscriptionExpired = reasons.length > 0 && reasons.every((reason) => reason === 'subscription_expired');
  if (onlySubscriptionExpired && OWNER_TYPES.includes(req.user.account_type)) {
    return res.status(401).json({
      success: false,
      code: 'SUBSCRIPTION_EXPIRED',
      message: 'Votre abonnement MIM est expiré. Renouvelez-le depuis votre espace pour continuer.',
    });
  }
  return res.status(401).json({ success: false, code: 'ACCOUNT_SUSPENDED', message: 'Votre compte a été suspendu.' });
}

// ─── Ré-authentification récente + 2FA par compte ─────────────────
// Un jeton de session volé ne doit pas suffire pour enrôler ou
// désactiver la double authentification : il faut un mot de passe
// saisi récemment. Indexé par session en mémoire : un redémarrage du
// serveur impose une nouvelle vérification, comportement sûr par défaut.
const passwordVerifiedAt = new Map();
const PASSWORD_REAUTH_WINDOW_MS = 10 * 60 * 1000;

// Compteur PAR COMPTE (et non par IP) : un attaquant qui répartit ses
// essais sur plusieurs adresses ne doit pas échapper au verrouillage,
// et un compte ne doit pas être épuisé depuis un seul poste. Le
// verrouillage double à chaque palier dépassé, plafonné.
const mfaAccountAttempts = new Map();
const MFA_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MFA_FREE_ATTEMPTS = 5;
const MFA_LOCK_BASE_MS = 60 * 1000;
const MFA_LOCK_MAX_MS = 30 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, at] of passwordVerifiedAt) {
    if (now - at > PASSWORD_REAUTH_WINDOW_MS) passwordVerifiedAt.delete(sessionId);
  }
  for (const [userId, entry] of mfaAccountAttempts) {
    if (now - entry.at > MFA_ATTEMPT_WINDOW_MS && entry.lockedUntil <= now) mfaAccountAttempts.delete(userId);
  }
}, 60 * 1000).unref();

export function markPasswordAuthenticated(sessionId) {
  if (!sessionId) return;
  passwordVerifiedAt.set(sessionId, Date.now());
}

export function requireRecentPasswordAuth(req, res, next) {
  const at = passwordVerifiedAt.get(req.user?.session_id);
  if (at && Date.now() - at <= PASSWORD_REAUTH_WINDOW_MS) return next();
  return res.status(401).json({
    success: false,
    code: 'REAUTH_REQUIRED',
    message: 'Confirmez votre mot de passe avant de continuer.',
  });
}

export function mfaAccountLockRemainingMs(userId) {
  const entry = userId ? mfaAccountAttempts.get(userId) : null;
  if (!entry) return 0;
  return Math.max(0, entry.lockedUntil - Date.now());
}

export function registerMfaAccountAttempt(userId, success) {
  if (!userId) return;
  const now = Date.now();
  let entry = mfaAccountAttempts.get(userId);
  if (!entry || (now - entry.at >= MFA_ATTEMPT_WINDOW_MS && entry.lockedUntil <= now)) {
    entry = { at: now, count: 0, lockedUntil: 0 };
    mfaAccountAttempts.set(userId, entry);
  }
  entry.at = now;
  if (success) {
    mfaAccountAttempts.delete(userId);
    return;
  }
  entry.count += 1;
  if (entry.count > MFA_FREE_ATTEMPTS) {
    const doubling = entry.count - MFA_FREE_ATTEMPTS - 1;
    entry.lockedUntil = now + Math.min(MFA_LOCK_BASE_MS * 2 ** doubling, MFA_LOCK_MAX_MS);
  }
}

export function requireMfaAccountUnlocked(req, res, next) {
  const lockMs = mfaAccountLockRemainingMs(req.user?.id);
  if (lockMs > 0) {
    res.setHeader('Retry-After', Math.ceil(lockMs / 1000));
    return res.status(429).json({ success: false, message: 'Trop de tentatives de vérification. Réessayez dans quelques minutes.' });
  }
  return next();
}

export async function authenticate(req, res, next) {
  const result = await verifyToken(req);
  if (!result) {
    return res.status(401).json({ success: false, code: 'UNAUTHENTICATED', message: 'Non authentifié.' });
  }
  req.user = result.user;
  req.user.suspended = result.suspended;
  setAuthCookie(res, result.user.session_token);
  return next();
}

// Les routes de changement de mot de passe doivent rester atteignables
// tant que must_change_password est vrai : sans exemption, un compte
// forcé recevrait 403 sur la seule route capable de le débloquer et
// serait enfermé définitivement.
const PASSWORD_CHANGE_ROUTE = /(^|\/)(password|change-password)$/;

export function requirePasswordChanged(req, res, next) {
  if (!req.user?.must_change_password) return next();
  if (PASSWORD_CHANGE_ROUTE.test(String(req.path || ''))) return next();
  return res.status(403).json({
    success: false,
    code: 'PASSWORD_CHANGE_REQUIRED',
    message: 'Vous devez modifier votre mot de passe avant d\'utiliser cette fonctionnalité.',
  });
}

export function authenticatePage(redirectTo = PAGE_LOGIN_REDIRECT) {
  return async (req, res, next) => {
    const result = await verifyToken(req);
    if (!result) return res.redirect(redirectTo);
    req.user = result.user;
    req.user.suspended = result.suspended;
    setAuthCookie(res, result.user.session_token);

    if (result.user.suspendedReasons?.includes('mfa_required')) {
      return res.redirect('/PartPublic/connexion.html?mfa_required=1');
    }
    if (result.user.must_change_password && !req.path.endsWith('change-password.html')) {
      return res.redirect('/PartPublic/change-password.html');
    }
    const reasons = Array.isArray(result.user.suspendedReasons) ? result.user.suspendedReasons : [];
    const onlySubscriptionExpired = reasons.length > 0 && reasons.every((reason) => reason === 'subscription_expired');
    const isAbonnementsPage = req.path === '/abonnements.html' || req.path.endsWith('/abonnements.html');
    if (onlySubscriptionExpired && OWNER_TYPES.includes(result.user.account_type) && !isAbonnementsPage) {
      return res.redirect(result.user.account_type === 'agence' ? '/PartAgence/first_Mode/abonnements.html' : '/PartProprietaires/abonnements.html');
    }
    return next();
  };
}

export function requireAdmin(req, res, next) {
  if (!['admin', 'ultra_admin'].includes(req.user?.account_type)) {
    return res.status(403).json({ success: false, code: 'FORBIDDEN', message: "Accès réservé à l'administration." });
  }
  return next();
}

export function requireUltraAdmin(req, res, next) {
  if (req.user?.account_type !== 'ultra_admin') {
    return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Accès réservé au Super Admin.' });
  }
  return next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (req.user && roles.includes(req.user.account_type)) return next();
    return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Accès non autorisé.' });
  };
}

export function requireZone(...roles) {
  return (req, res, next) => {
    if (req.user && roles.includes(req.user.account_type)) return next();
    return res.redirect(PAGE_LOGIN_REDIRECT);
  };
}
