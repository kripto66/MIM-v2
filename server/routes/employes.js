// ============================================================
// MIM - Routes employés (propriétaire)
// Gestion des employés, de leur compte d'accès, salaire et paiements.
// Règle métier : seul le propriétaire crée les comptes employés
// (username + mot de passe temporaire, comme les comptes locataires).
// ============================================================

import { Router } from 'express';
import { serviceClient } from '../app.js';
import { gitAutoBackup } from '../utils/gitBackup.js';
import { tenantEmailFor, usernameIsValid, uniqueUsername, splitFullName, generateInitialPassword, provisionProfile } from '../utils/tenantAccount.js';
import { passwordRuleError } from '../utils/passwordPolicy.js';
import { notify } from '../utils/notifications.js';
import { methodePaiementError, TYPES_MOYENS_PAIEMENT, sanitizeMoyenBody, paymentLinkError, TYPE_MOYEN_LABELS } from '../utils/paiementMethodes.js';
import { auditLog, LEVELS } from '../utils/audit.js';
import { revokeAllSessions } from '../utils/sessions.js';
import { isValidDate, isValidMonth, parseMoney } from '../utils/inputValidation.js';
import { enforceEmployesLimit } from '../utils/subscription.js';
import { reserveQuota, consumeQuota, releaseQuota } from '../utils/quota.js';

const router = Router();

// ------------------------------------------------------------
// Propriétaire cible de la requête.
//
// Monté tel quel sur /api/employes, le propriétaire est l'utilisateur
// connecté. L'espace AGENCE le monte aussi sous /api/agence/bien/:bienId
// (même contrat, mêmes formes de réponse) : `requireMandateBien` y pose
// `req.scope.proprietaireId` et `withScopeOwner` le recopie ici. Les
// employés, leurs tâches, leurs salaires et leurs moyens de paiement
// appartiennent alors au PROPRIÉTAIRE GÉRÉ, jamais à l'agence.
// Sans mandat, `req.scopeOwnerId` est absent : le comportement
// propriétaire d'origine est conservé à l'identique.
// ------------------------------------------------------------
export function withScopeOwner(req, _res, next) {
  const proprietaireId = req.scope?.proprietaireId;
  if (proprietaireId) req.scopeOwnerId = proprietaireId;
  next();
}

