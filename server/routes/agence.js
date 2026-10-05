// ============================================================
// MIM - Routes espace AGENCE (compte account_type = 'agence')
//
// Modèle « mandat » (RAPPORT-AGENCE-PHASE2.md) :
//   * l'agence gère des biens qui appartiennent à des propriétaires
//     gérés (agences_proprietaires / agences_biens) ;
//   * le propriétaire de chaque ligne métier reste le `user_id`
//     du propriétaire géré (jamais l'agence) ;
//   * TOUTE donnée est lue/écrite via le service_role APRÈS une
//     vérification de mandat fail-closed : le propriétaire est
//     toujours résolu depuis la base, jamais fourni par le client.
//
// MODE 1 : dashboard global (portefeuille, stats, propriétaires).
// MODE 2 : réutilisation des pages du dashboard propriétaire ;
//          les endpoints /bien/:bienId/* répondent avec les MÊMES
//          formes que le CRUD générique (/api/crud) pour autoriser
//          la commutation de base API côté front (MIM.apiBase).
// ============================================================

import { Router } from 'express';
import { serviceClient } from '../app.js';
import { gitAutoBackup } from '../utils/gitBackup.js';
import { passwordRuleError } from '../utils/passwordPolicy.js';
import { tenantEmailFor, usernameIsValid, uniqueUsername, splitFullName, generateInitialPassword, provisionProfile, rollbackCreatedAccount, deleteAuthAccount } from '../utils/tenantAccount.js';
import { notify, tenantUidOfLocataire, logementNomOf } from '../utils/notifications.js';
import { creerEcheanceSuivante, creerEcheanceInitiale, currentSimulatedMois } from '../utils/echeances.js';
import { enforceImmeublesLimit, enforceLogementsLimit, enforceLocatairesLimit } from '../utils/subscription.js';
import { reserveQuota, consumeQuota, releaseQuota } from '../utils/quota.js';
import { formatMois } from '../utils/mois.js';
import { revokeAllSessions } from '../utils/sessions.js';
import { sanitize, validateResource } from './crud.js';
import employesRoutes, { withScopeOwner } from './employes.js';
import tasksRoutes from './tasks.js';
import moyensPaiementRoutes from './moyensPaiement.js';
import { isValidMonth, parseMoney } from '../utils/inputValidation.js';
import { MANDAT_STATUTS, mandatMotifError, mandatReactivateError, applyMandatStatut } from '../utils/mandatRevocation.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const router = Router();
const sb = () => serviceClient();

async function bestEffortDelete(query) {
  try {
    const { error } = await query;
    if (error) console.warn('[agence/cleanup]', error.message);
  } catch (err) {
    console.warn('[agence/cleanup]', err.message);
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ============================================================
// Contrôles de mandat (fail-closed). Jamais d'identifiant client :
// propriétaire = agences_biens.proprietaire_id / biens.user_id.
// ============================================================
async function mandateBien(agenceId, bienId) {
  const { data } = await sb()
    .from('agences_biens')
    .select('*')
    .eq('agence_id', agenceId)
    .eq('bien_id', bienId)
    .eq('statut', 'actif')
    .maybeSingle();
  return data || null;
}

async function mandateOwner(agenceId, proprietaireId) {
  const { data } = await sb()
    .from('agences_proprietaires')
    .select('*')
    .eq('agence_id', agenceId)
    .eq('proprietaire_id', proprietaireId)
    .eq('statut', 'actif')
    .maybeSingle();
  return data || null;
}

async function bienOwnerOf(bienId) {
  const { data } = await sb().from('biens').select('user_id').eq('id', bienId).maybeSingle();
  return data?.user_id || null;
}

async function requireMandateBien(req, res, next) {
  const bienId = Number(req.params.bienId);
  if (!Number.isInteger(bienId) || bienId <= 0) {
    return res.status(400).json({ success: false, message: 'Identifiant de bien invalide.' });
  }
  const lien = await mandateBien(req.user.id, bienId);
  if (!lien) {
    return res.status(403).json({ success: false, message: 'Vous ne gérez pas ce bien.' });
  }
  const ownerMandate = await mandateOwner(req.user.id, lien.proprietaire_id);
  if (!ownerMandate) {
    return res.status(403).json({ success: false, message: 'Le mandat du propriétaire est révoqué.' });
  }
  const ownerId = await bienOwnerOf(bienId);
  if (!ownerId || ownerId !== lien.proprietaire_id) {
    return res.status(403).json({ success: false, message: 'Vous ne gérez pas ce bien.' });
  }
  req.mandate = lien;
  req.scope = { agenceId: req.user.id, bienId, proprietaireId: lien.proprietaire_id };
  next();
}

// Logements du bien géré (sentinelle [0] si aucun — pattern employé).
async function bienLogementIds(ownerId, bienId) {
  const { data: logements = [] } = await sb()
    .from('logements')
    .select('id')
    .eq('user_id', ownerId)
    .eq('bien_id', bienId);
  return logements.map((l) => l.id);
}

async function freeScopedLogementIfUnused(ownerId, logementId) {
  if (!logementId) return;
  const { data: active } = await sb()
    .from('locataires')
    .select('id')
    .eq('user_id', ownerId)
    .eq('logement_id', logementId)
    .eq('statut', 'actif')
    .is('superseded_at', null)
    .limit(1);
  if (!active?.length) {
    await sb().from('logements').update({ statut: 'libre' }).eq('id', logementId).eq('user_id', ownerId);
  }
}

// ============================================================
// MODE 1 — Portefeuille
// ============================================================
router.get('/portefeuille', async (req, res) => {
  try {
    const { data: liaisons = [] } = await sb()
      .from('agences_biens')
      .select('*')
      .eq('agence_id', req.user.id)
      .eq('statut', 'actif')
      .order('created_at', { ascending: false });

    // H-18 : seuls les mandats ACTIFS restent visibles — un mandat
    // révoqué disparaît immédiatement du portefeuille.
    const { data: mandatsActifs = [] } = await sb()
      .from('agences_proprietaires')
      .select('proprietaire_id')
      .eq('agence_id', req.user.id)
      .eq('statut', 'actif');
    const ownersActifs = new Set(mandatsActifs.map((m) => m.proprietaire_id));
    const portefeuille = liaisons.filter((l) => ownersActifs.has(l.proprietaire_id));

    if (!portefeuille.length) return res.json({ success: true, data: [] });

    const bienIds = portefeuille.map((l) => l.bien_id);
    const ownerIds = [...new Set(portefeuille.map((l) => l.proprietaire_id))];

    const [biensRes, ownersRes, logementsRes] = await Promise.all([
      sb().from('biens').select('id, user_id, nom, type, adresse, ville, pays, description').in('id', bienIds),
      sb().from('profiles').select('id, name, email, phone').in('id', ownerIds),
      sb().from('logements').select('id, bien_id, statut, loyer_mensuel').in('bien_id', bienIds),
    ]);

    const ownerBy = new Map((ownersRes.data || []).map((o) => [o.id, o]));
    const byBien = (rows, bienId) => (rows || []).filter((r) => r.bien_id === bienId);

    const data = portefeuille.map((l) => {
      const bien = (biensRes.data || []).find((b) => b.id === l.bien_id) || null;
      const owner = bien ? ownerBy.get(bien.user_id) : null;
      const logements = byBien(logementsRes.data, l.bien_id);
      return {
        id: l.id,
        bien_id: l.bien_id,
        statut: l.statut,
        created_at: l.created_at,
        bien: bien
          ? {
              ...bien,
              logements_count: logements.length,
              logements_occupes: logements.filter((lg) => lg.statut === 'occupe').length,
              loyer_total: logements.reduce((s, lg) => s + Number(lg.loyer_mensuel || 0), 0),
            }
          : null,
        proprietaire: owner ? { id: owner.id, name: owner.name, email: owner.email, phone: owner.phone } : null,
      };
    });

    res.json({ success: true, data });
  } catch (err) {
    console.error('[agence/portefeuille]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement du portefeuille.' });
  }
});

// ============================================================
// MODE 1 — Versements : l'agence reverse aux propriétaires gérés
// ============================================================

router.get('/versements', async (req, res) => {
  try {
    const agenceId = req.user.id;
    const { data, error } = await sb()
      .from('versements')
      .select('*')
      .eq('agence_id', agenceId)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;

    const proprietaireIds = [...new Set((data || []).map((v) => v.proprietaire_id).filter(Boolean))];
    const { data: profiles = [] } = proprietaireIds.length
      ? await sb().from('profiles').select('id, name, email, phone').in('id', proprietaireIds)
      : { data: [] };
    const byId = new Map(profiles.map((p) => [p.id, p]));

    res.json({
      success: true,
      versements: (data || []).map((v) => ({
        ...v,
        montant: Number(v.montant || 0),
        proprietaire: byId.get(v.proprietaire_id) || null,
      })),
    });
  } catch (err) {
    console.error('[agence/versements]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des versements.' });
  }
});

router.post('/versements', async (req, res) => {
  try {
    const agenceId = req.user.id;
    const proprietaireId = String(req.body?.proprietaire_id || '').trim();
    const montant = parseMoney(req.body?.montant);
    const bienId = req.body?.bien_id ? Number(req.body.bien_id) : null;
    const periode = req.body?.periode ? String(req.body.periode).trim().slice(0, 7) : null;
    const methode = req.body?.methode_paiement ? String(req.body.methode_paiement) : null;
    const reference = req.body?.reference ? String(req.body.reference).trim().slice(0, 100) : null;
    const note = req.body?.note ? String(req.body.note).trim().slice(0, 500) : null;

    const errors = {};
    if (!proprietaireId) errors.proprietaire_id = 'Propriétaire requis.';
    if (montant === null) errors.montant = 'Montant invalide.';
    if (periode && !isValidMonth(periode)) errors.periode = 'Période invalide (AAAA-MM).';
    if (methode && !['especes', 'mobile_money', 'virement', 'carte', 'wave', 'orange_money'].includes(methode)) {
      errors.methode_paiement = 'Méthode de paiement invalide.';
    }
    if (Object.keys(errors).length) {
      return res.status(400).json({ success: false, message: 'Veuillez corriger les champs en rouge.', errors });
    }

    // Le propriétaire ET le bien doivent être dans le périmètre de l'agence.
    const ownerMandate = await mandateOwner(agenceId, proprietaireId);
    if (!ownerMandate) {
      return res.status(403).json({ success: false, message: "Ce propriétaire ne fait pas partie de votre portefeuille." });
    }
    if (bienId) {
      const bienOwner = await bienOwnerOf(bienId);
      const lien = await mandateBien(agenceId, bienId);
      if (!lien || !bienOwner || bienOwner !== proprietaireId) {
        return res.status(403).json({ success: false, message: "Ce bien n'est pas dans votre périmètre." });
      }
    }

    const { data, error } = await sb()
      .from('versements')
      .insert({
        user_id: agenceId,
        agence_id: agenceId,
        proprietaire_id: proprietaireId,
        bien_id: Number.isInteger(bienId) && bienId > 0 ? bienId : null,
        montant,
        periode,
        statut: 'attente',
        methode_paiement: methode,
        reference,
        note,
      })
      .select()
      .single();
    if (error) throw error;

    await notify(proprietaireId, 'info', 'Votre agence vous a adressé un versement. Vous pouvez le confirmer depuis votre espace.');

    res.status(201).json({ success: true, data, message: 'Versement envoyé au propriétaire.' });
  } catch (err) {
    console.error('[agence/versement/create]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de la création du versement.' });
  }
});

