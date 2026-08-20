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
//  - Aucun passage à « payé » depuis le frontend.
// ============================================================

import express, { Router } from 'express';
import crypto from 'node:crypto';
import { confirmPaydunyaInvoice, verifyIpnHash, paydunyaConfig } from '../utils/paydunya.js';
import { initiatePaydunyaInvoice, findPendingPaydunyaInvoice } from '../utils/paydunyaCheckouts.js';
import {
  createAndAttemptRedistribution,
  retryRedistribution,
  recipientAliasOfOwner,
  recipientAliasOfEmploye,
} from '../utils/paydunyaRedistributions.js';
import { serviceClient } from '../app.js';
import { creerEcheanceSuivante } from '../utils/echeances.js';

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
  const pending = await findPendingPaydunyaInvoice({
    source: 'salaire',
    userId: req.user.id,
    paiementEmployeId: Number(paiement_employe_id),
  });
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

  const invoice = await initiatePaydunyaInvoice({
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

  res.status(201).json({
    success: true,
    data: { invoice, payment_url: invoice.payment_url, token: invoice.token },
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
  const pending = await findPendingPaydunyaInvoice({
    source: 'loyer',
    userId: req.user.id,
    paiementId: Number(paiement_id),
  });
  if (pending) {
    return res.json({
      success: true,
      data: { invoice: pending, payment_url: pending.payment_url, token: pending.token, resumed: true },
      message: 'Facture de paiement déjà en cours.',
    });
  }

  const { data: profile } = await sb().from('profiles').select('name, phone').eq('id', req.user.id).maybeSingle();

  const invoice = await initiatePaydunyaInvoice({
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

  res.status(201).json({
    success: true,
    data: { invoice, payment_url: invoice.payment_url, token: invoice.token },
    message: 'Facture de paiement créée. Votre loyer sera marqué payé dès le paiement confirmé.',
  });
}

// ------------------------------------------------------------
// Statut d'une facture (l'initiateur seul y a accès).
// Le statut est confirmé auprès de l'API PayDunya (source de vérité)
// puis reflété dans la session en base.
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

    // Confirmation auprès de PayDunya : l'IPN reste l'événement déclencheur
    // du traitement métier, mais on rafraîchit l'état côté client.
    let confirmed = null;
    try {
      confirmed = await confirmPaydunyaInvoice(token);
      if (confirmed.status !== invoice.status && ['completed', 'cancelled'].includes(confirmed.status)) {
        await sb()
          .from('paydunya_invoices')
          .update({ status: confirmed.status, receipt_url: confirmed.receiptUrl || invoice.receipt_url })
          .eq('id', invoice.id);
      }
    } catch {
      /* API momentanément indisponible : on renvoie l'état en base */
    }

    res.json({
      success: true,
      data: {
        ...invoice,
        status: confirmed?.status || invoice.status,
        receipt_url: confirmed?.receiptUrl || invoice.receipt_url,
      },
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
          : "Versement toujours en échec : vérifiez l'alias du destinataire.",
    });
  } catch (err) {
    console.error('[paydunya/redistributions/retry]', err.message);
    res.status(500).json({ success: false, message: err.message || 'Erreur lors de la relance.' });
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
    // précédent a échoué (handled=false), on retente au lieu de sauter.
    const { data: dup } = await sb().from('paydunya_webhooks').select('id, handled').eq('fingerprint', fingerprint).maybeSingle();
    if (dup?.handled) {
      return res.json({ success: true, duplicated: true });
    }

    // Journal (audit) enregistré AVANT le traitement : si le traitement
    // échoue, PayDunya renverra le même payload -> on retentera.
    // Insert ATOMIQUE (contrainte unique fingerprint) : en cas de course
    // entre deux IPN identiques envoyés en parallèle, un seul gagne.
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
      await sb().from('paydunya_webhooks').update({ handled: true }).eq('fingerprint', fingerprint);
      return res.json({ success: true, token, result: 'unknown' });
    }

    // 4) Confirmation auprès de l'API : le statut renvoyé par l'IPN n'est
    // jamais pris au pied de la lettre, la facture est re-confirmée.
    let confirmed;
    try {
      confirmed = await confirmPaydunyaInvoice(token);
    } catch (err) {
      console.error('[paydunya/webhook] confirm échoué:', err.message);
      await sb().from('paydunya_webhooks').update({ handled: true }).eq('fingerprint', fingerprint);
      return res.json({ success: true, token, result: 'confirm_unavailable' });
    }

    // 5) Vérification du montant : le montant confirmé doit correspondre
    // au montant en base de la session.
    const confirmedAmount = confirmed.totalAmount;
    if (confirmed.status === 'completed' && !(confirmedAmount > 0 && confirmedAmount === Number(invoice.amount))) {
      console.error(`[paydunya/webhook] montant incohérent: confirmé=${confirmedAmount} attendu=${invoice.amount}`);
      await sb().from('paydunya_invoices').update({ status: 'failed', last_ipn: data }).eq('id', invoice.id);
      await sb().from('paydunya_webhooks').update({ handled: true }).eq('fingerprint', fingerprint);
      return res.json({ success: true, token, result: 'amount_mismatch' });
    }

    // 6) On n'abaisse jamais une session déjà complétée.
    if (invoice.status === 'completed' && confirmed.status !== 'completed') {
      await sb().from('paydunya_webhooks').update({ handled: true }).eq('fingerprint', fingerprint);
      return res.json({ success: true, token, result: 'already_completed' });
    }

    // 7) Mise à jour de la session.
    const nextStatus = ['completed', 'pending', 'cancelled'].includes(confirmed.status) ? confirmed.status : invoice.status;
    await sb()
      .from('paydunya_invoices')
      .update({
        status: nextStatus,
        receipt_url: confirmed.receiptUrl || invoice.receipt_url,
        last_ipn: data,
      })
      .eq('id', invoice.id);

    // 8) Succès : mise à jour de la donnée MIM selon la source.
    if (nextStatus === 'completed') {
      if (invoice.source === 'salaire') {
        await applySalaireCompleted(invoice, token);
      } else if (invoice.source === 'abonnement') {
        await applyAbonnementCompleted(invoice, token);
      } else {
        await applyLoyerCompleted(invoice, token);
      }
    }

    await sb().from('paydunya_webhooks').update({ handled: true }).eq('fingerprint', fingerprint);
    res.json({ success: true, token, result: nextStatus });
  } catch (err) {
    console.error('[paydunya/webhook]', err.message);
    res.status(500).json({ success: false, message: 'Erreur interne.' });
  }
});

// ---- Traitements par source (succès) ----

// Loyer : le locataire a payé MIM via PayDunya. Le paiement passe
// « paye » directement (l'argent est encaissé par MIM, plus besoin de
// validation propriétaire) et MIM redistribue au propriétaire.
async function applyLoyerCompleted(invoice, token) {
  const { data: paiement } = await sb()
    .from('paiements')
    .select('id, user_id, locataire_id, logement_id, mois, montant, statut, reference')
    .eq('id', invoice.paiement_id)
    .maybeSingle();
  if (!paiement) return;

  // Mise à jour conditionnelle : une seule écriture gagne en cas de course.
  const { data: updated, error: payErr } = await sb()
    .from('paiements')
    .update({
      statut: 'paye',
      date_paiement: new Date().toISOString().slice(0, 10),
      methode_paiement: 'paydunya',
      reference: paiement.reference || token,
    })
    .eq('id', paiement.id)
    .in('statut', ['attente', 'retard', 'refuse', 'a_confirmer', 'en_validation'])
    .select()
    .maybeSingle();
  if (payErr) throw payErr;
  if (!updated) return;

  // L'échéance du mois suivant est créée (anti-doublon en base).
  try {
    await creerEcheanceSuivante(sb(), paiement);
  } catch (e) {
    console.warn('[paydunya/webhook] échéance suivante :', e.message);
  }

  // Redistribution au propriétaire (compte PayDunya du destinataire).
  try {
    const alias = await recipientAliasOfOwner(paiement.user_id);
    if (alias) {
      await createAndAttemptRedistribution({
        source: 'loyer',
        userId: paiement.user_id,
        paiementId: paiement.id,
        recipientAlias: alias,
        recipientLabel: `Loyer ${paiement.mois}`,
        amount: Number(paiement.montant),
      });
    }
  } catch (e) {
    console.warn('[paydunya/webhook] redistribution loyer :', e.message);
  }

  // Notifications.
  try {
    const { notify, tenantUidOfLocataire } = await import('../utils/notifications.js');
    await notify(
      paiement.user_id,
      'success',
      `Loyer ${paiement.mois} encaissé via PayDunya (${Number(paiement.montant).toLocaleString('fr-FR')} FCFA). Redistribution au propriétaire en cours.`
    );
    const tenantUid = await tenantUidOfLocataire(paiement.locataire_id);
    if (tenantUid) {
      await notify(tenantUid, 'paiement', `Votre loyer de ${paiement.mois} a été réglé avec succès via PayDunya.`);
    }
  } catch (e) {
    console.warn('[paydunya/webhook] notification loyer :', e.message);
  }
}

// Salaire : le propriétaire a payé MIM via PayDunya -> le salaire passe
// « paye » et MIM redistribue à l'employé.
async function applySalaireCompleted(invoice, token) {
  const { data: pay } = await sb()
    .from('paiements_employes')
    .select('id, user_id, employe_id, employe_uid, mois, montant, statut, reference')
    .eq('id', invoice.paiement_employe_id)
    .maybeSingle();
  if (!pay) return;

  const { data: updated, error: payErr } = await sb()
    .from('paiements_employes')
    .update({
      statut: 'paye',
      date_paiement: new Date().toISOString().slice(0, 10),
      methode_paiement: 'paydunya',
      reference: pay.reference || token,
    })
    .eq('id', pay.id)
    .neq('statut', 'paye')
    .select()
    .maybeSingle();
  if (payErr) throw payErr;
  if (!updated) return;

  // Redistribution à l'employé (compte PayDunya du destinataire).
  try {
    const alias = await recipientAliasOfEmploye(pay.employe_id);
    if (alias) {
      await createAndAttemptRedistribution({
        source: 'salaire',
        userId: pay.user_id,
        paiementEmployeId: pay.id,
        recipientAlias: alias,
        recipientLabel: `Salaire ${pay.mois}`,
        amount: Number(pay.montant),
      });
    }
  } catch (e) {
    console.warn('[paydunya/webhook] redistribution salaire :', e.message);
  }

  // Notifications.
  try {
    const { notify } = await import('../utils/notifications.js');
    await notify(
      pay.user_id,
      'success',
      `Salaire ${pay.mois} encaissé via PayDunya (${Number(pay.montant).toLocaleString('fr-FR')} FCFA). Redistribution à l'employé en cours.`
    );
    if (pay.employe_uid) {
      await notify(pay.employe_uid, 'salaire', `Votre salaire de ${pay.mois} a été payé via PayDunya. Vérifiez votre compte PayDunya.`);
    }
  } catch (e) {
    console.warn('[paydunya/webhook] notification salaire :', e.message);
  }
}

// Abonnement : le propriétaire a payé MIM -> activation de l'abonnement.
async function applyAbonnementCompleted(invoice, token) {
  const { data: paiementAbonnement, error: apErr } = await sb()
    .from('abonnement_paiements')
    .select('*')
    .eq('id', invoice.abonnement_paiement_id)
    .maybeSingle();
  if (apErr) throw apErr;
  if (!paiementAbonnement) return;

  const now = new Date();
  const updateHist = {
    date_paiement: now.toISOString(),
    methode_paiement: 'paydunya',
  };
  if (!paiementAbonnement.reference) updateHist.reference = token;
  await sb().from('abonnement_paiements').update(updateHist).eq('id', paiementAbonnement.id);

  // Activation / renouvellement de l'abonnement : l'échéance (date_debut,
  // date_expiration) a été calculée côté serveur lors de l'initiation.
  await sb()
    .from('subscriptions')
    .upsert(
      {
        user_id: paiementAbonnement.user_id,
        plan: paiementAbonnement.plan,
        statut: 'actif',
        date_debut: paiementAbonnement.date_debut,
        date_expiration: paiementAbonnement.date_expiration,
        date_paiement: now.toISOString(),
        montant: Number(paiementAbonnement.montant),
        methode_paiement: 'paydunya',
        reference: updateHist.reference,
        updated_at: now.toISOString(),
      },
      { onConflict: 'user_id' }
    );

  const { invalidateSubscriptionCache } = await import('../utils/subscription.js');
  invalidateSubscriptionCache();
  const { invalidatePlatformCache } = await import('./admin.js');
  invalidatePlatformCache();

  // Notification au propriétaire (abonnement activé).
  try {
    const { notify } = await import('../utils/notifications.js');
    await notify(paiementAbonnement.user_id, 'abonnement', `Votre abonnement MIM est actif. Merci pour votre paiement PayDunya.`);
  } catch (e) {
    console.warn('[paydunya/webhook] notification abonnement :', e.message);
  }
}

export default router;