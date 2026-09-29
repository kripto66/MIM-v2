import { Router } from 'express';
import { anonClient, authedClient, serviceClient } from '../app.js';
import { authenticate, requireActive, requireRecentPasswordAuth, requireMfaAccountUnlocked, markPasswordAuthenticated, registerMfaAccountAttempt, mfaAccountLockRemainingMs, ownerSuspendedFor, banStatusOf, businessAccountActive, invalidateMfaCache } from '../middleware/auth.js';
import { forgotPasswordRateLimit, mfaVerifyRateLimit } from '../middleware/rateLimit.js';
import { gitAutoBackup } from '../utils/gitBackup.js';
import { createSession, revokeAllSessions, revokeSession, createMfaChallenge, claimMfaChallenge, finishMfaChallenge, decryptSessionValue } from '../utils/sessions.js';
import { newOAuthClient, storeFlow, getFlow, deleteFlow } from '../utils/oauth.js';
import { resolveLoginEmail, tenantEmailFor, usernameIsValid, TENANT_EMAIL_DOMAIN } from '../utils/tenantAccount.js';
import { passwordRuleError } from '../utils/passwordPolicy.js';
import { issueResetToken, tryConsumeResetToken, finalizeResetToken, releaseResetToken, generateResetToken, hashResetToken, sendResetEmail, buildResetLink } from '../utils/passwordReset.js';
import { subscriptionExpiredFor } from '../utils/subscription.js';
import { auditLog, LEVELS } from '../utils/audit.js';
import { isSaasSuspended, isAllowedDuringSuspension } from '../utils/saasStatus.js';
import { notify } from '../utils/notifications.js';

const router = Router();

// Un locataire ne crée jamais son compte lui-même : seul le propriétaire
// peut créer un compte locataire depuis son espace.
const ALLOWED_TYPES = ['proprietaire', 'agence'];
const OWNER_TYPES_FOR_LOGIN = ['proprietaire', 'agence', 'entreprise'];

const PAGE_BY_TYPE = {
  proprietaire: 'PartProprietaires/dashboard.html',
  agence: 'PartAgence/first_Mode/dashboard.html',
  entreprise: 'PartProprietaires/dashboard.html',
  locataire: 'PartLocataires/LocaDash.html',
  admin: 'PartAdmin/admin.html',
  ultra_admin: 'PartUltraAdmin/ultra.html',
  employe: 'PartEmployes/employe.html',
};

const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');

const IS_PROD = process.env.NODE_ENV === 'production';

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: IS_PROD,
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