router.post('/versements/:id/statut', async (req, res) => {
  try {
    const agenceId = req.user.id;
    const id = Number(req.params.id);
    const statut = String(req.body?.statut || '').trim();
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'Identifiant invalide.' });
    }
    if (!['attente', 'en_cours', 'effectue', 'annule'].includes(statut)) {
      return res.status(400).json({ success: false, message: 'Statut invalide.' });
    }

    const patch = { statut };
    if (statut === 'effectue') {
      patch.effectue_a = new Date().toISOString();
      patch.effectue_par = agenceId;
    }

    const { data, error } = await sb()
      .from('versements')
      .update(patch)
      .eq('id', id)
      .eq('agence_id', agenceId)
      .select()
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, message: 'Versement introuvable.' });

    res.json({ success: true, data });
  } catch (err) {
    console.error('[agence/versement/statut]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de la mise à jour du versement.' });
  }
});

// ============================================================
// MODE 1 — Messagerie avec les propriétaires gérés
// ============================================================

router.get('/messages', async (req, res) => {
  try {
    const { data, error } = await sb()
      .from('messages')
      .select('*')
      .eq('agence_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;

    const proprietaireIds = [...new Set((data || []).map((m) => m.proprietaire_id).filter(Boolean))];
    const { data: profiles = [] } = proprietaireIds.length
      ? await sb().from('profiles').select('id, name, email, phone').in('id', proprietaireIds)
      : { data: [] };
    const byId = new Map(profiles.map((p) => [p.id, p]));

    res.json({
      success: true,
      messages: (data || []).map((m) => ({ ...m, proprietaire: byId.get(m.proprietaire_id) || null })),
    });
  } catch (err) {
    console.error('[agence/messages]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement de la messagerie.' });
  }
});

router.post('/messages', async (req, res) => {
  try {
    const agenceId = req.user.id;
    const proprietaireId = String(req.body?.proprietaire_id || '').trim();
    const corps = String(req.body?.corps || '').trim();
    const objet = req.body?.objet ? String(req.body.objet).trim().slice(0, 120) : null;

    if (!proprietaireId || !corps || corps.length > 4000) {
      return res.status(400).json({ success: false, message: 'Destinataire et message (4000 caractères max) requis.' });
    }
    const ownerMandate = await mandateOwner(agenceId, proprietaireId);
    if (!ownerMandate) {
      return res.status(403).json({ success: false, message: "Ce propriétaire ne fait pas partie de votre portefeuille." });
    }

    const { data, error } = await sb()
      .from('messages')
      .insert({
        user_id: agenceId,
        agence_id: agenceId,
        proprietaire_id: proprietaireId,
        auteur_id: agenceId,
        objet,
        corps,
        lu_par_destinataire: false,
      })
      .select()
      .single();
    if (error) throw error;

    await notify(proprietaireId, 'info', 'Votre agence vous a envoyé un message.');

    res.status(201).json({ success: true, message: data });
  } catch (err) {
    console.error('[agence/message/create]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de l\'envoi du message.' });
  }
});

// ============================================================
// MODE 1 — Statistiques globales de l'agence
// ============================================================
router.get('/stats', async (req, res) => {
  try {
    const agenceId = req.user.id;

    // H-18 : les deux sources de liaison sont lues ensemble pour ne
    // compter que les biens couverts par un mandat ACTIF (un mandat
    // révoqué disparaît immédiatement des statistiques).
    const [{ data: biensLiaisons = [] }, { data: proprietairesLiaisons = [] }] = await Promise.all([
      sb().from('agences_biens').select('bien_id, proprietaire_id').eq('agence_id', agenceId).eq('statut', 'actif'),
      sb().from('agences_proprietaires').select('proprietaire_id').eq('agence_id', agenceId).eq('statut', 'actif'),
    ]);

    const ownersActifs = new Set(proprietairesLiaisons.map((l) => l.proprietaire_id));
    const bienIds = biensLiaisons.filter((l) => ownersActifs.has(l.proprietaire_id)).map((l) => l.bien_id);
    const bienIdsEsc = bienIds.length ? bienIds : [0];

    const [{ data: biens = [] }, { data: logements = [] }, { data: versementsAttente = [] }, { data: messages = [] }] = await Promise.all([
      sb().from('biens').select('id').in('id', bienIdsEsc.length ? bienIdsEsc : [0]),
      sb().from('logements').select('id, bien_id, statut, loyer_mensuel').in('bien_id', bienIdsEsc.length ? bienIdsEsc : [0]),
      sb().from('versements').select('id, montant').eq('agence_id', agenceId).eq('statut', 'attente'),
      sb().from('messages').select('id').eq('agence_id', agenceId).eq('lu_par_destinataire', false),
    ]);

    const logementIds = logements.map((l) => l.id);
    const logementIdsEsc = logementIds.length ? logementIds : [0];

    const [{ data: locataires = [] }, { data: paiements = [] }] = await Promise.all([
      sb().from('locataires').select('id').in('bien_id', bienIdsEsc.length ? bienIdsEsc : [0]),
      sb().from('paiements').select('id, montant, statut, mois, logement_id').in('logement_id', logementIdsEsc),
    ]);

    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthPayments = paiements.filter((p) => p.mois === thisMonth);

    const expectedRent = logements
      .filter((l) => l.statut === 'occupe')
      .reduce((s, l) => s + Number(l.loyer_mensuel || 0), 0);
    const paidRent = monthPayments.filter((p) => p.statut === 'paye').reduce((s, p) => s + Number(p.montant), 0);
    const lateRent = monthPayments.filter((p) => p.statut === 'retard').reduce((s, p) => s + Number(p.montant), 0);

    // Série des 6 derniers mois (encaissé vs attendu) pour le graphique.
    const rentSeries = [];
    for (let i = 5; i >= 0; i -= 1) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      const rows = paiements.filter((p) => p.mois === ym);
      rentSeries.push({
        mois: ym,
        paye: rows.filter((p) => p.statut === 'paye').reduce((s, p) => s + Number(p.montant || 0), 0),
        attendu: i === 0 ? expectedRent : 0,
      });
    }

    res.json({
      success: true,
      stats: {
        totalBiens: bienIds.length,
        totalProprietaires: new Set(proprietairesLiaisons.map((l) => l.proprietaire_id)).size,
        totalLogements: logements.length,
        logementsOccupes: logements.filter((l) => l.statut === 'occupe').length,
        logementsLibres: logements.filter((l) => l.statut === 'libre').length,
        totalLocataires: locataires.length,
        locatairesActifs: locataires.filter((l) => l.statut === 'actif').length,
        incidentsOuverts: await sb()
          .from('incidents')
          .select('id, statut')
          .in('logement_id', logementIdsEsc)
          .then(({ data }) => (data || []).filter((i) => i.statut !== 'resolu').length),
        rentSeries,
        expectedRent,
        paidRent,
        lateRent,
        lateCount: monthPayments.filter((p) => p.statut === 'retard').length,
        versementsAttente: versementsAttente.reduce((s, v) => s + Number(v.montant), 0),
        versementsAttenteCount: versementsAttente.length,
        messagesNonLus: messages.length,
      },
    });
  } catch (err) {
    console.error('[agence/stats]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des statistiques.' });
  }
});

// ============================================================
// MODE 1 — Propriétaires gérés
// ============================================================
router.get('/proprietaires', async (req, res) => {
  try {
    const { data: liaisons = [] } = await sb()
      .from('agences_proprietaires')
      .select('*')
      .eq('agence_id', req.user.id)
      .order('created_at', { ascending: false });

    if (!liaisons.length) return res.json({ success: true, data: [] });

    const ownerIds = liaisons.map((l) => l.proprietaire_id);
    const { data: profiles = [] } = await sb()
      .from('profiles')
      .select('id, name, email, phone, username')
      .in('id', ownerIds);
    const profileBy = new Map(profiles.map((p) => [p.id, p]));

    const { data: biensLiaisons = [] } = await sb()
      .from('agences_biens')
      .select('proprietaire_id')
      .eq('agence_id', req.user.id)
      .eq('statut', 'actif');
    const biensByOwner = new Map();
    for (const b of biensLiaisons) {
      biensByOwner.set(b.proprietaire_id, (biensByOwner.get(b.proprietaire_id) || 0) + 1);
    }

    res.json({
      success: true,
      data: liaisons.map((l) => {
        const p = profileBy.get(l.proprietaire_id);
        return {
          id: l.id,
          proprietaire_id: l.proprietaire_id,
          statut: l.statut,
          motif: l.motif || null,
          updated_at: l.updated_at || null,
          revoque_par: l.revoque_par || null,
          created_at: l.created_at,
          biens_count: biensByOwner.get(l.proprietaire_id) || 0,
          nom: p?.name || null,
          email: p?.email || null,
          phone: p?.phone || null,
          username: p?.username || null,
        };
      }),
    });
  } catch (err) {
    console.error('[agence/proprietaires]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des propriétaires.' });
  }
});

// ------------------------------------------------------------
// H-18 — Suspension / réactivation du mandat d'un propriétaire.
// L'agence met fin à sa propre gestion (statut -> inactif) avec
// motif tracé ; la réactivation n'appartient qu'au compte qui a
// prononcé la suspension (voir utils/mandatRevocation.js).
// ------------------------------------------------------------
router.patch('/proprietaires/:proprietaireId/statut', async (req, res) => {
  try {
    const agenceId = req.user.id;
    const proprietaireId = String(req.params.proprietaireId || '');
    const statut = String(req.body?.statut || '').trim();
    const motif = req.body?.motif ? String(req.body.motif).trim() : '';

    if (!UUID_RE.test(proprietaireId)) {
      return res.status(400).json({ success: false, message: 'Identifiant de propriétaire invalide.' });
    }
    if (!MANDAT_STATUTS.has(statut)) {
      return res.status(400).json({ success: false, message: "Statut invalide (attendu : 'actif' ou 'inactif')." });
    }

    const { data: liaison, error: readError } = await sb()
      .from('agences_proprietaires')
      .select('id, agence_id, proprietaire_id, statut, revoque_par, motif, updated_at')
      .eq('agence_id', agenceId)
      .eq('proprietaire_id', proprietaireId)
      .maybeSingle();
    if (readError) throw readError;
    if (!liaison) {
      return res.status(404).json({ success: false, message: 'Ce propriétaire ne fait pas partie de votre portefeuille.' });
    }

    if (statut === liaison.statut) {
      return res.json({ success: true, changed: false, statut: liaison.statut, message: 'Aucun changement.' });
    }

    const motifError = mandatMotifError(motif);
    if (motifError) {
      return res.status(400).json({ success: false, message: motifError, errors: { motif: motifError } });
    }

    const forbidden = mandatReactivateError(liaison, statut, agenceId);
    if (forbidden) {
      return res.status(forbidden.status).json({ success: false, code: forbidden.code, message: forbidden.message });
    }

    const result = await applyMandatStatut({
      liaison,
      scope: { agence_id: agenceId },
      statut,
      motif,
      actorId: agenceId,
      actorRole: 'agence',
      ip: req.ip,
    });
    if (!result.ok) {
      return res.status(result.status).json({ success: false, code: result.code, message: result.message });
    }

    res.json({
      success: true,
      changed: true,
      statut,
      message: statut === 'inactif'
        ? 'Mandat suspendu : vos accès à ce propriétaire sont coupés.'
        : 'Mandat réactivé.',
    });
  } catch (err) {
    console.error('[agence/proprietaires/statut]', err.message);
    res.status(500).json({ success: false, message: 'Impossible de changer le statut du mandat.' });
  }
});

