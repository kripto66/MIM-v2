// ============================================================
// MIM - Routes espace employé (compte employé)
// L'employé est identifié par la fiche employes.account_uid.
// Toutes ses données (incidents, interventions, logements,
// locataires) sont scopées sur le propriétaire qui l'emploie.
// ============================================================

import { Router } from 'express';
import { supabase, authedClient, serviceClient } from '../app.js';
import { gitAutoBackup } from '../utils/gitBackup.js';
import { passwordRuleError } from '../utils/passwordPolicy.js';
import { tenantEmailFor, usernameIsValid } from '../utils/tenantAccount.js';
import { notify } from '../utils/notifications.js';
import { TYPES_MOYENS_PAIEMENT, sanitizeMoyenBody, TYPE_MOYEN_LABELS } from '../utils/paiementMethodes.js';

const router = Router();

// Charge la fiche employé + le propriétaire qui l'emploie (ou null).
async function employeContext(userId) {
  const sb = serviceClient();

  const { data: employe } = await sb
    .from('employes')
    .select('*')
    .eq('account_uid', userId)
    .maybeSingle();

  if (!employe) return null;

  return { employe, ownerId: employe.user_id };
}

async function requireEmploye(req, res, next) {
  const ctx = await employeContext(req.user.id);
  if (!ctx) {
    return res.status(403).json({ success: false, message: 'Votre compte n\'est pas rattaché à une fiche employé. Contactez votre employeur.' });
  }
  req.employe = ctx;
  next();
}

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ============================================================
// Profil de l'employé connecté.
// ============================================================
router.get('/me', async (req, res) => {
  const sb = serviceClient();

  try {
    const { data: profile } = await sb
      .from('profiles')
      .select('id, account_type, name, email, phone, username')
      .eq('id', req.user.id)
      .maybeSingle();

    const { data: employe } = await sb
      .from('employes')
      .select('*')
      .eq('account_uid', req.user.id)
      .maybeSingle();

    if (!employe) {
      return res.status(403).json({ success: false, message: 'Votre compte n\'est pas rattaché à une fiche employé.' });
    }

    res.json({
      success: true,
      data: {
        id: req.user.id,
        name: profile?.name || employe.nom || '',
        username: profile?.username || employe.username || '',
        email: employe.email || profile?.email || '',
        phone: profile?.phone || employe.phone || '',
        role: 'employe',
        employee_role: employe.poste || 'Employé',
        poste: employe.poste || '',
        salaire: Number(employe.salaire || 0),
        account_type: 'employe',
      },
    });
  } catch (err) {
    console.error('[employe/me]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement du profil.' });
  }
});

// ============================================================
// Tableau de bord.
// ============================================================
router.get('/dashboard', requireEmploye, async (req, res) => {
  const sb = serviceClient();
  const { employe, ownerId } = req.employe;
  const uid = req.user.id;

  try {
    const [{ data: tasks = [] }, { data: incidents = [] }, { data: interventions = [] }, { data: notifications = [] }, { data: paiements = [] }] =
      await Promise.all([
        sb.from('tasks').select('titre, statut, description, echeance, created_at').eq('employe_uid', uid),
        sb.from('incidents').select('titre, statut, created_at').eq('user_id', ownerId),
        sb.from('interventions').select('titre, statut, date_prevue, created_at').eq('user_id', ownerId),
        sb.from('notifications').select('type, message, lu, created_at').eq('user_id', uid),
        sb.from('paiements_employes').select('mois, montant, statut, created_at').eq('employe_uid', uid).eq('user_id', ownerId),
      ]);

    const tasksCount = (tasks || []).filter((t) => t.statut !== 'termine').length;
    const openIncidents = (incidents || []).filter((i) => i.statut !== 'resolu').length;
    const interventionsCount = (interventions || []).length;
    const unread = (notifications || []).filter((n) => !n.lu).length;

    const priorities = (tasks || [])
      .filter((t) => t.statut !== 'termine')
      .sort((a, b) => String(a.echeance || '9999').localeCompare(String(b.echeance || '9999')))
      .slice(0, 3)
      .map((t) => ({
        title: t.titre,
        status: t.statut,
        description: t.description || '',
        due_date: t.echeance || t.created_at,
      }));

    const activity = [
      ...(paiements || []).map((p) => ({
        action: `Salaire ${p.mois} ${p.statut === 'paye' ? 'payé' : 'en attente'} (${Number(p.montant).toLocaleString('fr-FR')} FCFA)`,
        created_at: p.date_paiement || p.created_at,
      })),
      ...(notifications || []).map((n) => ({
        action: n.message,
        created_at: n.created_at,
      })),
    ]
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .slice(0, 6);

    res.json({
      success: true,
      data: {
        tasks_count: tasksCount,
        open_incidents_count: openIncidents,
        interventions_count: interventionsCount,
        unread_notifications_count: unread,
        priorities,
        recent_activity: activity,
      },
    });
  } catch (err) {
    console.error('[employe/dashboard]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement du tableau de bord.' });
  }
});

