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
    const { data: paiements = [], error } = await sb
      .from('paiements_employes')
      .select('*')
      .eq('employe_uid', req.user.id)
      .eq('user_id', ownerId)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      data: (paiements || []).map((p) => ({
        id: p.id,
        mois: p.mois,
        montant: Number(p.montant),
        statut: p.statut,
        date_paiement: p.date_paiement || null,
        created_at: p.created_at,
      })),
    });
  } catch (err) {
    console.error('[employe/paiements]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des paiements.' });
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
          return res.status(409).json({ success: false, message: 'Ce nom d\'utilisateur est déjà utilisé.', errors: { username: 'Ce nom d\'utilisateur est déjà utilisé.' } });
        }

        const { error: emailError } = await sb.auth.admin.updateUserById(uid, { email: tenantEmailFor(username) });
        if (emailError) {
          console.error('[employe/profile] username email :', emailError.message);
          return res.status(409).json({ success: false, message: 'Ce nom d\'utilisateur est déjà utilisé.', errors: { username: 'Ce nom d\'utilisateur est déjà utilisé.' } });
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
