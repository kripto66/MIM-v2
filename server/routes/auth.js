import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { supabase, authedClient } from '../server.js';
import { signToken, authenticate } from '../middleware/auth.js';
import { gitAutoBackup } from '../utils/gitBackup.js';
import { logSession, closeSession } from '../utils/sessions.js';
import { newOAuthClient, storeFlow, getFlow, deleteFlow } from '../utils/oauth.js';

const router = Router();

const ALLOWED_TYPES = ['proprietaire', 'agence', 'entreprise', 'locataire'];

const PAGE_BY_TYPE = {
  proprietaire: 'PartProprietaires/dashboard.html',
  agence: 'PartProprietaires/dashboard.html',
  entreprise: 'PartProprietaires/dashboard.html',
  locataire: 'PartLocataires/LocaDash.html',
};

const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

function emailIsValid(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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
    maxAge: 10 * 60 * 1000,
  });
}

function accountTypeOf(user) {
  return user?.user_metadata?.account_type || 'proprietaire';
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

function publicUser(user) {
  return {
    id: user.id,
    account_type: accountTypeOf(user),
    name: user.user_metadata?.name || '',
    email: user.email,
    phone: user.user_metadata?.phone || '',
  };
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

async function finalizeLogin(res, user, session) {
  const accountType = accountTypeOf(user);

  const token = signToken(sessionPayload(user, session));

  setAuthCookie(res, token);

  await linkTenantAccount(user, session?.access_token);
  await logSession(user.id, 'login', session?.access_token);
  await gitAutoBackup(`Sauvegarde auto : connexion de ${user.email}`);

  return {
    user: publicUser(user),
    redirect: PAGE_BY_TYPE[accountType],
  };
}

// Relie un compte 'locataire' à sa fiche (par email) s'il n'est pas encore lié.
async function linkTenantAccount(user, supabaseToken) {
  if (accountTypeOf(user) !== 'locataire' || !user?.email) return;

  try {
    const { error } = await authedClient(supabaseToken)
      .from('locataires')
      .update({ account_uid: user.id })
      .ilike('email', user.email)
      .is('account_uid', null);

    if (error) {
      console.warn('[linkTenantAccount]', error.message);
    }
  } catch (err) {
    console.warn('[linkTenantAccount]', err.message);
  }
}

router.post('/register', async (req, res) => {
  const { account_type, name, email, phone, password, password_confirm } = req.body;

  if (!account_type || !name || !email || !phone || !password || !password_confirm) {
    return res.status(400).json({ success: false, message: 'Veuillez remplir tous les champs.' });
  }

  if (!ALLOWED_TYPES.includes(account_type)) {
    return res.status(400).json({ success: false, message: 'Type de compte invalide.' });
  }

  if (!emailIsValid(email)) {
    return res.status(400).json({ success: false, message: 'Adresse email invalide.' });
  }

  if (password.length < 8) {
    return res.status(400).json({ success: false, message: 'Le mot de passe doit contenir au moins 8 caractères.' });
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
      return res.status(409).json({ success: false, message: 'Cette adresse email est déjà utilisée.' });
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
  await logSession(user.id, 'register', data.session?.access_token);

  res.status(201).json({
    success: true,
    message: 'Compte créé avec succès.',
    redirect: PAGE_BY_TYPE[account_type],
  });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Veuillez remplir tous les champs.' });
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.user || !data.session) {
    return res.status(401).json({ success: false, message: 'Email ou mot de passe incorrect.' });
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

    return res.json({
      success: true,
      mfaRequired: true,
      redirect: 'PartPublic/2fa.html',
      message: 'Code de vérification requis.',
    });
  }

  const result = await finalizeLogin(res, data.user, data.session);

  res.json({
    success: true,
    message: 'Connexion réussie.',
    ...result,
  });
});

router.post('/verify-2fa', async (req, res) => {
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

    const result = await finalizeLogin(res, verified.user, verified);

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
      supabase_expires_at: verified.expires_at || null,
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

    const result = await finalizeLogin(res, user, session);
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
    await closeSession(req.user.id, supabaseToken);
    await gitAutoBackup(`Sauvegarde auto : déconnexion utilisateur ${req.user.id}`);
  }

  res.clearCookie('mim_token');
  res.clearCookie('mim_mfa_pending');
  res.json({ success: true, message: 'Déconnexion réussie.' });
});

router.get('/me', authenticate, async (req, res) => {
  const sb = authedClient(req.user.supabase_token);

  const { data: user, error } = await sb
    .from('profiles')
    .select('id, account_type, name, email, phone')
    .eq('id', req.user.id)
    .maybeSingle();

  if (error || !user) {
    return res.status(404).json({ success: false, message: 'Utilisateur introuvable.' });
  }

  res.json({ success: true, user });
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

  await gitAutoBackup(`Sauvegarde auto : mise à jour du profil ${req.user.id}`);

  res.json({ success: true, message: 'Profil mis à jour avec succès.' });
});

router.post('/forgot', async (req, res) => {
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
  const { password, password_confirm, code, token_hash } = req.body;

  if (!password || password.length < 8) {
    return res.status(400).json({ success: false, message: 'Le mot de passe doit contenir au moins 8 caractères.' });
  }

  if (password !== password_confirm) {
    return res.status(400).json({ success: false, message: 'Les mots de passe ne correspondent pas.' });
  }

  let supabaseToken = req.user?.supabase_token;

  if (!supabaseToken) {
    const candidate = token_hash || code;

    if (!candidate) {
      return res.status(401).json({ success: false, message: 'Jeton de réinitialisation manquant.' });
    }

    let session = null;

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

    if (!session) {
      console.error('[reset-password]', otpError?.message || 'verifyOtp échec');
      return res.status(400).json({ success: false, message: 'Lien de réinitialisation invalide ou expiré.' });
    }

    supabaseToken = session.access_token;
  }

  const { error: updateError } = await authedClient(supabaseToken).auth.updateUser({ password });

  if (updateError) {
    console.error('[reset-password]', updateError.message);
    return res.status(400).json({ success: false, message: 'Impossible de réinitialiser le mot de passe.' });
  }

  await gitAutoBackup('Sauvegarde auto : réinitialisation de mot de passe');

  res.json({ success: true, message: 'Mot de passe réinitialisé. Vous pouvez vous connecter.' });
});

export default router;
