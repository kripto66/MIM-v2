// ============================================================
// MIM - Paiement mobile money UnitechPay (loyers, salaires, abonnements)
//
// Flux : le propriétaire initie un checkout pour un paiement
// (loyer : le locataire paie — encaissement ; salaire : le
// propriétaire verse à l'employé — versement) -> UnitechPay
// notifie via webhook (HMAC-SHA256) -> MIM vérifie la transaction
// et marque le paiement « payé ».
//
// Sécurité :
//  - La clé API ne vit que dans server/.env (UNITECH_API_KEY).
//  - Le montant / destinataire / propriétaire ne viennent JAMAIS
//    du client : ils sont relus en base (paiement MIM).
//  - Le webhook vérifie la signature HMAC-SHA256 (401 sinon).
//  - Dédup par fingerprint : un même payload n'est traité qu'une fois.
//  - Aucun passage à « payé » depuis le frontend.
// ============================================================

import express, { Router } from 'express';
import crypto from 'node:crypto';
import { getBalance, verifyWebhookSignature } from '../utils/unitech.js';
import { initiateUnitechCheckout } from '../utils/unitechCheckouts.js';
import { serviceClient } from '../app.js';

const router = Router();
const sb = () => serviceClient();

const PHONE_RE = /^[0-9+ ]{7,20}$/;
const OPERATORS = { wave: true, orange: true };
const ORANGE_MODES = ['qr', 'maxit', 'om'];
const CHECKOUT_STATUS = { pending: true, completed: true, failed: true, cancelled: true, expired: true };
const EVENT_TO_STATUS = {
  payment_completed: 'completed',
  payment_failed: 'failed',
  payment_cancelled: 'cancelled',
  payment_expired: 'expired',
};

