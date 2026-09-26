// ============================================================
// MIM - Webhook Bictorys (paiements d'abonnement)
//
// Reçoit les notifications de transaction Bictorys. Seul ce point
// d'entrée peut ACTIVER un abonnement (statut `succeeded`) :
// aucune autre route ne met à jour date_expiration sur un paiement
// en ligne.
//
// Sécurité :
//   * le header X-Secret-Key doit être égal à BICTORYS_WEBHOOK_SECRET ;
//   * signature HMAC et timestamp obligatoires ;
//   * traitement idempotent (journal public.bictorys_webhooks) ;
//   * les rejets métier permanents sont acquittés en 200, les erreurs
//     techniques transitoires renvoient 503 pour permettre un retry.
//
// Le corps est traité en BRUT (Buffer) : le route est montée avant
// express.json dans app.js pour permettre la vérification de signature.
// ============================================================

import { Router } from 'express';
import { verifyWebhook } from '../providers/bictorys.js';
import { processWebhook } from '../utils/subscription.js';

const router = Router();

router.post('/bictorys', async (req, res) => {
  const rawBody = req.body; // Buffer (express.raw)

  const check = verifyWebhook({
    rawBody,
    headers: req.headers || {},
  });

  if (!check.ok) {
    // Header X-Secret-Key invalide ou absent : on refuse.
    return res.status(401).json({ success: false, code: check.code, message: 'Webhook non autorisé.' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    console.error('[bictorys/webhook] JSON invalide :', err.message);
    return res.status(400).json({ success: false, code: 'INVALID_JSON', message: 'Payload invalide.' });
  }

  try {
    const result = await processWebhook(payload);
    if (!result?.ok) {
      const permanent = new Set([
        'AMOUNT_MISMATCH',
        'CURRENCY_MISMATCH',
        'MERCHANT_REFERENCE_MISMATCH',
        'TRANSACTION_MISMATCH',
        'TRANSACTION_MISSING',
        'PLAN_UNAVAILABLE',
        'UNSUPPORTED_STATUS',
      ]).has(result?.code);
      const status = result?.code === 'MALFORMED_EVENT' ? 400 : (permanent ? 200 : 503);
      return res.status(status).json({ success: false, code: result?.code || 'WEBHOOK_PROCESSING_ERROR', message: result?.message || 'Traitement différé.' });
    }
    return res.status(200).json({ success: true, duplicate: Boolean(result.duplicate), unmatched: Boolean(result.unmatched) });
  } catch (err) {
    console.error('[bictorys/webhook] traitement :', err.message);
    return res.status(503).json({ success: false, code: 'WEBHOOK_PROCESSING_ERROR', message: 'Traitement différé.' });
  }
});

export default router;