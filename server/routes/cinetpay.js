// ============================================================
// MIM - Routes CinetPay (encaissement loyers + reversements)
//
// Montage (app.js) :
//   - webhookRouter        : PUBLIC, AVANT express.json (form-urlencoded)
//                            POST/GET /api/cinetpay/webhook
//   - transferNotifyRouter : PUBLIC, idem, /api/cinetpay/payout-notify
//   - router               : authentifié, /api/cinetpay
//
// Sécurité :
//  - Montant / locataire / propriétaire relus en base, jamais du client.
//  - Webhook : authenticité par HMAC-SHA256 « x-token » (mécanisme
//    officiel CinetPay) quand CINETPAY_WEBHOOK_SECRET est configuré ;
//    dans TOUS les cas le statut réel est re-vérifié auprès de l'API
//    /payment/check (le payload seul ne vaut jamais preuve).
//  - Dédup par fingerprint en base (journal cinetpay_webhooks).
//  - Échec transitoire -> 503 : CinetPay rejouera la notification ; le
//    polling GET /status rattrape aussi tout (self-healing).
//  - Deux initiations simultanées => une seule session (index unique
//    partiel + reprise applicative).
// ============================================================

import express, { Router } from 'express';
import crypto from 'node:crypto';
import { serviceClient } from '../app.js';
import { cinetpayEnabled, cinetpayConfig, verifyWebhookHmac } from '../providers/cinetpay.js';
import { getProvider } from '../providers/index.js';
import { initiateCinetpayRentPayment, reconcileCinetpayPayment } from '../utils/cinetpayPayments.js';
import { retryPayoutById, checkAndFinalizePayout, finalizePayoutByNotify } from '../utils/cinetpayPayouts.js';

const router = Router();
const sb = () => serviceClient();
const OWNER_TYPES = ['proprietaire', 'agence', 'entreprise'];

function testModeEnabled() {
    return process.env.CINETPAY_TEST_MODE === 'true';
}

router.get('/test-mode', (req, res) => {
    res.json({ success: true, testMode: testModeEnabled() });
});

// Disponibilité (frontend : afficher ou non le bouton CinetPay).
router.get('/enabled', async (req, res) => {
    const enabled = cinetpayEnabled();
    let transferReady = false;
    if (enabled && process.env.CINETPAY_TRANSFER_PASSWORD) transferReady = true;
    res.json({
        success: true,
        data: {
            enabled,
            transferReady,
            environment: (process.env.CINETPAY_ENVIRONMENT || 'test').toLowerCase(),
        },
    });
});

// ------------------------------------------------------------
// Initiation : le locataire règle son loyer via CinetPay.
// ------------------------------------------------------------
router.post('/initiate', async (req, res) => {
    try {
        if (req.user.account_type !== 'locataire') {
            return res.status(403).json({ success: false, message: 'Accès réservé aux locataires.' });
        }
        const { paiement_id } = req.body || {};
        if (!paiement_id) {
            return res.status(400).json({ success: false, message: 'paiement_id requis.' });
        }
        const { payment, resumed } = await initiateCinetpayRentPayment({
            userId: req.user.id,
            paiementId: Number(paiement_id),
        });
        return res.status(resumed ? 200 : 201).json({
            success: true,
            data: {
                payment,
                payment_url: payment.payment_url || null,
                transaction_id: payment.transaction_id,
                resumed,
            },
            message: resumed
                ? 'Une session de paiement est déjà en cours.'
                : 'Session de paiement créée. Votre loyer sera marqué payé dès la confirmation CinetPay.',
        });
    } catch (err) {
        console.error('[cinetpay/initiate]', err.message);
        const status = err.httpStatus || (err.transient ? 503 : 502);
        res.status(status).json({ success: false, message: err.message || 'Erreur CinetPay.' });
    }
});

// ------------------------------------------------------------
// Statut d'une session (l'initiateur seul). La consultation RE-VÉRIFIE
// auprès de CinetPay puis applique les mêmes effets que le webhook :
// notification perdue => simple consultation rattrape tout.
// ------------------------------------------------------------
router.get('/status/:transactionId', async (req, res) => {
    try {
        const { transactionId } = req.params;
        if (!transactionId) return res.status(400).json({ success: false, message: 'transaction_id requis.' });

        const { data: payment } = await sb()
            .from('cinetpay_payments')
            .select('*')
            .eq('transaction_id', transactionId)
            .eq('user_id', req.user.id)
            .maybeSingle();
        if (!payment) return res.status(404).json({ success: false, message: 'Session de paiement introuvable.' });

        let reconciliation = null;
        if (!['SUCCESS', 'FAILED', 'CANCELLED'].includes(payment.status)) {
            try {
                reconciliation = await reconcileCinetpayPayment(payment);
            } catch (err) {
                console.warn('[cinetpay/status] réconciliation différée:', err.message);
            }
        }

        const { data: fresh } = await sb().from('cinetpay_payments').select('*').eq('id', payment.id).maybeSingle();

        res.json({
            success: true,
            data: { ...(fresh || payment), reconciliation },
        });
    } catch (err) {
        console.error('[cinetpay/status]', err.message);
        res.status(500).json({ success: false, message: 'Erreur lors de la lecture du statut.' });
    }
});