function emailIsValid(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Recherche d'un compte auth par email (endpoint admin GoTrue). Permet de
// distinguer : compte inexistant, compte suspendu, mauvais identifiants.
async function lookupAuthUserByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users?filter=${encodeURIComponent(normalized)}`, {
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });

    if (!res.ok) {
      console.warn('[login] lookup auth users :', res.status);
      return null;
    }

    const body = await res.json();
    return (body?.users || []).find((u) => String(u.email || '').toLowerCase() === normalized) || null;
  } catch (err) {
    console.warn('[login] lookup auth users :', err.message);
    return null;
  }
}

function verifiedFactorsOf(user) {
  return (user?.factors || []).filter((f) => f.status === 'verified');
}

// Récupération de mot de passe : recherche du compte par email (GoTrue
// d'abord, sinon profil). Renvoie { id, email } ou null — jamais de
// message différencié au client.
async function findResetUserByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  try {
    const user = await lookupAuthUserByEmail(normalized);
    if (user?.id) return { id: user.id, email: normalized };
  } catch {
  }
  try {
    const { data: recovery, error: recoveryError } = await serviceClient()
      .from('account_recovery_emails')
      .select('user_id, email')
      .ilike('email', normalized)
      .maybeSingle();
    if (!recoveryError && recovery?.user_id) return { id: recovery.user_id, email: recovery.email };
  } catch {
  }
  try {
    const { data } = await serviceClient()
      .from('profiles')
      .select('id, email')
      .ilike('email', normalized)
      .maybeSingle();
    if (data?.id) return { id: data.id, email: data.email };
  } catch {
  }
  return null;
}

function setAuthCookie(res, token) {
  res.cookie('mim_token', token, COOKIE_OPTIONS);
}

function setPendingMfaCookie(res, token) {
  res.cookie('mim_mfa_pending', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    path: '/',
    maxAge: 10 * 60 * 1000,
  });
}

function accountTypeOf(user) {
  const t = user?.user_metadata?.account_type;
  if (['proprietaire', 'agence', 'entreprise', 'locataire', 'employe', 'admin', 'ultra_admin'].includes(t)) return t;
  return 'proprietaire';
}

function sessionPayload(user, session) {
  return {
    id: user.id,
    account_type: accountTypeOf(user),
    supabase_token: session?.access_token,
    refresh_token: session?.refresh_token || null,
    supabase_expires_at: session?.expires_at || null,
  };
}

function publicUser(user, profile) {
  const p = profile || {};
  return {
    id: user.id,
    account_type: p.account_type || accountTypeOf(user),
    name: user.user_metadata?.name || p.name || '',
    username: p.username || user.user_metadata?.username || '',
    email: (p.account_type || accountTypeOf(user)) === 'locataire' ? '' : (user.email || p.email || ''),
    phone: user.user_metadata?.phone || p.phone || '',
    must_change_password: Boolean(p.must_change_password),
  };
}

async function profileOf(userId) {
  const { data, error } = await serviceClient()
    .from('profiles')
    .select('account_type, name, email, phone, username, must_change_password')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    console.warn('[profileOf]', error.message);
    return null;
  }

  return data;
}

// Résout le type de compte d'un utilisateur OAuth en cherchant le profil
// existant par email. Quand un compte a été créé manuellement (email/mot
// de passe) puis que l'utilisateur se connecte avec Google, Supabase crée
// un nouvel UUID sans account_type dans user_metadata. Cette fonction
// retrouve le bon type enconsultant la table profiles.
async function resolveOAuthAccountType(user) {
  const email = user.email;
  if (!email) return null;

  try {
    const { data: profile } = await serviceClient()
      .from('profiles')
      .select('account_type')
      .ilike('email', email)
      .maybeSingle();

    return profile?.account_type || null;
  } catch {
    return null;
  }
}

async function revokeSupabaseSessions(userId, sbAdmin, scope = 'global') {
  const { data, error } = await sbAdmin
    .from('sessions')
    .select('supabase_access_token, supabase_refresh_token')
    .eq('user_id', userId)
    .is('revoked_at', null);
  if (error) throw new Error(error.message);

  for (const stored of data || []) {
    let token = decryptSessionValue(stored.supabase_access_token);
    const refreshToken = decryptSessionValue(stored.supabase_refresh_token);
    if (refreshToken) {
      const { data: refreshed, error: refreshError } = await anonClient().auth.refreshSession({ refresh_token: refreshToken });
      if (refreshError) {
        if (!/session missing|invalid refresh|already logged out|not found/i.test(refreshError.message)) throw new Error(refreshError.message);
        continue;
      }
      token = refreshed?.session?.access_token || token;
    }
    if (!token) continue;
    const { error: signOutError } = await sbAdmin.auth.admin.signOut(token, scope);
    if (signOutError && !/session missing|invalid refresh|already logged out|not found/i.test(signOutError.message)) {
      throw new Error(signOutError.message);
    }
  }
}

async function requireMfaFor(user, supabaseToken) {
  let factors = verifiedFactorsOf(user);

  if (!factors.length) {
    const { data, error } = await authedClient(supabaseToken).auth.mfa.listFactors();
    if (error) throw new Error(error.message);
    factors = (data?.all || []).filter((f) => f.status === 'verified');
  }

  return factors;
}

async function hasActiveMandat(userId) {
  try {
    const { data, error } = await serviceClient()
      .from('agences_proprietaires')
      .select('id')
      .eq('proprietaire_id', userId)
      .eq('statut', 'actif')
      .limit(1)
      .maybeSingle();
    return !error && Boolean(data);
  } catch {
    return false;
  }
}

async function finalizeLogin(res, user, session, userAgent, ip) {
  const profile = await profileOf(user.id);
  const accountType = profile?.account_type || accountTypeOf(user);
  const appSession = await createSession({ userId: user.id, session, userAgent, ip });
  setAuthCookie(res, appSession.token);
  markPasswordAuthenticated(appSession.id);
  gitAutoBackup(`Sauvegarde auto : connexion de ${user.email}`);

  let redirect = PAGE_BY_TYPE[accountType] || PAGE_BY_TYPE.proprietaire;
  if (OWNER_TYPES_FOR_LOGIN.includes(accountType) && await subscriptionExpiredFor(user.id, accountType)) {
    redirect = accountType === 'agence' ? 'PartAgence/first_Mode/abonnements.html' : 'PartProprietaires/abonnements.html';
  } else if (accountType === 'proprietaire' && await hasActiveMandat(user.id)) {
    redirect = 'PartProprietairesShadow/dashboard.html';
  }

  return {
    user: publicUser(user, { ...(profile || {}), account_type: accountType }),
    redirect,
    mustChangePassword: ['locataire', 'employe', 'admin'].includes(accountType) && Boolean(profile?.must_change_password),
  };
}

// Relie un compte 'locataire' à sa fiche s'il n'est pas encore lié.
// Liaison par username (nouveau) puis par email (ancien fonctionnement).
async function linkTenantAccount() {
  return null;
}

router.post('/register', async (req, res) => {
  const { account_type, name, email, phone, password, password_confirm } = req.body;

  if (!account_type || !name || !email || !phone || !password || !password_confirm) {
    return res.status(400).json({ success: false, message: 'Veuillez remplir tous les champs.' });
  }

  if (!ALLOWED_TYPES.includes(account_type)) {
    return res.status(400).json({ success: false, message: 'Type de compte invalide. Les comptes locataires sont créés par votre propriétaire.' });
  }

  // Bloquer l'inscription si le SaaS est suspendu (admin/ultra_admin autorisés)
  const saasSuspended = await isSaasSuspended();
  if (saasSuspended && !isAllowedDuringSuspension(account_type)) {
    return res.status(503).json({
      success: false,
      code: 'SAAS_SUSPENDED',
      message: 'Le service est temporairement indisponible. Veuillez réessayer plus tard.',
    });
  }

  if (!emailIsValid(email)) {
    return res.status(400).json({ success: false, message: 'Adresse email invalide.' });
  }

  if (email.toLowerCase().endsWith(`@${TENANT_EMAIL_DOMAIN}`)) {
    return res.status(400).json({
      success: false,
      message: `Cette adresse email est réservée aux comptes locataires (créés par un propriétaire).`,
    });
  }

  const pwError = passwordRuleError(password);
  if (pwError) {
    return res.status(400).json({ success: false, message: pwError, errors: { password: pwError } });
  }

  if (password !== password_confirm) {
    return res.status(400).json({ success: false, message: 'Les mots de passe ne correspondent pas.' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  // Le compte est créé DÉJÀ confirmé : l'inscription ne place pas l'utilisateur
  // derrière une confirmation d'e-mail, il accède à son espace immédiatement.
  // La double authentification reste, elle, optionnelle et se règle plus tard
  // depuis les paramètres du compte. Même approche que la création d'un
  // propriétaire par une agence (routes/agence.js).
  const { data: created, error: createError } = await serviceClient().auth.admin.createUser({
    email: normalizedEmail,
    password,
    email_confirm: true,
    user_metadata: {
      name: String(name).trim(),
      phone: String(phone || '').trim(),
      account_type,
    },
  });

  if (createError) {
    const msg = String(createError.message || '').toLowerCase();
    if (msg.includes('already') || msg.includes('existe')) {
      return res.status(409).json({ success: false, code: 'EMAIL_ALREADY_EXISTS', message: 'Cette adresse email est déjà utilisée.' });
    }
    if (msg.includes('rate limit') || createError.status === 429) {
      return res.status(429).json({ success: false, message: 'Trop de demandes d\'inscription récentes. Veuillez réessayer dans quelques minutes.' });
    }
    console.error('[register]', createError.message);
    return res.status(500).json({ success: false, message: 'Une erreur est survenue lors de la création du compte.' });
  }

  const newUser = created?.user;
  if (!newUser?.id) {
    return res.status(500).json({ success: false, message: 'Une erreur est survenue.' });
  }

  // Session ouverte dans la foulée : l'utilisateur arrive dans son espace sans
  // avoir à ressaisir ses identifiants. Un échec ici ne doit jamais remettre en
  // cause le compte qui vient d'être créé.
  try {
    const { data: signedIn, error: signInError } = await anonClient().auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });

    if (!signInError && signedIn?.session) {
      const result = await finalizeLogin(res, newUser, signedIn.session, req.headers['user-agent'], req.ip);
      return res.status(201).json({
        success: true,
        message: 'Compte créé. Bienvenue !',
        emailConfirmationRequired: false,
        ...result,
      });
    }

    console.warn('[register] ouverture de session :', signInError?.message);
  } catch (err) {
    console.warn('[register] ouverture de session :', err.message);
  }

  return res.status(201).json({
    success: true,
    message: 'Compte créé. Vous pouvez vous connecter.',
    emailConfirmationRequired: false,
  });
});

router.post('/login', async (req, res) => {
  const identifier = req.body?.identifier ?? req.body?.email ?? req.body?.username;
  const email = resolveLoginEmail(identifier);
  const { password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, code: 'VALIDATION', message: 'Veuillez remplir tous les champs.' });
  }

  // Bloquer la connexion si le SaaS est suspendu (admin/ultra_admin autorisés)
  // Cette vérification est effectuée après l'authentification afin de ne pas
  // révéler l'existence d'un compte et d'éviter une requête Auth admin par login.
  const { data, error } = await anonClient().auth.signInWithPassword({ email, password });

  const isTransient = (e) => {
    const status = Number(e?.status);
    return !status || status >= 500;
  };

  if (error || !data.user || !data.session) {
    const status = Number(error?.status);
    const msg = String(error?.message || '').toLowerCase();

    // GoTrue refuse la connexion d'un utilisateur banni (user_banned) :
    // on le traduit en suspension, pas en mauvais identifiants.
    if (error?.code === 'user_banned' || msg.includes('banned')) {
      return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', message: 'Email ou mot de passe incorrect.' });
    }

    if (isTransient(error)) {
      // Panne transitoire du backend auth (500/504 GoTrue) : on renvoie 503
      // (rétentable) plutôt qu'un faux 401 « mauvais identifiants ».
      console.warn('[login] erreur transitoire auth :', error?.status, error?.message);
      return res.status(503).json({ success: false, code: 'SERVICE_UNAVAILABLE', message: 'Service temporairement indisponible. Réessayez dans un instant.' });
    }
    if (status === 429 || msg.includes('rate limit') || msg.includes('too many') || msg.includes('trop de')) {
      return res.status(429).json({ success: false, code: 'RATE_LIMIT', message: 'Trop de tentatives. Réessayez dans un instant.' });
    }
    return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', message: 'Email ou mot de passe incorrect.' });
  }

  const profile = await profileOf(data.user.id);
  const accountType = profile?.account_type || accountTypeOf(data.user);
  const saasSuspended = await isSaasSuspended();
  const accessType = profile?.account_type || accountTypeOf(data.user);
  if (saasSuspended && !isAllowedDuringSuspension(accessType)) {
    return res.status(503).json({
      success: false,
      code: 'SAAS_SUSPENDED',
      message: 'Le service est temporairement indisponible. Veuillez réessayer plus tard.',
    });
  }

  if (!profile || (['locataire', 'employe'].includes(accountType) && !(await businessAccountActive(data.user.id, accountType)))) {
    return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', message: 'Email ou mot de passe incorrect.' });
  }
  // pour RENOUVELER en ligne (paiement Bictorys). Toutes les routes
  // métier restent bloquées tant qu'il n'a pas payé (requireActive).
  // Seuls les comptes bannis restent refusés (déjà gérés ci-dessus).

  // Un locataire/employé dont le PROPRIÉTAIRE est suspendu (ou a un
  // abonnement expiré) ne peut pas se connecter non plus (relation lue
  // en base, jamais un owner_id du client).
  if (accountType === 'locataire' || accountType === 'employe') {
    const ownerSuspended =
      (await ownerSuspendedFor(data.user.id, accountType)) ||
      (await subscriptionExpiredFor(data.user.id, accountType));
    if (ownerSuspended) {
      return res.status(401).json({
        success: false,
        code: 'INVALID_CREDENTIALS',
        message: 'Email ou mot de passe incorrect.',
      });
    }
  }

  let factors;
  try {
    factors = await requireMfaFor(data.user, data.session.access_token);
  } catch {
    return res.status(503).json({ success: false, code: 'MFA_UNAVAILABLE', message: 'La vérification de sécurité est indisponible.' });
  }

  if (factors.length > 0) {
    const challenge = await createMfaChallenge({
      userId: data.user.id,
      session: data.session,
      factorId: factors[0].id,
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    setPendingMfaCookie(res, challenge.token);

    // Le drapeau must_change_password doit survivre à l'étape 2FA :
    // sans lui, un locataire/employé avec 2FA activée contournerait le
    // changement de mot de passe obligatoire (redirection directe vers
    // sa zone après vérification).
    const mfaProfile = await profileOf(data.user.id);

    return res.json({
      success: true,
      mfaRequired: true,
      redirect: 'PartPublic/2fa.html',
      mustChangePassword:
        (accountType === 'locataire' || accountType === 'employe' || accountType === 'admin') &&
        Boolean(mfaProfile?.must_change_password),
      message: 'Code de vérification requis.',
    });
  }

  let result;
  try {
    result = await finalizeLogin(res, data.user, data.session, req.headers['user-agent'], req.ip);
  } catch (err) {
    console.error('[login] finalisation session :', err.message);
    return res.status(503).json({ success: false, code: 'SESSION_UNAVAILABLE', message: 'Service temporairement indisponible. Réessayez dans un instant.' });
  }

  res.json({
    success: true,
    message: 'Connexion réussie.',
    ...result,
  });
});

router.post('/verify-2fa', mfaVerifyRateLimit, async (req, res) => {
  const pending = req.cookies?.mim_mfa_pending;

  if (!pending) {
    return res.status(401).json({ success: false, message: 'Session de vérification expirée.' });
  }

  const code = String(req.body?.code || '').trim();
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ success: false, message: 'Code invalide.' });
  }

  let challenge;
  try {
    challenge = await claimMfaChallenge(pending);
  } catch (err) {
    console.error('[verify-2fa] challenge :', err.message);
    return res.status(503).json({ success: false, message: 'Service temporairement indisponible.' });
  }
  if (!challenge?.supabase_access_token || !challenge.mfa_factor_id) {
    return res.status(401).json({ success: false, message: 'Session de vérification expirée.' });
  }

  // Verrouillage PAR COMPTE : mfaVerifyRateLimit ne plafonne que par IP
  // (+ défi), contournable en répartissant les essais.
  const lockMs = mfaAccountLockRemainingMs(challenge.user_id);
  if (lockMs > 0) {
    await finishMfaChallenge(challenge, false).catch(() => {});
    res.setHeader('Retry-After', Math.ceil(lockMs / 1000));
    return res.status(429).json({ success: false, message: 'Trop de tentatives de vérification. Réessayez dans quelques minutes.' });
  }

  try {
    const sb = authedClient(challenge.supabase_access_token);

    const { data: mfaChallenge, error: challengeError } = await sb.auth.mfa.challenge({
      factorId: challenge.mfa_factor_id,
    });

    if (challengeError) {
      await finishMfaChallenge(challenge, false).catch(() => {});
      console.error('[verify-2fa]', challengeError.message);
      return res.status(400).json({ success: false, message: 'Impossible de créer le défi de vérification.' });
    }

    const { data: verified, error: verifyError } = await sb.auth.mfa.verify({
      factorId: challenge.mfa_factor_id,
      challengeId: mfaChallenge.id,
      code,
    });

    if (verifyError || !verified) {
      registerMfaAccountAttempt(challenge.user_id, false);
      await finishMfaChallenge(challenge, false).catch(() => {});
      return res.status(400).json({ success: false, message: 'Code de vérification incorrect.' });
    }

    registerMfaAccountAttempt(challenge.user_id, true);
    await finishMfaChallenge(challenge, true);
    res.clearCookie('mim_mfa_pending');

    const session = {
      access_token: verified.access_token,
      refresh_token: verified.refresh_token || null,
      expires_at: verified.expires_at ?? Math.floor(Date.now() / 1000) + (verified.expires_in || 3600),
    };

    const result = await finalizeLogin(res, verified.user, session, req.headers['user-agent'], req.ip);

    res.json({
      success: true,
      message: 'Vérification réussie.',
      ...result,
    });
  } catch (err) {
    await finishMfaChallenge(challenge, false).catch(() => {});
    console.error('[verify-2fa]', err.message);
    res.status(500).json({ success: false, message: 'Une erreur est survenue lors de la vérification.' });
  }
});

// Les routes /mfa/* exigent une preuve de mot de passe RÉCENTE (et non le
// simple jeton de session), plus un compteur de tentatives par compte.
// requireActive n'est monté que sur enroll/disable : status et confirm
// restent atteignables depuis un jeton aal1, sinon un compte déjà doté
// d'un facteur vérifié recevrait MFA_REQUIRED (jeton non aal2) et ne
// pourrait ni lire son état 2FA ni finaliser un enrôlement.
router.get('/mfa/status', authenticate, requireRecentPasswordAuth, async (req, res) => {
  try {
    const { data, error } = await authedClient(req.user.supabase_token).auth.mfa.listFactors();

    if (error) {
      console.error('[mfa/status]', error.message);
      return res.status(500).json({ success: false, message: 'Impossible de lire la configuration 2FA.' });
    }

    const verified = (data?.all || []).filter((f) => f.status === 'verified');

    res.json({
      success: true,
      enabled: verified.length > 0,
      factorId: verified[0]?.id || null,
    });
  } catch (err) {
    console.error('[mfa/status]', err.message);
    res.status(500).json({ success: false, message: 'Une erreur est survenue.' });
  }
});

router.post('/mfa/enroll', authenticate, requireActive, requireRecentPasswordAuth, async (req, res) => {
  try {
    const { data, error } = await authedClient(req.user.supabase_token).auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'MIM App',
    });

    if (error || !data) {
      console.error('[mfa/enroll]', error?.message);
      return res.status(400).json({ success: false, message: 'Impossible de démarrer l’enrôlement 2FA.' });
    }

    invalidateMfaCache(req.user.id);
    res.json({
      success: true,
      factorId: data.id,
      qrCode: `data:image/svg+xml;utf-8,${encodeURIComponent(data.totp.qr_code)}`,
      secret: data.totp.secret,
    });
  } catch (err) {
    console.error('[mfa/enroll]', err.message);
    res.status(500).json({ success: false, message: 'Une erreur est survenue.' });
  }
});

router.post('/mfa/confirm', authenticate, requireRecentPasswordAuth, requireMfaAccountUnlocked, async (req, res) => {
  const { factorId, code } = req.body;

  if (!factorId || !String(code || '').trim()) {
    return res.status(400).json({ success: false, message: 'Code manquant.' });
  }

  try {
    const sb = authedClient(req.user.supabase_token);

    const { data: challenge, error: challengeError } = await sb.auth.mfa.challenge({ factorId });
    if (challengeError) {
      return res.status(400).json({ success: false, message: 'Impossible de créer le défi de vérification.' });
    }

    const { data: verified, error: verifyError } = await sb.auth.mfa.verify({
      factorId,
      challengeId: challenge.id,
      code: String(code).trim(),
    });

    if (verifyError || !verified) {
      registerMfaAccountAttempt(req.user.id, false);
      return res.status(400).json({ success: false, message: 'Code incorrect.' });
    }
    registerMfaAccountAttempt(req.user.id, true);

    const freshSession = {
      access_token: verified.access_token,
      refresh_token: verified.refresh_token || null,
      expires_at: verified.expires_at ?? Math.floor(Date.now() / 1000) + (verified.expires_in || 3600),
    };
    invalidateMfaCache(req.user.id);
    const { error: revokeError } = await serviceClient().auth.admin.signOut(verified.access_token, 'others');
    if (revokeError) {
      return res.status(503).json({ success: false, code: 'SESSION_REVOCATION_FAILED', message: 'La 2FA est active, mais les anciennes sessions n\'ont pas pu être révoquées.' });
    }
    await revokeAllSessions(req.user.id, null, 'mfa_enabled');
    const appSession = await createSession({ userId: req.user.id, session: freshSession, userAgent: req.headers['user-agent'], ip: req.ip, action: 'mfa' });
    setAuthCookie(res, appSession.token);
    markPasswordAuthenticated(appSession.id);

    res.json({ success: true, message: 'Double authentification activée.' });
  } catch (err) {
    console.error('[mfa/confirm]', err.message);
    res.status(500).json({ success: false, message: 'Une erreur est survenue.' });
  }
});

router.post('/mfa/disable', authenticate, requireActive, requireRecentPasswordAuth, requireMfaAccountUnlocked, async (req, res) => {
  const { factorId, code } = req.body;

  if (!factorId || !String(code || '').trim()) {
    return res.status(400).json({ success: false, message: 'Code manquant.' });
  }

  try {
    const sb = authedClient(req.user.supabase_token);

    const { data: challenge, error: challengeError } = await sb.auth.mfa.challenge({ factorId });
    if (challengeError) {
      return res.status(400).json({ success: false, message: 'Impossible de créer le défi de vérification.' });
    }

    const { error: verifyError } = await sb.auth.mfa.verify({
      factorId,
      challengeId: challenge.id,
      code: String(code).trim(),
    });

    if (verifyError) {
      registerMfaAccountAttempt(req.user.id, false);
      return res.status(400).json({ success: false, message: 'Code incorrect.' });
    }
    registerMfaAccountAttempt(req.user.id, true);

    const { error: unenrollError } = await sb.auth.mfa.unenroll({ factorId });

    if (unenrollError) {
      console.error('[mfa/disable]', unenrollError.message);
      return res.status(400).json({ success: false, message: 'Impossible de désactiver la 2FA.' });
    }

    invalidateMfaCache(req.user.id);
    res.json({ success: true, message: 'Double authentification désactivée.' });
  } catch (err) {
    console.error('[mfa/disable]', err.message);
    res.status(500).json({ success: false, message: 'Une erreur est survenue.' });
  }
});

router.get('/google', async (req, res) => {
  try {
    const client = newOAuthClient();

    const { data, error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${APP_URL}/api/auth/callback`,
        skipBrowserRedirect: true,
      },
    });

    if (error || !data?.url) {
      console.error('[google]', error?.message);
      return res.status(500).json({ success: false, message: 'Impossible de démarrer la connexion Google.' });
    }

    storeFlow(data.flowId, client);

    res.cookie('oauth_flow', data.flowId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD,
      path: '/',
      maxAge: 10 * 60 * 1000,
    });

    res.redirect(data.url);
  } catch (err) {
    console.error('[google]', err.message);
    res.status(500).json({ success: false, message: 'Impossible de démarrer la connexion Google.' });
  }
});