// ============================================================
// Tâches assignées à l'employé.
// ============================================================
router.get('/tasks', async (req, res) => {
  const sb = serviceClient();

  try {
    const { data: tasks = [], error } = await sb
      .from('tasks')
      .select('id, titre, description, statut, echeance, created_at')
      .eq('employe_uid', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ success: true, data: tasks });
  } catch (err) {
    console.error('[employe/tasks]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des tâches.' });
  }
});

// ============================================================
// Incidents du propriétaire employeur.
// ============================================================
router.get('/incidents', requireEmploye, async (req, res) => {
  const sb = serviceClient();
  const { ownerId } = req.employe;

  try {
    const [{ data: incidents = [], error: e1 }, { data: logements = [] }] = await Promise.all([
      sb.from('incidents').select('*').eq('user_id', ownerId).order('created_at', { ascending: false }),
      sb.from('logements').select('id, nom').eq('user_id', ownerId),
    ]);

    if (e1) throw e1;

    const nomByLogement = new Map(logements.map((l) => [l.id, l.nom]));

    res.json({
      success: true,
      data: (incidents || []).map((i) => ({
        id: i.id,
        titre: i.titre,
        description: i.description || '',
        status: i.statut,
        logement: nomByLogement.get(i.logement_id) || '—',
        created_at: i.created_at,
      })),
    });
  } catch (err) {
    console.error('[employe/incidents]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des incidents.' });
  }
});

// ============================================================
// Interventions du propriétaire employeur.
// ============================================================
router.get('/interventions', requireEmploye, async (req, res) => {
  const sb = serviceClient();
  const { ownerId } = req.employe;

  try {
    const { data: interventions = [], error } = await sb
      .from('interventions')
      .select('*')
      .eq('user_id', ownerId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      data: (interventions || []).map((x) => ({
        id: x.id,
        titre: x.titre,
        description: x.description || '',
        status: x.statut,
        scheduled_at: x.date_prevue || x.created_at,
        created_at: x.created_at,
      })),
    });
  } catch (err) {
    console.error('[employe/interventions]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des interventions.' });
  }
});

// ============================================================
// Logements du propriétaire employeur.
// ============================================================
router.get('/logements', requireEmploye, async (req, res) => {
  const sb = serviceClient();
  const { ownerId } = req.employe;

  try {
    const [{ data: logements = [], error: e1 }, { data: locataires = [] }] = await Promise.all([
      sb.from('logements').select('*').eq('user_id', ownerId).order('created_at', { ascending: false }),
      sb.from('locataires').select('logement_id, nom').eq('user_id', ownerId).eq('statut', 'actif'),
    ]);

    if (e1) throw e1;

    const nomByLogement = new Map(locataires.map((l) => [l.logement_id, l.nom]));

    res.json({
      success: true,
      data: (logements || []).map((l) => ({
        id: l.id,
        name: l.nom,
        type: l.type || '—',
        tenant_name: nomByLogement.get(l.id) || 'Libre',
        rent: Number(l.loyer_mensuel || 0),
        statut: l.statut,
      })),
    });
  } catch (err) {
    console.error('[employe/logements]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des logements.' });
  }
});