// Création d'un propriétaire géré AVEC un compte d'authentification
// (pattern « compte auto » des employés : username imprévisible,
// mot de passe initial temporaire, must_change_password = true).
router.post('/proprietaires', async (req, res) => {
  try {
    const agenceId = req.user.id;
    const autoAccount = !req.body?.username && !req.body?.password;
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = autoAccount ? generateInitialPassword() : String(req.body.password || '');
    const nom = String(req.body.nom || '').trim();
    const email = req.body.email ? String(req.body.email).trim() : null;
    const phone = req.body.phone ? String(req.body.phone).trim() : null;

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

    let finalUsername = username;
    if (autoAccount) {
      const { prenom, nom: nomFamille } = splitFullName(nom);
      finalUsername = await uniqueUsername(sb(), prenom, nomFamille);
      if (!finalUsername) {
        return res.status(400).json({ success: false, message: 'Impossible de générer un nom d\'utilisateur unique pour ce propriétaire.' });
      }
    } else {
      const { data: existingUsername } = await sb()
        .from('profiles')
        .select('id')
        .ilike('username', finalUsername)
        .maybeSingle();
      if (existingUsername) {
        return res.status(409).json({ success: false, code: 'USERNAME_ALREADY_EXISTS', message: 'Ce nom d\'utilisateur est déjà utilisé.', errors: { username: 'Ce nom d\'utilisateur est déjà utilisé.' } });
      }
    }

    const { data: createdUser, error: createError } = await sb().auth.admin.createUser({
      email: tenantEmailFor(finalUsername),
      password,
      email_confirm: true,
      user_metadata: {
        name: nom,
        username: finalUsername,
        phone: phone || '',
      },
      app_metadata: {
        mim_account_type: 'proprietaire',
        mim_must_change_password: true,
      },
    });

    if (createError || !createdUser?.user?.id) {
      const msg = String(createError?.message || '').toLowerCase();
      if (msg.includes('already') || msg.includes('existe')) {
        return res.status(409).json({ success: false, code: 'USERNAME_ALREADY_EXISTS', message: 'Ce nom d\'utilisateur est déjà utilisé.', errors: { username: 'Ce nom d\'utilisateur est déjà utilisé.' } });
      }
      console.error('[agence/proprietaires/create]', createError?.message);
      return res.status(400).json({ success: false, message: 'Impossible de créer le compte propriétaire.' });
    }

    const proprietaireId = createdUser.user.id;
    try {
      await provisionProfile(sb(), proprietaireId, 'proprietaire', finalUsername, true, email);
    } catch (profileError) {
      // Même compensation que le lien de gestion : la souscription
      // d'essai (FK RESTRICT) doit être purgée, sinon deleteUser échoue
      // et laisse un compte propriétaire orphelin (H-19).
      await deleteAuthAccount(sb(), proprietaireId, 'proprietaires/provision');
      return res.status(500).json({ success: false, message: 'Impossible de finaliser le compte propriétaire.' });
    }

    const { data: lien, error: lienError } = await sb()
      .from('agences_proprietaires')
      .insert({ user_id: agenceId, agence_id: agenceId, proprietaire_id: proprietaireId, statut: 'actif' })
      .select()
      .single();

    if (lienError) {
      // H-19 : le compte existe mais n'est rattache a aucune agence —
      // ses identifiants ne seront jamais retournes. On rembourse la
      // creation (profil + liens cascadeent) plutot que de laisser un
      // compte Auth orphelin.
      await rollbackCreatedAccount(sb(), proprietaireId, 'proprietaires/link');
      if (String(lienError.message).includes('duplicate')) {
        return res.status(409).json({ success: false, message: 'Ce propriétaire est déjà géré par votre agence.' });
      }
      console.error('[agence/proprietaires/link]', lienError.message);
      return res.status(500).json({ success: false, message: 'Le rattachement du propriétaire a échoué : le compte créé a été annulé. Réessayez.' });
    }

    try {
      await notify(proprietaireId, 'system', `Votre agence vous a créé un compte. Utilisez le nom d'utilisateur « ${finalUsername} » et le mot de passe temporaire communiqué pour vous connecter.`);
    } catch (e) {
      console.warn('[agence/proprietaires] notification :', e.message);
    }

    gitAutoBackup(`Sauvegarde auto : ${req.user.account_type} a créé un propriétaire géré`);

    res.status(201).json({
      success: true,
      data: lien,
      generatedUsername: autoAccount ? finalUsername : undefined,
      generatedPassword: autoAccount ? password : undefined,
      message: 'Propriétaire géré créé et rattaché à votre agence.',
    });
  } catch (err) {
    console.error('[agence/proprietaires]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de la création du propriétaire.' });
  }
});

// Création d'un bien AU NOM d'un propriétaire géré + liaison agence.
router.post('/proprietaires/:proprietaireId/biens', async (req, res) => {
  // H-19 : tracés AVANT le try — le catch rembourse le bien déjà créé
  // et libère la reservation de quota. Jamais de bien cree sans lien de
  // gestion (invisible au portefeuille), jamais de quota fuit.
  let createdBienId = null;
  let reservation = null;
  try {
    const proprietaireId = req.params.proprietaireId;
    const agenceId = req.user.id;

    const lienOwner = await mandateOwner(agenceId, proprietaireId);
    if (!lienOwner) {
      return res.status(403).json({ success: false, message: 'Vous ne gérez pas ce propriétaire.' });
    }

    const clean = sanitize('biens', req.body || {});
    const errors = validateResource('biens', clean, false);
    if (Object.keys(errors).length) {
      return res.status(400).json({ success: false, message: 'Le nom et le type sont obligatoires.', errors });
    }

    const limit = await enforceImmeublesLimit(proprietaireId);
    if (!limit.allowed) return res.status(409).json({ success: false, code: limit.code, message: limit.message });
    reservation = await reserveQuota(sb(), proprietaireId, 'biens', limit.max);
    if (!reservation.allowed) return res.status(409).json({ success: false, code: reservation.code, message: reservation.message });

    const { data: bien, error } = await sb()
      .from('biens')
      .insert({ ...clean, user_id: proprietaireId })
      .select()
      .single();

    if (error) {
      await releaseQuota(sb(), reservation.id, proprietaireId).catch(() => {});
      console.error('[agence/proprietaires/biens]', error.message);
      return res.status(500).json({ success: false, message: 'Erreur lors de la création du bien.' });
    }
    createdBienId = bien.id;

    const { error: linkError } = await sb()
      .from('agences_biens')
      .insert({ user_id: agenceId, agence_id: agenceId, proprietaire_id: proprietaireId, bien_id: bien.id, statut: 'actif' });
    if (linkError) {
      // H-19 : pas de lien -> pas de bien. La suppression en cascade
      // retire aussi les liaisons partielles, la quota est libérée.
      await bestEffortDelete(sb().from('biens').delete().eq('id', bien.id).eq('user_id', proprietaireId));
      createdBienId = null;
      await releaseQuota(sb(), reservation.id, proprietaireId).catch(() => {});
      console.error('[agence/proprietaires/biens/link]', linkError.message);
      return res.status(500).json({ success: false, message: 'Le mandat n\'a pas pu être posé : le bien a été annulé. Réessayez.' });
    }
    createdBienId = null;
    await consumeQuota(sb(), reservation.id, proprietaireId);

    gitAutoBackup(`Sauvegarde auto : bien créé par une agence`);

    res.status(201).json({ success: true, data: bien, message: 'Bien créé pour le propriétaire et ajouté au portefeuille de l\'agence.' });
  } catch (err) {
    if (createdBienId) {
      await bestEffortDelete(sb().from('biens').delete().eq('id', createdBienId).eq('user_id', req.user.id));
      createdBienId = null;
    }
    if (reservation?.id) await releaseQuota(sb(), reservation.id, req.user.id).catch(() => {});
    console.error('[agence/proprietaires/biens]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de la création du bien.' });
  }
});

// ============================================================
// MODE 2 — Contexte d'un bien géré (bootstrap des pages)
// ============================================================
router.get('/bien/:bienId/contexte', requireMandateBien, async (req, res) => {
  try {
    const { bienId, proprietaireId } = req.scope;

    const [bienRes, ownerRes, logementsRes, locatairesRes] = await Promise.all([
      sb().from('biens').select('*').eq('id', bienId).maybeSingle(),
      sb().from('profiles').select('id, name, email, phone').eq('id', proprietaireId).maybeSingle(),
      sb().from('logements').select('id, bien_id, statut, loyer_mensuel').eq('user_id', proprietaireId).eq('bien_id', bienId),
      sb().from('locataires').select('id, statut, logement_id').eq('user_id', proprietaireId).eq('bien_id', bienId),
    ]);

    const logements = logementsRes.data || [];
    const logementIds = logements.map((l) => l.id);
    const logementIdsEsc = logementIds.length ? logementIds : [0];

    const { data: incidents = [] } = await sb()
      .from('incidents')
      .select('id, statut')
      .eq('user_id', proprietaireId)
      .in('logement_id', logementIdsEsc);

    const { data: paiements = [] } = await sb()
      .from('paiements')
      .select('id, statut, mois')
      .eq('user_id', proprietaireId)
      .in('logement_id', logementIdsEsc);

    const [prestatairesRes, interventionsBienRes] = await Promise.all([
      sb().from('prestataires').select('id').eq('user_id', proprietaireId),
      sb().from('interventions').select('id, logement_id').eq('user_id', proprietaireId).in('logement_id', logementIdsEsc),
    ]);

    const stats = {
      logements: logements.length,
      logementsOccupes: logements.filter((l) => l.statut === 'occupe').length,
      logementsLibres: logements.filter((l) => l.statut === 'libre').length,
      loyerTotal: logements.reduce((s, l) => s + Number(l.loyer_mensuel || 0), 0),
      locataires: (locatairesRes.data || []).length,
      locatairesOccupes: new Set((locatairesRes.data || []).filter((l) => l.statut === 'actif' && l.logement_id).map((l) => l.logement_id)).size,
      incidentsActifs: incidents.filter((i) => i.statut !== 'resolu').length,
      paiementsEnValidation: paiements.filter((p) => p.statut === 'en_validation').length,
      prestataires: (prestatairesRes.data || []).length,
      interventions: (interventionsBienRes.data || []).length,
    };

    res.json({
      success: true,
      data: {
        bien: bienRes.data || null,
        proprietaire: ownerRes.data
          ? { id: ownerRes.data.id, name: ownerRes.data.name, email: ownerRes.data.email, phone: ownerRes.data.phone }
          : null,
        stats,
      },
    });
  } catch (err) {
    console.error('[agence/bien/contexte]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement du contexte.' });
  }
});