router.get('/callback', async (req, res) => {
  const { code, error: oauthError } = req.query;
  const flowId = req.cookies?.oauth_flow;

  if (oauthError) {
    return res.redirect(`${APP_URL}/PartPublic/connexion.html?oauth_error=${encodeURIComponent(String(oauthError))}`);
  }

  if (!code || !flowId) {
    return res.redirect(`${APP_URL}/PartPublic/connexion.html?oauth_error=missing`);
  }

  const client = getFlow(flowId);
  deleteFlow(flowId);
  res.clearCookie('oauth_flow', { path: '/' });

  if (!client) {
    return res.redirect(`${APP_URL}/PartPublic/connexion.html?oauth_error=expired`);
  }

  try {
    const { data, error } = await client.auth.exchangeCodeForSession(code, { flowId });

    if (error || !data.session) {
      console.error('[oauth callback]', error?.message);
      return res.redirect(`${APP_URL}/PartPublic/connexion.html?oauth_error=exchange`);
    }

    const session = data.session;
    const user = session.user;

    // Quand un compte a déjà été créé manuellement (email/mot de passe)
    // puis que l'utilisateur se connecte avec Google, Supabase crée un
    // nouvel UUID sans account_type dans user_metadata. On retrouve le
    // bon type enconsultant la table profiles par email.
    const oauthProfile = await profileOf(user.id);
    const accountType = oauthProfile?.account_type || (await resolveOAuthAccountType(user)) || accountTypeOf(user);

    // Injecte le bon account_type dans le user pour finalizeLogin
    user.user_metadata = { ...user.user_metadata, account_type: accountType };

    // Même vérification que le login classique : compte banni refusé,
    // propriétaire suspendu (pour locataire/employé). Un propriétaire
    // dont l'abonnement est EXPIRÉ reste autorisé à se connecter pour
    // renouveler en ligne (routes métier bloquées par requireActive).
    const ownBan = await banStatusOf(user.id);
    if (ownBan === 'deleted') {
      return res.redirect(`${APP_URL}/PartPublic/connexion.html?oauth_error=account_deleted`);
    }
    if (ownBan === 'suspended') {
      return res.redirect(`${APP_URL}/PartPublic/connexion.html?oauth_error=suspended`);
    }

    if (accountType === 'locataire' || accountType === 'employe') {
      const ownerSusp =
        !(await businessAccountActive(user.id, accountType)) ||
        (await ownerSuspendedFor(user.id, accountType)) ||
        (await subscriptionExpiredFor(user.id, accountType));
      if (ownerSusp) {
        return res.redirect(`${APP_URL}/PartPublic/connexion.html?oauth_error=suspended`);
      }
    }

    // Bloquer l'OAuth si le SaaS est suspendu (admin/ultra_admin autorisés)
    const saasSuspended = await isSaasSuspended();
    if (saasSuspended && !isAllowedDuringSuspension(accountType)) {
      return res.redirect(`${APP_URL}/PartPublic/connexion.html?oauth_error=saas_suspended`);
    }

    let factors;
    try {
      factors = await requireMfaFor(user, session.access_token);
    } catch {
      return res.redirect(`${APP_URL}/PartPublic/connexion.html?oauth_error=mfa`);
    }

    if (factors.length > 0) {
      const challenge = await createMfaChallenge({
        userId: user.id,
        session,
        factorId: factors[0].id,
        userAgent: req.headers['user-agent'],
        ip: req.ip,
      });
      setPendingMfaCookie(res, challenge.token);

      return res.redirect(`${APP_URL}/PartPublic/2fa.html`);
    }

    const result = await finalizeLogin(res, user, session, req.headers['user-agent'], req.ip);
    return res.redirect(`${APP_URL}/${result.redirect}`);
  } catch (err) {
    console.error('[oauth callback]', err.message);
    return res.redirect(`${APP_URL}/PartPublic/connexion.html?oauth_error=server`);
  }
});