// ============================================================
// Locataires du propriétaire employeur.
// ============================================================
router.get('/locataires', requireEmploye, async (req, res) => {
  const sb = serviceClient();
  const { ownerId } = req.employe;

  try {
    const [{ data: locataires = [], error: e1 }, { data: logements = [] }] = await Promise.all([
      sb.from('locataires').select('*').eq('user_id', ownerId).order('created_at', { ascending: false }),
      sb.from('logements').select('id, nom').eq('user_id', ownerId),
    ]);

    if (e1) throw e1;

    const nomByLogement = new Map(logements.map((l) => [l.id, l.nom]));

    res.json({
      success: true,
      data: (locataires || []).map((l) => ({
        id: l.id,
        name: l.nom,
        full_name: l.nom,
        username: l.username || '—',
        logement_name: nomByLogement.get(l.logement_id) || '—',
        status: l.statut,
      })),
    });
  } catch (err) {
    console.error('[employe/locataires]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des locataires.' });
  }
});

// ============================================================
// Notifications de l'employé.
// ============================================================
router.get('/notifications', async (req, res) => {
  const sb = serviceClient();

  try {
    const { data: notifications = [], error } = await sb
      .from('notifications')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      data: (notifications || []).map((n) => ({
        id: n.id,
        title: n.type || 'Notification',
        message: n.message || '',
        read: Boolean(n.lu),
        is_read: Boolean(n.lu),
        created_at: n.created_at,
      })),
    });
  } catch (err) {
    console.error('[employe/notifications]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des notifications.' });
  }
});

router.post('/notifications/read-all', async (req, res) => {
  const sb = serviceClient();

  try {
    const { error } = await sb
      .from('notifications')
      .update({ lu: true })
      .eq('user_id', req.user.id)
      .eq('lu', false);

    if (error) throw error;

    res.json({ success: true, message: 'Notifications marquées comme lues.' });
  } catch (err) {
    console.error('[employe/notifications/read-all]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de la mise à jour des notifications.' });
  }
});

// ============================================================
// Paiements de salaire de l'employé.
// ============================================================
router.get('/paiements', requireEmploye, async (req, res) => {
  const sb = serviceClient();
  const { ownerId } = req.employe;

  try {
    const [{ data: paiements = [], error }, { data: moyens = [] }] = await Promise.all([
      sb.from('paiements_employes')
        .select('*')
        .eq('employe_uid', req.user.id)
        .eq('user_id', ownerId)
        .order('created_at', { ascending: false }),
      sb.from('moyens_paiement_employes').select('id, type').eq('employe_uid', req.user.id),
    ]);

    if (error) throw error;

    const typeById = new Map((moyens || []).map((m) => [String(m.id), m.type]));

    res.json({
      success: true,
      data: (paiements || []).map((p) => ({
        id: p.id,
        mois: p.mois,
        montant: Number(p.montant),
        statut: p.statut,
        date_paiement: p.date_paiement || null,
        created_at: p.created_at,
        reference: p.reference || null,
        methode_paiement: p.methode_paiement || null,
        moyen_label: p.moyen_employe_id ? TYPE_MOYEN_LABELS[typeById.get(String(p.moyen_employe_id))] || null : null,
        confirmed_at: p.confirmed_at || null,
        rejected_at: p.rejected_at || null,
        rejection_reason: p.rejection_reason || null,
      })),
    });
  } catch (err) {
    console.error('[employe/paiements]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des paiements.' });
  }
});