// ============================================================
// MODE 2 — Statistiques scoped du bien (shape de /api/stats/dashboard)
// ============================================================
router.get('/bien/:bienId/stats/dashboard', requireMandateBien, async (req, res) => {
  try {
    const { bienId, proprietaireId } = req.scope;

    const { data: logements = [] } = await sb()
      .from('logements')
      .select('id, statut, loyer_mensuel')
      .eq('user_id', proprietaireId)
      .eq('bien_id', bienId);

    const logementIds = logements.map((l) => l.id);
    const logementIdsEsc = logementIds.length ? logementIds : [0];

    const [locatairesRes, paiementsRes, incidentsRes, interventionsRes] = await Promise.all([
      sb().from('locataires').select('id').eq('user_id', proprietaireId).eq('bien_id', bienId),
      sb().from('paiements').select('id, montant, statut, mois').eq('user_id', proprietaireId).in('logement_id', logementIdsEsc),
      sb().from('incidents').select('id, statut').eq('user_id', proprietaireId).in('logement_id', logementIdsEsc),
      sb().from('interventions').select('id, statut').eq('user_id', proprietaireId).in('logement_id', logementIdsEsc),
    ]);

    const totalProperties = logements.length;
    const occupied = logements.filter((l) => l.statut === 'occupe').length;
    const available = logements.filter((l) => l.statut === 'libre').length;

    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthPayments = (paiementsRes.data || []).filter((p) => p.mois === thisMonth);

    const expectedRent = logements.filter((l) => l.statut === 'occupe').reduce((s, l) => s + Number(l.loyer_mensuel || 0), 0);
    const paidRent = monthPayments.filter((p) => p.statut === 'paye').reduce((s, p) => s + Number(p.montant), 0);
    const lateRent = monthPayments.filter((p) => p.statut === 'retard').reduce((s, p) => s + Number(p.montant), 0);

    res.json({
      success: true,
      stats: {
        totalProperties,
        occupiedProperties: occupied,
        availableProperties: available,
        totalTenants: locatairesRes.data?.length ?? 0,
        expectedRent,
        paidRent,
        lateRent,
        lateCount: monthPayments.filter((p) => p.statut === 'retard').length,
        paiementsEnValidation: (paiementsRes.data || []).filter((p) => p.statut === 'en_validation').length,
        activeIncidents: (incidentsRes.data || []).filter((i) => i.statut !== 'resolu').length ?? 0,
        activeInterventions: (interventionsRes.data || []).filter((i) => i.statut !== 'termine').length ?? 0,
      },
    });
  } catch (err) {
    console.error('[agence/bien/stats]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des statistiques.' });
  }
});

// ============================================================
// MODE 2 — CRUD scoped sur un bien géré.
// Formes de réponse identiques à /api/crud pour réutiliser le JS
// propriétaire (commutation MIM.apiBase).
// ============================================================
const SCOPED = {
  logements: { bienColumn: 'bien_id' },
  locataires: { bienColumn: 'bien_id' },
  depenses: { bienColumn: 'bien_id' },
  paiements: { viaLogement: true },
  incidents: { viaLogement: true },
  interventions: { viaLogement: true },
};

// Vérifie qu'une référence croisée appartient au propriétaire/au bien.
async function refBelongsToScope(scope, refField, refValue, refTable) {
  if (refValue === undefined || refValue === null || refValue === '') return null;

  // Colonnes de scoping disponibles selon la table :
  //   - logements, locataires -> bien_id (appartenance directe au bien)
  //   - incidents, paiements  -> logement_id (rattachés au bien via logement)
  //   - autres                -> user_id seul (portée = propriétaire géré)
  const withBienId = ['logements', 'locataires'].includes(refTable);
  const withLogementId = ['incidents', 'interventions', 'paiements', 'locataires'].includes(refTable);
  const select = `user_id${withBienId ? ', bien_id' : ''}${withLogementId ? ', logement_id' : ''}`;

  try {
    const { data } = await sb().from(refTable).select(select).eq('id', refValue).maybeSingle();
    if (!data || data.user_id !== scope.proprietaireId) return `${refField} : introuvable ou hors de votre portée.`;
    if (refTable !== 'biens' && withBienId && data.bien_id !== undefined && data.bien_id !== null && Number(data.bien_id) !== Number(scope.bienId)) {
      return `${refField} : hors du bien géré.`;
    }
    // Incident / paiement : son logement doit appartenir au bien géré.
    if (withLogementId && data.logement_id != null) {
      const logementIds = await bienLogementIds(scope.proprietaireId, scope.bienId);
      if (!logementIds.includes(data.logement_id)) return `${refField} : hors du bien géré.`;
    }
    return null;
  } catch (err) {
    console.warn(`[agence/refBelongsToScope] ${refTable}.${refField}`, err.message);
    return `${refField} : introuvable ou hors de votre portée.`;
  }
}