router.post('/tenant-invitations', authenticate, async (req, res) => {
  if (!['proprietaire', 'agence', 'entreprise'].includes(req.user.account_type)) {
    return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Réservé à un propriétaire.' });
  }
  const locataireId = Number(req.body?.locataire_id);
  if (!Number.isInteger(locataireId) || locataireId <= 0) {
    return res.status(400).json({ success: false, message: 'Fiche locataire invalide.' });
  }
  try {
    const rawToken = generateResetToken();
    const { data, error } = await serviceClient().rpc('create_tenant_invitation', {
      p_user_id: req.user.id,
      p_locataire_id: locataireId,
      p_token_hash: hashResetToken(rawToken),
      p_expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      p_max_uses: 1,
    });
    if (error || !data) throw new Error(error?.message || 'Invitation impossible.');
    res.status(201).json({ success: true, invitation: { id: data, token: rawToken, expires_in: 7 * 24 * 60 * 60 } });
  } catch (err) {
    console.error('[tenant-invitations]', err.message);
    res.status(400).json({ success: false, message: 'Impossible de créer l\'invitation.' });
  }
});

router.post('/claim-invitation', authenticate, async (req, res) => {
  if (req.user.account_type !== 'locataire') {
    return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'Compte locataire requis.' });
  }
  const rawToken = String(req.body?.token || '').trim();
  if (!rawToken) return res.status(400).json({ success: false, message: 'Invitation manquante.' });
  try {
    const { data, error } = await serviceClient().rpc('consume_tenant_invitation', {
      p_token_hash: hashResetToken(rawToken),
      p_account_uid: req.user.id,
    });
    if (error || !data) throw new Error(error?.message || 'Invitation invalide.');
    res.json({ success: true, invitation_id: data[0]?.invitation_id || null });
  } catch (err) {
    console.warn('[claim-invitation]', err.message);
    res.status(400).json({ success: false, message: 'Invitation invalide ou expirée.' });
  }
});

