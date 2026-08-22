// ============================================================
// MIM - Paiement PayDunya (abonnements, loyers, salaires)
//
// Flux :
//   - Abonnement  : l'admin initie une facture (routes/admin.js),
//                   le propriétaire paie sur la page PayDunya.
//   - Loyer       : le locataire initie une facture pour son loyer,
//                   paie sur PayDunya (MIM encaisse) -> le paiement
//                   passe « paye » et MIM redistribue au propriétaire.
//   - Salaire     : le propriétaire initie une facture pour le salaire
//                   d'un employé, paie sur PayDunya (MIM encaisse) ->
//                   le paiement passe « paye » et MIM redistribue à
//                   l'employé.
//
// Sécurité :
//  - Les clés API ne vivent que dans server/.env (PAYDUNYA_*).
//  - Le montant / destinataire / propriétaire ne viennent JAMAIS du
//    client : ils sont relus en base (paiement MIM).
//  - L'IPN est authentifié par hash SHA-512(Master Key) (401 sinon) et
//    recoupé par une confirmation de la facture auprès de l'API.
//  - Dédup par fingerprint : un même payload n'est traité qu'une fois.
//  - Toute la logique de confirmation + effets métier vit dans
//    utils/paydunyaReconcile.js (partagée avec GET /status) : une
//    notification perdue est rattrapée par le polling du client.
//  - Un échec transitoire laisse le journal IPN « non traité »
//    (réponse 503 : PayDunya renverra la notification).
//  - Deux initiations simultanées ne peuvent pas créer deux factures
//    en attente (index unique partiel en base + rattrapage applicatif).
//  - Aucun passage à « payé » depuis le frontend.
// ============================================================

import express, { Router } from 'express';
import crypto from 'node:crypto';
import { verifyIpnHash, paydunyaConfig } from '../utils/paydunya.js';
import { initiatePaydunyaInvoice, findPendingPaydunyaInvoice } from '../utils/paydunyaCheckouts.js';
import { retryRedistribution, finalizeDisbursementByProviderToken } from '../utils/paydunyaRedistributions.js';
import { reconcilePaydunyaInvoice } from '../utils/paydunyaReconcile.js';
import { serviceClient } from '../app.js';

const router = Router();
const sb = () => serviceClient();

const OWNER_TYPES = ['proprietaire', 'agence', 'entreprise'];
const PAYABLE_STATUS = { attente: true, retard: true, refuse: true };

// ------------------------------------------------------------
// Initiation d'une facture PayDunya.
// Le montant / le propriétaire / le locataire sont relus en base :
// jamais fournis par le client.
//
//  body { source: 'loyer'|'salaire', paiement_id | paiement_employe_id }
// ------------------------------------------------------------
router.post('/initiate', async (req, res) => {
  try {
    const { source = 'loyer' } = req.body || {};

    if (source === 'salaire') {
      if (!OWNER_TYPES.includes(req.user.account_type)) {
        return res.status(403).json({ success: false, message: 'Accès réservé aux propriétaires.' });
      }
      return await initiateSalaire(req, res);
    }
    if (source === 'loyer') {
      if (req.user.account_type !== 'locataire') {
        return res.status(403).json({ success: false, message: 'Accès réservé aux locataires.' });
      }
      return await initiateLoyer(req, res);
    }
    return res.status(400).json({ success: false, message: 'Source invalide (loyer ou salaire).' });
  } catch (err) {
    console.error('[paydunya/initiate]', err.message);
    const status = err.code === 401 ? 401 : 502;
    res.status(status).json({ success: false, message: err.message || 'Erreur PayDunya.' });
  }
});

// Course concurrente : deux clics simultanés ne doivent créer qu'une
// facture en attente (index unique partiel en base). Si l'insertion
// perd la course (code 23505), on reprend la facture gagnante.
async function resumeOnRace(refetch) {
  try {
    return { created: await initiatePaydunyaInvoice(refetch.params()) };
  } catch (err) {
    if (err?.code !== '23505') throw err;
    const pending = await findPendingPaydunyaInvoice(refetch.criteria());
    if (!pending) throw err;
    return { created: null, resumed: pending };
  }
}

