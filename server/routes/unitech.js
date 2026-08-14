// ============================================================
// MIM - Initiation de paiement UnitechPay (Wave / Orange Money)
// Le propriétaire génère un lien de paiement mobile money qu'il
// envoie au locataire/employé. La confirmation se fait via webhook
// (signature HMAC-SHA256 vérifiée) ou manuellement.
// ============================================================

import express, { Router } from 'express';
import { createWavePayment, createOrangePayment, getBalance, verifyWebhookSignature } from '../utils/unitech.js';

const router = Router();

const PHONE_RE = /^[0-9+ ]{7,20}$/;

// Génère un lien de paiement pour un montant donné.
// body : { amount, customer_number, operator: 'wave'|'orange', orange_mode?: 'qr'|'maxit'|'om', description }
router.post('/initiate', async (req, res) => {
  try {
    const { amount, customer_number, operator, orange_mode = 'om', description = '' } = req.body;

    if (!amount || !(Number(amount) > 0)) {
      return res.status(400).json({ success: false, message: 'Montant invalide.', errors: { amount: 'Montant requis et supérieur à 0.' } });
    }
    if (!customer_number || !PHONE_RE.test(String(customer_number))) {
      return res.status(400).json({ success: false, message: 'Numéro de téléphone invalide.', errors: { customer_number: 'Numéro au format international ou local requis.' } });
    }
    if (operator !== 'wave' && operator !== 'orange') {
      return res.status(400).json({ success: false, message: 'Opérateur invalide.', errors: { operator: 'Choisir wave ou orange.' } });
    }

    const callbacks = {
      callbackSuccess: process.env.APP_URL ? `${process.env.APP_URL}/paiement-succes` : '',
      callbackCancel: process.env.APP_URL ? `${process.env.APP_URL}/paiement-annule` : '',
    };

    const result = operator === 'wave'
      ? await createWavePayment({ amount: Number(amount), customerNumber: String(customer_number), description, ...callbacks })
      : await createOrangePayment({ type: orange_mode, amount: Number(amount), customerNumber: String(customer_number), description, ...callbacks });

    res.json({ success: true, data: result.data, message: 'Lien de paiement généré.' });
  } catch (err) {
    console.error('[unitech/initiate]', err.message);
    res.status(err.code === 401 ? 401 : 502).json({ success: false, message: err.message || 'Erreur UnitechPay.', code: err.code });
  }
});

// Solde du compte marchand (lecture seule, réservé aux propriétaires/admin).
router.get('/balance', async (req, res) => {
  try {
    const result = await getBalance();
    res.json({ success: true, data: result.data });
  } catch (err) {
    console.error('[unitech/balance]', err.message);
    res.status(502).json({ success: false, message: err.message || 'Erreur UnitechPay.' });
  }
});

// Webhook UnitechPay : confirme les paiements (payment_completed…).
// Accessible sans authentification MIM : la signature HMAC-SHA256 fait foi.
export const webhookRouter = Router();

webhookRouter.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.get('X-UNITECHPAY-SIGNATURE') || '';
    const payload = req.body || Buffer.alloc(0);
    if (!verifyWebhookSignature(payload.toString('utf8'), signature)) {
      return res.status(401).json({ success: false, message: 'Signature invalide.' });
    }
    const data = JSON.parse(payload.toString('utf8') || '{}');
    console.log('[unitech/webhook]', data.event, data.reference, data.status);
    // TODO production : marquer le paiement correspondant (paiements.reference)
    // comme payé lorsque event === 'payment_completed'.
    res.json({ success: true });
  } catch (err) {
    console.error('[unitech/webhook]', err.message);
    res.status(500).json({ success: false, message: 'Erreur interne.' });
  }
});

export default router;