// ------------------------------------------------------------
// Initiation : montant/propriétaire relus en base (jamais le client)
// body : { source: 'loyer'|'salaire', paiement_id | paiement_employe_id,
//          operator: 'wave'|'orange', orange_mode?: 'qr'|'maxit'|'om' }
// ------------------------------------------------------------
router.post('/initiate', async (req, res) => {
  try {
    const { source = 'loyer', operator, orange_mode = 'om' } = req.body;

    if (!OPERATORS[operator]) {
      return res.status(400).json({ success: false, message: 'Opérateur invalide (wave ou orange).' });
    }
    if (!ORANGE_MODES.includes(orange_mode)) {
      return res.status(400).json({ success: false, message: 'Mode Orange Money invalide.' });
    }

    if (source === 'salaire') {
      const { paiement_employe_id } = req.body;
      if (!paiement_employe_id) {
        return res.status(400).json({ success: false, message: 'paiement_employe_id requis.' });
      }

      // Le paiement de salaire est relu en base, filtré par le propriétaire.
      const { data: pay, error } = await sb()
        .from('paiements_employes')
        .select('id, user_id, employe_id, montant, mois, statut, reference')
        .eq('id', paiement_employe_id)
        .eq('user_id', req.user.id)
        .single();
      if (error || !pay) {
        return res.status(404).json({ success: false, message: 'Paiement de salaire introuvable.' });
      }
      if (pay.statut === 'paye') {
        return res.status(400).json({ success: false, message: 'Ce salaire est déjà payé.' });
      }

      // Reprendre une session en attente existante.
      const { data: existing } = await sb()
        .from('unitech_checkouts')
        .select('*')
        .eq('paiement_employe_id', pay.id)
        .eq('user_id', req.user.id)
        .order('created_at', { ascending: false })
        .limit(5);
      const pending = (existing || []).find((c) => c.status === 'pending');
      if (pending) {
        return res.json({
          success: true,
          data: { checkout: pending, payment_url: pending.payment_url, reference: pending.unitech_reference, resumed: true },
          message: 'Session de versement déjà en cours.',
        });
      }

      // Téléphone du bénéficiaire (l'employé) : lu en base.
      const { data: employe } = await sb()
        .from('employes')
        .select('nom, phone')
        .eq('id', pay.employe_id)
        .maybeSingle();
      if (!employe || !employe.phone) {
        return res.status(400).json({
          success: false,
          message: 'L\'employé n\'a pas de numéro de téléphone : renseignez-le pour verser via mobile money.',
        });
      }
      if (!PHONE_RE.test(String(employe.phone))) {
        return res.status(400).json({ success: false, message: 'Numéro de téléphone de l\'employé invalide.' });
      }

      const checkout = await initiateUnitechCheckout({
        source: 'salaire',
        userId: req.user.id,
        amount: Number(pay.montant),
        description: `MIM-SALAIRE-${pay.id}`,
        operator,
        orangeMode: orange_mode,
        customerNumber: String(employe.phone),
        payout: true,
        paiementEmployeId: Number(paiement_employe_id),
      });

      res.status(201).json({
        success: true,
        data: { checkout, payment_url: checkout.payment_url, reference: checkout.unitech_reference },
        message: 'Session de versement créée.',
      });
      return;
    }

    // --- Loyer (encaissement) ---
    const { paiement_id } = req.body;
    if (!paiement_id) {
      return res.status(400).json({ success: false, message: 'paiement_id requis.' });
    }

    // Le paiement de loyer est relu en base, filtré par le propriétaire.
    const { data: paiement, error } = await sb()
      .from('paiements')
      .select('id, user_id, locataire_id, logement_id, montant, mois, statut, reference')
      .eq('id', paiement_id)
      .eq('user_id', req.user.id)
      .single();
    if (error || !paiement) {
      return res.status(404).json({ success: false, message: 'Paiement introuvable.' });
    }
    if (paiement.statut === 'paye') {
      return res.status(400).json({ success: false, message: 'Ce paiement est déjà payé.' });
    }

    // Reprendre une session en attente existante au lieu d'en créer une autre.
    const { data: existing } = await sb()
      .from('unitech_checkouts')
      .select('*')
      .eq('paiement_id', paiement.id)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(5);
    const pending = (existing || []).find((c) => c.status === 'pending');
    if (pending) {
      return res.json({
        success: true,
        data: { checkout: pending, payment_url: pending.payment_url, reference: pending.unitech_reference, resumed: true },
        message: 'Session de paiement déjà en cours.',
      });
    }

    // Téléphone du locataire : lu en base, jamais fourni par le client.
    const { data: locataire } = await sb()
      .from('locataires')
      .select('nom, phone')
      .eq('id', paiement.locataire_id)
      .single();
    if (!locataire || !locataire.phone) {
      return res.status(400).json({
        success: false,
        message: 'Le locataire n\'a pas de numéro de téléphone : renseignez-le pour utiliser le paiement mobile money.',
      });
    }
    if (!PHONE_RE.test(String(locataire.phone))) {
      return res.status(400).json({ success: false, message: 'Numéro de téléphone du locataire invalide.' });
    }

    const checkout = await initiateUnitechCheckout({
      source: 'loyer',
      userId: req.user.id,
      amount: Number(paiement.montant),
      description: `MIM-PAIEMENT-${paiement.id}`, // référence interne MIM
      operator,
      orangeMode: orange_mode,
      customerNumber: String(locataire.phone),
      payout: false,
      paiementId: Number(paiement.id),
    });

    res.status(201).json({
      success: true,
      data: { checkout, payment_url: checkout.payment_url, reference: checkout.unitech_reference },
      message: 'Session de paiement créée.',
    });
  } catch (err) {
    console.error('[unitech/initiate]', err.message);
    const status = err.code === 401 ? 401 : 502;
    res.status(status).json({ success: false, message: err.message || 'Erreur UnitechPay.' });
  }
});