function ownerIdOf(req) {
  return req.scopeOwnerId || req.user.id;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidAmount(value, allowZero = false) {
  return parseMoney(value, { allowZero }) !== null;
}

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ============================================================
// Affectation d'un employé à ses biens (remplace les liaisons
// existantes). Chaque bien doit appartenir au propriétaire.
// ============================================================
async function setEmployeBiens(sb, ownerId, employeId, biens, opts = {}) {
  if (biens === undefined || biens === null) return null;

  const bienIds = Array.isArray(biens)
    ? [...new Set(biens.map((b) => (typeof b === 'object' && b !== null ? b.id : b)).filter((id) => id != null && id !== '').map(Number))]
    : [];
  if (bienIds.some((id) => Number.isNaN(id))) {
    return { message: 'Affectations aux biens invalides.', errors: { biens: 'Affectations aux biens invalides.' } };
  }

  const { data: owned = [], error: bienError } = await sb
    .from('biens')
    .select('id')
    .eq('user_id', ownerId)
    .in('id', bienIds.length ? bienIds : [0]);

  if (bienError) {
    console.error('[employes/biens]', bienError.message);
    return { message: 'Erreur lors de la vérification des biens.' };
  }

  const ownedIds = new Set(owned.map((b) => b.id));
  const foreign = bienIds.filter((id) => !ownedIds.has(id));
  if (foreign.length) {
    return { message: 'Un ou plusieurs biens ne vous appartiennent pas.', errors: { biens: `Biens inconnus : ${foreign.join(', ')}` } };
  }

  await sb.from('employes_biens').delete().eq('employe_id', employeId).eq('user_id', ownerId);

  if (bienIds.length) {
    const rows = bienIds.map((bien_id) => ({ user_id: ownerId, employe_id: employeId, bien_id }));
    const { error } = await sb.from('employes_biens').insert(rows);
    if (error) {
      console.error('[employes/biens/insert]', error.message);
      if (opts.rollback) opts.rollback();
      return { message: 'Erreur lors de l\'affectation aux biens.' };
    }
  }
  return null;
}

// ============================================================
// Liste des employés du propriétaire (avec résumé des paiements).
// ============================================================
router.get('/', async (req, res) => {
  const sb = serviceClient();
  const ownerId = ownerIdOf(req);

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

    const { data: liaisonRows, error: liaisonError } = await sb
      .from('employes_biens')
      .select('employe_id, bien_id')
      .eq('user_id', ownerId);
    if (liaisonError) console.warn('[employes] liaisons:', liaisonError.message);

    const linkedBienIds = [...new Set((liaisonRows || []).map((row) => row.bien_id).filter(Boolean))];
    const { data: linkedBiens = [] } = linkedBienIds.length
      ? await sb.from('biens').select('id, nom').in('id', linkedBienIds)
      : { data: [] };
    const bienById = new Map(linkedBiens.map((bien) => [String(bien.id), bien]));
    const biensByEmploye = {};
    for (const l of liaisonRows || []) {
      if (!biensByEmploye[l.employe_id]) biensByEmploye[l.employe_id] = [];
      const bien = bienById.get(String(l.bien_id));
      biensByEmploye[l.employe_id].push(bien ? { id: bien.id, nom: bien.nom } : { id: l.bien_id, nom: null });
    }

    const data = (employes || []).map((e) => {
      const own = (paiements || []).filter((p) => p.employe_id === e.id);
      return {
        ...e,
        salaire: Number(e.salaire || 0),
        biens: biensByEmploye[e.id] || [],
        paiements_count: own.length,
        total_paye: own.filter((p) => p.statut === 'paye').reduce((s, p) => s + Number(p.montant || 0), 0),
        en_attente_confirmation: own.filter((p) => p.statut === 'attente').length,
        dernier_paiement: own[0] || null,
      };
    });

    // Enrichissement : avatar réel du profil. La RLS empêche le
    // propriétaire de lire profiles des autres → client service.
    const uids = [...new Set((employes || []).map((e) => e.account_uid).filter(Boolean))];
    const avatars = {};
    if (uids.length) {
      const { data: profs } = await sb.from('profiles').select('id, avatar_url').in('id', uids);
      for (const p of profs || []) avatars[p.id] = p.avatar_url || null;
    }
    for (const e of data) e.avatar_url = avatars[e.account_uid] || null;

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
  const ownerId = ownerIdOf(req);

  // Mode automatique (comme pour les locataires) : quand le propriétaire ne
  // fournit ni username ni mot de passe, MIM génère le username (préfixe
  // lisible + jeton aléatoire, imprévisible) et le mot de passe initial
  // temporaire (aléatoire, must_change_password = true).
  const autoAccount = !req.body?.username && !req.body?.password;
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = autoAccount ? generateInitialPassword() : String(req.body.password || '');
  const nom = String(req.body.nom || '').trim();
  const poste = String(req.body.poste || '').trim() || null;
  const rawSalaire = req.body.salaire;
  const salaire = rawSalaire === '' || rawSalaire == null ? 0 : parseMoney(rawSalaire, { allowZero: true });
  const email = req.body.email ? String(req.body.email).trim() : null;
  const phone = req.body.phone ? String(req.body.phone).trim() : null;
  const dateEmbauche = req.body.date_embauche || null;
  const statut = req.body.statut || 'actif';

  if (!nom) {
    return res.status(400).json({ success: false, message: 'Le nom est obligatoire.', errors: { nom: 'Le nom est obligatoire.' } });
  }

  if (!autoAccount && !usernameIsValid(username)) {
    return res.status(400).json({
      success: false,
      message: 'Le username doit contenir entre 3 et 32 caractères (lettres minuscules, chiffres, . _ -).',
      errors: { username: 'Le username doit contenir entre 3 et 32 caractères (lettres minuscules, chiffres, . _ -).' },
    });
  }

  if (email && !EMAIL_RE.test(email)) {
    return res.status(400).json({ success: false, message: 'Adresse email invalide.', errors: { email: 'Adresse email invalide.' } });
  }

  if (!autoAccount) {
    const pwError = passwordRuleError(password);
    if (pwError) {
      return res.status(400).json({ success: false, message: pwError, errors: { password: pwError } });
    }
  }

  if (!isValidAmount(salaire, true)) {
    return res.status(400).json({ success: false, message: 'Le salaire doit être un nombre positif.', errors: { salaire: 'Le salaire doit être un nombre positif.' } });
  }

  if (dateEmbauche && !isValidDate(dateEmbauche)) {
    return res.status(400).json({ success: false, message: 'Date d\'embauche invalide.', errors: { date_embauche: 'Date d\'embauche invalide.' } });
  }

  if (!['actif', 'inactif'].includes(statut)) {
    return res.status(400).json({ success: false, message: 'Statut invalide.', errors: { statut: 'Statut invalide.' } });
  }

  // Username unique dans toute l'application.
  let finalUsername = username;
  if (autoAccount) {
    const { prenom, nom: nomFamille } = splitFullName(nom);
    finalUsername = await uniqueUsername(sb, prenom, nomFamille);
    if (!finalUsername) {
      return res.status(400).json({ success: false, message: 'Impossible de générer un nom d\'utilisateur unique pour cet employé.' });
    }
  } else {
    const { data: existingUsername } = await sb
      .from('profiles')
      .select('id')
      .ilike('username', finalUsername)
      .maybeSingle();

    if (existingUsername) {
      return res.status(409).json({ success: false, code: 'USERNAME_ALREADY_EXISTS', message: 'Ce nom d\'utilisateur est déjà utilisé.', errors: { username: 'Ce nom d\'utilisateur est déjà utilisé.' } });
    }
  }

  // Plafond d'employés du plan : chaque employé consomme un compte Auth,
  // donc un quota de ressource. La réservation est posée AVANT la
  // création du compte (verrou advisory) pour fermer la course
  // « deux créations simultanées passent toutes les deux ».
  const employesLimit = await enforceEmployesLimit(ownerId);
  if (!employesLimit.allowed) {
    return res.status(409).json({ success: false, code: employesLimit.code, message: employesLimit.message, errors: { nom: employesLimit.message } });
  }
  let quotaReservation = await reserveQuota(sb, ownerId, 'employes', employesLimit.max);
  if (!quotaReservation.allowed) {
    return res.status(409).json({ success: false, code: quotaReservation.code, message: quotaReservation.message, errors: { nom: quotaReservation.message } });
  }
  const releaseEmployeeQuota = async () => {
    if (!quotaReservation) return;
    await releaseQuota(sb, quotaReservation?.id, ownerId).catch(() => {});
    quotaReservation = null;
  };

  const { data: createdUser, error: createError } = await sb.auth.admin.createUser({
    email: tenantEmailFor(finalUsername),
    password,
    email_confirm: true,
    user_metadata: {
      name: nom,
      username: finalUsername,
      phone: phone || '',
    },
    app_metadata: {
      mim_account_type: 'employe',
      mim_must_change_password: true,
    },
  });

  if (createError || !createdUser?.user?.id) {
    const msg = String(createError?.message || '').toLowerCase();
    if (msg.includes('already') || msg.includes('existe')) {
      await releaseEmployeeQuota();
      return res.status(409).json({ success: false, code: 'USERNAME_ALREADY_EXISTS', message: 'Ce nom d\'utilisateur est déjà utilisé.', errors: { username: 'Ce nom d\'utilisateur est déjà utilisé.' } });
    }
    console.error('[employes/create]', createError?.message);
    await releaseEmployeeQuota();
    return res.status(400).json({ success: false, message: 'Impossible de créer le compte employé.' });
  }

  const accountUid = createdUser.user.id;
  try {
    await provisionProfile(sb, accountUid, 'employe', finalUsername, true, email);
  } catch (profileError) {
    await sb.auth.admin.deleteUser(accountUid).catch(() => {});
    await releaseEmployeeQuota();
    return res.status(500).json({ success: false, message: 'Impossible de finaliser le compte employé.' });
  }
  if (statut === 'inactif') {
    const { error: banError } = await sb.auth.admin.updateUserById(accountUid, { ban_duration: '8760h' });
    if (banError) {
      await sb.auth.admin.deleteUser(accountUid).catch(() => {});
      await releaseEmployeeQuota();
      return res.status(503).json({ success: false, message: 'Impossible de synchroniser le statut du compte.' });
    }
  }

  const { data, error } = await sb
    .from('employes')
    .insert({
      user_id: ownerId,
      account_uid: accountUid,
      username: finalUsername,
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
    await releaseEmployeeQuota();
    console.error('[employes/create]', error.message);
    return res.status(400).json({ success: false, message: 'Erreur lors de la création de l\'employé.' });
  }

  // Affectation de l'employé à ses biens (aucun bien étranger accepté).
  const biensError = await setEmployeBiens(sb, ownerId, data.id, req.body.biens, { rollback: () => sb.auth.admin.deleteUser(accountUid).catch(() => {}) });
  if (biensError) {
    try {
      await sb.from('employes').delete().eq('id', data.id);
    } catch (cleanupErr) {
      console.warn('[employes] nettoyage échec après rollback biens :', cleanupErr.message);
    }
    await sb.auth.admin.deleteUser(accountUid).catch(() => {});
    await releaseEmployeeQuota();
    return res.status(400).json({ success: false, message: biensError.message, errors: biensError.errors });
  }

  await consumeQuota(sb, quotaReservation?.id, ownerId);
  quotaReservation = null;

  await notify(accountUid, 'info', 'Votre compte employé a été créé par votre employeur. À votre première connexion, vous devrez choisir un nouveau mot de passe.');
  gitAutoBackup(`Sauvegarde auto : ajout employé (compte ${finalUsername})`);

  await auditLog({
    userId: req.user.id,
    action: 'employee.create',
    target: data.id,
    targetType: 'employee',
    level: LEVELS.INFO,
    meta: { username: finalUsername, nom: data.nom, prenom: data.prenom },
    ip: req.ip,
  });

  res.status(201).json({
    success: true,
    data,
    accountCreated: true,
    autoAccount,
    account: autoAccount ? { username: finalUsername, password } : undefined,
  });
});

// ============================================================
// Mise à jour d'un employé (le username / mot de passe ne se
// modifient pas ici : le mot de passe se change depuis le profil).
// ============================================================
router.put('/:id', async (req, res) => {
  const sb = serviceClient();
  const ownerId = ownerIdOf(req);

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
    const salaire = req.body.salaire === '' || req.body.salaire == null ? 0 : parseMoney(req.body.salaire, { allowZero: true });
    if (!isValidAmount(salaire, true)) {
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

  let data;
  if (Object.keys(updates).length) {
    const { data: updated, error } = await sb
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
    data = updated;
  } else {
    const { data: current } = await sb
      .from('employes')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', ownerId)
      .maybeSingle();
    data = current;
  }

  // Remplacement des affectations aux biens (si le champ est fourni).
  if (updates.statut !== undefined) {
    const existingAccount = await sb.from('employes').select('account_uid').eq('id', req.params.id).eq('user_id', ownerId).maybeSingle();
    if (existingAccount.data?.account_uid) {
      const { error: banError } = await sb.auth.admin.updateUserById(existingAccount.data.account_uid, {
        ban_duration: updates.statut === 'inactif' ? '8760h' : 'none',
      });
      if (banError) return res.status(503).json({ success: false, message: 'Le statut Auth n\'a pas pu être synchronisé.' });
    }
  }

  if (req.body.biens !== undefined) {
    const biensError = await setEmployeBiens(sb, ownerId, req.params.id, req.body.biens);
    if (biensError) {
      return res.status(400).json({ success: false, message: biensError.message, errors: biensError.errors });
    }
  }

  gitAutoBackup(`Sauvegarde auto : mise à jour employé ${req.params.id}`);
  res.json({ success: true, data });
});

// ============================================================
// Suppression d'un employé (+ suppression du compte d'accès).
// ============================================================
router.delete('/:id', async (req, res) => {
  const sb = serviceClient();
  const ownerId = ownerIdOf(req);

  const { data: existing } = await sb
    .from('employes')
    .select('id, nom, account_uid')
    .eq('id', req.params.id)
    .eq('user_id', ownerId)
    .maybeSingle();

  if (!existing) {
    return res.status(404).json({ success: false, message: 'Employé introuvable.' });
  }

  const { error } = await sb.from('employes').update({ statut: 'inactif', account_uid: null }).eq('id', req.params.id).eq('user_id', ownerId);

  if (error) {
    console.error('[employes/delete]', error.message);
    return res.status(400).json({ success: false, message: 'Erreur lors de l\'archivage de l\'employé.' });
  }

  if (existing.account_uid) {
    const { error: banError } = await sb.auth.admin.updateUserById(existing.account_uid, { ban_duration: '8760h' });
    if (banError) return res.status(503).json({ success: false, message: 'Employé archivé, mais le compte Auth n\'a pas été désactivé.' });
    await revokeAllSessions(existing.account_uid, null, 'employee_archived').catch(() => {});
  }

  await auditLog({
    userId: req.user.id,
    action: 'employee.delete',
    target: existing.id,
    targetType: 'employee',
    level: LEVELS.WARN,
    meta: { nom: existing.nom },
    ip: req.ip,
  });

  gitAutoBackup(`Sauvegarde auto : suppression employé ${existing.nom}`);
  res.json({ success: true, message: 'Employé supprimé.' });
});

// ============================================================
// Paiements de salaire d'un employé (avec détail de confirmation).
// ============================================================
router.get('/:id/paiements', async (req, res) => {
  const sb = serviceClient();
  const ownerId = ownerIdOf(req);

  const { data: employe } = await sb
    .from('employes')
    .select('id, account_uid')
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
    sb.from('moyens_paiement_employes').select('id, type, nom_titulaire, numero').eq('employe_uid', employe.account_uid),
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
// seul l'employé confirme.
// ============================================================
router.post('/:id/paiements', async (req, res) => {
  const sb = serviceClient();
  const ownerId = ownerIdOf(req);

  const { data: employe } = await sb
    .from('employes')
    .select('id, nom, account_uid')
    .eq('id', req.params.id)
    .eq('user_id', ownerId)
    .maybeSingle();

  if (!employe) {
    return res.status(404).json({ success: false, message: 'Employé introuvable.' });
  }

  const montant = parseMoney(req.body.montant);
  const mois = String(req.body.mois || '').trim();
  const statut = req.body.statut || 'attente';
  const datePaiement = req.body.date_paiement || null;
  const reference = req.body.reference || null;
  const moyenEmployeId = req.body.moyen_employe_id || null;
  const methodePaiement = req.body.methode_paiement || null;

  if (!isValidAmount(montant)) {
    return res.status(400).json({ success: false, message: 'Le montant doit être supérieur à 0.', errors: { montant: 'Le montant doit être supérieur à 0.' } });
  }
  if (!isValidMonth(mois)) {
    return res.status(400).json({ success: false, message: 'Le mois doit être au format AAAA-MM.', errors: { mois: 'Le mois doit être au format AAAA-MM.' } });
  }
  if (statut !== 'attente') {
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
  const ownerId = ownerIdOf(req);

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
  const ownerId = ownerIdOf(req);

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

  const linkError = paymentLinkError(req.body?.lien_paiement);
  if (linkError) return res.status(400).json({ success: false, message: linkError, errors: { lien_paiement: linkError } });
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
