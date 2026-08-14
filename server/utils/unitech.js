// ============================================================
// MIM - Client UnitechPay (https://pay.unitech.sn/documentation)
// Encaisse mobile money : Wave / Orange Money (SN) + pays CI, TG, BF, BJ.
// Clé API en serveur/.env -> UNITECH_API_KEY (jamais en dur ici).
// ============================================================

import crypto from 'node:crypto';

const BASE_URL = process.env.UNITECH_API_URL || 'https://api.unitech.sn/api';

function apiKey() {
  const key = process.env.UNITECH_API_KEY;
  if (!key) throw new Error('UNITECH_API_KEY manquante dans l\'environnement.');
  return key;
}

// Appel générique : POST ?action=... avec body JSON, ou GET ?action=...&params.
export async function unitechRequest(action, { params = {}, body = {}, method = 'POST' } = {}) {
  const url = new URL(BASE_URL);
  url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, v);
  }

  const options = {
    method,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      Accept: 'application/json',
    },
    timeout: 30000,
  };
  if (method === 'POST') {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const data = await res.json().catch(() => null);

  if (!res.ok || !data || data.success === false) {
    const err = new Error(data?.message || `UnitechPay ${action} -> HTTP ${res.status}`);
    err.code = data?.code || res.status;
    err.unitech = data;
    throw err;
  }
  return data;
}

// Soldes marchand : { sold_wave, sold_om, sold_intl, total, currency }
export async function getBalance() {
  return unitechRequest('balance', { method: 'GET' });
}

// Paiement Wave (Sénégal) : renvoie { transaction_id, reference, payment_url, status, ... }
export async function createWavePayment({ amount, customerNumber, description = '', callbackSuccess = '', callbackCancel = '' }) {
  return unitechRequest('create_wave_payment', {
    body: {
      amount,
      customer_number: customerNumber,
      description,
      callback_success: callbackSuccess,
      callback_cancel: callbackCancel,
    },
  });
}

// Paiement Orange Money (Sénégal) : type = 'qr' | 'maxit' | 'om'
export async function createOrangePayment({ type = 'om', amount, customerNumber = '', reference = '', description = '', callbackSuccess = '', callbackCancel = '' }) {
  const action =
    type === 'qr' ? 'create_orange_qr'
    : type === 'maxit' ? 'create_orange_maxit'
    : 'create_orange_om';
  const body = { amount, description, callback_success: callbackSuccess, callback_cancel: callbackCancel };
  if (customerNumber) body.customer_number = customerNumber;
  if (reference) body.reference = reference;
  return unitechRequest(action, { body });
}

// Vérifie la signature HMAC-SHA256 d'un webhook UnitechPay.
// signature = header 'X-UNITECHPAY-SIGNATURE', rawPayload = corps brut de la requête.
export function verifyWebhookSignature(rawPayload, signature) {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', apiKey()).update(rawPayload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'));
  } catch {
    return false;
  }
}

// Versement (payout) mobile money : le marchand MIM verse à un bénéficiaire
// (ex. salaire d'un employé). action 'withdraw_funds'.
export async function withdrawFunds({ amount, customerNumber = '', operator = 'wave', reference = '', description = '' }) {
  const body = { amount, description };
  if (customerNumber) body.customer_number = customerNumber;
  if (reference) body.reference = reference;
  return unitechRequest('withdraw_funds', { body });
}
