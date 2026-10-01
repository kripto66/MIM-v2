// ============================================================
// MIM - Espace « propriétaire confié à une agence » (shadow)
//   Le propriétaire garde la propriété de ses biens mais en confie
//   la gestion à une agence (mandat). Il NE PEUT PAS créer ni
//   modifier les locataires / employés / loyers : il consulte, il
//   dialogue avec son agence et il confirme les versements reçus.
// ============================================================

import { Router } from 'express';
import { serviceClient } from '../app.js';
import { notify } from '../utils/notifications.js';
import { MANDAT_STATUTS, mandatMotifError, mandatReactivateError, applyMandatStatut } from '../utils/mandatRevocation.js';

const router = Router();
const sb = () => serviceClient();

async function mandatOf(userId) {
  const { data, error } = await sb()
    .from('agences_proprietaires')
    .select('id, agence_id, statut, motif, updated_at, created_at')
    .eq('proprietaire_id', userId)
    .eq('statut', 'actif')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

async function requireMandate(req, res, next) {
  try {
    const mandat = await mandatOf(req.user.id);
    if (!mandat) {
      return res.status(404).json({
        success: false,
        code: 'MANDAT_NOT_FOUND',
        message: "Aucun mandat actif pour ce compte.",
      });
    }
    req.mandat = mandat;
    next();
  } catch (err) {
    console.error('[mandat]', err.message);
    res.status(500).json({ success: false, message: 'Impossible de charger le mandat.' });
  }
}

// Biens réellement confiés (liaison agence_biens active) — seule
// base de tout le drill-down lecture seule de l'espace délégué.
async function mandatBienIds(proprietaireId) {
  const { data, error } = await sb()
    .from('agences_biens')
    .select('bien_id')
    .eq('proprietaire_id', proprietaireId)
    .eq('statut', 'actif');
  if (error) throw new Error(error.message);
  return (data || []).map((l) => l.bien_id).filter(Boolean);
}

function moisCourant() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

router.get('/etat', requireMandate, async (req, res) => {
  const { data: agence } = await sb()
    .from('profiles')
    .select('id, name, email, phone, username')
    .eq('id', req.mandat.agence_id)
    .maybeSingle();

  res.json({
    success: true,
    mandat: {
      agence_id: req.mandat.agence_id,
      agence: agence
        ? { id: agence.id, name: agence.name, email: agence.email, phone: agence.phone, username: agence.username }
        : null,
      depuis: req.mandat.created_at,
      motif: req.mandat.motif || null,
      maj: req.mandat.updated_at || null,
    },
  });
});

// ------------------------------------------------------------
// H-18 — Révocation / réactivation du mandat par le propriétaire.
// Route SANS requireMandate : le propriétaire doit pouvoir révoquer
// même s'il consulte l'état d'une liaison déjà inactive. La
// révocation coupe immédiatement l'accès de l'agence (mandatGuard,
// requireMandateBien, portefeuille et stats) et rouvre ses propres
// écritures (plus de mandat actif = garde délégué inactif).
// ------------------------------------------------------------
router.patch('/statut', async (req, res) => {
  try {
    const proprietaireId = req.user.id;
    const statut = String(req.body?.statut || '').trim();
    const motif = req.body?.motif ? String(req.body.motif).trim() : '';

    if (!MANDAT_STATUTS.has(statut)) {
      return res.status(400).json({ success: false, message: "Statut invalide (attendu : 'actif' ou 'inactif')." });
    }

    const { data: liaison, error } = await sb()
      .from('agences_proprietaires')
      .select('id, agence_id, proprietaire_id, statut, revoque_par, motif, updated_at, created_at')
      .eq('proprietaire_id', proprietaireId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!liaison) {
      return res.status(404).json({ success: false, code: 'MANDAT_NOT_FOUND', message: 'Aucun mandat pour ce compte.' });
    }

    if (statut === liaison.statut) {
      return res.json({ success: true, changed: false, statut: liaison.statut, message: 'Aucun changement.' });
    }

    const motifError = mandatMotifError(motif);
    if (motifError) {
      return res.status(400).json({ success: false, message: motifError, errors: { motif: motifError } });
    }

    const forbidden = mandatReactivateError(liaison, statut, proprietaireId);
    if (forbidden) {
      return res.status(forbidden.status).json({ success: false, code: forbidden.code, message: forbidden.message });
    }

    const result = await applyMandatStatut({
      liaison,
      scope: { proprietaire_id: proprietaireId },
      statut,
      motif,
      actorId: proprietaireId,
      actorRole: 'proprietaire',
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
        ? 'Mandat révoqué : votre agence n\'a plus accès à vos biens.'
        : 'Mandat rétabli.',
    });
  } catch (err) {
    console.error('[mandat/statut]', err.message);
    res.status(500).json({ success: false, message: 'Impossible de changer le statut du mandat.' });
  }
});

router.get('/dashboard', requireMandate, async (req, res) => {
  const proprietaireId = req.user.id;
  const agenceId = req.mandat.agence_id;

  const [biensRes, versementsRes, messagesRes, agenceRes] = await Promise.all([
    sb()
      .from('agences_biens')
      .select('bien_id, statut, created_at, biens(id, nom, type, adresse, ville, pays)')
      .eq('proprietaire_id', proprietaireId)
      .eq('statut', 'actif'),
    sb()
      .from('versements')
      .select('*')
      .eq('proprietaire_id', proprietaireId)
      .order('created_at', { ascending: false })
      .limit(50),
    sb()
      .from('messages')
      .select('id, objet, corps, auteur_id, lu_par_destinataire, created_at')
      .eq('proprietaire_id', proprietaireId)
      .order('created_at', { ascending: false })
      .limit(20),
    sb().from('profiles').select('id, name, email, phone, username').eq('id', agenceId).maybeSingle(),
  ]);

  if (biensRes.error) return res.status(500).json({ success: false, message: 'Impossible de charger les biens.' });
  if (versementsRes.error) return res.status(500).json({ success: false, message: 'Impossible de charger les versements.' });
  if (messagesRes.error) return res.status(500).json({ success: false, message: 'Impossible de charger la messagerie.' });

  const bienIds = (biensRes.data || []).map((b) => b.bien_id).filter(Boolean);
  const escaped = bienIds.length ? bienIds : [0];

  const [logementsRes] = await Promise.all([
    sb().from('logements').select('id, bien_id, nom, statut, loyer_mensuel').eq('user_id', proprietaireId).in('bien_id', escaped),
  ]);

  const logements = logementsRes.data || [];
  const logementIds = logements.map((l) => l.id);
  const logementIdsEsc = logementIds.length ? logementIds : [0];

  const [incidents, paiements] = await Promise.all([
    sb().from('incidents').select('id, titre, statut, logement_id, created_at').eq('user_id', proprietaireId).in('logement_id', logementIdsEsc).order('created_at', { ascending: false }).limit(20),
    sb().from('paiements').select('id, mois, montant, statut, date_paiement, logement_id').eq('user_id', proprietaireId).in('logement_id', logementIdsEsc).order('mois', { ascending: false }).limit(50),
  ]);

  if (paiements.error || incidents.error) {
    return res.status(500).json({ success: false, message: 'Impossible de charger les données du parc.' });
  }

  const parBien = (biensRes.data || []).map((lien) => {
    const bien = Array.isArray(lien.biens) ? lien.biens[0] : lien.biens;
    const bienLogements = logements.filter((l) => l.bien_id === lien.bien_id);
    const ids = new Set(bienLogements.map((l) => l.id));
    const bienPaiements = (paiements.data || []).filter((p) => ids.has(p.logement_id));
    const bienIncidents = (incidents.data || []).filter((i) => ids.has(i.logement_id));
    return {
      id: lien.bien_id,
      nom: bien?.nom || 'Bien #' + lien.bien_id,
      type: bien?.type || null,
      adresse: [bien?.adresse, bien?.ville].filter(Boolean).join(', ') || null,
      mandateDepuis: lien.created_at,
      logements: bienLogements.length,
      logementsOccupes: bienLogements.filter((l) => l.statut === 'occupe').length,
      loyerTotal: bienLogements.reduce((s, l) => s + Number(l.loyer_mensuel || 0), 0),
      incidents: bienIncidents.length,
      incidentsOuverts: bienIncidents.filter((i) => !['resolu', 'ferme'].includes(String(i.statut))).length,
      paiementsEnRetard: bienPaiements.filter((p) => p.statut === 'retard').length,
      paiementsEnAttente: bienPaiements.filter((p) => p.statut === 'attente').length,
      paiementsTotal: bienPaiements.reduce((s, p) => s + Number(p.montant || 0), 0),
    };
  });

  const versementRows = versementsRes.data || [];
  const totalVerse = versementRows
    .filter((v) => v.statut === 'effectue')
    .reduce((s, v) => s + Number(v.montant || 0), 0);
  const totalAttente = versementRows
    .filter((v) => v.statut === 'attente' || v.statut === 'en_cours')
    .reduce((s, v) => s + Number(v.montant || 0), 0);

  res.json({
    success: true,
    agence: agenceRes.data
      ? { id: agenceRes.data.id, name: agenceRes.data.name, email: agenceRes.data.email, phone: agenceRes.data.phone }
      : null,
    biens: parBien,
    totaux: {
      biens: parBien.length,
      logements: parBien.reduce((s, b) => s + b.logements, 0),
      occupes: parBien.reduce((s, b) => s + b.logementsOccupes, 0),
      loyerTotal: parBien.reduce((s, b) => s + b.loyerTotal, 0),
      verse: totalVerse,
      verseAttente: totalAttente,
      retards: parBien.reduce((s, b) => s + b.paiementsEnRetard, 0),
      incidentsOuverts: parBien.reduce((s, b) => s + b.incidentsOuverts, 0),
    },
    versements: versementRows,
    messages: messagesRes.data || [],
  });
});

// ------------------------------------------------------------
// Drill-down lecture seule — logements et locataires du parc
// confié. Aucune écriture ici : le mandat est géré par l'agence
// (mandatGuard refuse toute mutation côté propriétaire).
// ------------------------------------------------------------

router.get('/logements', requireMandate, async (req, res) => {
  try {
    const proprietaireId = req.user.id;
    const bienIds = await mandatBienIds(proprietaireId);
    const bienIdsEsc = bienIds.length ? bienIds : [0];

    // Biens et logements en deux requêtes : deux FK logements→biens
    // existent (simple + composite propriétaire), l'embed PostgREST est
    // donc ambigu et il faut figer un nom de contrainte — on préfère le
    // mapping explicite déjà utilisé par le dashboard.
    const [{ data: biens = [], error: bienError }, { data: logements = [], error }] = await Promise.all([
      sb().from('biens').select('id, nom, type, adresse, ville').eq('user_id', proprietaireId).in('id', bienIdsEsc),
      sb()
        .from('logements')
        .select('id, bien_id, nom, statut, loyer_mensuel')
        .eq('user_id', proprietaireId)
        .in('bien_id', bienIdsEsc),
    ]);
    if (bienError || error) throw new Error(bienError?.message || error.message);
    const bienById = new Map(biens.map((b) => [b.id, b]));

    const logementIds = logements.map((l) => l.id);
    const logementIdsEsc = logementIds.length ? logementIds : [0];
    const mois = moisCourant();

    const [locRes, paiRes, incRes] = await Promise.all([
      sb()
        .from('locataires')
        .select('id, logement_id, nom, date_entree, statut')
        .eq('user_id', proprietaireId)
        .in('logement_id', logementIdsEsc)
        .eq('statut', 'actif'),
      sb()
        .from('paiements')
        .select('id, logement_id, montant, statut, mois, date_paiement')
        .eq('user_id', proprietaireId)
        .in('logement_id', logementIdsEsc)
        .eq('mois', mois),
      sb()
        .from('incidents')
        .select('id, logement_id, statut')
        .eq('user_id', proprietaireId)
        .in('logement_id', logementIdsEsc),
    ]);
    if (locRes.error || paiRes.error || incRes.error) {
      throw new Error(locRes.error?.message || paiRes.error?.message || incRes.error?.message);
    }

    const locByLogement = new Map((locRes.data || []).map((l) => [l.logement_id, l]));
    const paiByLogement = new Map((paiRes.data || []).map((p) => [p.logement_id, p]));
    const incOuverts = new Map();
    for (const inc of incRes.data || []) {
      if (['resolu', 'ferme'].includes(String(inc.statut))) continue;
      incOuverts.set(inc.logement_id, (incOuverts.get(inc.logement_id) || 0) + 1);
    }

    const rows = logements.map((l) => {
      const bien = bienById.get(l.bien_id) || null;
      const loc = locByLogement.get(l.id) || null;
      const pai = paiByLogement.get(l.id) || null;
      return {
        id: l.id,
        bien_id: l.bien_id,
        bien_nom: bien?.nom || 'Bien #' + l.bien_id,
        nom: l.nom,
        statut: l.statut,
        loyer_mensuel: Number(l.loyer_mensuel || 0),
        locataire: loc ? { id: loc.id, nom: loc.nom, date_entree: loc.date_entree } : null,
        paiementMois: pai ? { id: pai.id, montant: Number(pai.montant || 0), statut: pai.statut, date_paiement: pai.date_paiement } : null,
        incidentsOuverts: incOuverts.get(l.id) || 0,
      };
    });

    res.json({
      success: true,
      mois,
      logements: rows,
      totaux: {
        logements: rows.length,
        occupes: rows.filter((l) => l.statut === 'occupe').length,
        loyerTotal: rows.reduce((s, l) => s + l.loyer_mensuel, 0),
        retards: rows.filter((l) => l.paiementMois?.statut === 'retard').length,
        enAttente: rows.filter((l) => l.paiementMois?.statut === 'attente').length,
        sansLocataire: rows.filter((l) => !l.locataire).length,
      },
    });
  } catch (err) {
    console.error('[mandat/logements]', err.message);
    res.status(500).json({ success: false, message: 'Impossible de charger les logements.' });
  }
});

router.get('/locataires', requireMandate, async (req, res) => {
  try {
    const proprietaireId = req.user.id;
    const bienIds = await mandatBienIds(proprietaireId);
    const bienIdsEsc = bienIds.length ? bienIds : [0];

    // Même motif que /logements : mapping explicite plutôt que l'embed
    // ambigu entre logements et biens (voir plus haut).
    const [{ data: biens = [], error: bienError }, { data: logements = [], error: lgError }] = await Promise.all([
      sb().from('biens').select('id, nom').eq('user_id', proprietaireId).in('id', bienIdsEsc),
      sb()
        .from('logements')
        .select('id, bien_id, nom, loyer_mensuel')
        .eq('user_id', proprietaireId)
        .in('bien_id', bienIdsEsc),
    ]);
    if (bienError || lgError) throw new Error(bienError?.message || lgError.message);
    const bienById = new Map(biens.map((b) => [b.id, b]));

    const logementById = new Map(logements.map((l) => [l.id, l]));
    const logementIds = logements.map((l) => l.id);
    const logementIdsEsc = logementIds.length ? logementIds : [0];
    const mois = moisCourant();

    const [locRes, paiRes] = await Promise.all([
      sb()
        .from('locataires')
        .select('id, logement_id, nom, phone, date_entree, statut, created_at')
        .eq('user_id', proprietaireId)
        .in('logement_id', logementIdsEsc)
        .order('created_at', { ascending: false }),
      sb()
        .from('paiements')
        .select('id, locataire_id, logement_id, montant, statut, mois')
        .eq('user_id', proprietaireId)
        .in('logement_id', logementIdsEsc)
        .eq('mois', mois),
    ]);
    if (locRes.error || paiRes.error) throw new Error(locRes.error?.message || paiRes.error?.message);

    // Appariement par locataire, avec repli par logement (un paiement
    // peut être saisi sans locataire_id).
    const paiByLocataire = new Map();
    const paiByLogement = new Map();
    for (const p of paiRes.data || []) {
      if (p.locataire_id) paiByLocataire.set(p.locataire_id, p);
      if (p.logement_id && !paiByLogement.has(p.logement_id)) paiByLogement.set(p.logement_id, p);
    }

    const rows = (locRes.data || []).map((loc) => {
      const logement = logementById.get(loc.logement_id) || null;
      const bien = logement ? bienById.get(logement.bien_id) || null : null;
      const pai = paiByLocataire.get(loc.id) || (loc.logement_id ? paiByLogement.get(loc.logement_id) : null) || null;
      return {
        id: loc.id,
        nom: loc.nom,
        phone: loc.phone || null,
        date_entree: loc.date_entree,
        statut: loc.statut,
        logement_id: loc.logement_id,
        logement_nom: logement?.nom || null,
        bien_nom: bien?.nom || null,
        loyer_mensuel: logement ? Number(logement.loyer_mensuel || 0) : 0,
        paiementMois: pai ? { id: pai.id, montant: Number(pai.montant || 0), statut: pai.statut } : null,
      };
    });

    res.json({
      success: true,
      mois,
      locataires: rows,
      totaux: {
        total: rows.length,
        actifs: rows.filter((l) => l.statut === 'actif').length,
        impayes: rows.filter((l) => l.paiementMois?.statut === 'retard').length,
        enAttente: rows.filter((l) => l.paiementMois?.statut === 'attente').length,
      },
    });
  } catch (err) {
    console.error('[mandat/locataires]', err.message);
    res.status(500).json({ success: false, message: 'Impossible de charger les locataires.' });
  }
});

// ------------------------------------------------------------
// Versements : le propriétaire confirme la réception d'un virement
// ------------------------------------------------------------

router.get('/versements', requireMandate, async (req, res) => {
  const { data, error } = await sb()
    .from('versements')
    .select('*')
    .eq('proprietaire_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ success: false, message: 'Impossible de charger les versements.' });
  res.json({ success: true, versements: data || [] });
});

router.post('/versements/:id/confirmer', requireMandate, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, message: 'Identifiant invalide.' });
  }

  const { data: row, error: readError } = await sb()
    .from('versements')
    .select('*')
    .eq('id', id)
    .eq('proprietaire_id', req.user.id)
    .maybeSingle();
  if (readError) return res.status(500).json({ success: false, message: 'Impossible de charger le versement.' });
  if (!row) return res.status(404).json({ success: false, message: 'Versement introuvable.' });
  if (row.statut === 'effectue') {
    return res.status(409).json({ success: false, code: 'ALREADY_CONFIRMED', message: 'Ce versement est déjà confirmé.' });
  }
  if (row.statut === 'annule') {
    return res.status(409).json({ success: false, code: 'CANCELLED', message: 'Ce versement a été annulé.' });
  }

  const reference = req.body?.reference ? String(req.body.reference).trim().slice(0, 100) : null;

  const { error } = await sb()
    .from('versements')
    .update({
      statut: 'effectue',
      effectue_a: new Date().toISOString(),
      effectue_par: req.user.id,
      reference: reference || row.reference,
    })
    .eq('id', id)
    .eq('proprietaire_id', req.user.id)
    .in('statut', ['attente', 'en_cours']);
  if (error) {
    return res.status(500).json({ success: false, message: 'Impossible de confirmer le versement.' });
  }

  try {
    await notify(row.agence_id, 'info', 'Le propriétaire a confirmé la réception d\'un versement.');
  } catch (e) {
    console.warn('[mandat/versement]', e.message);
  }

  res.json({ success: true, message: 'Versement confirmé.' });
});

