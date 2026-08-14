// ============================================================
// MIM - Paiement mobile money UnitechPay (loyers)
//
// Flux : le propriétaire initie un checkout pour un paiement de
// loyer en attente -> le locataire paie sur Wave/Orange Money ->
// UnitechPay notifie via webhook (HMAC-SHA256) -> MIM vérifie la
// transaction et marque le paiement « payé ».
//
// Sécurité :
//  - La clé API ne vit que dans server/.env (UNITECH_API_KEY).
//  - Le montant / propriétaire / locataire / échéance ne viennent
//    JAMAIS du client : ils sont relus en base (paiement MIM).
//  - Le webhook vérifie la signature HMAC-SHA256 (401 sinon).
//  - Dédup par fingerprint : un même payload n'est traité qu'une fois.
//  - Aucun passage à « payé » depuis le frontend.
// ============================================================

import express, { Router } from 'express';
import crypto from 'node:crypto';
import { createWavePayment, createOrangePayment, getBalance, verifyWebhookSignature } from '../utils/unitech.js';
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

// Callback URLs : redirection navigateur APRÈS paiement. La décision
// réelle (statut payé) vient uniquement du webhook vérifié.
function callbackUrls() {
  const base = process.env.APP_URL || '';
  return {
    success: base ? `${base}/paiement-succes` : '',
    cancel: base ? `${base}/paiement-annule` : '',
  };
}

// ------------------------------------------------------------
// Initiation : montant/propriétaire relus en base (jamais le client)
// body : { paiement_id, operator: 'wave'|'orange', orange_mode?: 'qr'|'maxit'|'om' }
// ------------------------------------------------------------
router.post('/initiate', async (req, res) => {
  try {
    const { paiement_id, operator, orange_mode = 'om' } = req.body;

    if (!paiement_id) {
      return res.status(400).json({ success: false, message: 'paiement_id requis.' });
    }
    if (!OPERATORS[operator]) {
      return res.status(400).json({ success: false, message: 'Opérateur invalide (wave ou orange).' });
    }
    if (!ORANGE_MODES.includes(orange_mode)) {
      return res.status(400).json({ success: false, message: 'Mode Orange Money invalide.' });
    }

    // Le paiement est relu en base, filtré par le propriétaire du token.
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

    const amount = Number(paiement.montant);
    const description = `MIM-PAIEMENT-${paiement.id}`; // référence interne MIM
    const cb = callbackUrls();

    const result = operator === 'wave'
      ? await createWavePayment({ amount, customerNumber: String(locataire.phone), description, callbackSuccess: cb.success, callbackCancel: cb.cancel })
      : await createOrangePayment({ type: orange_mode, amount, customerNumber: String(locataire.phone), description, callbackSuccess: cb.success, callbackCancel: cb.cancel });

    const d = result.data || {};
    const checkout = {
      user_id: req.user.id,
      paiement_id: paiement.id,
      unitech_reference: d.reference,
      unitech_transaction_id: d.transaction_id != null ? String(d.transaction_id) : null,
      method: operator === 'wave' ? 'wave' : `orange_${orange_mode}`,
      amount,
      status: 'pending',
      payment_url: d.payment_url || null,
      description,
      last_webhook: null,
    };

    const { data: inserted, error: insErr } = await sb().from('unitech_checkouts').insert(checkout).select('*').single();
    if (insErr) {
      console.error('[unitech/initiate] insert checkout:', insErr.message);
      return res.status(500).json({ success: false, message: 'Erreur lors de l\'enregistrement de la session.' });
    }

    res.status(201).json({
      success: true,
      data: { checkout: inserted, payment_url: d.payment_url, qr_code: d.qr_code, deep_links: d.deep_links, message: d.message, reference: d.reference },
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
// ------------------------------------------------------------
router.get('/checkouts', async (req, res) => {
  try {
    const { paiement_id } = req.query;
    if (!paiement_id) {
      return res.status(400).json({ success: false, message: 'paiement_id requis.' });
    }
    const { data, error } = await sb()
      .from('unitech_checkouts')
      .select('*')
      .eq('paiement_id', paiement_id)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('[unitech/checkouts]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement des sessions.' });
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
    if (!dup) {
      // Journal (audit) enregistré AVANT le traitement : si le traitement
      // échoue, UnitechPay renverra le même payload -> on retentera.
      await sb().from('unitech_webhooks').insert({ fingerprint, event, unitech_reference, payload, handled: false });
    }

    // 4) Raccordement à la session puis au paiement MIM (jamais au client).
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

    // 5) Vérification du montant : le montant du webhook doit correspondre
    // au montant en base du paiement MIM. On ne fait JAMAIS confiance à un
    // montant envoyé par le client.
    const webhookAmount = Number(payload.amount);
    if (event === 'payment_completed' && !(webhookAmount > 0 && webhookAmount === Number(checkout.amount))) {
      console.error(`[unitech/webhook] montant incohérent: webhook=${payload.amount} attendu=${checkout.amount}`);
      await sb().from('unitech_checkouts').update({ status: 'failed', last_webhook: payload }).eq('id', checkout.id);
      await sb().from('unitech_webhooks').update({ handled: true }).eq('fingerprint', fingerprint);
      return res.json({ success: true, reference: checkout.unitech_reference, result: 'amount_mismatch' });
    }

    // 6) On n'abaisse jamais un paiement déjà complété.
    if (checkout.status === 'completed' && targetStatus !== 'completed') {
      await sb().from('unitech_webhooks').update({ handled: true }).eq('fingerprint', fingerprint);
      return res.json({ success: true, reference: checkout.unitech_reference, result: 'already_completed' });
    }

    const nextStatus = targetStatus || checkout.status;

    // 7) Mise à jour de la session.
    const { error: upErr } = await sb()
      .from('unitech_checkouts')
      .update({ status: nextStatus, last_webhook: payload })
      .eq('id', checkout.id);
    if (upErr) throw upErr;

    // 8) Succès : mise à jour du paiement MIM (le paiement appartient au
    // propriétaire de la session -> propriétaire vérifié côté serveur).
    if (nextStatus === 'completed') {
      const updatePaiement = {
        statut: 'paye',
        date_paiement: new Date().toISOString().slice(0, 10),
        methode_paiement: 'mobile_money',
      };
      // Référence UnitechPay enregistrée sur le paiement si vide.
      const { data: paiement } = await sb().from('paiements').select('reference').eq('id', checkout.paiement_id).maybeSingle();
      if (!paiement?.reference) updatePaiement.reference = checkout.unitech_reference;

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

    await sb().from('unitech_webhooks').update({ handled: true }).eq('fingerprint', fingerprint);
    res.json({ success: true, reference: checkout.unitech_reference, result: nextStatus });
  } catch (err) {
    console.error('[unitech/webhook]', err.message);
    res.status(500).json({ success: false, message: 'Erreur interne.' });
  }
});

export default router;