router.post('/logout', authenticate, async (req, res) => {
  // Les deux invalidations sont indépendantes : une panne de l'autre
  // côté ne doit jamais empêcher celle-ci (session résiduelle valide).
  let authRevoked = true;
  let localRevoked = true;

  if (req.user?.supabase_token) {
    try {
      const result = await authedClient(req.user.supabase_token).auth.signOut();
      authRevoked = !result?.error;
    } catch (err) {
      authRevoked = false;
      console.warn('[logout] révocation Supabase :', err.message);
    }
  }

  if (req.user?.session_id) {
    try {
      await revokeSession(req.user.session_id, req.user.id, 'logout');
    } catch (err) {
      localRevoked = false;
      console.warn('[logout] révocation locale :', err.message);
    }
  }

  res.clearCookie('mim_token', { path: '/' });
  res.clearCookie('mim_mfa_pending', { path: '/' });
  res.clearCookie('mim_csrf', { path: '/' });
  if (!localRevoked || !authRevoked) return res.status(503).json({ success: false, code: 'LOGOUT_RETRY', message: 'Déconnexion incomplète : reconnectez-vous pour révoquer les sessions restantes.' });
  if (req.user?.id) gitAutoBackup(`Sauvegarde auto : déconnexion utilisateur ${req.user.id}`);
  return res.json({ success: true, message: 'Déconnexion réussie.' });
});

