// ============================================================
// MIM - Routes d'administration (rôle 'admin')
// Données agrégées de toute la plateforme via le service role.
// ============================================================

import { Router } from 'express';
import { serviceClient } from '../app.js';
import { notify } from '../utils/notifications.js';
import { invalidateSubscriptionCache } from '../utils/subscription.js';
import { isBannedValue } from '../middleware/auth.js';

const router = Router();

const OWNER_TYPES = ['proprietaire', 'agence', 'entreprise'];
const ROW_LIMIT = 10000;

// Cache mémoire court : les agrégations admin sont en lecture seule et coûteuses,
// un TTL de 8 s suffit pour un tableau de bord, sans jamais bloquer l'écriture
// (le cache est invalidé dès qu'une action de mutation passe par ces routes).
const CACHE_TTL_MS = 8000;
let platformCache = { at: 0, data: null };

function platformCacheGet() {
  if (platformCache.data && Date.now() - platformCache.at < CACHE_TTL_MS) return platformCache.data;
  return null;
}

function platformCacheSet(data) {
  platformCache = { at: Date.now(), data };
}

export function invalidatePlatformCache() {
  platformCache = { at: 0, data: null };
}

// Charge l'ensemble des données utiles en parallèle (agrégation en mémoire).
async function loadPlatformData() {
  const cached = platformCacheGet();
  if (cached) return cached;

  const data = await loadPlatformDataUncached();
  platformCacheSet(data);
  return data;
}

