// ============================================================
// MIM - Routes employés (propriétaire)
// Gestion des employés, de leur compte d'accès, salaire et paiements.
// Règle métier : seul le propriétaire crée les comptes employés
// (username + mot de passe temporaire, comme les comptes locataires).
// ============================================================

import { Router } from 'express';
import { serviceClient } from '../app.js';
import { gitAutoBackup } from '../utils/gitBackup.js';
import { tenantEmailFor, usernameIsValid } from '../utils/tenantAccount.js';
import { passwordRuleError } from '../utils/passwordPolicy.js';
import { notify } from '../utils/notifications.js';
import { methodePaiementError } from '../utils/paiementMethodes.js';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidDate(value) {
  return value && !Number.isNaN(new Date(value).getTime());
}

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ============================================================
// Liste des employés du propriétaire (avec résumé des paiements).
// ============================================================
router.get('/', async (req, res) => {
  const sb = serviceClient();
  const ownerId = req.user.id;

  try {
    const { data: employes = [], error } = await sb
      .from('employes')
      .select('*')
      .eq('user_id', ownerId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[employes]', error.message);
      return res.status(500).json({ success: false, message: 'Erreur lors du chargement des employés.' });
    }

    const { data: paiements = [] } = await sb
      .from('paiements_employes')
      .select('*')
      .eq('user_id', ownerId);

    const data = (employes || []).map((e) => {
      const own = (paiements || []).filter((p) => p.employe_id === e.id);
      return {
        ...e,
        salaire: Number(e.salaire || 0),
        paiements_count: own.length,
        total_paye: own.filter((p) => p.statut === 'paye').reduce((s, p) => s + Number(p.montant || 0), 0),
      };
    });

    res.json({ success: true, data });
  } catch (err) {
    console.error('[employes]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des employés.' });
  }
});

// ============================================================
// Création d'un employé AVEC un compte d'authentification.
// ============================================================
router.post('/', async (req, res) => {
  const sb = serviceClient();
  const ownerId = req.user.id;

  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const nom = String(req.body.nom || '').trim();
  const poste = String(req.body.poste || '').trim() || null;
  const rawSalaire = req.body.salaire;
  const salaire = rawSalaire === '' || rawSalaire == null ? 0 : Number(rawSalaire);
  const email = req.body.email ? String(req.body.email).trim() : null;
  const phone = req.body.phone ? String(req.body.phone).trim() : null;
  const dateEmbauche = req.body.date_embauche || null;
  const statut = req.body.statut || 'actif';

  if (!nom) {
    return res.status(400).json({ success: false, message: 'Le nom est obligatoire.', errors: { nom: 'Le nom est obligatoire.' } });
  }

  if (!usernameIsValid(username)) {
    return res.status(400).json({
      success: false,
      message: 'Le username doit contenir entre 3 et 32 caractères (lettres minuscules, chiffres, . _ -).',
      errors: { username: 'Le username doit contenir entre 3 et 32 caractères (lettres minuscules, chiffres, . _ -).' },
    });
  }

  if (email && !EMAIL_RE.test(email)) {
    return res.status(400).json({ success: false, message: 'Adresse email invalide.', errors: { email: 'Adresse email invalide.' } });
  }

  const pwError = passwordRuleError(password);
  if (pwError) {
    return res.status(400).json({ success: false, message: pwError, errors: { password: pwError } });
  }

  if (Number.isNaN(salaire) || salaire < 0) {
    return res.status(400).json({ success: false, message: 'Le salaire doit être un nombre positif.', errors: { salaire: 'Le salaire doit être un nombre positif.' } });
  }

  if (dateEmbauche && !isValidDate(dateEmbauche)) {
    return res.status(400).json({ success: false, message: 'Date d\'embauche invalide.', errors: { date_embauche: 'Date d\'embauche invalide.' } });
  }

  if (!['actif', 'inactif'].includes(statut)) {
    return res.status(400).json({ success: false, message: 'Statut invalide.', errors: { statut: 'Statut invalide.' } });
  }

  // Username unique dans toute l'application.
  const { data: existingUsername } = await sb
    .from('profiles')
    .select('id')
    .ilike('username', username)
    .maybeSingle();

  if (existingUsername) {
    return res.status(409).json({ success: false, code: 'USERNAME_ALREADY_EXISTS', message: 'Ce nom d\'utilisateur est déjà utilisé.', errors: { username: 'Ce nom d\'utilisateur est déjà utilisé.' } });
  }

  const { data: createdUser, error: createError } = await sb.auth.admin.createUser({
    email: tenantEmailFor(username),
    password,
    email_confirm: true,
    user_metadata: {
      account_type: 'employe',
      role: 'employe',
      name: nom,
      username,
      phone: phone || '',
      must_change_password: true,
    },
  });

  if (createError || !createdUser?.user?.id) {
    const msg = String(createError?.message || '').toLowerCase();
    if (msg.includes('already') || msg.includes('existe')) {
      return res.status(409).json({ success: false, code: 'USERNAME_ALREADY_EXISTS', message: 'Ce nom d\'utilisateur est déjà utilisé.', errors: { username: 'Ce nom d\'utilisateur est déjà utilisé.' } });
    }
    console.error('[employes/create]', createError?.message);
    return res.status(400).json({ success: false, message: 'Impossible de créer le compte employé.' });
  }

  const accountUid = createdUser.user.id;

  const { data, error } = await sb
    .from('employes')
    .insert({
      user_id: ownerId,
      account_uid: accountUid,
      username,
      nom,
      poste,
      salaire,
      email,
      phone,
      date_embauche: dateEmbauche,
      statut,
    })
    .select()
    .single();

  if (error) {
    await sb.auth.admin.deleteUser(accountUid).catch(() => {});
    console.error('[employes/create]', error.message);
    return res.status(400).json({ success: false, message: 'Erreur lors de la création de l\'employé.' });
  }

  await notify(accountUid, 'info', 'Votre compte employé a été créé par votre employeur. À votre première connexion, vous devrez choisir un nouveau mot de passe.');
  gitAutoBackup(`Sauvegarde auto : ajout employé (compte ${username})`);

  res.status(201).json({ success: true, data, accountCreated: true });
});