router.get('/me', authenticate, async (req, res) => {
  const sb = authedClient(req.user.supabase_token);

  const { data: user, error } = await sb
    .from('profiles')
    .select('id, account_type, name, email, phone, username, must_change_password, avatar_url')
    .eq('id', req.user.id)
    .maybeSingle();

  if (error || !user) {
    return res.status(404).json({ success: false, message: 'Utilisateur introuvable.' });
  }

  if (user.account_type === 'locataire') {
    user.email = '';
  }

  res.json({ success: true, user });
});

router.put('/change-password', authenticate, requireActive, async (req, res) => {
  const { current_password, password, password_confirm } = req.body;

  const pwError = passwordRuleError(password);
  if (pwError) {
    return res.status(400).json({ success: false, message: pwError, errors: { password: pwError } });
  }

  if (password !== password_confirm) {
    return res.status(400).json({ success: false, message: 'Les mots de passe ne correspondent pas.' });
  }

  try {
    // Changement forcé (première connexion) : le mot de passe actuel vient
    // d'être validé à la connexion, on ne le redemande pas.
    const { data: profile } = await serviceClient()
      .from('profiles')
      .select('must_change_password')
      .eq('id', req.user.id)
      .maybeSingle();

    const isForcedChange = Boolean(profile?.must_change_password);

    if (!isForcedChange && !current_password) {
      return res.status(400).json({ success: false, message: 'Veuillez saisir votre mot de passe actuel.' });
    }

    const sb = authedClient(req.user.supabase_token);

    // Les méthodes auth.* (GoTrue) n'utilisent pas le header Authorization
    // global du client : il faut charger la session dans le client pour que
    // updateUser s'applique au bon compte.
    await sb.auth.setSession({
      access_token: req.user.supabase_token,
      refresh_token: req.user.refresh_token || '',
    });

    const { data: account, error: userError } = await sb.auth.getUser();
    if (userError || !account?.user?.email) {
      return res.status(401).json({ success: false, message: 'Session expirée, reconnectez-vous.' });
    }

    if (!isForcedChange) {
      // Vérifie le mot de passe actuel avant toute modification.
      const { error: signInError } = await anonClient().auth.signInWithPassword({
        email: account.user.email,
        password: current_password,
      });

      if (signInError) {
        return res.status(400).json({ success: false, message: 'Mot de passe actuel incorrect.' });
      }
    }

    const { error } = await sb.auth.updateUser({ password });

    if (error) {
      console.error('[change-password]', error.message);
      return res.status(400).json({ success: false, message: 'Impossible de modifier le mot de passe.' });
    }

    try {
      await revokeSupabaseSessions(req.user.id, serviceClient());
    } catch (signOutError) {
      return res.status(503).json({ success: false, code: 'SESSION_REVOCATION_FAILED', message: 'Mot de passe modifié, mais la révocation des sessions a échoué. Reconnectez-vous.' });
    }
    await revokeAllSessions(req.user.id, null, 'password_change');

    const { data: freshSession, error: freshError } = await anonClient().auth.signInWithPassword({
      email: account.user.email,
      password,
    });
    if (freshError || !freshSession?.session) {
      return res.status(503).json({ success: false, code: 'SESSION_REISSUE_FAILED', message: 'Mot de passe modifié. Reconnectez-vous pour continuer.' });
    }
    const appSession = await createSession({ userId: req.user.id, session: freshSession.session, userAgent: req.headers['user-agent'], ip: req.ip, action: 'password_change' });
    setAuthCookie(res, appSession.token);
    markPasswordAuthenticated(appSession.id);

    const { error: profileError } = await serviceClient()
      .from('profiles')
      .update({ must_change_password: false })
      .eq('id', req.user.id);

    if (profileError) {
      return res.status(503).json({ success: false, code: 'PROFILE_UPDATE_FAILED', message: 'Mot de passe modifié, mais le statut de rotation n\'a pas été mis à jour.' });
    }

    gitAutoBackup(`Sauvegarde auto : changement de mot de passe ${req.user.id}`);

    await auditLog({
      userId: req.user.id,
      action: 'auth.password_change',
      level: LEVELS.WARN,
      ip: req.ip,
    });

    res.json({ success: true, message: 'Mot de passe modifié avec succès.' });
  } catch (err) {
    console.error('[change-password]', err.message);
    res.status(500).json({ success: false, message: 'Une erreur est survenue.' });
  }
});