async function loadPlatformDataUncached() {
  const sb = serviceClient();

  const fetchAll = async (table, columns) => {
    const { data, error } = await sb.from(table).select(columns).limit(ROW_LIMIT);
    if (error) throw new Error(`${table}: ${error.message}`);
    return data || [];
  };

  const listAllUsers = async () => {
    const users = [];
    let page = 1;
    let hasMore = true;
    while (hasMore && page <= 10) {
      const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw new Error(`listUsers: ${error.message}`);
      users.push(...(data?.users || []));
      hasMore = (data?.users || []).length === 1000;
      page++;
    }
    return users;
  };

  const [
    profiles,
    users,
    biens,
    logements,
    locataires,
    paiements,
    incidents,
    interventions,
    sessions,
    subscriptions,
  ] = await Promise.all([
    fetchAll('profiles', 'id, account_type, name, email, phone, username, created_at'),
    listAllUsers(),
    fetchAll('biens', 'id, user_id, nom, type, ville'),
    fetchAll('logements', 'id, user_id, bien_id, nom, statut, loyer_mensuel'),
    fetchAll('locataires', 'id, user_id, account_uid, logement_id, nom, email, statut'),
    fetchAll('paiements', 'id, user_id, locataire_id, logement_id, montant, mois, statut, date_paiement, created_at'),
    fetchAll('incidents', 'id, user_id, logement_id, titre, statut, created_at'),
    fetchAll('interventions', 'id, user_id, logement_id, statut, created_at'),
    fetchAll('sessions', 'id, user_id, action, created_at, logout_at, user_agent'),
    fetchAll('subscriptions', 'id, user_id, plan, statut, date_debut, date_expiration, date_paiement, montant, methode_paiement, reference'),
  ]);

  const userById = new Map(users.map((u) => [u.id, u]));
  const profileById = new Map(profiles.map((p) => [p.id, p]));
  const subByUserId = new Map(subscriptions.map((s) => [s.user_id, s]));

  const ownerName = (userId) => profileById.get(userId)?.name || '—';

  return {
    profiles,
    users,
    userById,
    profileById,
    ownerName,
    biens,
    logements,
    locataires,
    paiements,
    incidents,
    interventions,
    sessions,
    subscriptions,
    subByUserId,
  };
}

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return `${formatDate(value)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const ACTION_LABELS = {
  login: 'Connexion',
  logout: 'Déconnexion',
  register: 'Inscription',
};

// Statut d'abonnement calculé côté serveur (jamais confiance au frontend).
function subscriptionView(sub) {
  if (!sub) return null;
  const now = Date.now();
  const exp = new Date(sub.date_expiration).getTime();
  const expired = !Number.isNaN(exp) && exp <= now;
  return {
    plan: sub.plan || 'standard',
    statut: expired ? 'expire' : 'actif',
    date_debut: sub.date_debut || null,
    date_expiration: sub.date_expiration || null,
    date_paiement: sub.date_paiement || null,
    montant: sub.montant == null ? null : Number(sub.montant),
    methode_paiement: sub.methode_paiement || null,
    reference: sub.reference || null,
    joursRestants: expired ? 0 : Math.max(0, Math.ceil((exp - now) / 86400000)),
  };
}

// Nouvelle échéance : on prolonge à partir de l'échéance courante si elle
// est encore dans le futur (renouvellement), sinon à partir de maintenant.
function addMonths(d, months) {
  const r = new Date(d);
  const day = r.getDate();
  r.setDate(1);
  r.setMonth(r.getMonth() + months);
  const lastDay = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
  r.setDate(Math.min(day, lastDay));
  return r;
}

function formatDateFR(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('fr-FR');
}

router.get('/stats', async (req, res) => {
  try {
    const d = await loadPlatformData();
    const month = currentMonth();

    const proprietaires = d.profiles.filter((p) => OWNER_TYPES.includes(p.account_type));
    const monthPayments = d.paiements.filter((p) => p.mois === month);

    const expectedRent = d.logements
      .filter((l) => l.statut === 'occupe')
      .reduce((s, l) => s + Number(l.loyer_mensuel || 0), 0);
    const paidRent = monthPayments.filter((p) => p.statut === 'paye').reduce((s, p) => s + Number(p.montant), 0);
    const lateRent = monthPayments.filter((p) => p.statut === 'retard').reduce((s, p) => s + Number(p.montant), 0);

    // Revenus (paiements payés) des 12 derniers mois, mois courant en dernier.
    const months = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const m = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1));
      months.push(`${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`);
    }
    const revenue12 = months.map((m) => ({
      mois: m,
      total: d.paiements
        .filter((p) => p.mois === m && p.statut === 'paye')
        .reduce((s, p) => s + Number(p.montant), 0),
    }));

    const recentSessions = [...d.sessions]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 5)
      .map((s) => ({
        title: ACTION_LABELS[s.action] || s.action,
        detail: d.ownerName(s.user_id) || '—',
        time: s.created_at,
      }));

    const logementById = new Map(d.logements.map((l) => [l.id, l]));
    const locataireById = new Map(d.locataires.map((l) => [l.id, l]));

    const recentPayments = [...d.paiements]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 5)
      .map((p) => ({
        id: p.id,
        locataire: locataireById.get(p.locataire_id)?.nom || '—',
        logement: logementById.get(p.logement_id)?.nom || '—',
        proprietaire: d.ownerName(p.user_id),
        periode: p.mois,
        montant: Number(p.montant),
        statut: p.statut,
        date: p.date_paiement,
      }));

    const recentIncidents = [...d.incidents]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 4)
      .map((i) => {
        const logement = logementById.get(i.logement_id);
        const locataire = d.locataires.find((l) => l.logement_id === i.logement_id && l.statut === 'actif');
        return {
          id: i.id,
          titre: i.titre,
          logement: logement?.nom || '—',
          locataire: locataire?.nom || '—',
          proprietaire: d.ownerName(i.user_id),
          statut: i.statut,
          date: i.created_at,
        };
      });

    res.json({
      success: true,
      stats: {
        proprietaires: proprietaires.length,
        locataires: d.locataires.length,
        biens: d.biens.length,
        logements: d.logements.length,
        logementsOccupes: d.logements.filter((l) => l.statut === 'occupe').length,
        logementsLibres: d.logements.filter((l) => l.statut === 'libre').length,
        paiements: d.paiements.length,
        expectedRent,
        paidRent,
        lateRent,
        revenusMois: paidRent,
        paiementsEnAttente: monthPayments.filter((p) => p.statut === 'attente').length,
        paiementsEnRetard: monthPayments.filter((p) => p.statut === 'retard').length,
        incidentsActifs: d.incidents.filter((i) => i.statut !== 'resolu').length,
        interventionsActives: d.interventions.filter((i) => i.statut !== 'termine').length,
        revenue12,
        activiteRecent: recentSessions,
        recentPayments,
        recentIncidents,
      },
    });
  } catch (err) {
    console.error('[admin/stats]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des statistiques.' });
  }
});

router.get('/subscriptions', async (req, res) => {
  try {
    const d = await loadPlatformData();

    const data = d.subscriptions
      .map((s) => ({
        id: s.id,
        user_id: s.user_id,
        proprietaire: d.ownerName(s.user_id),
        ...subscriptionView(s),
      }))
      .sort((a, b) => String(b.date_expiration || '').localeCompare(String(a.date_expiration || '')));

    res.json({ success: true, data });
  } catch (err) {
    console.error('[admin/subscriptions]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des abonnements.' });
  }
});

// Enregistrement / validation d'un paiement d'abonnement par l'admin.
// La nouvelle échéance est TOUJOURS calculée côté serveur.
router.post('/subscriptions/register', async (req, res) => {
  const { userId, plan, montant, dureeMois, methodePaiement, reference } = req.body || {};

  if (!userId || typeof userId !== 'string') {
    return res.status(400).json({ success: false, message: 'Propriétaire requis.' });
  }
  if (!(Number(montant) > 0)) {
    return res.status(400).json({ success: false, message: 'Le montant doit être supérieur à 0.' });
  }
  const duree = Number(dureeMois);
  if (!Number.isInteger(duree) || duree < 1 || duree > 36) {
    return res.status(400).json({ success: false, message: 'La durée doit être un nombre de mois entre 1 et 36.' });
  }

  const sb = serviceClient();

  try {
    const { data: profile } = await sb
      .from('profiles')
      .select('id, name, account_type')
      .eq('id', userId)
      .maybeSingle();

    if (!profile || !OWNER_TYPES.includes(profile.account_type)) {
      return res.status(404).json({ success: false, message: 'Propriétaire introuvable.' });
    }

    const now = new Date();
    const existing = await sb.from('subscriptions').select('*').eq('user_id', userId).maybeSingle();

    // Renouvellement : prolonge à partir de l'échéance en cours si elle est
    // encore future, sinon à partir de maintenant (réactivation).
    const base = existing?.data && new Date(existing.data.date_expiration) > now
      ? new Date(existing.data.date_expiration)
      : now;
    const newExpiration = addMonths(base, duree);

    const payload = {
      user_id: userId,
      plan: String(plan || 'standard').trim() || 'standard',
      statut: 'actif',
      date_debut: existing?.data?.date_debut || now.toISOString(),
      date_expiration: newExpiration.toISOString(),
      date_paiement: now.toISOString(),
      montant: Number(montant),
      methode_paiement: methodePaiement ? String(methodePaiement).trim() : null,
      reference: reference ? String(reference).trim() : null,
      updated_at: now.toISOString(),
    };

    if (existing?.data) {
      const { error } = await sb.from('subscriptions').update(payload).eq('user_id', userId);
      if (error) throw error;
    } else {
      const { error } = await sb.from('subscriptions').insert(payload);
      if (error) throw error;
    }

    const { error: histError } = await sb.from('abonnement_paiements').insert({
      user_id: userId,
      plan: payload.plan,
      montant: payload.montant,
      date_paiement: now.toISOString(),
      methode_paiement: payload.methode_paiement,
      reference: payload.reference,
      date_debut: payload.date_debut,
      date_expiration: newExpiration.toISOString(),
    });
    if (histError) throw histError;

    invalidateSubscriptionCache();
    invalidatePlatformCache();

    await notify(userId, 'abonnement', `Votre abonnement MIM a été enregistré/renouvelé jusqu'au ${formatDateFR(newExpiration)}.`);

    res.json({
      success: true,
      message: `Abonnement enregistré. Nouvelle échéance : ${formatDateFR(newExpiration)}.`,
      subscription: subscriptionView({ ...payload, date_debut: payload.date_debut }),
    });
  } catch (err) {
    console.error('[admin/subscriptions/register]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de l\'enregistrement de l\'abonnement.' });
  }
});