async function scopedList(req, res, table) {
  try {
    const { bienId, proprietaireId } = req.scope;
    const cfg = SCOPED[table];

    let query = sb().from(table).select('*').eq('user_id', proprietaireId);

    if (cfg.viaLogement) {
      const logementIds = await bienLogementIds(proprietaireId, bienId);
      query = query.in('logement_id', logementIds.length ? logementIds : [0]);
    } else {
      query = query.eq(cfg.bienColumn, bienId);
    }

    const { data = [], error } = await query.order('created_at', { ascending: false });
    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    console.error(`[agence/list:${table}]`, err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement.' });
  }
}

async function scopedCreate(req, res, table) {
  // Déclarées AVANT le try : le catch les référence pour libérer le quota.
  // Déclarées dans le try, elles levaient un ReferenceError dans le catch
  // et remplissaient la réponse d'erreur d'une seconde exception.
  const { bienId, proprietaireId } = req.scope || {};
  let quotaReservation = null;
  try {
    const payload = req.body || {};

    // Formulaire unique « Ajouter un locataire » (compte embarqué) :
    // même contrat de réponse que le CRUD générique.
    if (
      table === 'locataires' &&
      (payload.username || payload.password || payload.logement || payload.autoAccount)
    ) {
      return scopedCreateTenant(req, res);
    }

    let insert = sanitize(table, payload);

    // L'adresse d'un logement est héritée du bien si elle n'est pas fournie.
    if (table === 'logements' && !insert.adresse) {
      const { data: bien } = await sb()
        .from('biens')
        .select('adresse, ville, pays')
        .eq('id', bienId)
        .maybeSingle();
      if (bien) {
        const inherited = [bien.adresse, bien.ville, bien.pays].filter(Boolean).join(', ');
        if (inherited) insert.adresse = inherited;
      }
    }

    // Contraintes de rattachement au bien géré (jamais un id client).
    if (table === 'logements') {
      insert.bien_id = bienId;
    } else if (table === 'locataires') {
      let bienRef = null;
      if (payload.logement_id) {
        const err = await refBelongsToScope(req.scope, 'logement_id', payload.logement_id, 'logements');
        if (err) return res.status(400).json({ success: false, message: 'Le logement est introuvable ou hors du bien géré.', errors: { logement_id: 'Le logement est introuvable ou hors du bien géré.' } });
        const { data: lg } = await sb().from('logements').select('bien_id').eq('id', payload.logement_id).maybeSingle();
        bienRef = lg?.bien_id;
        insert.bien_id = bienRef;
        insert.logement_id = payload.logement_id;
      } else if (payload.bien_id !== undefined) {
        if (Number(payload.bien_id) !== Number(bienId)) {
          return res.status(400).json({ success: false, message: 'Le bien est hors de votre portée.', errors: { bien_id: 'Le bien est hors de votre portée.' } });
        }
        insert.bien_id = bienId;
      }
    } else if (table === 'paiements' || table === 'incidents' || table === 'interventions') {
      const refField = table === 'paiements' ? 'logement_id' : table === 'incidents' ? 'logement_id' : 'logement_id';
      if (!payload[refField]) {
        return res.status(400).json({ success: false, message: 'Un logement est requis.', errors: { [refField]: 'Un logement est requis.' } });
      }
      const err = await refBelongsToScope(req.scope, refField, payload[refField], 'logements');
      if (err) return res.status(400).json({ success: false, message: 'Le logement est introuvable ou hors du bien géré.', errors: { [refField]: 'Le logement est introuvable ou hors du bien géré.' } });
      insert.logement_id = payload[refField];
    } else if (table === 'depenses') {
      // Une dépense appartient au bien géré : bien_id forcé côté serveur,
      // logement optionnel (mais rattaché au bien s'il est fourni).
      insert.bien_id = bienId;
      if (payload.logement_id) {
        const err = await refBelongsToScope(req.scope, 'logement_id', payload.logement_id, 'logements');
        if (err) return res.status(400).json({ success: false, message: 'Le logement est introuvable ou hors du bien géré.', errors: { logement_id: 'Le logement est introuvable ou hors du bien géré.' } });
        insert.logement_id = payload.logement_id;
      } else {
        delete insert.logement_id;
      }
    }

    if (table === 'paiements') {
      if (!insert.locataire_id) {
        return res.status(400).json({ success: false, message: 'Un locataire est requis.', errors: { locataire_id: 'Un locataire est requis.' } });
      }
      const err = await refBelongsToScope(req.scope, 'locataire_id', insert.locataire_id, 'locataires');
      if (err) return res.status(400).json({ success: false, message: 'Le locataire est introuvable ou hors du bien géré.', errors: { locataire_id: 'Le locataire est introuvable ou hors du bien géré.' } });
      const { data: tenantRow } = await sb().from('locataires').select('logement_id').eq('id', insert.locataire_id).eq('user_id', proprietaireId).maybeSingle();
      if (!tenantRow || Number(tenantRow.logement_id) !== Number(insert.logement_id)) {
        return res.status(400).json({ success: false, message: 'Le locataire et le logement ne correspondent pas.', errors: { locataire_id: 'Le locataire et le logement ne correspondent pas.' } });
      }
      if (insert.bien_id) delete insert.bien_id;
    }
    if (table === 'interventions' && payload.incident_id) {
      const err = await refBelongsToScope(req.scope, 'incident_id', payload.incident_id, 'incidents');
      if (err) return res.status(400).json({ success: false, message: 'L\'incident est introuvable ou hors du bien géré.', errors: { incident_id: 'L\'incident est introuvable ou hors du bien géré.' } });
      const { data: incidentRow } = await sb().from('incidents').select('logement_id').eq('id', payload.incident_id).eq('user_id', proprietaireId).maybeSingle();
      if (!incidentRow || Number(incidentRow.logement_id) !== Number(insert.logement_id)) {
        return res.status(400).json({ success: false, message: 'L\'incident et le logement ne correspondent pas.', errors: { incident_id: 'L\'incident et le logement ne correspondent pas.' } });
      }
      insert.incident_id = payload.incident_id;
    }
    if (table === 'interventions' && payload.prestataire_id) {
      const { data: p } = await sb().from('prestataires').select('user_id').eq('id', payload.prestataire_id).maybeSingle();
      if (!p || p.user_id !== proprietaireId) {
        return res.status(400).json({ success: false, message: 'Le prestataire est introuvable.', errors: { prestataire_id: 'Le prestataire est introuvable.' } });
      }
      insert.prestataire_id = payload.prestataire_id;
    }

    // Un logement ne peut avoir qu'un seul locataire actif (règle crud).
    if (table === 'locataires' && insert.statut !== 'inactif' && insert.logement_id) {
      const { data: other } = await sb()
        .from('locataires')
        .select('id')
        .eq('user_id', proprietaireId)
        .eq('logement_id', insert.logement_id)
        .eq('statut', 'actif')
        .limit(1);
      if (other?.length) {
        return res.status(400).json({ success: false, message: 'Ce logement est déjà occupé par un autre locataire actif.', errors: { logement_id: 'Ce logement est déjà occupé par un autre locataire actif.' } });
      }
    }

    // Un paiement confirmé (« paye ») sans date renseignée est daté du jour.
    if (table === 'paiements' && insert.statut === 'paye' && !insert.date_paiement) {
      insert.date_paiement = new Date().toISOString().slice(0, 10);
    }

    // Aucune échéance pour un mois strictement futur (règle crud).
    if (table === 'paiements' && insert.mois && insert.mois > await currentSimulatedMois()) {
      return res.status(400).json({
        success: false,
        message: 'Le mois concerné ne peut pas être dans le futur. Choisissez le mois courant ou un mois passé.',
        errors: { mois: 'Le mois concerné ne peut pas être dans le futur. Choisissez le mois courant ou un mois passé.' },
      });
    }

    const errors = validateResource(table, insert, false);
    if (Object.keys(errors).length) {
      return res.status(400).json({ success: false, message: 'Données invalides.', errors });
    }

    if (table === 'logements' || table === 'locataires') {
      const limit = table === 'logements'
        ? await enforceLogementsLimit(proprietaireId)
        : await enforceLocatairesLimit(proprietaireId);
      if (!limit.allowed) {
        return res.status(409).json({ success: false, code: limit.code, message: limit.message });
      }
      quotaReservation = await reserveQuota(sb(), proprietaireId, table, limit.max);
      if (!quotaReservation.allowed) {
        return res.status(409).json({ success: false, code: quotaReservation.code, message: quotaReservation.message });
      }
      // H-19 : le quota est consomme AVANT l'insertion : une insertion
      // qui echoue ne laisse alors aucune ligne, et une reservation
      // consommee sans ligne n'affecte aucun compteur (seules les
      // reservations « reserved » entrent dans le plafond).
      await consumeQuota(sb(), quotaReservation.id, proprietaireId);
    }

    // Anti-doublon paiement : une seule ligne (locataire, mois). Si une
    // ligne non définitive existe, on la transforme au lieu d'en créer
    // une seconde — comportement identique au CRUD générique.
    if (table === 'paiements' && insert.locataire_id && insert.mois) {
      const incomingStatus = insert.statut || 'attente';
      const { data: existing } = await sb()
        .from('paiements')
        .select('id, statut, logement_id')
        .eq('user_id', proprietaireId)
        .eq('locataire_id', insert.locataire_id)
        .eq('mois', insert.mois)
        .maybeSingle();

      if (existing) {
        if (Number(existing.logement_id) !== Number(insert.logement_id)) {
          return res.status(409).json({ success: false, code: 'PAYMENT_HOUSING_CONFLICT', message: 'Un paiement existe déjà pour ce locataire et ce mois dans un autre logement.' });
        }
        if (existing.statut === 'paye') {
          return res.status(409).json({ success: false, message: `Loyer de ${insert.mois} déjà payé pour ce locataire.` });
        }
        if (existing.statut === 'en_validation') {
          return res.status(409).json({
            success: false,
            message: 'Une déclaration de ce locataire est en attente pour ce mois. Validez-la depuis la liste « Paiements à valider ».',
          });
        }
        if (existing.statut === incomingStatus) {
          return res.status(409).json({ success: false, message: `Une échéance existe déjà pour ${insert.mois} avec le statut ${incomingStatus}.` });
        }

        const { data: updated, error: upErr } = await sb()
          .from('paiements')
          .update(insert)
          .eq('id', existing.id)
          .select()
          .single();

        if (upErr) {
          console.error('[agence paiements upsert]', upErr.message);
          return res.status(400).json({ success: false, message: 'Erreur lors de l\'enregistrement du paiement.' });
        }

        gitAutoBackup(`Sauvegarde auto : mise à jour paiement (anti-doublon, agence bien ${bienId})`);
        return res.status(200).json({ success: true, data: updated, merged: true });
      }
    }

    const body = { ...insert, user_id: proprietaireId };
    if (table === 'logements' && !body.statut) body.statut = 'libre';

    const { data, error } = await sb().from(table).insert(body).select().single();
    if (error) {
      await releaseQuota(sb(), quotaReservation?.id, proprietaireId).catch(() => {});
      const msg = String(error.message || '').toLowerCase();
      if (msg.includes('duplicate') || msg.includes('already')) {
        return res.status(409).json({ success: false, message: 'Un paiement existe déjà pour cette période.' });
      }
      console.error(`[agence/create:${table}]`, error.message);
      return res.status(500).json({ success: false, message: 'Erreur lors de la création.' });
    }

    gitAutoBackup(`Sauvegarde auto : ${req.user.account_type} · création ${table} (bien ${bienId})`);
    res.status(201).json({ success: true, data });
  } catch (err) {
    await releaseQuota(sb(), quotaReservation?.id, proprietaireId).catch(() => {});
    console.error(`[agence/create:${table}]`, err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de la création.' });
  }
}

// ============================================================
// Création scoped d'un locataire AVEC NOUVEAU compte locataire
// (formulaire unique « Ajouter un locataire », parité MODE 2 avec
// createTenantWithAccount de crud.js). Le logement est le cas
// échéant créé DANS le bien géré ; l'échéance initiale relit le
// loyer en base ; les identifiants générés sont imprévisibles.
// ============================================================
async function scopedCreateTenant(req, res) {
  // Même principe que scopedCreate : le catch libère les quotas, ces
  // variables doivent donc exister hors du bloc try.
  const { bienId, proprietaireId } = req.scope || {};
  const admin = sb();
  let logementReservation = null;
  let locataireReservation = null;
  // H-19 : tout objet créé pendant la requête est tracé ici, pour que
  // la moindre sortie anormale (dont le catch global) rembourse en
  // cascade — aucune donnée orpheline.
  let createdLogementId = null;
  let createdAccountUid = null;
  let createdLocataireId = null;

  // Remboursement en cascade, dans l'ordre inverse de création :
  // échéances -> fiche locataire -> compte Auth -> logement embarqué
  // -> réservations de quota. Idempotent (chaque étape est sautée si
  // l'objet n'a pas été créé) et jamais leakant : les réservations déjà
  // consommées sont ignorées par release_quota et les compteurs ne
  // tiennent que des lignes réellement présentes.
  const rollback = async (contexte) => {
    if (createdLocataireId) {
      await bestEffortDelete(admin.from('paiements').delete().eq('locataire_id', createdLocataireId));
      await bestEffortDelete(admin.from('locataires').delete().eq('id', createdLocataireId).eq('user_id', proprietaireId));
      createdLocataireId = null;
    }
    if (createdAccountUid) {
      await rollbackCreatedAccount(admin, createdAccountUid, contexte);
      createdAccountUid = null;
    }
    if (createdLogementId) {
      await bestEffortDelete(admin.from('logements').delete().eq('id', createdLogementId).eq('user_id', proprietaireId));
      createdLogementId = null;
    }
    await releaseQuota(admin, logementReservation?.id, proprietaireId).catch(() => {});
    await releaseQuota(admin, locataireReservation?.id, proprietaireId).catch(() => {});
  };

  try {
    const payload = req.body || {};

    const autoAccount = !payload.username && !payload.password;
    const username = String(payload.username || '').trim().toLowerCase();
    const password = autoAccount ? generateInitialPassword() : String(payload.password || '');
    const nom = String(payload.nom || '').trim();
    const logementNew = payload.logement && typeof payload.logement === 'object' ? payload.logement : null;
    const email = payload.email ? String(payload.email).trim() : null;
    const phone = payload.phone ? String(payload.phone).trim() : null;
    const dateEntree = payload.date_entree || null;
    const rawJour = payload.jour_echeance;
    const jourEcheance = rawJour === '' || rawJour == null ? 1 : Number(rawJour);
    const statut = payload.statut || 'actif';

    let logementId = logementNew ? null : payload.logement_id || null;
    let createdLogement = null;
    let logementLoyer = null;

    if (!nom) {
      return res.status(400).json({ success: false, message: 'Le nom est obligatoire.', errors: { nom: 'Le nom est obligatoire.' } });
    }
    if (!autoAccount) {
      if (!usernameIsValid(username)) {
        return res.status(400).json({ success: false, message: 'Le username doit contenir entre 3 et 32 caractères (lettres minuscules, chiffres, . _ -).', errors: { username: 'Le username doit contenir au moins 3 caractères (lettres minuscules, chiffres, . _ -).' } });
      }
      const pwError = passwordRuleError(password);
      if (pwError) {
        return res.status(400).json({ success: false, message: pwError, errors: { password: pwError } });
      }
    }
    if (email && !EMAIL_RE.test(email)) {
      return res.status(400).json({ success: false, message: 'Adresse email invalide.', errors: { email: 'Adresse email invalide.' } });
    }
    const jour = Number(jourEcheance);
    if (Number.isNaN(jour) || jour < 1 || jour > 31) {
      return res.status(400).json({ success: false, message: 'Le jour d\'échéance doit être entre 1 et 31.', errors: { jour_echeance: 'Le jour d\'échéance doit être entre 1 et 31.' } });
    }

    // Plafonds du plan du propriétaire géré (même règle que crud).
    const locatairesLimit = await enforceLocatairesLimit(proprietaireId);
    if (!locatairesLimit.allowed) {
      return res.status(409).json({ success: false, code: locatairesLimit.code, message: locatairesLimit.message, errors: { nom: locatairesLimit.message } });
    }
    if (logementNew) {
      const logementsLimit = await enforceLogementsLimit(proprietaireId);
      if (!logementsLimit.allowed) {
        return res.status(409).json({ success: false, code: logementsLimit.code, message: logementsLimit.message, errors: { logement: logementsLimit.message } });
      }
    }
    if (logementNew) {
      const limit = await enforceLogementsLimit(proprietaireId);
      if (!limit.allowed) {
        return res.status(409).json({ success: false, code: limit.code, message: limit.message, errors: { logement: limit.message } });
      }
    }

    if (logementId) {
      const err = await refBelongsToScope(req.scope, 'logement_id', logementId, 'logements');
      if (err) return res.status(400).json({ success: false, message: 'Logement introuvable ou hors du bien géré.', errors: { logement_id: 'Logement introuvable ou hors du bien géré.' } });
      const { data: logementRef } = await admin.from('logements').select('loyer_mensuel, bien_id').eq('id', logementId).maybeSingle();
      logementLoyer = logementRef?.loyer_mensuel ?? null;
    } else if (!logementNew) {
      return res.status(400).json({ success: false, message: 'Un logement est requis.', errors: { logement_id: 'Un logement est requis.' } });
    }

    // Username : manuel (vérifié) ou généré (imprévisible).
    let finalUsername;
    if (!autoAccount) {
      finalUsername = username;
      const { data: existingUsername } = await admin.from('profiles').select('id').ilike('username', finalUsername).maybeSingle();
      if (existingUsername) {
        return res.status(409).json({ success: false, code: 'USERNAME_ALREADY_EXISTS', message: 'Ce nom d\'utilisateur est déjà utilisé.', errors: { username: 'Ce nom d\'utilisateur est déjà utilisé.' } });
      }
    } else {
      const { prenom, nom: nomFamille } = splitFullName(nom);
      finalUsername = await uniqueUsername(admin, prenom, nomFamille);
      if (!finalUsername) {
        return res.status(400).json({ success: false, message: 'Impossible de générer un nom d\'utilisateur unique pour ce locataire.' });
      }
    }

    if (logementNew) {
      const limit = await enforceLogementsLimit(proprietaireId);
      logementReservation = await reserveQuota(admin, proprietaireId, 'logements', limit.max);
      if (!logementReservation.allowed) {
        return res.status(409).json({ success: false, code: logementReservation.code, message: logementReservation.message });
      }
    }
    locataireReservation = await reserveQuota(admin, proprietaireId, 'locataires', locatairesLimit.max);
    if (!locataireReservation.allowed) {
      await releaseQuota(admin, logementReservation?.id, proprietaireId).catch(() => {});
      return res.status(409).json({ success: false, code: locataireReservation.code, message: locataireReservation.message });
    }

    // Logement embarqué (après toutes les vérifications : jamais orphelin).
    if (logementNew) {
      const lg = sanitize('logements', { ...logementNew });
      lg.bien_id = bienId;
      if (!lg.adresse) {
        const { data: bien } = await admin.from('biens').select('adresse, ville, pays').eq('id', bienId).maybeSingle();
        if (bien) {
          const inherited = [bien.adresse, bien.ville, bien.pays].filter(Boolean).join(', ');
          if (inherited) lg.adresse = inherited;
        }
      }
      const errs = validateResource('logements', lg, false);
      if (Object.keys(errs).length) {
        await releaseQuota(admin, logementReservation?.id, proprietaireId).catch(() => {});
        await releaseQuota(admin, locataireReservation?.id, proprietaireId).catch(() => {});
        return res.status(400).json({
          success: false,
          message: 'Veuillez corriger les champs du logement.',
          errors: Object.fromEntries(Object.entries(errs).map(([k, v]) => [`logement_${k}`, v])),
        });
      }
      const { data: logement, error: lgError } = await admin
        .from('logements')
        .insert({ ...lg, user_id: proprietaireId, statut: statut === 'actif' ? 'occupe' : 'libre' })
        .select()
        .single();
      if (lgError) {
        await releaseQuota(admin, logementReservation?.id, proprietaireId).catch(() => {});
        await releaseQuota(admin, locataireReservation?.id, proprietaireId).catch(() => {});
        console.error('[agence/tenant:logement]', lgError.message);
        return res.status(400).json({ success: false, message: 'Erreur lors de la création du logement.' });
      }
      logementId = logement.id;
      createdLogementId = logement.id;
      createdLogement = logement;
      await consumeQuota(admin, logementReservation?.id, proprietaireId);
      logementLoyer = logement.loyer_mensuel;
    }

    // Un logement ne peut avoir qu'un seul locataire actif (règle crud).
    if (statut === 'actif' && logementId) {
      const { data: other } = await admin.from('locataires').select('id').eq('user_id', proprietaireId).eq('logement_id', logementId).eq('statut', 'actif').limit(1);
      if (other?.length) {
        await rollback('tenant:occupied');
        return res.status(400).json({ success: false, message: 'Ce logement est déjà occupé par un autre locataire actif.', errors: { logement_id: 'Ce logement est déjà occupé par un autre locataire actif.' } });
      }
    }

    const { data: createdUser, error: createError } = await admin.auth.admin.createUser({
      email: tenantEmailFor(finalUsername),
      password,
      email_confirm: true,
      user_metadata: {
        name: nom,
        username: finalUsername,
        phone: phone || '',
      },
      app_metadata: {
        mim_account_type: 'locataire',
        mim_must_change_password: true,
      },
    });

    if (createError || !createdUser?.user?.id) {
      await rollback('tenant:createUser');
      const msg = String(createError?.message || '').toLowerCase();
      if (msg.includes('already') || msg.includes('existe')) {
        return res.status(409).json({ success: false, code: 'USERNAME_ALREADY_EXISTS', message: 'Ce nom d\'utilisateur est déjà utilisé.', errors: { username: 'Ce nom d\'utilisateur est déjà utilisé.' } });
      }
      console.error('[agence/tenant:createUser]', createError?.message);
      return res.status(400).json({ success: false, message: 'Impossible de créer le compte locataire.' });
    }

    const accountUid = createdUser.user.id;
    createdAccountUid = accountUid;
    let accountWarnings = [];
    try {
      const provisioned = await provisionProfile(admin, accountUid, 'locataire', finalUsername, true, email);
      accountWarnings = provisioned?.warnings || [];
    } catch (profileError) {
      console.error('[agence/tenant:profile]', profileError.message);
      await rollback('tenant:profile');
      return res.status(500).json({ success: false, message: 'Impossible de finaliser le compte locataire.' });
    }

    const { data: row, error: rowError } = await admin
      .from('locataires')
      .insert({
        user_id: proprietaireId,
        account_uid: accountUid,
        username: finalUsername,
        nom,
        email,
        phone,
        logement_id: logementId,
        bien_id: bienId,
        date_entree: dateEntree,
        jour_echeance: jour,
        statut,
      })
      .select()
      .single();

    if (rowError) {
      console.error('[agence/tenant:insert]', rowError.message);
      await rollback('tenant:insert');
      return res.status(400).json({ success: false, message: 'Erreur lors de la création du locataire.' });
    }
    createdLocataireId = row.id;

    if (logementId) {
      await admin.from('logements').update({ statut: 'occupe' }).eq('id', logementId).eq('user_id', proprietaireId);
    }

    let echeance = null;
    if (autoAccount && logementId && logementLoyer != null) {
      echeance = await creerEcheanceInitiale(admin, {
        userId: proprietaireId,
        locataireId: row.id,
        logementId,
        montant: logementLoyer,
        dateEntree,
      });
      if (echeance.error) {
        console.error('[agence/tenant:échéance]', echeance.error);
        await rollback('tenant:echeance');
        return res.status(400).json({ success: false, message: 'Impossible de créer l\'échéance du loyer. Veuillez réessayer.' });
      }
    }

    await consumeQuota(admin, locataireReservation?.id, proprietaireId);
    try {
      await notify(accountUid, 'info', 'Votre compte locataire a été créé par votre propriétaire. À votre première connexion, vous devrez choisir un nouveau mot de passe.');
    } catch (e) {
      console.warn('[agence/tenant:notify]', e.message);
    }

    gitAutoBackup(`Sauvegarde auto : ajout locataire (compte ${finalUsername}) via agence bien ${bienId}`);

    res.status(201).json({
      success: true,
      data: row,
      accountCreated: true,
      autoAccount,
      account: autoAccount ? { username: finalUsername, password } : undefined,
      logement: createdLogement || null,
      echeance: echeance && echeance.created ? { mois: echeance.mois } : null,
      ...(accountWarnings.length ? { warnings: accountWarnings } : {}),
    });
  } catch (err) {
    // H-19 : le catch global rembourse aussi ce qui avait déjà été créé
    // (avant : logement, compte et fiche survivaient à l'exception).
    await rollback('tenant');
    console.error('[agence/tenant]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de la création du locataire.' });
  }
}

async function validateScopedEffectiveRecord(scope, table, record) {
  const errors = {};
  const invalid = (field, message) => { errors[field] = message; };
  const { proprietaireId, bienId } = scope;

  if (table === 'logements') {
    if (Number(record.bien_id) !== Number(bienId)) invalid('bien_id', 'Le bien est hors de votre portée.');
  }

  if (table === 'locataires') {
    if (record.logement_id) {
      const err = await refBelongsToScope(scope, 'logement_id', record.logement_id, 'logements');
      if (err) invalid('logement_id', err);
      const { data: dwelling } = await sb().from('logements').select('bien_id').eq('id', record.logement_id).eq('user_id', proprietaireId).maybeSingle();
      if (!dwelling || Number(dwelling.bien_id) !== Number(bienId)) invalid('logement_id', 'Le logement est hors de votre portée.');
      if (record.bien_id != null && Number(record.bien_id) !== Number(bienId)) invalid('bien_id', 'Le bien est hors de votre portée.');
    }
  }

  if (table === 'paiements') {
    if (!record.locataire_id) invalid('locataire_id', 'Un locataire est requis.');
    if (!record.logement_id) invalid('logement_id', 'Un logement est requis.');
    if (record.logement_id) {
      const err = await refBelongsToScope(scope, 'logement_id', record.logement_id, 'logements');
      if (err) invalid('logement_id', err);
    }
    if (record.locataire_id) {
      const err = await refBelongsToScope(scope, 'locataire_id', record.locataire_id, 'locataires');
      if (err) invalid('locataire_id', err);
      const { data: tenant } = await sb().from('locataires').select('logement_id, user_id').eq('id', record.locataire_id).maybeSingle();
      if (!tenant || tenant.user_id !== proprietaireId || Number(tenant.logement_id) !== Number(record.logement_id)) invalid('locataire_id', 'Le locataire et le logement ne correspondent pas.');
    }
  }

  if (table === 'incidents' && record.logement_id) {
    const err = await refBelongsToScope(scope, 'logement_id', record.logement_id, 'logements');
    if (err) invalid('logement_id', err);
  }

  if (table === 'interventions') {
    if (record.logement_id) {
      const err = await refBelongsToScope(scope, 'logement_id', record.logement_id, 'logements');
      if (err) invalid('logement_id', err);
    }
    if (record.incident_id) {
      const err = await refBelongsToScope(scope, 'incident_id', record.incident_id, 'incidents');
      if (err) invalid('incident_id', err);
      const { data: incident } = await sb().from('incidents').select('logement_id, user_id').eq('id', record.incident_id).maybeSingle();
      if (!incident || incident.user_id !== proprietaireId || Number(incident.logement_id) !== Number(record.logement_id)) invalid('incident_id', 'L\'incident et le logement ne correspondent pas.');
    }
    if (record.prestataire_id) {
      const { data: provider } = await sb().from('prestataires').select('id, user_id').eq('id', record.prestataire_id).maybeSingle();
      if (!provider || provider.user_id !== proprietaireId) invalid('prestataire_id', 'Le prestataire est introuvable.');
    }
  }

  return errors;
}

async function scopedUpdate(req, res, table) {
  // Déclarées avant le try pour être atteignables depuis le catch.
  const { bienId, proprietaireId } = req.scope || {};
  let logementReservation = null;
  // H-19 : un logement « logement_new » créé pendant la requête doit
  // être remboursé si la validation principale ou la mise à jour de la
  // fiche échoue — jamais de logement orphelin. Une fois la fiche
  // sauvegardée, le logement est référencé : plus de rollback.
  let createdLogementId = null;
  let saved = false;
  const rollbackLogement = async (contexte) => {
    if (createdLogementId) {
      await bestEffortDelete(sb().from('logements').delete().eq('id', createdLogementId).eq('user_id', proprietaireId));
      createdLogementId = null;
    }
    await releaseQuota(sb(), logementReservation?.id, proprietaireId).catch(() => {});
    if (contexte) console.warn(`[agence/update:${table}]`, `rollback du logement créé (${contexte})`);
  };
  try {
    const id = Number(req.params.id);
    const payload = req.body || {};
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'Identifiant invalide.' });
    }

    // La ligne cible doit appartenir au propriétaire ET au bien géré.
    const { data: row } = await sb()
      .from(table)
      .select('*')
      .eq('id', id)
      .eq('user_id', proprietaireId)
      .maybeSingle();
    if (!row) return res.status(404).json({ success: false, message: 'Élément introuvable.' });

    const cfg = SCOPED[table];
    if (cfg.viaLogement) {
      const logementIds = await bienLogementIds(proprietaireId, bienId);
      if (!row.logement_id || !logementIds.includes(row.logement_id)) {
        return res.status(403).json({ success: false, message: 'Hors du bien géré.' });
      }
    } else if (Number(row[cfg.bienColumn]) !== Number(bienId)) {
      return res.status(403).json({ success: false, message: 'Hors du bien géré.' });
    }

    const clean = sanitize(table, payload);
    if (table === 'locataires' && ('username' in payload || 'password' in payload)) {
      return res.status(400).json({ success: false, message: 'Le compte du locataire se modifie depuis son profil.' });
    }

    // Parité avec le PUT générique (/api/crud) : un locataire peut embarquier
    // la création ou la modification de son logement (formulaire fusionné).
    if (table === 'locataires') {
      const admin = sb();
      if (payload.logement_new && typeof payload.logement_new === 'object') {
        let lg = sanitize('logements', { ...payload.logement_new });
        if (!lg.adresse) {
          const { data: bien } = await admin.from('biens').select('adresse, ville, pays').eq('id', bienId).maybeSingle();
          if (bien) {
            const inherited = [bien.adresse, bien.ville, bien.pays].filter(Boolean).join(', ');
            if (inherited) lg.adresse = inherited;
          }
        }
        lg.bien_id = bienId;
        const lgErrs = validateResource('logements', lg, false);
        if (Object.keys(lgErrs).length) {
          return res.status(400).json({
            success: false,
            message: 'Veuillez corriger les champs du logement.',
            errors: Object.fromEntries(Object.entries(lgErrs).map(([k, v]) => [`logement_${k}`, v])),
          });
        }
        const limit = await enforceLogementsLimit(proprietaireId);
        if (!limit.allowed) {
          return res.status(409).json({ success: false, code: limit.code, message: limit.message, errors: { logement: limit.message } });
        }
        logementReservation = await reserveQuota(admin, proprietaireId, 'logements', limit.max);
        if (!logementReservation.allowed) {
          return res.status(409).json({ success: false, code: logementReservation.code, message: logementReservation.message });
        }
        const { data: logement, error: lgError } = await admin
          .from('logements')
          .insert({ ...lg, user_id: proprietaireId, statut: (clean.statut ?? 'actif') === 'actif' ? 'occupe' : 'libre' })
          .select()
          .single();
        if (lgError) {
          await releaseQuota(admin, logementReservation?.id, proprietaireId).catch(() => {});
          console.error('[agence/update:logement_new]', lgError.message);
          return res.status(400).json({ success: false, message: 'Erreur lors de la création du logement.', errors: { logement: 'Erreur lors de la création du logement.' } });
        }
        await consumeQuota(admin, logementReservation?.id, proprietaireId);
        createdLogementId = logement.id;
        clean.logement_id = logement.id;
      } else if (payload.logement_update && typeof payload.logement_update === 'object') {
        const targetId = Number(payload.logement_update.id);
        if (targetId && Number.isInteger(targetId)) {
          const err = await refBelongsToScope(req.scope, 'logement_id', String(targetId), 'logements');
          if (err) return res.status(400).json({ success: false, message: 'Le logement est introuvable ou hors du bien géré.', errors: { logement_id: 'Le logement est introuvable ou hors du bien géré.' } });
          const upd = sanitize('logements', { ...payload.logement_update, id: undefined });
          delete upd.id;
          delete upd.bien_id;
          if (Object.keys(upd).length) {
            const { data: prevLg } = await admin.from('logements').select('loyer_mensuel').eq('id', targetId).eq('user_id', proprietaireId).maybeSingle();
            const { data: updatedLg, error: upErr } = await admin.from('logements').update(upd).eq('id', targetId).eq('user_id', proprietaireId).select().single();
            if (upErr) {
              console.error('[agence/update:logement_update]', upErr.message);
              return res.status(400).json({ success: false, message: 'Erreur lors de la modification du logement.', errors: { logement: 'Erreur lors de la modification du logement.' } });
            }
            if (prevLg && upd.loyer_mensuel !== undefined && Number(upd.loyer_mensuel) !== Number(prevLg.loyer_mensuel)) {
              const { syncMontantEcheancesOuvertes } = await import('../utils/echeances.js');
              const synced = await syncMontantEcheancesOuvertes(admin, { logementId: targetId, montant: upd.loyer_mensuel });
              if (synced.error) {
                return res.status(503).json({ success: false, code: 'RENT_SYNC_FAILED', message: 'Le logement a été modifié, mais les échéances ouvertes n\'ont pas pu être synchronisées.' });
              }
            }
            if (updatedLg) clean.logement_id = updatedLg.id;
          }
        }
      }
    }

    const effective = { ...row, ...clean };
    const effectiveErrors = {
      ...validateResource(table, effective, false),
      ...(await validateScopedEffectiveRecord(req.scope, table, effective)),
    };
    if (Object.keys(effectiveErrors).length) {
      await rollbackLogement('validation');
      return res.status(400).json({ success: false, message: 'Données invalides.', errors: effectiveErrors });
    }

    delete clean.user_id;
    delete clean.bien_id;

    // Un logement ne peut avoir qu'un seul locataire actif (règle crud).
    if (table === 'locataires') {
      const targetLogementId = clean.logement_id ?? row.logement_id;
      const willBeActive = (clean.statut ?? row.statut) === 'actif';
      if (willBeActive && targetLogementId) {
        const { data: other } = await sb()
          .from('locataires')
          .select('id')
          .eq('user_id', proprietaireId)
          .eq('logement_id', targetLogementId)
          .eq('statut', 'actif')
          .neq('id', id)
          .limit(1);
        if (other?.length) {
          return res.status(400).json({ success: false, message: 'Ce logement est déjà occupé par un autre locataire actif.', errors: { logement_id: 'Ce logement est déjà occupé par un autre locataire actif.' } });
        }
      }
    }

    let updateQuery = sb().from(table).update(clean).eq('id', id).eq('user_id', proprietaireId);
    if (cfg.viaLogement) {
      const logementIds = await bienLogementIds(proprietaireId, bienId);
      updateQuery = updateQuery.in('logement_id', logementIds.length ? logementIds : [0]);
    } else {
      updateQuery = updateQuery.eq('bien_id', bienId);
    }
    const { data, error } = await updateQuery.select().single();
    if (error) {
      console.error(`[agence/update:${table}]`, error.message);
      await rollbackLogement('save');
      return res.status(500).json({ success: false, message: 'Erreur lors de la modification.' });
    }
    saved = true;

    if (table === 'locataires') {
      const targetLogementId = data.logement_id;
      if (clean.logement_id && clean.logement_id !== row.logement_id) {
        const { error: paymentSyncError } = await sb()
          .from('paiements')
          .update({ logement_id: clean.logement_id })
          .eq('user_id', proprietaireId)
          .eq('locataire_id', id)
          .in('statut', ['attente', 'retard', 'en_validation'])
          .is('superseded_at', null);
        if (paymentSyncError) {
          return res.status(503).json({ success: false, code: 'PAYMENT_SYNC_FAILED', message: 'Le locataire a été déplacé, mais les échéances ouvertes n\'ont pas pu être synchronisées.' });
        }
        if (targetLogementId) {
          await sb().from('logements').update({ statut: 'occupe' }).eq('id', targetLogementId).eq('user_id', proprietaireId);
        }
        await freeScopedLogementIfUnused(proprietaireId, row.logement_id);
      } else if (targetLogementId) {
        await sb().from('logements').update({ statut: 'occupe' }).eq('id', targetLogementId).eq('user_id', proprietaireId);
      }
      if (clean.statut !== undefined && clean.statut !== row.statut && row.account_uid) {
        const { error: banError } = await sb().auth.admin.updateUserById(row.account_uid, {
          ban_duration: clean.statut === 'inactif' ? '8760h' : 'none',
        });
        if (banError) {
          return res.status(503).json({ success: false, code: 'AUTH_STATUS_SYNC_FAILED', message: 'La fiche a été modifiée, mais le compte Auth n\'a pas pu être synchronisé.' });
        }
        if (clean.statut === 'inactif') await revokeAllSessions(row.account_uid, null, 'agency_tenant_status_changed');
      }
    }

    if (table === 'paiements' && clean.statut === 'paye') {
      try {
        const tenantUid = await tenantUidOfLocataire(data.locataire_id);
        if (tenantUid) {
          await notify(tenantUid, 'paiement', `Votre loyer de ${data.mois} a été confirmé.`);
        }
      } catch (e) {
        console.warn('[agence/update:notify]', e.message);
      }
    }

    gitAutoBackup(`Sauvegarde auto : ${req.user.account_type} · modification ${table} (bien ${bienId})`);
    res.json({ success: true, data });
  } catch (err) {
    // H-19 : toute exception postérieure à la création du logement
    // embarqué le rembourse (avant : il restait orphelin).
    if (!saved) await rollbackLogement('exception');
    console.error(`[agence/update:${table}]`, err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de la modification.' });
  }
}