router.post('/verify-password', authenticate, async (req, res) => {
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ success: false, message: 'Mot de passe requis.' });
  }

  const sb = authedClient(req.user.supabase_token);
  await sb.auth.setSession({
    access_token: req.user.supabase_token,
    refresh_token: req.user.refresh_token || '',
  });

  const { data: account, error: userError } = await sb.auth.getUser();
  if (userError || !account?.user?.email) {
    return res.status(401).json({ success: false, message: 'Session expirée, reconnectez-vous.' });
  }

  const { error: signInError } = await anonClient().auth.signInWithPassword({
    email: account.user.email,
    password,
  });

  if (signInError) {
    return res.status(403).json({ success: false, message: 'Mot de passe incorrect.' });
  }

  markPasswordAuthenticated(req.user.session_id);
  res.json({ success: true });
});

router.put('/update-username', authenticate, async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();

  // Seuls les comptes locataires et employés ont un username : un
  // propriétaire ne doit pas pouvoir réserver un username ni détourner
  // l'email interne @mim.local.
  if (req.user.account_type !== 'locataire' && req.user.account_type !== 'employe') {
    return res.status(403).json({
      success: false,
      message: 'Le nom d\'utilisateur ne peut être modifié que depuis un compte locataire ou employé.',
      errors: { username: 'Modification réservée aux comptes locataires et employés.' },
    });
  }

  if (!usernameIsValid(username)) {
    return res.status(400).json({
      success: false,
      message: 'Le username doit contenir entre 3 et 32 caractères (lettres minuscules, chiffres, . _ -).',
      errors: { username: 'Le username doit contenir au moins 3 caractères (lettres minuscules, chiffres, . _ -).' },
    });
  }

  try {
    const sb = serviceClient();

    const { data: taken } = await sb
      .from('profiles')
      .select('id')
      .ilike('username', username)
      .neq('id', req.user.id)
      .maybeSingle();

    if (taken) {
      return res.status(409).json({ success: false, code: 'USERNAME_ALREADY_EXISTS', message: 'Ce nom d\'utilisateur est déjà utilisé.', errors: { username: 'Ce nom d\'utilisateur est déjà utilisé.' } });
    }

    // L'email interne dérive du username : on le met à jour pour que la
    // connexion par username continue de fonctionner.
    const newEmail = tenantEmailFor(username);

    const { error: emailError } = await sb.auth.admin.updateUserById(req.user.id, {
      email: newEmail,
    });

    if (emailError) {
      console.error('[update-username]', emailError.message);
      return res.status(409).json({ success: false, code: 'USERNAME_ALREADY_EXISTS', message: 'Ce nom d\'utilisateur est déjà utilisé.', errors: { username: 'Ce nom d\'utilisateur est déjà utilisé.' } });
    }

    const { error: profileError } = await sb
      .from('profiles')
      .update({ username })
      .eq('id', req.user.id);

    if (profileError) {
      console.error('[update-username] profil :', profileError.message);
      return res.status(500).json({ success: false, message: 'Erreur lors de la mise à jour du username.' });
    }

    if (req.user.account_type === 'locataire') {
      const { error: locataireError } = await sb
        .from('locataires')
        .update({ username })
        .eq('account_uid', req.user.id);

      if (locataireError) {
        console.warn('[update-username] fiche locataire :', locataireError.message);
      }
    } else if (req.user.account_type === 'employe') {
      const { error: employeError } = await sb
        .from('employes')
        .update({ username })
        .eq('account_uid', req.user.id);

      if (employeError) {
        console.warn('[update-username] fiche employé :', employeError.message);
      }
    }

    gitAutoBackup(`Sauvegarde auto : changement de username ${req.user.id}`);

    res.json({ success: true, message: 'Username modifié avec succès.', username });
  } catch (err) {
    console.error('[update-username]', err.message);
    res.status(500).json({ success: false, message: 'Une erreur est survenue.' });
  }
});