// ------------------------------------------------------------
// Encaissements (admin uniquement)
// ------------------------------------------------------------
router.get('/payments', async (req, res) => {
    if (req.user.account_type !== 'admin') {
        return res.status(403).json({ success: false, message: "Accès réservé à l'administration." });
    }
    try {
        const { status } = req.query || {};
        let query = sb().from('cinetpay_payments').select('*').order('created_at', { ascending: false }).limit(200);
        if (status) query = query.eq('status', status);
        const { data, error } = await query;
        if (error) throw error;
        res.json({ success: true, data });
    } catch (err) {
        console.error('[cinetpay/payments]', err.message);
        res.status(500).json({ success: false, message: 'Erreur lors du chargement des paiements.' });
    }
});

// ------------------------------------------------------------
// Reversements (admin uniquement)
// ------------------------------------------------------------
router.get('/payouts', async (req, res) => {
    if (req.user.account_type !== 'admin') {
        return res.status(403).json({ success: false, message: "Accès réservé à l'administration." });
    }
    try {
        const { status } = req.query || {};
        let query = sb().from('cinetpay_payouts').select('*').order('created_at', { ascending: false }).limit(200);
        if (status) query = query.eq('status', status);
        const { data, error } = await query;
        if (error) throw error;
        res.json({ success: true, data });
    } catch (err) {
        console.error('[cinetpay/payouts]', err.message);
        res.status(500).json({ success: false, message: 'Erreur lors du chargement des reversements.' });
    }
});

// Reversements du propriétaire connecté (RLS + filtre explicite).
router.get('/owner/payouts', async (req, res) => {
    if (!OWNER_TYPES.includes(req.user.account_type)) {
        return res.status(403).json({ success: false, message: 'Accès réservé aux propriétaires.' });
    }
    try {
        const { data, error } = await sb()
            .from('cinetpay_payouts')
            .select('*')
            .eq('owner_id', req.user.id)
            .order('created_at', { ascending: false })
            .limit(200);
        if (error) throw error;
        res.json({ success: true, data });
    } catch (err) {
        console.error('[cinetpay/owner/payouts]', err.message);
        res.status(500).json({ success: false, message: 'Erreur lors du chargement des reversements.' });
    }
});

// Relance contrôlée d'un reversement bloqué (admin uniquement).
router.post('/payouts/:id/retry', async (req, res) => {
    if (req.user.account_type !== 'admin') {
        return res.status(403).json({ success: false, message: "Accès réservé à l'administration." });
    }
    try {
        const payout = await retryPayoutById(Number(req.params.id));
        res.json({
            success: true,
            data: payout,
            message:
                payout.status === 'SUCCESS'
                    ? 'Reversement effectué.'
                    : payout.status === 'PROCESSING'
                      ? 'Transfert toujours en cours chez CinetPay : son statut sera confirmé automatiquement.'
                      : 'Reversement toujours en échec : vérifiez le numéro de versement du propriétaire.',
        });
    } catch (err) {
        console.error('[cinetpay/payouts/retry]', err.message);
        const status = err.httpStatus || 500;
        res.status(status).json({ success: false, message: err.message || 'Erreur lors de la relance.', data: err.payout || null });
    }
});

// Passage de revue des reversements en attente/bloqués (admin).
// Pour chaque ligne : PROCESSING -> vérification d'état ; les autres
// restent à déclencher explicitement (retry) pour garder la main.
router.post('/payouts/process', async (req, res) => {
    if (req.user.account_type !== 'admin') {
        return res.status(403).json({ success: false, message: "Accès réservé à l'administration." });
    }
    try {
        const { data: rows } = await sb()
            .from('cinetpay_payouts')
            .select('*')
            .in('status', ['PROCESSING'])
            .order('created_at', { ascending: true })
            .limit(50);
        const results = [];
        for (const row of rows || []) {
            try {
                const updated = await checkAndFinalizePayout(row);
                results.push({ id: row.id, status: updated.status });
            } catch (e) {
                results.push({ id: row.id, error: e.message });
            }
        }
        res.json({ success: true, data: results, processed: results.length });
    } catch (err) {
        console.error('[cinetpay/payouts/process]', err.message);
        res.status(500).json({ success: false, message: 'Erreur lors du traitement des reversements.' });
    }
});