// ---- Salaire : le propriétaire paie via PayDunya (MIM encaisse) ----
async function initiateSalaire(req, res) {
  const { paiement_employe_id } = req.body || {};
  if (!paiement_employe_id) {
    return res.status(400).json({ success: false, message: 'paiement_employe_id requis.' });
  }

  const { data: pay, error } = await sb()
    .from('paiements_employes')
    .select('id, user_id, employe_id, employe_uid, montant, mois, statut, reference')
    .eq('id', paiement_employe_id)
    .eq('user_id', req.user.id)
    .single();
  if (error || !pay) {
    return res.status(404).json({ success: false, message: 'Paiement de salaire introuvable.' });
  }
  if (pay.statut === 'paye') {
    return res.status(400).json({ success: false, message: 'Ce salaire est déjà payé.' });
  }

  // Reprendre une facture en attente existante au lieu d'en créer une autre.
  const criteria = () => ({
    source: 'salaire',
    userId: req.user.id,
    paiementEmployeId: Number(paiement_employe_id),
  });
  const pending = await findPendingPaydunyaInvoice(criteria());
  if (pending) {
    return res.json({
      success: true,
      data: { invoice: pending, payment_url: pending.payment_url, token: pending.token, resumed: true },
      message: 'Facture de paiement déjà en cours.',
    });
  }

  const { data: employe } = await sb()
    .from('employes')
    .select('nom')
    .eq('id', pay.employe_id)
    .maybeSingle();

  const params = () => ({
    source: 'salaire',
    userId: req.user.id,
    amount: Number(pay.montant),
    description: `MIM-SALAIRE-${pay.id}`,
    items: [
      {
        name: `Salaire de ${pay.mois} — ${employe?.nom || 'Employé'}`,
        quantity: 1,
        unit_price: Number(pay.montant),
        total_price: Number(pay.montant),
      },
    ],
    customData: { source: 'salaire', paiement_employe_id: pay.id },
    paiementEmployeId: Number(paiement_employe_id),
  });

  const { created, resumed } = await resumeOnRace({ params, criteria });
  if (resumed) {
    return res.json({
      success: true,
      data: { invoice: resumed, payment_url: resumed.payment_url, token: resumed.token, resumed: true },
      message: 'Facture de paiement déjà en cours.',
    });
  }

  res.status(201).json({
    success: true,
    data: { invoice: created, payment_url: created.payment_url, token: created.token },
    message: 'Facture de paiement créée. Le salaire sera marqué payé dès le paiement confirmé.',
  });
}

// ---- Loyer : le locataire paie via PayDunya (MIM encaisse) ----
async function initiateLoyer(req, res) {
  const { paiement_id } = req.body || {};
  if (!paiement_id) {
    return res.status(400).json({ success: false, message: 'paiement_id requis.' });
  }

  // La fiche locataire est déduite de account_uid : un locataire ne peut
  // jamais payer le loyer d'un autre locataire.
  const { data: locataire } = await sb()
    .from('locataires')
    .select('id, nom')
    .eq('account_uid', req.user.id)
    .maybeSingle();
  if (!locataire) {
    return res.status(403).json({ success: false, message: "Votre compte n'est pas lié à une fiche locataire." });
  }

  const { data: paiement, error } = await sb()
    .from('paiements')
    .select('id, user_id, locataire_id, montant, mois, statut, reference')
    .eq('id', paiement_id)
    .eq('locataire_id', locataire.id)
    .single();
  if (error || !paiement) {
    return res.status(404).json({ success: false, message: 'Paiement introuvable.' });
  }
  if (paiement.statut === 'paye') {
    return res.status(400).json({ success: false, message: 'Ce paiement est déjà payé.' });
  }
  if (!PAYABLE_STATUS[paiement.statut]) {
    return res.status(400).json({ success: false, message: 'Ce paiement ne peut pas être réglé en ligne pour le moment.' });
  }

  // Reprendre une facture en attente existante au lieu d'en créer une autre.
  const criteria = () => ({
    source: 'loyer',
    userId: req.user.id,
    paiementId: Number(paiement_id),
  });
  const pending = await findPendingPaydunyaInvoice(criteria());
  if (pending) {
    return res.json({
      success: true,
      data: { invoice: pending, payment_url: pending.payment_url, token: pending.token, resumed: true },
      message: 'Facture de paiement déjà en cours.',
    });
  }

  const { data: profile } = await sb().from('profiles').select('name, phone').eq('id', req.user.id).maybeSingle();

  const params = () => ({
    source: 'loyer',
    userId: req.user.id,
    amount: Number(paiement.montant),
    description: `MIM-PAIEMENT-${paiement.id}`,
    items: [
      {
        name: `Loyer de ${paiement.mois} — ${locataire.nom || 'Locataire'}`,
        quantity: 1,
        unit_price: Number(paiement.montant),
        total_price: Number(paiement.montant),
      },
    ],
    customer: { name: profile?.name || locataire.nom || '', phone: profile?.phone || '' },
    customData: { source: 'loyer', paiement_id: paiement.id },
    paiementId: Number(paiement_id),
  });

  const { created, resumed } = await resumeOnRace({ params, criteria });
  if (resumed) {
    return res.json({
      success: true,
      data: { invoice: resumed, payment_url: resumed.payment_url, token: resumed.token, resumed: true },
      message: 'Facture de paiement déjà en cours.',
    });
  }

  res.status(201).json({
    success: true,
    data: { invoice: created, payment_url: created.payment_url, token: created.token },
    message: 'Facture de paiement créée. Votre loyer sera marqué payé dès le paiement confirmé.',
  });
}