// ============================================================
// Confirmation de réception d'un salaire par l'employé.
//
// Le propriétaire a DÉCLARÉ avoir versé (statut « attente »).
// Seul l'employé confirme la réception : statut « paye » +
// confirmed_at + confirmed_by, notification au propriétaire.
// Mise à jour conditionnelle (statut attendu) : anti-double-clic.
// ============================================================
router.post('/paiements/:id/confirmer', requireEmploye, async (req, res) => {
  const sb = serviceClient();
  const { employe, ownerId } = req.employe;
  const uid = req.user.id;

  try {
    const { data: paiement } = await sb
      .from('paiements_employes')
      .select('id, user_id, employe_uid, montant, mois, statut')
      .eq('id', req.params.id)
      .eq('employe_uid', uid)
      .eq('user_id', ownerId)
      .maybeSingle();

    if (!paiement) {
      return res.status(404).json({ success: false, message: 'Paiement introuvable.' });
    }
    if (paiement.statut !== 'attente') {
      const message =
        paiement.statut === 'paye'
          ? 'Ce paiement est déjà confirmé.'
          : paiement.statut === 'non_recu'
            ? 'Vous avez signalé ne pas avoir reçu ce paiement.'
            : 'Ce paiement ne peut pas être confirmé.';
      return res.status(400).json({ success: false, message });
    }

    const { data: updated, error } = await sb
      .from('paiements_employes')
      .update({
        statut: 'paye',
        confirmed_at: new Date().toISOString(),
        confirmed_by: uid,
      })
      .eq('id', paiement.id)
      .eq('statut', 'attente')
      .select()
      .maybeSingle();

    if (error) {
      console.error('[employe/confirmer]', error.message);
      return res.status(500).json({ success: false, message: 'Impossible de confirmer le paiement.' });
    }
    if (!updated) {
      return res.status(409).json({ success: false, message: 'Ce paiement a déjà été traité.' });
    }

    await notify(
      ownerId,
      'salaire',
      `Paiement confirmé — ${employe.nom || 'Votre employé'} a confirmé avoir reçu son salaire de ` +
        `${Number(paiement.montant).toLocaleString('fr-FR')} FCFA (${paiement.mois}).`
    );
    gitAutoBackup(`Sauvegarde auto : confirmation de salaire par l'employé ${uid}`);

    res.json({ success: true, data: updated, message: 'Paiement confirmé. Votre employeur en a été informé.' });
  } catch (err) {
    console.error('[employe/confirmer]', err.message);
    res.status(500).json({ success: false, message: 'Une erreur est survenue.' });
  }
});

// ============================================================
// « Je n'ai pas reçu le paiement » (refus par l'employé).
//
// Le paiement passe à « non_recu » (l'historique est conservé) et
// le propriétaire est notifié. Motifs fixés + précision libre.
// ============================================================
const REJECTION_MOTIFS_SALAIRE = ['Paiement non reçu', 'Montant incorrect', 'Autre'];

router.post('/paiements/:id/non-recus', requireEmploye, async (req, res) => {
  const sb = serviceClient();
  const { employe, ownerId } = req.employe;
  const uid = req.user.id;

  try {
    const motif = String((req.body || {}).motif || '').trim();
    if (!motif || motif.length > 200) {
      return res.status(400).json({ success: false, message: 'Indiquez le motif (200 caractères max).' });
    }

    const { data: paiement } = await sb
      .from('paiements_employes')
      .select('id, user_id, employe_uid, montant, mois, statut')
      .eq('id', req.params.id)
      .eq('employe_uid', uid)
      .eq('user_id', ownerId)
      .maybeSingle();

    if (!paiement) {
      return res.status(404).json({ success: false, message: 'Paiement introuvable.' });
    }
    if (paiement.statut !== 'attente') {
      const message =
        paiement.statut === 'paye'
          ? 'Ce paiement est déjà confirmé.'
          : paiement.statut === 'non_recu'
            ? 'Vous avez déjà signalé ne pas avoir reçu ce paiement.'
            : 'Ce paiement ne peut pas être refusé.';
      return res.status(400).json({ success: false, message });
    }

    const { data: updated, error } = await sb
      .from('paiements_employes')
      .update({
        statut: 'non_recu',
        rejected_at: new Date().toISOString(),
        rejection_reason: motif,
      })
      .eq('id', paiement.id)
      .eq('statut', 'attente')
      .select()
      .maybeSingle();

    if (error) {
      console.error('[employe/non-recus]', error.message);
      return res.status(500).json({ success: false, message: 'Impossible d\'enregistrer le signalement.' });
    }
    if (!updated) {
      return res.status(409).json({ success: false, message: 'Ce paiement a déjà été traité.' });
    }

    await notify(
      ownerId,
      'salaire',
      `Paiement non reçu — ${employe.nom || 'Votre employé'} indique ne pas avoir reçu son salaire de ` +
        `${Number(paiement.montant).toLocaleString('fr-FR')} FCFA (${paiement.mois}). Motif : ${motif}.`
    );
    gitAutoBackup(`Sauvegarde auto : salaire non reçu signalé par l'employé ${uid}`);

    res.json({ success: true, data: updated, message: 'Signalement enregistré : votre employeur en a été informé.' });
  } catch (err) {
    console.error('[employe/non-recus]', err.message);
    res.status(500).json({ success: false, message: 'Une erreur est survenue.' });
  }
});

