import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { supabase, authedClient, serviceClient } from '../app.js';
import { signToken, authenticate, ownerSuspendedFor, isBannedValue, banStatusOf } from '../middleware/auth.js';
import { forgotPasswordRateLimit, mfaVerifyRateLimit } from '../middleware/rateLimit.js';
import { gitAutoBackup } from '../utils/gitBackup.js';
import { logSession, closeSession } from '../utils/sessions.js';
import { newOAuthClient, storeFlow, getFlow, deleteFlow } from '../utils/oauth.js';
import { resolveLoginEmail, tenantEmailFor, usernameIsValid, TENANT_EMAIL_DOMAIN } from '../utils/tenantAccount.js';
import { passwordRuleError } from '../utils/passwordPolicy.js';
import { subscriptionExpiredFor } from '../utils/subscription.js';
import { auditLog, LEVELS } from '../utils/audit.js';

const router = Router();

// Un locataire ne crée jamais son compte lui-même : seul le propriétaire
// peut créer un compte locataire depuis son espace.
const ALLOWED_TYPES = ['proprietaire', 'agence', 'entreprise'];

const PAGE_BY_TYPE = {
  proprietaire: 'PartProprietaires/dashboard.html',
  agence: 'PartProprietaires/dashboard.html',
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
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`, {
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
    return (body?.users || []).find((u) => u.email === email) || null;
  } catch (err) {
    console.warn('[login] lookup auth users :', err.message);
    return null;
  }
}

function verifiedFactorsOf(user) {
  return (user?.factors || []).filter((f) => f.status === 'verified');
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
    account_type: accountTypeOf(user),
    name: user.user_metadata?.name || p.name || '',
    username: p.username || user.user_metadata?.username || '',
    email: accountTypeOf(user) === 'locataire' ? '' : (user.email || p.email || ''),
    phone: user.user_metadata?.phone || p.phone || '',
    must_change_password: Boolean(p.must_change_password),
  };
}

async function profileOf(userId) {
  const { data, error } = await serviceClient()
    .from('profiles')
    .select('name, email, phone, username, must_change_password')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    console.warn('[profileOf]', error.message);
    return null;
  }

  return data;
}

async function requireMfaFor(user, supabaseToken) {
  let factors = verifiedFactorsOf(user);

  if (!factors.length) {
    try {
      const { data } = await authedClient(supabaseToken).auth.mfa.listFactors();
      factors = (data?.all || []).filter((f) => f.status === 'verified');
    } catch (err) {
      console.warn('[mfa] listFactors échec :', err.message);
    }
  }

  return factors;
}

async function finalizeLogin(res, user, session, userAgent, ip) {
  const accountType = accountTypeOf(user);

  const token = signToken(sessionPayload(user, session));

  setAuthCookie(res, token);

  await linkTenantAccount(user, session?.access_token);
  await logSession(user.id, 'login', session?.access_token, userAgent, ip);
  gitAutoBackup(`Sauvegarde auto : connexion de ${user.email}`);

  const profile = await profileOf(user.id);

  return {
    user: publicUser(user, profile),
    redirect: PAGE_BY_TYPE[accountType],
    mustChangePassword: (accountType === 'locataire' || accountType === 'employe' || accountType === 'admin') && Boolean(profile?.must_change_password),
  };
}

// Relie un compte 'locataire' à sa fiche s'il n'est pas encore lié.
// Liaison par username (nouveau) puis par email (ancien fonctionnement).
async function linkTenantAccount(user, supabaseToken) {
  if (accountTypeOf(user) !== 'locataire') return;

  const username = user.user_metadata?.username;
  const email = user.email;

  const sb = authedClient(supabaseToken);
  let matched = false;

  if (username) {
    const { data, error } = await sb
      .from('locataires')
      .update({ account_uid: user.id })
      .ilike('username', username)
      .is('account_uid', null)
      .select('id')
      .maybeSingle();

    if (!error && data) matched = true;
    else if (error) console.warn('[linkTenantAccount] username :', error.message);
  }

  if (!matched && email) {
    try {
      const { error } = await sb
        .from('locataires')
        .update({ account_uid: user.id })
        .ilike('email', email)
        .is('account_uid', null);

      if (error) console.warn('[linkTenantAccount] email :', error.message);
    } catch (err) {
      console.warn('[linkTenantAccount]', err.message);
    }
  }
}

router.post('/register', async (req, res) => {
  const { account_type, name, email, phone, password, password_confirm } = req.body;

  if (!account_type || !name || !email || !phone || !password || !password_confirm) {
    return res.status(400).json({ success: false, message: 'Veuillez remplir tous les champs.' });
  }

  if (!ALLOWED_TYPES.includes(account_type)) {
    return res.status(400).json({ success: false, message: 'Type de compte invalide. Les comptes locataires sont créés par votre propriétaire.' });
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

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        account_type,
        name,
        phone,
        role: account_type,
      },
    },
  });

  if (error) {
    const msg = String(error.message || '').toLowerCase();

    if (msg.includes('already registered') || msg.includes('existe')) {
      return res.status(409).json({ success: false, code: 'EMAIL_ALREADY_EXISTS', message: 'Cette adresse email est déjà utilisée.' });
    }

    if (msg.includes('rate limit') || error.status === 429) {
      console.warn('[register]', error.message);
      return res.status(429).json({
        success: false,
        message: 'Trop de demandes d\'inscription récentes. Veuillez réessayer dans quelques minutes.',
      });
    }

    console.error('[register]', error.message);
    return res.status(500).json({ success: false, message: 'Une erreur est survenue lors de la création du compte.' });
  }

  const user = data.user;

  if (!user) {
    return res.status(500).json({ success: false, message: 'Une erreur est survenue.' });
  }

  if (!data.session) {
    return res.status(201).json({
      success: true,
      message: 'Compte créé. Veuillez vérifier votre email pour confirmer.',
      emailConfirmationRequired: true,
    });
  }

  setAuthCookie(res, signToken(sessionPayload(user, data.session)));

  await linkTenantAccount(user, data.session?.access_token);
  await logSession(user.id, 'register', data.session?.access_token, req.headers['user-agent'], req.ip);

  res.status(201).json({
    success: true,
    message: 'Compte créé avec succès.',
    redirect: PAGE_BY_TYPE[account_type],
  });
});

router.post('/login', async (req, res) => {
  const identifier = req.body?.identifier ?? req.body?.email ?? req.body?.username;
  const email = resolveLoginEmail(identifier);
  const { password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, code: 'VALIDATION', message: 'Veuillez remplir tous les champs.' });
  }

  // Distinction compte inexistant / compte suspendu / mauvais identifiants.
  const account = await lookupAuthUserByEmail(email);

  if (account && isBannedValue(account.banned_until)) {
    return res.status(401).json({
      success: false,
      code: 'INVALID_CREDENTIALS',
      message: 'Email ou mot de passe incorrect.',
    });
  }

  if (!account) {
    // Même réponse que pour un mauvais mot de passe (anti-énumération) :
    // on ne révèle pas l'existence du compte.
    return res.status(401).json({
      success: false,
      code: 'INVALID_CREDENTIALS',
      message: 'Email ou mot de passe incorrect.',
    });
  }

  const isTransient = (e) => {
    const status = Number(e?.status);
    return !status || status >= 500;
  };

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

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

  const accountType = accountTypeOf(data.user);

  // Un propriétaire dont l'abonnement MIM est expiré ne peut pas se
  // connecter (état calculé en base à partir de date_expiration, jamais
  // d'une valeur envoyée par le client).
  if (['proprietaire', 'agence', 'entreprise'].includes(accountType)) {
    const expired = await subscriptionExpiredFor(data.user.id, accountType);
    if (expired) {
      return res.status(401).json({
        success: false,
        code: 'INVALID_CREDENTIALS',
        message: 'Email ou mot de passe incorrect.',
      });
    }
  }

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

  const factors = await requireMfaFor(data.user, data.session.access_token);

  if (factors.length > 0) {
    setPendingMfaCookie(res, signToken({
      id: data.user.id,
      account_type: accountTypeOf(data.user),
      supabase_token: data.session.access_token,
      mfa_pending: true,
      factorId: factors[0].id,
    }, '10m'));

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

  const result = await finalizeLogin(res, data.user, data.session, req.headers['user-agent'], req.ip);

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

  let decoded;
  try {
    decoded = jwt.verify(pending, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Session de vérification expirée.' });
  }

  const code = String(req.body?.code || '').trim();
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ success: false, message: 'Code invalide.' });
  }

  try {
    const sb = authedClient(decoded.supabase_token);

    const { data: challenge, error: challengeError } = await sb.auth.mfa.challenge({
      factorId: decoded.factorId,
    });

    if (challengeError) {
      console.error('[verify-2fa]', challengeError.message);
      return res.status(400).json({ success: false, message: 'Impossible de créer le défi de vérification.' });
    }

    const { data: verified, error: verifyError } = await sb.auth.mfa.verify({
      factorId: decoded.factorId,
      challengeId: challenge.id,
      code,
    });

    if (verifyError || !verified) {
      return res.status(400).json({ success: false, message: 'Code de vérification incorrect.' });
    }

    res.clearCookie('mim_mfa_pending');

    // mfa.verify renvoie access_token/refresh_token/expires_in (pas expires_at).
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
    console.error('[verify-2fa]', err.message);
    res.status(500).json({ success: false, message: 'Une erreur est survenue lors de la vérification.' });
  }
});

router.get('/mfa/status', authenticate, async (req, res) => {
  try {
    const { data, error } = await authedClient(req.user.supabase_token).auth.mfa.listFactors();

    if (error) {
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

router.post('/mfa/enroll', authenticate, async (req, res) => {
  try {
    const { data, error } = await authedClient(req.user.supabase_token).auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'MIM App',
    });

    if (error || !data) {
      console.error('[mfa/enroll]', error?.message);
      return res.status(400).json({ success: false, message: 'Impossible de démarrer l’enrôlement 2FA.' });
    }

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

router.post('/mfa/confirm', authenticate, async (req, res) => {
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
      return res.status(400).json({ success: false, message: 'Code incorrect.' });
    }

    setAuthCookie(res, signToken({
      id: req.user.id,
      account_type: req.user.account_type,
      supabase_token: verified.access_token,
      refresh_token: verified.refresh_token || null,
      supabase_expires_at: verified.expires_at ?? Math.floor(Date.now() / 1000) + (verified.expires_in || 3600),
    }));

    res.json({ success: true, message: 'Double authentification activée.' });
  } catch (err) {
    console.error('[mfa/confirm]', err.message);
    res.status(500).json({ success: false, message: 'Une erreur est survenue.' });
  }
});

router.post('/mfa/disable', authenticate, async (req, res) => {
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
      return res.status(400).json({ success: false, message: 'Code incorrect.' });
    }

    const { error: unenrollError } = await sb.auth.mfa.unenroll({ factorId });

    if (unenrollError) {
      console.error('[mfa/disable]', unenrollError.message);
      return res.status(400).json({ success: false, message: 'Impossible de désactiver la 2FA.' });
    }

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
    const accountType = accountTypeOf(user);

    // Même vérification que le login classique : compte banni, abonnement
    // expiré, propriétaire suspendu (pour locataire/employé).
    const ownBan = await banStatusOf(user.id);
    if (ownBan === 'deleted') {
      return res.redirect(`${APP_URL}/PartPublic/connexion.html?oauth_error=account_deleted`);
    }
    if (ownBan === 'suspended') {
      return res.redirect(`${APP_URL}/PartPublic/connexion.html?oauth_error=suspended`);
    }

    if (['proprietaire', 'agence', 'entreprise'].includes(accountType)) {
      const expired = await subscriptionExpiredFor(user.id, accountType);
      if (expired) {
        return res.redirect(`${APP_URL}/PartPublic/connexion.html?oauth_error=suspended`);
      }
    }

    if (accountType === 'locataire' || accountType === 'employe') {
      const ownerSusp =
        (await ownerSuspendedFor(user.id, accountType)) ||
        (await subscriptionExpiredFor(user.id, accountType));
      if (ownerSusp) {
        return res.redirect(`${APP_URL}/PartPublic/connexion.html?oauth_error=suspended`);
      }
    }

    const factors = await requireMfaFor(user, session.access_token);

    if (factors.length > 0) {
      setPendingMfaCookie(res, signToken({
        id: user.id,
        account_type: accountTypeOf(user),
        supabase_token: session.access_token,
        mfa_pending: true,
        factorId: factors[0].id,
      }, '10m'));

      return res.redirect(`${APP_URL}/PartPublic/2fa.html`);
    }

    const result = await finalizeLogin(res, user, session, req.headers['user-agent'], req.ip);
    return res.redirect(`${APP_URL}/${result.redirect}`);
  } catch (err) {
    console.error('[oauth callback]', err.message);
    return res.redirect(`${APP_URL}/PartPublic/connexion.html?oauth_error=server`);
  }
});

router.post('/logout', authenticate, async (req, res) => {
  const supabaseToken = req.user?.supabase_token;

  try {
    if (supabaseToken) {
      await authedClient(supabaseToken).auth.signOut();
    }
  } catch (err) {
    console.warn('[logout] signOut échec :', err.message);
  }

  if (req.user?.id) {
    await closeSession(req.user.id, supabaseToken, req.headers['user-agent']);
    gitAutoBackup(`Sauvegarde auto : déconnexion utilisateur ${req.user.id}`);
  }

  res.clearCookie('mim_token');
  res.clearCookie('mim_mfa_pending');
  res.json({ success: true, message: 'Déconnexion réussie.' });
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

router.put('/change-password', authenticate, async (req, res) => {
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
      const { error: signInError } = await supabase.auth.signInWithPassword({
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

    // Invalidation des autres sessions : après changement de mot de passe,
    // tous les anciens jetons Supabase sont révoqués.
    try {
      await supabase.auth.admin.signOut(req.user.id, 'global');
    } catch (signOutErr) {
      console.warn('[change-password] signOut global :', signOutErr.message);
    }

    // Re-login de la session courante pour obtenir un nouveau refresh token.
    try {
      const { data: freshSession } = await supabase.auth.signInWithPassword({
        email: account.user.email,
        password,
      });
      if (freshSession?.session) {
        setAuthCookie(res, signToken({
          id: req.user.id,
          account_type: req.user.account_type,
          supabase_token: freshSession.session.access_token,
          refresh_token: freshSession.session.refresh_token,
          supabase_expires_at: freshSession.session.expires_at,
        }));
      }
    } catch (reErr) {
      console.warn('[change-password] re-login :', reErr.message);
    }

    const { error: profileError } = await serviceClient()
      .from('profiles')
      .update({ must_change_password: false })
      .eq('id', req.user.id);

    if (profileError) {
      console.warn('[change-password] mise à jour du profil :', profileError.message);
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

  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: account.user.email,
    password,
  });

  if (signInError) {
    return res.status(403).json({ success: false, message: 'Mot de passe incorrect.' });
  }

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

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${APP_URL}/PartPublic/reset.html`,
  });

  if (error) {
    console.error('[forgot]', error.message);
  }

  res.json({
    success: true,
    message: 'Si cette adresse est enregistrée, un lien de réinitialisation a été envoyé.',
  });
});