// ------------------------------------------------------------
// Statut d'une facture (l'initiateur seul y a accès).
// La consultation CONFIRME auprès de l'API PayDunya puis applique la
// même logique métier que l'IPN (utils/paydunyaReconcile.js) : si une
// notification a été perdue, le simple fait de consulter la page de
// retour rattrape la mise à jour (self-healing).
// ------------------------------------------------------------
router.get('/status/:token', async (req, res) => {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ success: false, message: 'token requis.' });

    const { data: invoice } = await sb()
      .from('paydunya_invoices')
      .select('*')
      .eq('token', token)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (!invoice) return res.status(404).json({ success: false, message: 'Facture introuvable.' });

    let reconciliation = null;
    try {
      reconciliation = await reconcilePaydunyaInvoice(invoice);
    } catch (err) {
      console.warn('[paydunya/status] réconciliation différée:', err.message);
    }

    const { data: fresh } = await sb().from('paydunya_invoices').select('*').eq('id', invoice.id).maybeSingle();

    res.json({
      success: true,
      data: { ...(fresh || invoice), reconciliation },
    });
  } catch (err) {
    console.error('[paydunya/status]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de la lecture du statut.' });
  }
});

// ------------------------------------------------------------
// Lecture des sessions (admin uniquement)
// ------------------------------------------------------------
router.get('/checkouts', async (req, res) => {
  if (req.user.account_type !== 'admin') {
    return res.status(403).json({ success: false, message: "Accès réservé à l'administration." });
  }
  try {
    const { data, error } = await sb()
      .from('paydunya_invoices')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('[paydunya/checkouts]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des sessions.' });
  }
});

// ------------------------------------------------------------
// Redistributions (admin uniquement)
// ------------------------------------------------------------
router.get('/redistributions', async (req, res) => {
  if (req.user.account_type !== 'admin') {
    return res.status(403).json({ success: false, message: "Accès réservé à l'administration." });
  }
  try {
    const { status } = req.query || {};
    let query = sb().from('paydunya_redistributions').select('*').order('created_at', { ascending: false }).limit(200);
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('[paydunya/redistributions]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des redistributions.' });
  }
});

// ------------------------------------------------------------
// Relance d'une redistribution échouée (admin uniquement)
// ------------------------------------------------------------
router.post('/redistributions/:id/retry', async (req, res) => {
  if (req.user.account_type !== 'admin') {
    return res.status(403).json({ success: false, message: "Accès réservé à l'administration." });
  }
  try {
    const redistribution = await retryRedistribution(Number(req.params.id));
    res.json({
      success: true,
      data: redistribution,
      message:
        redistribution.status === 'success'
          ? 'Versement effectué.'
          : redistribution.response?.pending
            ? 'Décaissement toujours en attente chez l’opérateur : son statut sera confirmé automatiquement.'
            : "Versement toujours en échec : vérifiez le moyen de réception ou l'alias du destinataire.",
    });
  } catch (err) {
    console.error('[paydunya/redistributions/retry]', err.message);
    res.status(500).json({ success: false, message: err.message || 'Erreur lors de la relance.' });
  }
});