// ------------------------------------------------------------
// Lecture des sessions d'un paiement (propriétaire uniquement)
// Query : ?paiement_id= (loyer) ou ?paiement_employe_id= (salaire)
// ------------------------------------------------------------
router.get('/checkouts', async (req, res) => {
  try {
    const { paiement_id, paiement_employe_id } = req.query;
    let query = sb().from('unitech_checkouts').select('*').eq('user_id', req.user.id);
    if (paiement_id) query = query.eq('paiement_id', paiement_id);
    else if (paiement_employe_id) query = query.eq('paiement_employe_id', paiement_employe_id);
    else {
      return res.status(400).json({ success: false, message: 'paiement_id ou paiement_employe_id requis.' });
    }
    const { data, error } = await query.order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('[unitech/checkouts]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des sessions.' });
  }
});

// ------------------------------------------------------------
// Validation métier d'un paiement mobile money (propriétaire)
// body : { paiement_id, action: 'valider' | 'refuser' }
//
// Le webhook a confirmé techniquement le paiement (« a_confirmer ») ;
// le locataire peut confirmer de son côté (« en_validation »). C'est le
// propriétaire qui réalise la validation métier : « valider » -> paye,
// « refuser » -> refuse. La mise à jour est CONDITIONNELLE (statut
// attendu) : deux clics simultanés ne produisent qu'une seule écriture.
// Le montant / la référence / le propriétaire sont relus en base : le
// frontend ne peut rien imposer.
// ------------------------------------------------------------
router.post('/valider', async (req, res) => {
  try {
    const { paiement_id, action } = req.body || {};
    if (!['valider', 'refuser'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Action invalide (valider ou refuser).' });
    }
    if (!paiement_id) {
      return res.status(400).json({ success: false, message: 'paiement_id requis.' });
    }

    // Relu en base, filtré par le propriétaire connecté (jamais le client).
    const { data: paiement } = await sb()
      .from('paiements')
      .select('id, user_id, locataire_id, montant, mois, statut, date_paiement, reference')
      .eq('id', paiement_id)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (!paiement) {
      return res.status(404).json({ success: false, message: 'Paiement introuvable.' });
    }
    if (!['a_confirmer', 'en_validation'].includes(paiement.statut)) {
      const message = paiement.statut === 'paye' ? 'Ce paiement est déjà payé.' : 'Ce paiement ne peut pas être validé.';
      return res.status(400).json({ success: false, message });
    }

    const next = action === 'valider' ? 'paye' : 'refuse';
    const update = { statut: next };
    if (action === 'valider' && !paiement.date_paiement) {
      update.date_paiement = new Date().toISOString().slice(0, 10);
    }

    // Mise à jour conditionnelle : une seule écriture gagne en cas de course.
    const { data: updated, error } = await sb()
      .from('paiements')
      .update(update)
      .eq('id', paiement.id)
      .in('statut', ['a_confirmer', 'en_validation'])
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!updated) {
      return res.status(409).json({ success: false, message: 'Ce paiement a déjà été traité.' });
    }

    // Notification au locataire concerné.
    try {
      const { notify, tenantUidOfLocataire } = await import('../utils/notifications.js');
      const tenantUid = await tenantUidOfLocataire(paiement.locataire_id);
      if (tenantUid) {
        if (action === 'valider') {
          await notify(tenantUid, 'paiement', `Votre loyer de ${paiement.mois} a été confirmé par le propriétaire.`);
        } else {
          await notify(tenantUid, 'paiement', `Votre paiement de ${paiement.mois} a été refusé par le propriétaire. Contactez-le pour régulariser.`);
        }
      }
    } catch (e) {
      console.warn('[unitech/valider] notification:', e.message);
    }

    res.json({ success: true, data: updated, message: action === 'valider' ? 'Paiement validé.' : 'Paiement refusé.' });
  } catch (err) {
    console.error('[unitech/valider]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de la validation.' });
  }
});

// ------------------------------------------------------------
// Solde du compte marchand (lecture seule)
// ------------------------------------------------------------
router.get('/balance', async (req, res) => {
  try {
    const result = await getBalance();
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error('[unitech/balance]', err.message);
    res.status(502).json({ success: false, message: err.message || 'Erreur UnitechPay.' });
  }
});