// ============================================================
// Moyens de paiement de l'employé (gérés par lui-même).
// ============================================================

// Liste des moyens de l'employé connecté.
router.get('/moyens-paiement', requireEmploye, async (req, res) => {
  const sb = serviceClient();

  try {
    const { data: moyens = [], error } = await sb
      .from('moyens_paiement_employes')
      .select('*')
      .eq('employe_uid', req.user.id)
      .order('type', { ascending: true })
      .order('id', { ascending: true });

    if (error) throw error;
    res.json({ success: true, data: moyens });
  } catch (err) {
    console.error('[employe/moyens-paiement]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement.' });
  }
});

// Création d'un moyen de paiement.
router.post('/moyens-paiement', requireEmploye, async (req, res) => {
  const sb = serviceClient();

  try {
    const type = String((req.body || {}).type || '');
    if (!TYPES_MOYENS_PAIEMENT.includes(type)) {
      return res.status(400).json({ success: false, message: 'Type de moyen de paiement invalide.' });
    }

    const clean = sanitizeMoyenBody(type, req.body);
    const { data, error } = await sb
      .from('moyens_paiement_employes')
      .insert({ employe_uid: req.user.id, type, ...clean })
      .select()
      .single();

    if (error) {
      console.error('[employe/moyens-paiement] insert :', error.message);
      return res.status(400).json({ success: false, message: 'Erreur lors de l\'enregistrement.' });
    }
    gitAutoBackup(`Sauvegarde auto : moyen de paiement employé ${req.user.id}`);
    res.status(201).json({ success: true, data, message: 'Moyen de paiement enregistré.' });
  } catch (err) {
    console.error('[employe/moyens-paiement]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de l\'enregistrement.' });
  }
});

// Mise à jour d'un moyen (filtré par l'employé connecté).
router.put('/moyens-paiement/:id', requireEmploye, async (req, res) => {
  const sb = serviceClient();

  try {
    const { data: existing } = await sb
      .from('moyens_paiement_employes')
      .select('id, type')
      .eq('id', req.params.id)
      .eq('employe_uid', req.user.id)
      .maybeSingle();

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Moyen de paiement introuvable.' });
    }

    const clean = sanitizeMoyenBody(existing.type, req.body);
    const { data, error } = await sb
      .from('moyens_paiement_employes')
      .update(clean)
      .eq('id', existing.id)
      .eq('employe_uid', req.user.id)
      .select()
      .single();

    if (error) {
      console.error('[employe/moyens-paiement] update :', error.message);
      return res.status(400).json({ success: false, message: 'Erreur lors de la mise à jour.' });
    }
    res.json({ success: true, data, message: 'Moyen de paiement mis à jour.' });
  } catch (err) {
    console.error('[employe/moyens-paiement]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de la mise à jour.' });
  }
});

// Suppression d'un moyen (filtré par l'employé connecté).
router.delete('/moyens-paiement/:id', requireEmploye, async (req, res) => {
  const sb = serviceClient();

  try {
    const { data, error } = await sb
      .from('moyens_paiement_employes')
      .delete()
      .eq('id', req.params.id)
      .eq('employe_uid', req.user.id)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ success: false, message: 'Moyen de paiement introuvable.' });
    }
    res.json({ success: true, data, message: 'Moyen de paiement supprimé.' });
  } catch (err) {
    console.error('[employe/moyens-paiement]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de la suppression.' });
  }
});