// ------------------------------------------------------------
// Callback des décaissements (API Déboursement v2, PUBLIC).
// PayDunya y pousse le statut FINAL d'un versement wallet soumis
// (success | failed), authentifié par hash SHA-512(Master Key).
// La finalisation est idempotent (écriture conditionnelle sur
// status='pending') : un callback rejoué ne notifie pas deux fois.
// ------------------------------------------------------------
export const disburseCallbackRouter = Router();

disburseCallbackRouter.post('/', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    let data = req.body?.data ?? req.body;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        return res.status(400).json({ success: false, message: 'data invalide.' });
      }
    }
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ success: false, message: 'Payload invalide.' });
    }

    // 1) Authenticité : hash SHA-512 du Master Key.
    if (!verifyIpnHash(data.hash)) {
      return res.status(401).json({ success: false, message: 'Hash invalide.' });
    }

    const token = data.token || null;
    if (!token) return res.status(400).json({ success: false, message: 'token manquant.' });

    const status = String(data.status || '').toLowerCase();
    if (!['success', 'failed'].includes(status)) {
      // Statuts intermédiaires (created/pending) : rien à finaliser.
      return res.json({ success: true, result: 'ignored' });
    }

    const row = await finalizeDisbursementByProviderToken(token, status, {
      transactionId: data.transaction_id || null,
      disburseTxId: data.disburse_tx_id || null,
      disburseId: data.disburse_id || null,
      withdrawMode: data.withdraw_mode || null,
      amount: data.amount != null ? Number(data.amount) : null,
      description: typeof data.description === 'string' ? data.description : '',
    });

    return res.json({ success: true, result: row ? `redistribution_${status}` : 'unknown' });
  } catch (err) {
    console.error('[paydunya/disburse-callback]', err.message);
    // 200 malgré l'erreur interne ? Non : 500 pour que PayDunya rejoue.
    res.status(500).json({ success: false, message: 'Erreur interne.' });
  }
});

// ------------------------------------------------------------
// Mode test (outil de développement uniquement)
//   Activé par PAYDUNYA_TEST_MODE=true dans server/.env.
//   À désactiver en production.
// ------------------------------------------------------------
function testModeEnabled() {
  return process.env.PAYDUNYA_TEST_MODE === 'true';
}

router.get('/test-mode', (req, res) => {
  res.json({ success: true, testMode: testModeEnabled() });
});

// ------------------------------------------------------------
// Simulation d'IPN (développement uniquement)
//   POST /paydunya/test-ipn  body { token, status, amount }
//   Rejoue exactement ce que PayDunya enverrait (form-urlencoded avec
//   hash SHA-512 du Master Key) vers le webhook réel. Renvoie la
//   réponse du webhook. Désactivé (404) si PAYDUNYA_TEST_MODE != 'true'.
// ------------------------------------------------------------
router.post('/test-ipn', async (req, res) => {
  if (!testModeEnabled()) {
    return res.status(404).json({ success: false, message: 'Mode test désactivé (PAYDUNYA_TEST_MODE=true requis).' });
  }
  const { token, status = 'completed', amount } = req.body || {};
  if (!token || !['completed', 'pending', 'cancelled'].includes(status)) {
    return res.status(400).json({ success: false, message: 'token et status (completed|pending|cancelled) requis.' });
  }
  const numericAmount = Number(amount);
  if (status === 'completed' && !(numericAmount > 0)) {
    return res.status(400).json({ success: false, message: 'amount positif requis pour completed.' });
  }

  try {
    const { masterKey } = paydunyaConfig();
    const data = {
      token,
      status,
      hash: crypto.createHash('sha512').update(masterKey).digest('hex'),
      invoice: { total_amount: status === 'completed' ? numericAmount : 0 },
      receipt_url: status === 'completed' ? `https://paydunya.com/sandbox-checkout/receipt/pdf/${token}` : null,
      customer: { name: 'Test MIM', phone: '771111111' },
    };
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(data)) {
      if (v == null) continue;
      if (typeof v === 'object') {
        for (const [kk, vv] of Object.entries(v)) form.append(`data[${k}][${kk}]`, String(vv));
      } else {
        form.append(`data[${k}]`, String(v));
      }
    }

    const target = `http://${req.headers.host}/api/paydunya/webhook`;
    const webhookRes = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      timeout: 15000,
    });
    const body = await webhookRes.json().catch(() => null);
    res.status(webhookRes.status).json({ success: webhookRes.ok, payload: data, webhook: body });
  } catch (err) {
    console.error('[paydunya/test-ipn]', err.message);
    res.status(502).json({ success: false, message: err.message || 'Erreur lors de la simulation.' });
  }
});