router.post('/reset-password', async (req, res) => {
  const { password, password_confirm, code, token_hash, access_token, refresh_token } = req.body;

  const pwError = passwordRuleError(password);
  if (pwError) {
    return res.status(400).json({ success: false, message: pwError, errors: { password: pwError } });
  }

  if (password !== password_confirm) {
    return res.status(400).json({ success: false, message: 'Les mots de passe ne correspondent pas.' });
  }

  // Le jeton du lien de récupération PRIME sur toute session existante :
  // un utilisateur connecté qui clique un lien de réinitialisation émis pour
  // un autre compte ne doit pas modifier SON mot de passe (audit m16).
  let supabaseToken = null;
  let session = null;

  // 1) Flow implicite : le lien de récupération contient access_token
  // (+ refresh_token) dans le fragment d'URL.
  if (access_token) {
    try {
      const sbTemp = authedClient(access_token);
      await sbTemp.auth.setSession({
        access_token,
        refresh_token: refresh_token || '',
      });
      const { data: sess } = await sbTemp.auth.getSession();
      if (sess?.session) {
        session = sess.session;
        supabaseToken = session.access_token;
      }
    } catch (err) {
      console.warn('[reset-password] session fragment :', err.message);
    }
  }

  // 2) Flow classique : token_hash (lien email) ou code PKCE.
  if (!supabaseToken) {
    const candidate = token_hash || code;

    if (candidate) {
      const { data: otpData, error: otpError } = await supabase.auth.verifyOtp({
        type: 'recovery',
        token_hash: candidate,
      });

      if (!otpError && otpData?.session) {
        session = otpData.session;
      }

      if (!session && code) {
        try {
          const { data: exchangeData, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
          if (!exchangeError && exchangeData?.session) {
            session = exchangeData.session;
          }
        } catch (err) {
          console.warn('[reset-password] échange PKCE impossible :', err.message);
        }
      }
    }

    if (session) {
      supabaseToken = session.access_token;
    } else if (candidate) {
      console.error('[reset-password]', 'verifyOtp échec pour le lien fourni');
    }
  }

  if (!supabaseToken) {
    if (code || token_hash || access_token) {
      return res.status(400).json({ success: false, message: 'Lien de réinitialisation invalide ou expiré.' });
    }
    return res.status(401).json({ success: false, message: 'Jeton de réinitialisation manquant.' });
  }

  const sb = authedClient(supabaseToken);

  if (session?.refresh_token) {
    await sb.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
  }

  const { error: updateError } = await sb.auth.updateUser({ password });

  if (updateError) {
    console.error('[reset-password]', updateError.message);
    return res.status(400).json({ success: false, message: 'Impossible de réinitialiser le mot de passe.' });
  }

  // Invalidation de toutes les sessions existantes après réinitialisation.
  try {
    const userId = session?.user?.id;
    if (userId) {
      await supabase.auth.admin.signOut(userId, 'global');
    }
  } catch (signOutErr) {
    console.warn('[reset-password] signOut global :', signOutErr.message);
  }

  gitAutoBackup('Sauvegarde auto : réinitialisation de mot de passe');

  res.json({ success: true, message: 'Mot de passe réinitialisé. Vous pouvez vous connecter.' });
});

export default router;