router.get('/proprietaires', async (req, res) => {
  try {
    const d = await loadPlatformData();
    const proprietaires = d.profiles
      .filter((p) => OWNER_TYPES.includes(p.account_type))
      .map((p) => {
        const authUser = d.userById.get(p.id);
        return {
          id: p.id,
          nom: p.name,
          email: p.email,
          account_type: p.account_type,
          biens: d.biens.filter((b) => b.user_id === p.id).length,
          logements: d.logements.filter((l) => l.user_id === p.id).length,
          locataires: d.locataires.filter((l) => l.user_id === p.id).length,
          paiements: d.paiements.filter((x) => x.user_id === p.id).length,
          statut: isBannedValue(authUser?.banned_until) ? 'suspendu' : 'actif',
          subscription: subscriptionView(d.subByUserId.get(p.id)),
          created_at: p.created_at,
          last_login: authUser?.last_sign_in_at || null,
        };
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({ success: true, data: proprietaires });
  } catch (err) {
    console.error('[admin/proprietaires]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des propriétaires.' });
  }
});

router.get('/locataires', async (req, res) => {
  try {
    const d = await loadPlatformData();
    const logementById = new Map(d.logements.map((l) => [l.id, l]));

    const data = d.locataires
      .map((l) => ({
        id: l.id,
        nom: l.nom,
        email: l.email || '—',
        proprietaire: d.ownerName(l.user_id),
        logement: logementById.get(l.logement_id)?.nom || '—',
        statut: l.statut,
      }))
      .sort((a, b) => b.id - a.id);

    res.json({ success: true, data });
  } catch (err) {
    console.error('[admin/locataires]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des locataires.' });
  }
});

