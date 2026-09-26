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

const router = Router();
const sb = () => serviceClient();

async function mandatOf(userId) {
  const { data, error } = await sb()
    .from('agences_proprietaires')
    .select('id, agence_id, statut, created_at')
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
    },
  });
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
