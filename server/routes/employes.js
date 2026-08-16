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
import { methodePaiementError, TYPES_MOYENS_PAIEMENT, sanitizeMoyenBody, TYPE_MOYEN_LABELS } from '../utils/paiementMethodes.js';

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
      .eq('user_id', ownerId)
      .order('created_at', { ascending: false });

    const data = (employes || []).map((e) => {
      const own = (paiements || []).filter((p) => p.employe_id === e.id);
      return {
        ...e,
        salaire: Number(e.salaire || 0),
        paiements_count: own.length,
        total_paye: own.filter((p) => p.statut === 'paye').reduce((s, p) => s + Number(p.montant || 0), 0),
        en_attente_confirmation: own.filter((p) => p.statut === 'attente').length,
        dernier_paiement: own[0] || null,
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
// Paiements de salaire d'un employé (avec détail de confirmation).
// ============================================================
router.get('/:id/paiements', async (req, res) => {
  const sb = serviceClient();
  const ownerId = req.user.id;

  const { data: employe } = await sb
    .from('employes')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', ownerId)
    .maybeSingle();

  if (!employe) {
    return res.status(404).json({ success: false, message: 'Employé introuvable.' });
  }

  const [{ data: paiements = [], error }, { data: moyens = [] }] = await Promise.all([
    sb.from('paiements_employes')
      .select('*')
      .eq('employe_id', req.params.id)
      .eq('user_id', ownerId)
      .order('created_at', { ascending: false }),
    sb.from('moyens_paiement_employes').select('id, type, nom_titulaire, numero'),
  ]);

  if (error) {
    console.error('[employes/paiements]', error.message);
    return res.status(500).json({ success: false, message: 'Erreur lors du chargement des paiements.' });
  }

  const moyenById = new Map((moyens || []).map((m) => [String(m.id), m]));

  res.json({
    success: true,
    data: (paiements || []).map((p) => {
      const moyen = p.moyen_employe_id ? moyenById.get(String(p.moyen_employe_id)) : null;
      return {
        ...p,
        montant: Number(p.montant),
        moyen: moyen ? { id: moyen.id, type: moyen.type, label: TYPE_MOYEN_LABELS[moyen.type] || moyen.type, nom_titulaire: moyen.nom_titulaire, numero: moyen.numero } : null,
      };
    }),
  });
});

// ============================================================
// Paiement de salaire d'un employé.
//
// Flux actuel : le propriétaire DÉCLARE avoir versé (statut
// « attente ») ; l'employé confirme la réception (statut « paye »).
// Le propriétaire ne peut PAS passer seul un paiement à « paye » :
// seul l'employé confirme. Compatibilité conservée : statut « paye »
// reste accepté pour les versements vérifiés hors flux (ex. UnitechPay).
// ============================================================
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
  const statut = req.body.statut || 'attente';
  const datePaiement = req.body.date_paiement || null;
  const reference = req.body.reference || null;
  const moyenEmployeId = req.body.moyen_employe_id || null;
  const methodePaiement = req.body.methode_paiement || null;

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
  if (reference && String(reference).length > 80) {
    return res.status(400).json({ success: false, message: 'La référence ne doit pas dépasser 80 caractères.', errors: { reference: 'La référence ne doit pas dépasser 80 caractères.' } });
  }

  // Le moyen de paiement (si fourni) doit appartenir À CET employé.
  let effectiveMethode = methodePaiement;
  if (moyenEmployeId) {
    const { data: moyen } = await sb
      .from('moyens_paiement_employes')
      .select('id, type')
      .eq('id', moyenEmployeId)
      .eq('employe_uid', employe.account_uid)
      .maybeSingle();

    if (!moyen) {
      return res.status(404).json({ success: false, message: 'Moyen de paiement introuvable pour cet employé.', errors: { moyen_employe_id: 'Moyen de paiement introuvable pour cet employé.' } });
    }
    effectiveMethode = moyen.type;
  }

  const methodeError = methodePaiementError(effectiveMethode);
  if (methodeError) {
    return res.status(400).json({ success: false, message: methodeError, errors: { methode_paiement: methodeError } });
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
      methode_paiement: effectiveMethode,
      reference: reference,
      moyen_employe_id: moyenEmployeId || null,
    })
    .select()
    .single();

  if (error) {
    console.error('[employes/paiements]', error.message);
    return res.status(400).json({ success: false, message: 'Erreur lors de l\'enregistrement du paiement.' });
  }

  if (employe.account_uid) {
    if (statut === 'attente') {
      const moyenLabel = effectiveMethode ? TYPE_MOYEN_LABELS[effectiveMethode] || effectiveMethode : null;
      await notify(
        employe.account_uid,
        'salaire',
        `Votre employeur indique avoir versé votre salaire de ${Number(montant).toLocaleString('fr-FR')} FCFA (${mois})` +
          (moyenLabel ? ` via ${moyenLabel}` : '') +
          `. Vérifiez votre compte de paiement puis confirmez la réception depuis votre espace.`
      );
    } else {
      await notify(employe.account_uid, 'salaire', `Votre salaire de ${mois} a été payé.`);
    }
  }

  gitAutoBackup(`Sauvegarde auto : paiement salaire employé ${employe.id} (${mois})`);
  res.status(201).json({
    success: true,
    data,
    message: statut === 'attente' ? 'Versement déclaré : l\'employé doit confirmer la réception.' : 'Paiement enregistré.',
  });
});