async function scopedDelete(req, res, table) {
  try {
    const { bienId, proprietaireId } = req.scope;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: 'Identifiant invalide.' });
    }

    const { data: row } = await sb()
      .from(table)
      .select('id')
      .eq('id', id)
      .eq('user_id', proprietaireId)
      .maybeSingle();
    if (!row) return res.status(404).json({ success: false, message: 'Élément introuvable.' });

    if (table === 'paiements') {
      return res.status(409).json({ success: false, code: 'FINANCIAL_RECORD_IMMUTABLE', message: 'Un paiement ne peut pas être supprimé.' });
    }

    const cfg = SCOPED[table];
    if (cfg.viaLogement) {
      const { data: full } = await sb().from(table).select('logement_id').eq('id', id).maybeSingle();
      const logementIds = await bienLogementIds(proprietaireId, bienId);
      if (!full?.logement_id || !logementIds.includes(full.logement_id)) {
        return res.status(403).json({ success: false, message: 'Hors du bien géré.' });
      }
    } else {
      const { data: full } = await sb().from(table).select(cfg.bienColumn).eq('id', id).maybeSingle();
      if (full && Number(full[cfg.bienColumn]) !== Number(bienId)) {
        return res.status(403).json({ success: false, message: 'Hors du bien géré.' });
      }
    }

    // H-19 : mêmes invariants de suppression que le CRUD propriétaire —
    // un logement porteur d'un historique (locataire ou paiement) n'est
    // jamais supprimé, sous peine de fiche locataire sans logement ni
    // d'historique financier orphelin.
    if (table === 'logements') {
      const { data: ref } = await sb()
        .from('locataires')
        .select('id')
        .eq('logement_id', id)
        .limit(1)
        .maybeSingle();
      if (ref) {
        return res.status(409).json({
          success: false,
          code: 'TENANT_HISTORY_PRESENT',
          message: 'Ce logement est lié à un historique de locataire et ne peut pas être supprimé.',
        });
      }
      const { data: payment } = await sb()
        .from('paiements')
        .select('id')
        .eq('logement_id', id)
        .limit(1)
        .maybeSingle();
      if (payment) {
        return res.status(409).json({
          success: false,
          code: 'FINANCIAL_HISTORY_PRESENT',
          message: 'Ce logement possède des paiements historiques et ne peut pas être supprimé.',
        });
      }
    }

    if (table === 'locataires') {
      const { data: existingTenant, error: readError } = await sb()
        .from('locataires')
        .select('account_uid, logement_id')
        .eq('id', id)
        .eq('user_id', proprietaireId)
        .maybeSingle();
      if (readError || !existingTenant) {
        return res.status(400).json({ success: false, message: 'Erreur lors de l\'archivage du locataire.' });
      }
      const { error: tenantError } = await sb()
        .from('locataires')
        .update({ statut: 'inactif', account_uid: null, superseded_at: new Date().toISOString() })
        .eq('id', id)
        .eq('user_id', proprietaireId);
      if (tenantError) {
        return res.status(400).json({ success: false, message: 'Erreur lors de l\'archivage du locataire.' });
      }
      if (existingTenant.account_uid) {
        const { error: banError } = await sb().auth.admin.updateUserById(existingTenant.account_uid, { ban_duration: '8760h' });
        if (banError) return res.status(503).json({ success: false, message: 'Fiche archivée, mais le compte Auth n\'a pas été désactivé.' });
        await revokeAllSessions(existingTenant.account_uid, null, 'agency_tenant_archived');
      }
      await freeScopedLogementIfUnused(proprietaireId, existingTenant.logement_id);
      gitAutoBackup(`Sauvegarde auto : ${req.user.account_type} · archivage locataire (bien ${bienId})`);
      return res.json({ success: true, message: 'Locataire archivé. Les historiques financiers sont conservés.' });
    }

    let deleteQuery = sb().from(table).delete().eq('id', id).eq('user_id', proprietaireId);
    if (cfg.viaLogement) {
      const logementIds = await bienLogementIds(proprietaireId, bienId);
      deleteQuery = deleteQuery.in('logement_id', logementIds.length ? logementIds : [0]);
    } else {
      deleteQuery = deleteQuery.eq('bien_id', bienId);
    }
    const { error } = await deleteQuery;
    if (error) {
      console.error(`[agence/delete:${table}]`, error.message);
      return res.status(500).json({ success: false, message: 'Erreur lors de la suppression.' });
    }

    gitAutoBackup(`Sauvegarde auto : ${req.user.account_type} · suppression ${table} (bien ${bienId})`);
    res.json({ success: true, message: 'Supprimé.' });
  } catch (err) {
    console.error(`[agence/delete:${table}]`, err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de la suppression.' });
  }
}