// ------------------------------------------------------------
// Messagerie propriétaire <-> agence
// ------------------------------------------------------------

router.get('/messages', requireMandate, async (req, res) => {
  const { data, error } = await sb()
    .from('messages')
    .select('*')
    .eq('proprietaire_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return res.status(500).json({ success: false, message: 'Impossible de charger la messagerie.' });
  res.json({ success: true, messages: data || [] });
});

router.post('/messages', requireMandate, async (req, res) => {
  const corps = String(req.body?.corps || '').trim();
  const objet = req.body?.objet ? String(req.body.objet).trim().slice(0, 120) : null;
  if (!corps || corps.length > 4000) {
    return res.status(400).json({ success: false, message: 'Le message est obligatoire (4000 caractères max).' });
  }

  const { data, error } = await sb()
    .from('messages')
    .insert({
      user_id: req.mandat.agence_id,
      agence_id: req.mandat.agence_id,
      proprietaire_id: req.user.id,
      auteur_id: req.user.id,
      objet,
      corps,
      lu_par_destinataire: false,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ success: false, message: 'Impossible d\'envoyer le message.' });

  try {
    await notify(req.mandat.agence_id, 'info', 'Nouveau message du propriétaire.');
  } catch (e) {
    console.warn('[mandat/message]', e.message);
  }

  res.status(201).json({ success: true, message: data });
});

router.post('/messages/lus', requireMandate, async (req, res) => {
  const { error } = await sb()
    .from('messages')
    .update({ lu_par_destinataire: true })
    .eq('proprietaire_id', req.user.id)
    .eq('lu_par_destinataire', false);
  if (error) return res.status(500).json({ success: false, message: 'Impossible de marquer les messages comme lus.' });
  res.json({ success: true });
});

export default router;