// ============================================================
// Moyens de paiement d'un employé (consultation propriétaire).
// ============================================================
router.get('/:id/moyens-paiement', async (req, res) => {
  const sb = serviceClient();
  const ownerId = req.user.id;

  const { data: employe } = await sb
    .from('employes')
    .select('id, account_uid')
    .eq('id', req.params.id)
    .eq('user_id', ownerId)
    .maybeSingle();

  if (!employe) {
    return res.status(404).json({ success: false, message: 'Employé introuvable.' });
  }
  if (!employe.account_uid) {
    return res.json({ success: true, data: [] });
  }

  const { data: moyens = [], error } = await sb
    .from('moyens_paiement_employes')
    .select('*')
    .eq('employe_uid', employe.account_uid)
    .eq('actif', true)
    .order('type', { ascending: true });

  if (error) {
    console.error('[employes/moyens-paiement]', error.message);
    return res.status(500).json({ success: false, message: 'Erreur lors du chargement des moyens.' });
  }

  res.json({ success: true, data: moyens });
});

// Création d'un moyen de paiement pour un employé (par le propriétaire).
router.post('/:id/moyens-paiement', async (req, res) => {
  const sb = serviceClient();
  const ownerId = req.user.id;

  const { data: employe } = await sb
    .from('employes')
    .select('id, account_uid')
    .eq('id', req.params.id)
    .eq('user_id', ownerId)
    .maybeSingle();

  if (!employe) {
    return res.status(404).json({ success: false, message: 'Employé introuvable.' });
  }
  if (!employe.account_uid) {
    return res.status(400).json({ success: false, message: 'Cet employé n\'a pas encore de compte de connexion.' });
  }

  const type = String((req.body || {}).type || '');
  if (!TYPES_MOYENS_PAIEMENT.includes(type)) {
    return res.status(400).json({ success: false, message: 'Type de moyen de paiement invalide.' });
  }

  const clean = sanitizeMoyenBody(type, req.body);
  const { data, error } = await sb
    .from('moyens_paiement_employes')
    .insert({ employe_uid: employe.account_uid, type, ...clean })
    .select()
    .single();

  if (error) {
    console.error('[employes/moyens-paiement] insert :', error.message);
    return res.status(400).json({ success: false, message: 'Erreur lors de l\'enregistrement.' });
  }
  res.status(201).json({ success: true, data, message: 'Moyen de paiement enregistré.' });
});

// Solde courant : versé par défaut au mois courant (pré-remplissage frontend).
router.get('/mois-courant', (req, res) => {
  res.json({ success: true, mois: currentMonth() });
});

export default router;