// Montage des routes CRUD scoped (listes + actions), formes idem /api/crud.
const SCOPED_TABLES = ['logements', 'locataires', 'paiements', 'incidents', 'interventions', 'depenses'];

for (const table of SCOPED_TABLES) {
  router.get(`/bien/:bienId/${table}`, requireMandateBien, (req, res) => scopedList(req, res, table));
  router.post(`/bien/:bienId/${table}`, requireMandateBien, (req, res) => scopedCreate(req, res, table));
  router.put(`/bien/:bienId/${table}/:id`, requireMandateBien, (req, res) => scopedUpdate(req, res, table));
  router.delete(`/bien/:bienId/${table}/:id`, requireMandateBien, (req, res) => scopedDelete(req, res, table));
}

// ============================================================
// MODE 2 — Validation des paiements du bien géré
//   (mêmes règles que validations.js mais scopées sur le bien).
// ============================================================
router.get('/bien/:bienId/paiements-validation/en-attente', requireMandateBien, async (req, res) => {
  try {
    const { bienId, proprietaireId } = req.scope;
    const logementIds = await bienLogementIds(proprietaireId, bienId);
    const logementIdsEsc = logementIds.length ? logementIds : [0];

    const { data: paiements = [] } = await sb()
      .from('paiements')
      .select('*')
      .eq('user_id', proprietaireId)
      .eq('statut', 'en_validation')
      .in('logement_id', logementIdsEsc)
      .order('validation_requested_at', { ascending: false });

    const locatairesIds = [...new Set(paiements.map((p) => p.locataire_id))];
    const logementsIds = [...new Set(paiements.map((p) => p.logement_id).filter(Boolean))];

    const [locatairesRes, logementsRes] = await Promise.all([
      locatairesIds.length ? sb().from('locataires').select('id, nom').in('id', locatairesIds) : Promise.resolve({ data: [] }),
      logementsIds.length ? sb().from('logements').select('id, nom').in('id', logementsIds) : Promise.resolve({ data: [] }),
    ]);
    const locBy = new Map((locatairesRes.data || []).map((l) => [String(l.id), l]));
    const lgBy = new Map((logementsRes.data || []).map((l) => [String(l.id), l]));

    res.json({
      success: true,
      data: paiements.map((p) => ({
        ...p,
        locataire_nom: locBy.get(String(p.locataire_id))?.nom || null,
        logement_nom: lgBy.get(String(p.logement_id))?.nom || null,
      })),
    });
  } catch (err) {
    console.error('[agence/paiements-validation/en-attente]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement.' });
  }
});