// ------------------------------------------------------------
// Webhook IPN PayDunya (hash SHA-512(Master Key) obligatoire)
// PayDunya envoie un POST application/x-www-form-urlencoded dont la
// clé « data » contient les informations de la transaction.
//
// La confirmation + les effets métier sont délégués à
// reconcilePaydunyaInvoice (idempotent). En cas d'échec transitoire
// (API PayDunya injoignable, panne DB), le journal reste « non
// traité » et la réponse est 503 : PayDunya renverra la notification,
// ou bien le poll de statut / un rattrapage refera le travail.
// ------------------------------------------------------------
export const webhookRouter = Router();

webhookRouter.post('/', express.urlencoded({ extended: true }), async (req, res) => {
  try {
    let data = req.body?.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        return res.status(400).json({ success: false, message: 'data invalide.' });
      }
    }
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ success: false, message: 'Payload IPN invalide.' });
    }

    // 1) Authenticité : hash SHA-512 du Master Key.
    if (!verifyIpnHash(data.hash)) {
      return res.status(401).json({ success: false, message: 'Hash IPN invalide.' });
    }

    const token = data.token || null;
    if (!token) return res.status(400).json({ success: false, message: 'token manquant.' });

    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
    const ipnStatus = String(data.status || '').toLowerCase();

    // 2) Dédup : un payload déjà TRAITÉ est ignoré (200). Si un traitement
    //    précédent a été différé (handled=false), on retente au lieu de sauter.
    const { data: dup } = await sb().from('paydunya_webhooks').select('id, handled').eq('fingerprint', fingerprint).maybeSingle();
    if (dup?.handled) {
      return res.json({ success: true, duplicated: true });
    }

    // Journal (audit) enregistré AVANT le traitement : tant qu'il n'est
    // pas marqué « traité », la notification sera rejouée (par PayDunya,
    // le poll de statut ou un rattrapage admin). Insert ATOMIQUE
    // (contrainte unique fingerprint) : en cas de course entre deux IPN
    // identiques envoyés en parallèle, un seul gagne.
    if (!dup) {
      const { data: inserted } = await sb()
        .from('paydunya_webhooks')
        .upsert(
          { fingerprint, token, status: ipnStatus, payload: data, handled: false },
          { onConflict: 'fingerprint', ignoreDuplicates: true }
        )
        .select();
      if (!inserted?.length) {
        return res.json({ success: true, duplicated: true });
      }
    }

    // 3) Raccordement à la session puis au paiement MIM (jamais au client).
    const { data: invoice, error: invErr } = await sb()
      .from('paydunya_invoices')
      .select('*')
      .eq('token', token)
      .maybeSingle();
    if (invErr) throw invErr;
    if (!invoice) {
      console.warn('[paydunya/webhook] token inconnu:', token);
      await sb()
        .from('paydunya_webhooks')
        .update({ handled: true, handled_at: new Date().toISOString() })
        .eq('fingerprint', fingerprint);
      return res.json({ success: true, token, result: 'unknown' });
    }

    // 4) Confirmation + effets métier (source de vérité serveur partagée).
    let outcome;
    try {
      outcome = await reconcilePaydunyaInvoice(invoice, { ipnData: data });
    } catch (err) {
      console.error('[paydunya/webhook] traitement différé:', err.message);
      await sb().from('paydunya_webhooks').update({ error: err.message || String(err) }).eq('fingerprint', fingerprint);
      return res.status(503).json({
        success: false,
        token,
        result: 'confirm_unavailable',
        message: 'Confirmation PayDunya momentanément indisponible ; notification conservée pour re-traitement.',
      });
    }

    // 5) Traitement mené à terme : le journal est clos (audit horodaté).
    await sb()
      .from('paydunya_webhooks')
      .update({ handled: true, handled_at: new Date().toISOString(), error: null })
      .eq('fingerprint', fingerprint);

    const result = outcome.result === 'unchanged' ? outcome.status : outcome.result;
    res.json({ success: true, token, result });
  } catch (err) {
    console.error('[paydunya/webhook]', err.message);
    res.status(500).json({ success: false, message: 'Erreur interne.' });
  }
});

export default router;