// ============================================================
// Mise à jour d'un employé (le username / mot de passe ne se
// modifient pas ici : le mot de passe se change depuis le profil).
// ============================================================
router.put('/:id', async (req, res) => {
  const sb = serviceClient();
  const ownerId = req.user.id;

  const { data: existing } = await sb
    .from('employes')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', ownerId)
    .maybeSingle();

  if (!existing) {
    return res.status(404).json({ success: false, message: 'Employé introuvable.' });
  }

  const updates = {};
  const setIfPresent = (field) => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  };

  if (req.body.nom !== undefined) {
    const nom = String(req.body.nom || '').trim();
    if (!nom) {
      return res.status(400).json({ success: false, message: 'Le nom est obligatoire.', errors: { nom: 'Le nom est obligatoire.' } });
    }
    updates.nom = nom;
  }
  setIfPresent('poste');
  setIfPresent('phone');
  setIfPresent('date_embauche');
  setIfPresent('statut');

  if (req.body.email !== undefined) {
    const email = String(req.body.email || '').trim() || null;
    if (email && !EMAIL_RE.test(email)) {
      return res.status(400).json({ success: false, message: 'Adresse email invalide.', errors: { email: 'Adresse email invalide.' } });
    }
    updates.email = email;
  }

  if (req.body.salaire !== undefined) {
    const salaire = req.body.salaire === '' || req.body.salaire == null ? 0 : Number(req.body.salaire);
    if (Number.isNaN(salaire) || salaire < 0) {
      return res.status(400).json({ success: false, message: 'Le salaire doit être un nombre positif.', errors: { salaire: 'Le salaire doit être un nombre positif.' } });
    }
    updates.salaire = salaire;
  }

  if (updates.statut !== undefined && !['actif', 'inactif'].includes(updates.statut)) {
    return res.status(400).json({ success: false, message: 'Statut invalide.', errors: { statut: 'Statut invalide.' } });
  }
  if (updates.date_embauche !== undefined && updates.date_embauche && !isValidDate(updates.date_embauche)) {
    return res.status(400).json({ success: false, message: 'Date d\'embauche invalide.', errors: { date_embauche: 'Date d\'embauche invalide.' } });
  }
  if (updates.poste !== undefined) updates.poste = String(updates.poste || '').trim() || null;
  if (updates.phone !== undefined) updates.phone = String(updates.phone || '').trim() || null;

  const { data, error } = await sb
    .from('employes')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', ownerId)
    .select()
    .single();

  if (error) {
    console.error('[employes/update]', error.message);
    return res.status(400).json({ success: false, message: 'Erreur lors de la mise à jour de l\'employé.' });
  }

  gitAutoBackup(`Sauvegarde auto : mise à jour employé ${req.params.id}`);
  res.json({ success: true, data });
});

