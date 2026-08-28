// ============================================================
// MIM - Routes tâches (propriétaire)
// Gestion des tâches assignées aux employés du propriétaire.
// ============================================================

import { Router } from 'express';
import { serviceClient } from '../app.js';
import { gitAutoBackup } from '../utils/gitBackup.js';
import { notify } from '../utils/notifications.js';

const router = Router();

const STATUSES = ['a_faire', 'en_cours', 'termine'];

function isValidDate(value) {
  return value && !Number.isNaN(new Date(value).getTime());
}

// Vérifie que l'employé ciblé appartient bien au propriétaire connecté.
async function employeBelongsToOwner(sb, ownerId, employeUid) {
  if (!employeUid) return true; // tâche sans affectation possible
  const { data } = await sb
    .from('employes')
    .select('id')
    .eq('account_uid', employeUid)
    .eq('user_id', ownerId)
    .maybeSingle();
  return Boolean(data);
}

router.get('/', async (req, res) => {
  const sb = serviceClient();
  const ownerId = req.user.id;

  try {
    const { data: tasks = [], error } = await sb
      .from('tasks')
      .select('*')
      .eq('user_id', ownerId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[tasks]', error.message);
      return res.status(500).json({ success: false, message: 'Erreur lors du chargement des tâches.' });
    }

    // Nom de l'employé assigné pour l'affichage.
    const uids = [...new Set((tasks || []).map((t) => t.employe_uid).filter(Boolean))];
    let nameByUid = new Map();
    if (uids.length) {
      const { data: employes = [] } = await sb.from('employes').select('id, nom, account_uid').in('account_uid', uids);
      nameByUid = new Map(employes.map((e) => [e.account_uid, e.nom]));
    }

    const data = (tasks || []).map((t) => ({
      ...t,
      employe_nom: t.employe_uid ? nameByUid.get(t.employe_uid) || '—' : null,
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error('[tasks]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des tâches.' });
  }
});

router.post('/', async (req, res) => {
  const sb = serviceClient();
  const ownerId = req.user.id;

  const titre = String(req.body.titre || '').trim();
  const description = String(req.body.description || '').trim() || null;
  const employeUid = req.body.employe_uid || null;
  const statut = req.body.statut || 'a_faire';
  const echeance = req.body.echeance || null;

  if (!titre) {
    return res.status(400).json({ success: false, message: 'Le titre est obligatoire.', errors: { titre: 'Le titre est obligatoire.' } });
  }
  if (titre.length > 200) {
    return res.status(400).json({ success: false, message: 'Le titre est trop long (200 caractères maximum).', errors: { titre: 'Le titre est trop long (200 caractères maximum).' } });
  }
  if (!STATUSES.includes(statut)) {
    return res.status(400).json({ success: false, message: 'Statut invalide.', errors: { statut: 'Statut invalide.' } });
  }
  if (echeance && !isValidDate(echeance)) {
    return res.status(400).json({ success: false, message: 'Échéance invalide.', errors: { echeance: 'Échéance invalide.' } });
  }
  if (employeUid && !(await employeBelongsToOwner(sb, ownerId, employeUid))) {
    return res.status(400).json({ success: false, message: 'Employé introuvable ou ne vous appartient pas.', errors: { employe_uid: 'Employé introuvable ou ne vous appartient pas.' } });
  }

  const { data, error } = await sb
    .from('tasks')
    .insert({ user_id: ownerId, employe_uid: employeUid, titre, description, statut, echeance })
    .select()
    .single();

  if (error) {
    console.error('[tasks/create]', error.message);
    return res.status(400).json({ success: false, message: 'Erreur lors de la création de la tâche.' });
  }

  if (employeUid) {
    await notify(employeUid, 'tache', `Nouvelle tâche assignée : ${titre}.`);
  }

  gitAutoBackup(`Sauvegarde auto : création tâche ${data.id}`);
  res.status(201).json({ success: true, data });
});

router.put('/:id', async (req, res) => {
  const sb = serviceClient();
  const ownerId = req.user.id;

  const { data: existing } = await sb
    .from('tasks')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', ownerId)
    .maybeSingle();

  if (!existing) {
    return res.status(404).json({ success: false, message: 'Tâche introuvable.' });
  }

  const updates = {};

  if (req.body.titre !== undefined) {
    const titre = String(req.body.titre || '').trim();
    if (!titre) {
      return res.status(400).json({ success: false, message: 'Le titre est obligatoire.', errors: { titre: 'Le titre est obligatoire.' } });
    }
    if (titre.length > 200) {
      return res.status(400).json({ success: false, message: 'Le titre est trop long (200 caractères maximum).', errors: { titre: 'Le titre est trop long (200 caractères maximum).' } });
    }
    updates.titre = titre;
  }
  if (req.body.description !== undefined) updates.description = String(req.body.description || '').trim() || null;
  if (req.body.statut !== undefined) {
    if (!STATUSES.includes(req.body.statut)) {
      return res.status(400).json({ success: false, message: 'Statut invalide.', errors: { statut: 'Statut invalide.' } });
    }
    updates.statut = req.body.statut;
  }
  if (req.body.echeance !== undefined) {
    if (req.body.echeance && !isValidDate(req.body.echeance)) {
      return res.status(400).json({ success: false, message: 'Échéance invalide.', errors: { echeance: 'Échéance invalide.' } });
    }
    updates.echeance = req.body.echeance || null;
  }
  if (req.body.employe_uid !== undefined) {
    if (req.body.employe_uid && !(await employeBelongsToOwner(sb, ownerId, req.body.employe_uid))) {
      return res.status(400).json({ success: false, message: 'Employé introuvable ou ne vous appartient pas.', errors: { employe_uid: 'Employé introuvable ou ne vous appartient pas.' } });
    }
    updates.employe_uid = req.body.employe_uid || null;
  }

  const { data, error } = await sb
    .from('tasks')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', ownerId)
    .select()
    .single();

  if (error) {
    console.error('[tasks/update]', error.message);
    return res.status(400).json({ success: false, message: 'Erreur lors de la mise à jour de la tâche.' });
  }

  gitAutoBackup(`Sauvegarde auto : mise à jour tâche ${req.params.id}`);
  res.json({ success: true, data });
});

router.delete('/:id', async (req, res) => {
  const sb = serviceClient();
  const ownerId = req.user.id;

  const { data: existing } = await sb
    .from('tasks')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', ownerId)
    .maybeSingle();

  if (!existing) {
    return res.status(404).json({ success: false, message: 'Tâche introuvable.' });
  }

  const { error } = await sb.from('tasks').delete().eq('id', req.params.id).eq('user_id', ownerId);

  if (error) {
    console.error('[tasks/delete]', error.message);
    return res.status(400).json({ success: false, message: 'Erreur lors de la suppression de la tâche.' });
  }

  gitAutoBackup(`Sauvegarde auto : suppression tâche ${req.params.id}`);
  res.json({ success: true, message: 'Tâche supprimée.' });
});

export default router;