// ------------------------------------------------------------
// Simulation de notification Checkout (développement uniquement,
// CINETPAY_TEST_MODE=true). Rejoue exactement ce que CinetPay enverrait :
// form-urlencoded + header x-token HMAC valide.
// ------------------------------------------------------------
router.post('/test-webhook', async (req, res) => {
    if (!testModeEnabled()) {
        return res.status(404).json({ success: false, message: 'Mode test désactivé (CINETPAY_TEST_MODE=true requis).' });
    }
    const { transaction_id, amount } = req.body || {};
    if (!transaction_id) return res.status(400).json({ success: false, message: 'transaction_id requis.' });

    try {
        const { data: payment } = await sb()
            .from('cinetpay_payments')
            .select('*')
            .eq('transaction_id', String(transaction_id))
            .maybeSingle();
        if (!payment) return res.status(404).json({ success: false, message: 'Transaction inconnue.' });

        const cfg = cinetpayConfig();
        // Champs officiels d'une notification Checkout (sans le statut :
        // CinetPay n'en envoie pas de fiable, d'où la re-vérification).
        const data = {
            cpm_site_id: cfg.siteId,
            cpm_trans_id: payment.transaction_id,
            cpm_trans_date: new Date().toISOString(),
            cpm_amount: String(amount != null ? Number(amount) : Number(payment.amount)),
            cpm_currency: payment.currency || 'XOF',
            signature: 'NOT_PROVIDED',
            payment_method: 'MOBILE_MONEY',
            cel_phone_num: '770000000',
            cpm_phone_prefixe: '221',
            cpm_language: 'fr',
            cpm_version: 'V1',
            cpm_payment_config: 'SINGLE',
            cpm_page_action: 'PAYMENT',
            cpm_custom: payment.transaction_id,
            cpm_designation: 'LOYER MIM',
            cpm_error_message: '',
        };
        // HMAC officiel : concaténation ordonnée des champs ci-dessus.
        const concatenated = [
            data.cpm_site_id, data.cpm_trans_id, data.cpm_trans_date, data.cpm_amount,
            data.cpm_currency, data.signature, data.payment_method, data.cel_phone_num,
            data.cpm_phone_prefixe, data.cpm_language, data.cpm_version, data.cpm_payment_config,
            data.cpm_page_action, data.cpm_custom, data.cpm_designation, data.cpm_error_message,
        ].join('');
        const token = crypto.createHmac('sha256', cfg.webhookSecret || cfg.secret).update(concatenated).digest('hex');

        const form = new URLSearchParams(data).toString();
        const target = `http://${req.headers.host}/api/cinetpay/webhook`;
        const webhookRes = await fetch(target, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-token': token },
            body: form,
            timeout: 15000,
        });
        const body = await webhookRes.json().catch(() => null);
        res.status(webhookRes.status).json({ success: webhookRes.ok, payload: data, webhook: body });
    } catch (err) {
        console.error('[cinetpay/test-webhook]', err.message);
        res.status(502).json({ success: false, message: err.message || 'Erreur lors de la simulation.' });
    }
});

// ============================================================
// WEBHOOK CHECKOUT (PUBLIC) — POST form-urlencoded + ping GET.
// Le payload ne contient pas de statut fiable : il sert seulement à
// retrouver la transaction, puis /payment/check tranche.
// ============================================================
export const webhookRouter = Router();

webhookRouter.get('/', (req, res) => {
    // CinetPay « pinge » l'URL en GET sans données : toujours 200 OK.
    res.status(200).send('OK');
});