router.put('/update-profile', authenticate, async (req, res) => {
  const { name, phone } = req.body;

  if (!name || name.trim() === '') {
    return res.status(400).json({ success: false, message: 'Le nom est obligatoire.' });
  }

  const sb = authedClient(req.user.supabase_token);

  const { error } = await sb
    .from('profiles')
    .update({ name: name.trim(), phone: phone ? phone.trim() : '' })
    .eq('id', req.user.id);

  if (error) {
    console.error('[update-profile]', error.message);
    return res.status(400).json({ success: false, message: 'Erreur lors de la mise à jour du profil.' });
  }

  // Synchroniser le nom dans la fiche (locataires / employés) afin que la
  // fiche affichée là où le propriétaire la voit reflète le profil.
  try {
    const syncedName = name.trim();
    const syncedPhone = phone ? phone.trim() : '';
    if (req.user.account_type === 'locataire') {
      await serviceClient().from('locataires').update({ nom: syncedName, phone: syncedPhone }).eq('account_uid', req.user.id);
    } else if (req.user.account_type === 'employe') {
      await serviceClient().from('employes').update({ nom: syncedName, phone: syncedPhone }).eq('account_uid', req.user.id);
    }
  } catch (err) {
    console.warn('[update-profile] fiche non synchronisée', err.message);
  }

  gitAutoBackup(`Sauvegarde auto : mise à jour du profil ${req.user.id}`);

  res.json({ success: true, message: 'Profil mis à jour avec succès.' });
});

router.get('/username-available', authenticate, async (req, res) => {
  const username = String(req.query?.username || '').trim().toLowerCase();

  if (!username) {
    return res.json({ success: true, available: true });
  }

  if (!usernameIsValid(username)) {
    return res.json({ success: true, available: false, reason: 'format' });
  }

  try {
    const { data } = await serviceClient()
      .from('profiles')
      .select('id')
      .ilike('username', username)
      .neq('id', req.user.id)
      .maybeSingle();

    res.json({ success: true, available: !data });
  } catch (err) {
    console.error('[username-available]', err.message);
    res.status(500).json({ success: false, message: 'Vérification impossible.' });
  }
});

router.post('/forgot', forgotPasswordRateLimit, async (req, res) => {
  const { email } = req.body;

  if (!email || !emailIsValid(email)) {
    return res.status(400).json({ success: false, message: 'Adresse email invalide.' });
  }

  // Réponse identique que le compte existe ou non (anti-énumération).
  const generic = {
    success: true,
    message: 'Si un compte correspond à cette adresse, un e-mail de réinitialisation vous sera envoyé.',
  };

  const target = await findResetUserByEmail(email);
  if (!target) return res.json(generic);

  try {
    const rawToken = await issueResetToken(target.id);
    // Le lien est aussi déposé dans le compte du concerné : ses
    // notifications (RLS « chacun voit les siennes ») servent de canal de
    // secours quand la boîte mail est injoignable alors qu'une session
    // reste ouverte sur un autre appareil. L'e-mail reste envoyé.
    await notify(
      target.id,
      'system',
      `Reinitialisation du mot de passe MIM : ouvrez ce lien dans les 30 minutes (usage unique) ${buildResetLink(rawToken)} - si ce n'etait pas vous, ignorez ce message.`
    );
    await sendResetEmail({ email: target.email, rawToken });
  } catch (err) {
    // Jamais de jeton ni de mot de passe dans les logs : erreur technique seule.
    console.error('[forgot]', err.message);
  }

  res.json(generic);
});

router.post('/reset-password', async (req, res) => {
  const { token, password, password_confirm } = req.body;

  const pwError = passwordRuleError(password);
  if (pwError) {
    return res.status(400).json({ success: false, message: pwError, errors: { password: pwError } });
  }

  if (password !== password_confirm) {
    return res.status(400).json({ success: false, message: 'Les mots de passe ne correspondent pas.' });
  }

  if (!token) {
    return res.status(400).json({ success: false, message: 'Jeton de réinitialisation manquant.' });
  }

  // Consommation ATOMIQUE du jeton : inconnu, expiré OU déjà utilisé →
  // même réponse générique, et le jeton ne peut pas être rejoué.
  // Le jeton du lien de récupération prime sur toute session existante :
  // le mot de passe du compte lié au jeton est modifié, jamais celui
  // d'une autre session (audit m16).
  let claim = null;
  try {
    claim = await tryConsumeResetToken(token);
  } catch (err) {
    console.warn('[reset-password] jeton invalide :', err.message);
  }
  if (!claim?.userId || !claim?.tokenHash) {
    return res.status(400).json({ success: false, message: 'Lien de réinitialisation invalide ou expiré.' });
  }

  // Mise à jour via Supabase Auth : EXACTEMENT le même système de hash
  // que pour l'inscription / le changement de mot de passe (bcrypt GoTrue).
  // Admin → client service-role (le client `supabase` d'app.js est ANON).
  const sbAdmin = serviceClient();
  const { error: updateError } = await sbAdmin.auth.admin.updateUserById(claim.userId, { password });
  if (updateError) {
    console.error('[reset-password]', updateError.message);
    await releaseResetToken(claim.tokenHash);
    return res.status(400).json({ success: false, message: 'Impossible de réinitialiser le mot de passe.' });
  }

  try {
    await finalizeResetToken(claim.tokenHash);
  } catch (finalizeError) {
    console.error('[reset-password] finalisation du jeton :', finalizeError.message);
    return res.status(503).json({ success: false, message: 'Mot de passe réinitialisé, mais la demande doit être clôturée manuellement.' });
  }

  let supabaseRevocationError = null;
  try {
    await revokeSupabaseSessions(claim.userId, sbAdmin);
  } catch (signOutError) {
    supabaseRevocationError = signOutError;
    console.error('[reset-password] révocation Auth :', signOutError.message);
  } finally {
    await revokeAllSessions(claim.userId, null, 'password_reset');
  }
  if (supabaseRevocationError) {
    return res.status(503).json({ success: false, code: 'SESSION_REVOCATION_FAILED', message: 'Mot de passe réinitialisé, mais la révocation des sessions a échoué.' });
  }

  gitAutoBackup('Sauvegarde auto : réinitialisation de mot de passe');

  res.json({ success: true, message: 'Mot de passe réinitialisé. Vous pouvez vous connecter.' });
});

export default router;