// ------------------------------------------------------------
// Mode test (outil de développement uniquement)
//   Activé par UNITECH_TEST_MODE=true dans server/.env.
//   À désactiver en production.
// ------------------------------------------------------------
function testModeEnabled() {
  return process.env.UNITECH_TEST_MODE === 'true';
}

router.get('/test-mode', (req, res) => {
  res.json({ success: true, testMode: testModeEnabled() });
});

// ------------------------------------------------------------
// Simulation de webhook (développement uniquement)
//   POST /unitech/test-webhook  body { reference, event, amount }
//   Rejoue exactement ce qu'UnitechPay enverrait (payload brut signé
//   HMAC-SHA256 côté serveur) vers le webhook réel. Aucune clé ne
//   transite par le frontend. Renvoie la réponse du webhook.
//   Désactivé (404) si UNITECH_TEST_MODE n'est pas 'true'.
// ------------------------------------------------------------
router.post('/test-webhook', async (req, res) => {
  if (!testModeEnabled()) {
    return res.status(404).json({ success: false, message: 'Mode test désactivé (UNITECH_TEST_MODE=true requis).' });
  }

  const { reference, event, amount } = req.body || {};
  if (!reference || !event) {
    return res.status(400).json({ success: false, message: 'reference et event sont requis.' });
  }
  const status = req.body.status || (event === 'payment_completed' ? 'completed' : event === 'payment_failed' ? 'failed' : event === 'payment_expired' ? 'expired' : 'cancelled');
  const numericAmount = Number(amount);
  if (event === 'payment_completed' && !(numericAmount > 0)) {
    return res.status(400).json({ success: false, message: 'amount positif requis pour payment_completed.' });
  }

  try {
    const payload = {
      event,
      reference,
      amount: event === 'payment_completed' ? numericAmount : (numericAmount > 0 ? numericAmount : 0),
      status,
      created_at: new Date().toISOString(),
    };
    const raw = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', process.env.UNITECH_API_KEY || '').update(raw).digest('hex');

    const target = `http://${req.headers.host}/api/unitech/webhook`;
    const webhookRes = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-UNITECHPAY-SIGNATURE': signature,
      },
      body: raw,
      timeout: 15000,
    });
    const body = await webhookRes.json().catch(() => null);
    res.status(webhookRes.status).json({ success: webhookRes.ok, payload, webhook: body });
  } catch (err) {
    console.error('[unitech/test-webhook]', err.message);
    res.status(502).json({ success: false, message: err.message || 'Erreur lors de la simulation.' });
  }
});

// ------------------------------------------------------------
// Webhook UnitechPay (signature HMAC-SHA256 obligatoire)
// ------------------------------------------------------------
export const webhookRouter = Router();