webhookRouter.post('/', express.urlencoded({ extended: true }), async (req, res) => {
    try {
        const payload = req.body;
        if (!payload || typeof payload !== 'object') {
            return res.status(400).json({ success: false, message: 'Payload invalide.' });
        }

        // 1) Authenticité HMAC (mécanisme officiel) si le secret est configuré.
        const secretConfigured = Boolean(cinetpayConfig().webhookSecret);
        if (secretConfigured) {
            const token = req.headers['x-token'] || '';
            if (!verifyWebhookHmac(payload, token)) {
                return res.status(401).json({ success: false, message: 'Signature x-token invalide.' });
            }
        } else {
            console.warn('[cinetpay/webhook] CINETPAY_WEBHOOK_SECRET absent : seule la re-vérification serveur protège ce webhook.');
        }

        const transId = payload.cpm_trans_id || payload.transaction_id || null;
        if (!transId) return res.status(400).json({ success: false, message: 'cpm_trans_id manquant.' });

        const fingerprint = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');

        // 2) Dédup : payload déjà traité => ignoré (200).
        const { data: dup } = await sb().from('cinetpay_webhooks').select('id, handled').eq('fingerprint', fingerprint).maybeSingle();
        if (dup?.handled) {
            return res.json({ success: true, duplicated: true });
        }

        // 3) Journal atomique AVANT traitement (rejeu possible tant que
        //    non « traité »).
        if (!dup) {
            const { data: inserted } = await sb()
                .from('cinetpay_webhooks')
                .upsert(
                    { kind: 'payment', transaction_ref: transId, fingerprint, payload, handled: false },
                    { onConflict: 'fingerprint', ignoreDuplicates: true }
                )
                .select();
            if (!inserted?.length) {
                return res.json({ success: true, duplicated: true });
            }
        }

        // 4) Raccordement à la session MIM (par transaction_id généré ici).
        const { data: payment, error: payErr } = await sb()
            .from('cinetpay_payments')
            .select('*')
            .eq('transaction_id', transId)
            .maybeSingle();
        if (payErr) throw payErr;
        if (!payment) {
            console.warn('[cinetpay/webhook] transaction inconnue:', transId);
            await sb()
                .from('cinetpay_webhooks')
                .update({ handled: true, handled_at: new Date().toISOString(), result: 'unknown' })
                .eq('fingerprint', fingerprint);
            return res.json({ success: true, transaction_id: transId, result: 'unknown' });
        }

        // 5) Re-vérification serveur + effets métier (source de vérité).
        let outcome;
        try {
            outcome = await reconcileCinetpayPayment(payment, { webhookPayload: payload });
        } catch (err) {
            console.error('[cinetpay/webhook] traitement différé:', err.message);
            await sb().from('cinetpay_webhooks').update({ error: err.message || String(err) }).eq('fingerprint', fingerprint);
            return res.status(503).json({
                success: false,
                transaction_id: transId,
                result: 'confirm_unavailable',
                message: 'Vérification CinetPay momentanément indisponible ; notification conservée pour re-traitement.',
            });
        }

        await sb()
            .from('cinetpay_webhooks')
            .update({ handled: true, handled_at: new Date().toISOString(), result: outcome.result, error: null })
            .eq('fingerprint', fingerprint);

        res.json({ success: true, transaction_id: transId, result: outcome.result === 'unchanged' ? outcome.status.toLowerCase() : outcome.result });
    } catch (err) {
        console.error('[cinetpay/webhook]', err.message);
        res.status(500).json({ success: false, message: 'Erreur interne.' });
    }
});

// ============================================================
// NOTIFICATION TRANSFERT (PUBLIC) — POST form-urlencoded.
// Annonce un changement d'état d'un reversement. Comme pour le
// checkout : le payload sert à RETROUVER la ligne, l'état réel est
// confirmé auprès de /transfer/check/money.
// ============================================================
export const transferNotifyRouter = Router();

transferNotifyRouter.get('/', (req, res) => {
    res.status(200).send('OK');
});

transferNotifyRouter.post('/', express.urlencoded({ extended: true }), async (req, res) => {
    try {
        const payload = req.body || {};
        const clientTx = payload.client_transaction_id || null;
        const providerTx = payload.transaction_id || payload.provider_transaction_id || null;

        const fingerprint = crypto.createHash('sha256').update(`payout:${JSON.stringify(payload)}`).digest('hex');

        const { data: dup } = await sb().from('cinetpay_webhooks').select('id, handled').eq('fingerprint', fingerprint).maybeSingle();
        if (dup?.handled) return res.json({ success: true, duplicated: true });
        if (!dup) {
            const { data: inserted } = await sb()
                .from('cinetpay_webhooks')
                .upsert(
                    { kind: 'payout', transaction_ref: clientTx || providerTx, fingerprint, payload, handled: false },
                    { onConflict: 'fingerprint', ignoreDuplicates: true }
                )
                .select();
            if (!inserted?.length) return res.json({ success: true, duplicated: true });
        }

        if (!clientTx && !providerTx) {
            await sb()
                .from('cinetpay_webhooks')
                .update({ handled: true, handled_at: new Date().toISOString(), result: 'no_reference' })
                .eq('fingerprint', fingerprint);
            return res.json({ success: true, result: 'ignored' });
        }

        try {
            const updated = await finalizePayoutByNotify({
                clientTransactionId: clientTx,
                providerTransferId: providerTx,
            });
            await sb()
                .from('cinetpay_webhooks')
                .update({
                    handled: true,
                    handled_at: new Date().toISOString(),
                    result: updated ? updated.status.toLowerCase() : 'unknown',
                    error: null,
                })
                .eq('fingerprint', fingerprint);
            return res.json({ success: true, result: updated ? updated.status.toLowerCase() : 'unknown' });
        } catch (err) {
            await sb().from('cinetpay_webhooks').update({ error: err.message || String(err) }).eq('fingerprint', fingerprint);
            return res.status(503).json({ success: false, result: 'confirm_unavailable' });
        }
    } catch (err) {
        console.error('[cinetpay/payout-notify]', err.message);
        res.status(500).json({ success: false, message: 'Erreur interne.' });
    }
});

export default router;