// ============================================================
// Mise à jour du profil (nom, username, email d'affichage).
// ============================================================
router.put('/profile', async (req, res) => {
  const sb = serviceClient();
  const uid = req.user.id;

  try {
    const { data: employe } = await sb
      .from('employes')
      .select('*')
      .eq('account_uid', uid)
      .maybeSingle();

    if (!employe) {
      return res.status(403).json({ success: false, message: 'Votre compte n\'est pas rattaché à une fiche employé.' });
    }

    const name = req.body.name !== undefined ? String(req.body.name || '').trim() : null;
    if (name !== null && !name) {
      return res.status(400).json({ success: false, message: 'Le nom est obligatoire.', errors: { name: 'Le nom est obligatoire.' } });
    }

    const email = req.body.email !== undefined ? String(req.body.email || '').trim() || null : null;

    const updates = {};
    if (name !== null) {
      updates.name = name;
      await sb.from('profiles').update({ name }).eq('id', uid);
      await sb.from('employes').update({ nom: name }).eq('account_uid', uid);
    }

    if (email !== null) {
      await sb.from('employes').update({ email }).eq('account_uid', uid);
    }

    if (req.body.username !== undefined) {
      const username = String(req.body.username || '').trim().toLowerCase();

      if (username !== (employe.username || '').toLowerCase()) {
        if (!usernameIsValid(username)) {
          return res.status(400).json({
            success: false,
            message: 'Le username doit contenir entre 3 et 32 caractères (lettres minuscules, chiffres, . _ -).',
            errors: { username: 'Le username doit contenir entre 3 et 32 caractères (lettres minuscules, chiffres, . _ -).' },
          });
        }

        const { data: taken } = await sb
          .from('profiles')
          .select('id')
          .ilike('username', username)
          .neq('id', uid)
          .maybeSingle();

        if (taken) {
          return res.status(409).json({ success: false, code: 'USERNAME_ALREADY_EXISTS', message: 'Ce nom d\'utilisateur est déjà utilisé.', errors: { username: 'Ce nom d\'utilisateur est déjà utilisé.' } });
        }

        const { error: emailError } = await sb.auth.admin.updateUserById(uid, { email: tenantEmailFor(username) });
        if (emailError) {
          console.error('[employe/profile] username email :', emailError.message);
          return res.status(409).json({ success: false, code: 'USERNAME_ALREADY_EXISTS', message: 'Ce nom d\'utilisateur est déjà utilisé.', errors: { username: 'Ce nom d\'utilisateur est déjà utilisé.' } });
        }

        await sb.from('profiles').update({ username }).eq('id', uid);
        await sb.from('employes').update({ username }).eq('account_uid', uid);
      }
    }

    gitAutoBackup(`Sauvegarde auto : mise à jour profil employé ${uid}`);
    res.json({ success: true, message: 'Profil mis à jour avec succès.' });
  } catch (err) {
    console.error('[employe/profile]', err.message);
    res.status(500).json({ success: false, message: 'Une erreur est survenue.' });
  }
});

// ============================================================
// Changement de mot de passe.
// ============================================================
router.put('/password', async (req, res) => {
  const { current_password, new_password } = req.body;

  const pwError = passwordRuleError(new_password);
  if (pwError) {
    return res.status(400).json({ success: false, message: pwError, errors: { password: pwError } });
  }

  try {
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

    await sb.auth.setSession({
      access_token: req.user.supabase_token,
      refresh_token: req.user.refresh_token || '',
    });

    const { data: account, error: userError } = await sb.auth.getUser();
    if (userError || !account?.user?.email) {
      return res.status(401).json({ success: false, message: 'Session expirée, reconnectez-vous.' });
    }

    if (!isForcedChange) {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: account.user.email,
        password: current_password,
      });
      if (signInError) {
        return res.status(400).json({ success: false, message: 'Mot de passe actuel incorrect.' });
      }
    }

    const { error } = await sb.auth.updateUser({ password: new_password });
    if (error) {
      console.error('[employe/password]', error.message);
      return res.status(400).json({ success: false, message: 'Impossible de modifier le mot de passe.' });
    }

    await serviceClient()
      .from('profiles')
      .update({ must_change_password: false })
      .eq('id', req.user.id);

    gitAutoBackup(`Sauvegarde auto : changement de mot de passe employé ${req.user.id}`);
    res.json({ success: true, message: 'Mot de passe modifié avec succès.' });
  } catch (err) {
    console.error('[employe/password]', err.message);
    res.status(500).json({ success: false, message: 'Une erreur est survenue.' });
  }
});

export default router;