router.get('/biens', async (req, res) => {
  try {
    const d = await loadPlatformData();

    const data = d.biens
      .map((b) => {
        const logs = d.logements.filter((l) => l.bien_id === b.id);
        return {
          id: b.id,
          nom: b.nom,
          type: b.type,
          ville: b.ville || '—',
          logements: logs.length,
          occupes: logs.filter((l) => l.statut === 'occupe').length,
          proprietaire: d.ownerName(b.user_id),
        };
      })
      .sort((a, b) => b.id - a.id);

    res.json({ success: true, data });
  } catch (err) {
    console.error('[admin/biens]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des biens.' });
  }
});

router.get('/paiements', async (req, res) => {
  try {
    const d = await loadPlatformData();
    const locataireById = new Map(d.locataires.map((l) => [l.id, l]));
    const logementById = new Map(d.logements.map((l) => [l.id, l]));

    const data = [...d.paiements]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 500)
      .map((p) => ({
        id: p.id,
        locataire: locataireById.get(p.locataire_id)?.nom || '—',
        logement: logementById.get(p.logement_id)?.nom || '—',
        proprietaire: d.ownerName(p.user_id),
        periode: p.mois,
        montant: Number(p.montant),
        statut: p.statut,
        date: p.date_paiement,
      }));

    res.json({ success: true, data });
  } catch (err) {
    console.error('[admin/paiements]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des paiements.' });
  }
});

router.get('/incidents', async (req, res) => {
  try {
    const d = await loadPlatformData();
    const logementById = new Map(d.logements.map((l) => [l.id, l]));

    const data = [...d.incidents]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .map((i) => {
        const logement = logementById.get(i.logement_id);
        const locataire = d.locataires.find((l) => l.logement_id === i.logement_id && l.statut === 'actif');
        return {
          id: i.id,
          titre: i.titre,
          logement: logement?.nom || '—',
          locataire: locataire?.nom || '—',
          proprietaire: d.ownerName(i.user_id),
          statut: i.statut,
          date: i.created_at,
        };
      });

    res.json({ success: true, data });
  } catch (err) {
    console.error('[admin/incidents]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des incidents.' });
  }
});

router.get('/activite', async (req, res) => {
  try {
    const d = await loadPlatformData();

    const data = [...d.sessions]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 100)
      .map((s) => ({
        id: s.id,
        user: d.ownerName(s.user_id),
        action: ACTION_LABELS[s.action] || s.action,
        detail: s.user_agent || '—',
        date: formatDateTime(s.created_at),
      }));

    res.json({ success: true, data });
  } catch (err) {
    console.error('[admin/activite]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement de l\'activité.' });
  }
});

// Suspension / réactivation d'un compte propriétaire (ban GoTrue).
router.patch('/proprietaires/:id', async (req, res) => {
  const { id } = req.params;
  const { statut } = req.body || {};

  if (!['actif', 'suspendu'].includes(statut)) {
    return res.status(400).json({ success: false, message: 'Statut invalide. Attendu : actif ou suspendu.' });
  }

  const sb = serviceClient();
  const { data: profile } = await sb.from('profiles').select('id, name, email').eq('id', id).maybeSingle();

  if (!profile) {
    return res.status(404).json({ success: false, message: 'Propriétaire introuvable.' });
  }

  try {
    const ban_duration = statut === 'suspendu' ? '8760h' : 'none';
    const { error } = await sb.auth.admin.updateUserById(id, { ban_duration });
    if (error) {
      console.error('[admin/suspend]', error.message);
      return res.status(500).json({ success: false, message: 'Impossible de mettre à jour le compte.' });
    }

    invalidatePlatformCache();
    const message =
      statut === 'suspendu'
        ? `Compte de ${profile.name} suspendu.`
        : `Compte de ${profile.name} réactivé.`;
    res.json({ success: true, message, statut });
  } catch (err) {
    console.error('[admin/suspend]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de la mise à jour du compte.' });
  }
});

export default router;