router.post('/bien/:bienId/paiements-validation/:id/valider', requireMandateBien, async (req, res) => {
  try {
    const { bienId, proprietaireId } = req.scope;
    const id = Number(req.params.id);
    const logementIds = await bienLogementIds(proprietaireId, bienId);
    const logementIdsEsc = logementIds.length ? logementIds : [0];

    const { data: paiement } = await sb()
      .from('paiements')
      .select('id, user_id, locataire_id, logement_id, montant, mois, statut, validated_at, reference')
      .eq('id', id)
      .eq('user_id', proprietaireId)
      .in('logement_id', logementIdsEsc)
      .maybeSingle();

    if (!paiement) return res.status(404).json({ success: false, message: 'Paiement introuvable.' });
    if (paiement.statut !== 'en_validation') {
      const message = paiement.statut === 'paye' ? 'Ce paiement est déjà validé.' : 'Ce paiement ne peut pas être validé.';
      return res.status(400).json({ success: false, message });
    }

    const { data: updated, error } = await sb()
      .from('paiements')
      .update({ statut: 'paye', validated_at: new Date().toISOString(), validated_by: req.user.id })
      .eq('id', paiement.id)
      .eq('statut', 'en_validation')
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!updated) return res.status(409).json({ success: false, message: 'Ce paiement a déjà été traité.' });

    const echeance = await creerEcheanceSuivante(sb(), paiement);

    try {
      const tenantUid = await tenantUidOfLocataire(paiement.locataire_id);
      if (tenantUid) {
        const nomLogement = await logementNomOf(paiement.logement_id);
        await notify(
          tenantUid,
          'paiement',
          `Paiement validé — votre propriétaire a confirmé votre paiement de ` +
            `${Number(paiement.montant).toLocaleString('fr-FR')} FCFA (${formatMois(paiement.mois)}).` +
            (echeance.created ? ` Prochaine échéance : ${formatMois(echeance.mois)}.` : '')
        );
      }
    } catch (e) {
      console.warn('[agence/valider] notification :', e.message);
    }

    res.json({
      success: true,
      data: updated,
      echeance: echeance.created ? { mois: echeance.mois } : null,
      message: echeance.created
        ? `Paiement validé. Nouvelle échéance créée (${formatMois(echeance.mois)}).`
        : echeance.error
          ? `Paiement validé, mais l'échéance suivante n'a pas pu être créée : ${echeance.error}`
          : 'Paiement validé.',
    });
  } catch (err) {
    console.error('[agence/paiements-validation/valider]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de la validation.' });
  }
});

router.post('/bien/:bienId/paiements-validation/:id/refuser', requireMandateBien, async (req, res) => {
  try {
    const motif = String((req.body || {}).motif || '').trim();
    if (!motif || motif.length > 200) {
      return res.status(400).json({ success: false, message: 'Un motif de refus est requis (200 caractères max).' });
    }

    const { bienId, proprietaireId } = req.scope;
    const id = Number(req.params.id);
    const logementIds = await bienLogementIds(proprietaireId, bienId);
    const logementIdsEsc = logementIds.length ? logementIds : [0];

    const { data: paiement } = await sb()
      .from('paiements')
      .select('id, user_id, locataire_id, logement_id, montant, mois, statut')
      .eq('id', id)
      .eq('user_id', proprietaireId)
      .in('logement_id', logementIdsEsc)
      .maybeSingle();

    if (!paiement) return res.status(404).json({ success: false, message: 'Paiement introuvable.' });
    if (paiement.statut !== 'en_validation') {
      const message = paiement.statut === 'paye' ? 'Ce paiement est déjà validé.' : 'Ce paiement ne peut pas être refusé.';
      return res.status(400).json({ success: false, message });
    }

    const { data: updated, error } = await sb()
      .from('paiements')
      .update({ statut: 'refuse', rejection_reason: motif })
      .eq('id', paiement.id)
      .eq('statut', 'en_validation')
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!updated) return res.status(409).json({ success: false, message: 'Ce paiement a déjà été traité.' });

    try {
      const tenantUid = await tenantUidOfLocataire(paiement.locataire_id);
      if (tenantUid) {
        await notify(
          tenantUid,
          'paiement',
          `Paiement non validé — votre demande pour ${formatMois(paiement.mois)} (${Number(paiement.montant).toLocaleString('fr-FR')} FCFA) ` +
            `n'a pas été confirmée par votre propriétaire. Motif : ${motif}. Contactez-le pour régulariser.`
        );
      }
    } catch (e) {
      console.warn('[agence/refuser] notification :', e.message);
    }

    res.json({ success: true, data: updated, message: 'Déclaration refusée. Le locataire en a été informé.' });
  } catch (err) {
    console.error('[agence/paiements-validation/refuser]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du refus.' });
  }
});

// ============================================================
// MODE 2 — Liste des prestataires du propriétaire (sélecteurs des
//   pages interventions). Les prestataires ne sont pas scoped par
//   bien (table sans bien_id) : lecture seule au niveau propriétaire.
// ============================================================
router.get('/bien/:bienId/prestataires', requireMandateBien, async (req, res) => {
  try {
    const { data = [] } = await sb()
      .from('prestataires')
      .select('*')
      .eq('user_id', req.scope.proprietaireId)
      .order('created_at', { ascending: false });
    res.json({ success: true, data });
  } catch (err) {
    console.error('[agence/bien/prestataires]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement.' });
  }
});

// ============================================================
// MODE 2 — Biens du PROPRIÉTAIRE GÉRÉ.
//
// Les employés, leurs tâches, leurs salaires et leurs moyens de
// paiement appartiennent au propriétaire, pas au bien : ils sont
// scopés par le MANDAT (requireMandateBien), jamais par le bien
// lui-même. `/biens` renvoie donc TOUS les biens du propriétaire,
// comme le fait `/api/biens` dans l'espace propriétaire — c'est
// cette liste qu'alimentent les sélecteurs d'affectation.
// ============================================================
router.get('/bien/:bienId/biens', requireMandateBien, async (req, res) => {
  try {
    const { data = [], error } = await sb()
      .from('biens')
      .select('*')
      .eq('user_id', req.scope.proprietaireId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('[agence/bien/biens]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement.' });
  }
});

// ============================================================
// MODE 2 — Employés, tâches et moyens de paiement.
//
// Les routeurs propriétaires sont montés TEL QUELS sous le scope
// du bien : `withScopeOwner` y remplace le propriétaire cible par le
// PROPRIÉTAIRE GÉRÉ. Les contrats (chemins, formes de réponse,
// codes d'erreur, validations, quotas, génération du compte Auth)
// sont donc rigoureusement ceux de /api/employes, /api/tasks et
// /api/moyens-paiement : les pages du dashboard propriétaire
// fonctionnent à l'identique en changeant seulement la base API.
//
// `requireMandateBien` remplace le `mandatGuard` de ces mounts :
// même exigence (écriture seulement sous mandat actif), vérifiée
// fail-closed sur le couple agence/bien/propriétaire.
// ============================================================
const scopedOwner = [requireMandateBien, withScopeOwner];

router.use('/bien/:bienId/employes', ...scopedOwner, employesRoutes);
router.use('/bien/:bienId/tasks', ...scopedOwner, tasksRoutes);
router.use('/bien/:bienId/moyens-paiement', ...scopedOwner, moyensPaiementRoutes);

export default router;
export { mandateBien, mandateOwner };