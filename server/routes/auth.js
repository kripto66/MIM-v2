import { Router } from 'express';
import { supabase, authedClient } from '../server.js';
import { signToken, authenticate } from '../middleware/auth.js';
import { gitAutoBackup } from '../utils/gitBackup.js';
import { logSession, closeSession } from '../utils/sessions.js';

const router = Router();

const ALLOWED_TYPES = ['proprietaire', 'agence', 'entreprise'];

const PAGE_BY_TYPE = {
  proprietaire: 'PartProprietaires/dashboard.html',
  agence: 'PartProprietaires/dashboard.html',
  entreprise: 'PartProprietaires/dashboard.html',
};

function emailIsValid(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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
    if (error.message.includes('already registered') || error.message.includes('existe')) {
      return res.status(409).json({ success: false, message: 'Cette adresse email est déjà utilisée.' });
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

  const token = signToken({
    id: user.id,
    account_type: user.user_metadata?.account_type,
    supabase_token: data.session.access_token,
  });

  res.cookie('mim_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  await logSession(user.id, 'register');

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

  if (error || !data.user) {
    return res.status(401).json({ success: false, message: 'Email ou mot de passe incorrect.' });
  }

  const accountType = data.user.user_metadata?.account_type || 'proprietaire';

  const token = signToken({
    id: data.user.id,
    account_type: accountType,
    supabase_token: data.session.access_token,
  });

  res.cookie('mim_token', token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  await logSession(data.user.id, 'login', data.session.access_token);
  await gitAutoBackup(`Sauvegarde auto : connexion de ${data.user.email}`);

  res.json({
    success: true,
    message: 'Connexion réussie.',
    user: {
      id: data.user.id,
      account_type: accountType,
      name: data.user.user_metadata?.name || '',
      email: data.user.email,
      phone: data.user.user_metadata?.phone || '',
    },
    redirect: PAGE_BY_TYPE[accountType],
  });
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
    redirectTo: 'http://localhost:3000/api/auth/reset-password',
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
  const { password, password_confirm } = req.body;

  if (!password || password.length < 8) {
    return res.status(400).json({ success: false, message: 'Le mot de passe doit contenir au moins 8 caractères.' });
  }

  if (password !== password_confirm) {
    return res.status(400).json({ success: false, message: 'Les mots de passe ne correspondent pas.' });
  }

  const supabaseToken = req.user?.supabase_token;

  if (!supabaseToken) {
    return res.status(401).json({ success: false, message: 'Jeton de réinitialisation manquant.' });
  }

  const { error } = await authedClient(supabaseToken).auth.updateUser({ password });

  if (error) {
    console.error('[reset-password]', error.message);
    return res.status(400).json({ success: false, message: 'Impossible de réinitialiser le mot de passe.' });
  }

  await gitAutoBackup('Sauvegarde auto : réinitialisation de mot de passe');

  res.json({ success: true, message: 'Mot de passe réinitialisé. Vous pouvez vous connecter.' });
});

export default router;