// ============================================================
// Suppression d'un employé (+ suppression du compte d'accès).
// ============================================================
router.delete('/:id', async (req, res) => {
  const sb = serviceClient();
  const ownerId = req.user.id;

  const { data: existing } = await sb
    .from('employes')
    .select('id, nom, account_uid')
    .eq('id', req.params.id)
    .eq('user_id', ownerId)
    .maybeSingle();

  if (!existing) {
    return res.status(404).json({ success: false, message: 'Employé introuvable.' });
  }

  const { error } = await sb.from('employes').delete().eq('id', req.params.id).eq('user_id', ownerId);

  if (error) {
    console.error('[employes/delete]', error.message);
    return res.status(400).json({ success: false, message: 'Erreur lors de la suppression de l\'employé.' });
  }

  if (existing.account_uid) {
    await sb.auth.admin.deleteUser(existing.account_uid).catch(() => {});
  }

  gitAutoBackup(`Sauvegarde auto : suppression employé ${existing.nom}`);
  res.json({ success: true, message: 'Employé supprimé.' });
});

// ============================================================
// Paiements de salaire d'un employé.
// ============================================================
router.get('/:id/paiements', async (req, res) => {
  const sb = serviceClient();
  const ownerId = req.user.id;

  const { data: paiements = [], error } = await sb
    .from('paiements_employes')
    .select('*')
    .eq('employe_id', req.params.id)
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[employes/paiements]', error.message);
    return res.status(500).json({ success: false, message: 'Erreur lors du chargement des paiements.' });
  }

  res.json({ success: true, data: paiements });
});

router.post('/:id/paiements', async (req, res) => {
  const sb = serviceClient();
  const ownerId = req.user.id;

  const { data: employe } = await sb
    .from('employes')
    .select('id, nom, account_uid')
    .eq('id', req.params.id)
    .eq('user_id', ownerId)
    .maybeSingle();

  if (!employe) {
    return res.status(404).json({ success: false, message: 'Employé introuvable.' });
  }

  const montant = Number(req.body.montant);
  const mois = String(req.body.mois || '').trim();
  const statut = req.body.statut || 'paye';
  const datePaiement = req.body.date_paiement || null;
  const methodePaiement = req.body.methode_paiement || null;
  const reference = req.body.reference || null;

  if (Number.isNaN(montant) || montant <= 0) {
    return res.status(400).json({ success: false, message: 'Le montant doit être supérieur à 0.', errors: { montant: 'Le montant doit être supérieur à 0.' } });
  }
  if (!/^\d{4}-\d{2}$/.test(mois)) {
    return res.status(400).json({ success: false, message: 'Le mois doit être au format AAAA-MM.', errors: { mois: 'Le mois doit être au format AAAA-MM.' } });
  }
  if (!['paye', 'attente'].includes(statut)) {
    return res.status(400).json({ success: false, message: 'Statut invalide.', errors: { statut: 'Statut invalide.' } });
  }
  if (datePaiement && !isValidDate(datePaiement)) {
    return res.status(400).json({ success: false, message: 'Date de paiement invalide.', errors: { date_paiement: 'Date de paiement invalide.' } });
  }
  const methodeError = methodePaiementError(methodePaiement);
  if (methodeError) {
    return res.status(400).json({ success: false, message: methodeError, errors: { methode_paiement: methodeError } });
  }
  if (reference && String(reference).length > 80) {
    return res.status(400).json({ success: false, message: 'La référence ne doit pas dépasser 80 caractères.', errors: { reference: 'La référence ne doit pas dépasser 80 caractères.' } });
  }

  const { data, error } = await sb
    .from('paiements_employes')
    .insert({
      user_id: ownerId,
      employe_id: employe.id,
      employe_uid: employe.account_uid,
      montant,
      mois,
      statut,
      date_paiement: datePaiement || null,
      methode_paiement: methodePaiement,
      reference: reference,
    })
    .select()
    .single();

  if (error) {
    console.error('[employes/paiements]', error.message);
    return res.status(400).json({ success: false, message: 'Erreur lors de l\'enregistrement du paiement.' });
  }

  if (employe.account_uid) {
    const label = statut === 'paye' ? 'payé' : 'enregistré (en attente)';
    await notify(employe.account_uid, 'salaire', `Votre salaire de ${mois} a été ${label}.`);
  }

  gitAutoBackup(`Sauvegarde auto : paiement salaire employé ${employe.id} (${mois})`);
  res.status(201).json({ success: true, data, message: 'Paiement enregistré.' });
});

// Solde courant : versé par défaut au mois courant (pré-remplissage frontend).
router.get('/mois-courant', (req, res) => {
  res.json({ success: true, mois: currentMonth() });
});

export default router;