webhookRouter.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const raw = (req.body || Buffer.alloc(0)).toString('utf8');
    const signature = req.get('X-UNITECHPAY-SIGNATURE') || '';

    // 1) Signature : aucune donnée n'est traitée sans HMAC valide.
    if (!verifyWebhookSignature(raw, signature)) {
      return res.status(401).json({ success: false, message: 'Signature invalide.' });
    }

    let payload;
    try {
      payload = JSON.parse(raw || '{}');
    } catch {
      return res.status(400).json({ success: false, message: 'Payload JSON invalide.' });
    }

    const fingerprint = crypto.createHash('sha256').update(raw).digest('hex');
    const event = payload.event || '';
    const unitechReference = payload.reference || null;

    // 2) Dédup : un payload déjà TRAITÉ est ignoré (200). Si un traitement
    // précédent a échoué (handled=false), on retente au lieu de sauter.
    const { data: dup } = await sb().from('unitech_webhooks').select('id, handled').eq('fingerprint', fingerprint).maybeSingle();
    if (dup?.handled) {
      return res.json({ success: true, duplicated: true });
    }

    // Journal (audit) enregistré AVANT le traitement : si le traitement
    // échoue, UnitechPay renverra le même payload -> on retentera.
    // Insert ATOMIQUE (contrainte unique fingerprint) : en cas de course
    // entre deux webhooks identiques envoyés en parallèle, un seul gagne
    // l'écriture ; les autres répondent 200 sans double traitement.
    if (!dup) {
      const { data: inserted } = await sb()
        .from('unitech_webhooks')
        .upsert(
          { fingerprint, event, unitech_reference: unitechReference, payload, handled: false },
          { onConflict: 'fingerprint', ignoreDuplicates: true }
        )
        .select();
      if (!inserted?.length) {
        return res.json({ success: true, duplicated: true });
      }
    }

    // 3) Raccordement à la session puis au paiement MIM (jamais au client).
    const { data: checkout, error: coErr } = await sb()
      .from('unitech_checkouts')
      .select('*')
      .eq('unitech_reference', unitechReference)
      .maybeSingle();
    if (coErr) throw coErr;
    if (!checkout) {
      console.warn('[unitech/webhook] référence inconnue:', unitechReference);
      await sb().from('unitech_webhooks').update({ handled: true }).eq('fingerprint', fingerprint);
      return res.json({ success: true, reference: 'unknown' });
    }

    const targetStatus = EVENT_TO_STATUS[event] || (CHECKOUT_STATUS[payload.status] ? payload.status : null);

    // 4) Vérification du montant : le montant du webhook doit correspondre
    // au montant en base de la session. On ne fait JAMAIS confiance à un
    // montant envoyé par le client.
    const webhookAmount = Number(payload.amount);
    if (event === 'payment_completed' && !(webhookAmount > 0 && webhookAmount === Number(checkout.amount))) {
      console.error(`[unitech/webhook] montant incohérent: webhook=${payload.amount} attendu=${checkout.amount}`);
      await sb().from('unitech_checkouts').update({ status: 'failed', last_webhook: payload }).eq('id', checkout.id);
      await sb().from('unitech_webhooks').update({ handled: true }).eq('fingerprint', fingerprint);
      return res.json({ success: true, reference: checkout.unitech_reference, result: 'amount_mismatch' });
    }

    // 5) On n'abaisse jamais une session déjà complétée.
    if (checkout.status === 'completed' && targetStatus !== 'completed') {
      await sb().from('unitech_webhooks').update({ handled: true }).eq('fingerprint', fingerprint);
      return res.json({ success: true, reference: checkout.unitech_reference, result: 'already_completed' });
    }

    const nextStatus = targetStatus || checkout.status;

    // 6) Mise à jour de la session.
    const { error: upErr } = await sb()
      .from('unitech_checkouts')
      .update({ status: nextStatus, last_webhook: payload })
      .eq('id', checkout.id);
    if (upErr) throw upErr;

    // 7) Succès : mise à jour de la donnée MIM selon la source.
    if (nextStatus === 'completed') {
      if (checkout.source === 'salaire') {
        await applySalaryCompleted(checkout, unitechReference);
      } else if (checkout.source === 'abonnement') {
        await applyAbonnementCompleted(checkout, unitechReference);
      } else {
        await applyLoyerCompleted(checkout, unitechReference);
      }
    }

    await sb().from('unitech_webhooks').update({ handled: true }).eq('fingerprint', fingerprint);
    res.json({ success: true, reference: checkout.unitech_reference, result: nextStatus });
  } catch (err) {
    console.error('[unitech/webhook]', err.message);
    res.status(500).json({ success: false, message: 'Erreur interne.' });
  }
});

// ---- Traitements par source (succès) ----

// Loyer : le locataire a payé le propriétaire.
// Le webhook est la preuve technique : le paiement passe en
// « a_confirmer », le locataire est invité à le confirmer et le
// propriétaire le valide (statut « paye ») — voir POST /unitech/valider.
async function applyLoyerCompleted(checkout, unitechReference) {
  const updatePaiement = {
    statut: 'a_confirmer',
    date_paiement: new Date().toISOString().slice(0, 10),
    methode_paiement: 'mobile_money',
  };
  // Référence UnitechPay enregistrée sur le paiement si vide.
  const { data: paiement } = await sb().from('paiements').select('reference').eq('id', checkout.paiement_id).maybeSingle();
  if (!paiement?.reference) updatePaiement.reference = unitechReference;

  const { error: payErr } = await sb().from('paiements').update(updatePaiement).eq('id', checkout.paiement_id);
  if (payErr) throw payErr;

  // Notification au propriétaire (loyer encaissé via mobile money).
  try {
    const { notify } = await import('../utils/notifications.js');
    await notify(checkout.user_id, 'success', `Paiement mobile money reçu (${checkout.amount} FCFA) — ${checkout.description || ''}`.trim());
  } catch (e) {
    console.warn('[unitech/webhook] notification:', e.message);
  }
}

// Salaire : le propriétaire a versé à l'employé (payout).
async function applySalaryCompleted(checkout, unitechReference) {
  const update = {
    statut: 'paye',
    date_paiement: new Date().toISOString().slice(0, 10),
    methode_paiement: 'mobile_money',
  };
  const { data: pay } = await sb().from('paiements_employes').select('reference').eq('id', checkout.paiement_employe_id).maybeSingle();
  if (!pay?.reference) update.reference = unitechReference;

  const { error: payErr } = await sb().from('paiements_employes').update(update).eq('id', checkout.paiement_employe_id);
  if (payErr) throw payErr;

  // Notification au propriétaire (versement effectué).
  try {
    const { notify } = await import('../utils/notifications.js');
    await notify(checkout.user_id, 'success', `Versement mobile money effectué (${checkout.amount} FCFA) — ${checkout.description || ''}`.trim());
  } catch (e) {
    console.warn('[unitech/webhook] notification:', e.message);
  }
}

// Abonnement : le propriétaire a payé MIM -> activation de l'abonnement.
async function applyAbonnementCompleted(checkout, unitechReference) {
  const { data: paiementAbonnement, error: apErr } = await sb()
    .from('abonnement_paiements')
    .select('*')
    .eq('id', checkout.abonnement_paiement_id)
    .maybeSingle();
  if (apErr) throw apErr;
  if (!paiementAbonnement) return;

  const now = new Date();
  const updateHist = {
    date_paiement: now.toISOString(),
    methode_paiement: 'mobile_money',
  };
  if (!paiementAbonnement.reference) updateHist.reference = unitechReference;
  await sb().from('abonnement_paiements').update(updateHist).eq('id', paiementAbonnement.id);

  // Activation / renouvellement de l'abonnement : l'échéance (date_debut,
  // date_expiration) a été calculée côté serveur lors de l'initiation.
  await sb()
    .from('subscriptions')
    .upsert({
      user_id: paiementAbonnement.user_id,
      plan: paiementAbonnement.plan,
      statut: 'actif',
      date_debut: paiementAbonnement.date_debut,
      date_expiration: paiementAbonnement.date_expiration,
      date_paiement: now.toISOString(),
      montant: Number(paiementAbonnement.montant),
      methode_paiement: 'mobile_money',
      reference: updateHist.reference,
      updated_at: now.toISOString(),
    }, { onConflict: 'user_id' });

  const { invalidateSubscriptionCache } = await import('../utils/subscription.js');
  invalidateSubscriptionCache();
  const { invalidatePlatformCache } = await import('./admin.js');
  invalidatePlatformCache();

  // Notification au propriétaire (abonnement activé).
  try {
    const { notify } = await import('../utils/notifications.js');
    await notify(paiementAbonnement.user_id, 'abonnement', `Votre abonnement MIM est actif. Merci pour votre paiement mobile money.`);
  } catch (e) {
    console.warn('[unitech/webhook] notification:', e.message);
  }
}

export default router;
