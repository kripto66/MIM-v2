// ============================================================
// MIM - Client PayDunya (https://developers.paydunya.com)
//
// API « Payment And Redistribution » (PAR) pour encaisser :
//   - abonnements MIM (l'admin initie la facture)
//   - loyers (le locataire paie, MIM encaisse puis redistribue)
//   - salaires (le propriétaire paie, MIM encaisse puis redistribue)
//
// API « Payment ET Redistribution » (PER / Déboursement) pour verser :
//   - POST /direct-pay/credit-account (compte PayDunya du destinataire)
//
// Sécurité :
//   - Les clés ne vivent que dans server/.env (PAYDUNYA_*).
//   - Le webhook IPN est authentifié par hash SHA-512(Master Key).
//   - Le montant / destinataire ne viennent JAMAIS du client : ils
//     sont relus en base côté routes.
// ============================================================

import crypto from 'node:crypto';

const BASE_TEST = 'https://app.paydunya.com/sandbox-api/v1';
const BASE_PROD = 'https://app.paydunya.com/api/v1';

export function paydunyaConfig() {
  const mode = process.env.PAYDUNYA_MODE === 'production' ? 'production' : 'test';
  const masterKey = process.env.PAYDUNYA_MASTER_KEY;
  const privateKey = process.env.PAYDUNYA_PRIVATE_KEY;
  const token = process.env.PAYDUNYA_TOKEN;
  if (!masterKey || !privateKey || !token) {
    throw new Error('Clés API PayDunya manquantes (PAYDUNYA_MASTER_KEY / PAYDUNYA_PRIVATE_KEY / PAYDUNYA_TOKEN).');
  }
  // Override pour les tests (mock local) : PAYDUNYA_API_URL
  const base = process.env.PAYDUNYA_API_URL || (mode === 'production' ? BASE_PROD : BASE_TEST);
  return { mode, base, masterKey, privateKey, token };
}

// Appel générique : JSON vers l'API PayDunya (authentification par headers).
export async function paydunyaRequest(path, { method = 'POST', body, query = {}, timeout = 30000 } = {}) {
  const cfg = paydunyaConfig();
  const url = new URL(path, cfg.base + '/');
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== '') url.searchParams.set(k, v);
  }

  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'PAYDUNYA-MASTER-KEY': cfg.masterKey,
      'PAYDUNYA-PRIVATE-KEY': cfg.privateKey,
      'PAYDUNYA-TOKEN': cfg.token,
    },
    body: method !== 'GET' && body != null ? JSON.stringify(body) : undefined,
    timeout,
  });
  const data = await res.json().catch(() => null);

  if (!res.ok || !data || (data.response_code != null && String(data.response_code) !== '00')) {
    const err = new Error(data?.response_text || data?.message || `PayDunya ${path} -> HTTP ${res.status}`);
    err.code = data?.response_code || res.status;
    err.paydunya = data;
    throw err;
  }
  return data;
}

// Informations de la boutique (affichées sur la page de paiement PayDunya).
export function storeInfo() {
  return {
    name: process.env.PAYDUNYA_STORE_NAME || 'MIM',
    tagline: process.env.PAYDUNYA_STORE_TAGLINE || 'Gestion immobilière',
    phone: process.env.PAYDUNYA_STORE_PHONE || '',
    logo_url: process.env.PAYDUNYA_STORE_LOGO_URL || '',
    website_url: process.env.PAYDUNYA_STORE_WEBSITE_URL || process.env.APP_URL || '',
  };
}

// Crée une facture PAR : le client est redirigé vers invoiceUrl pour payer
// (il choisit lui-même son moyen : Wave, Orange Money, carte, etc.).
export async function createPaydunyaInvoice({
  totalAmount,
  description = '',
  items = [],
  customer = {},
  customData = {},
  returnUrl = '',
  cancelUrl = '',
  callbackUrl = '',
}) {
  const invoice = { total_amount: Number(totalAmount), description: String(description || '') };
  if (Array.isArray(items) && items.length) invoice.items = items;
  const customerObj = {};
  if (customer.name) customerObj.name = String(customer.name);
  if (customer.email) customerObj.email = String(customer.email);
  if (customer.phone) customerObj.phone = String(customer.phone);
  if (Object.keys(customerObj).length) invoice.customer = customerObj;

  const payload = { invoice, store: storeInfo() };
  if (customData && Object.keys(customData).length) payload.custom_data = customData;
  const actions = {};
  if (returnUrl) actions.return_url = returnUrl;
  if (cancelUrl) actions.cancel_url = cancelUrl;
  if (callbackUrl) actions.callback_url = callbackUrl;
  if (Object.keys(actions).length) payload.actions = actions;

  const data = await paydunyaRequest('/checkout-invoice/create', { body: payload });
  if (!data.token) throw new Error("PayDunya n'a pas retourné de token de facture.");
  return {
    token: data.token,
    invoiceUrl: data.response_text || null,
    responseCode: data.response_code,
  };
}

// Statut d'une facture (source de vérité, utilisée aussi après un IPN).
// Le serveur PayDunya renvoie status : 'completed' | 'pending' | 'cancelled'.
export async function confirmPaydunyaInvoice(token) {
  const data = await paydunyaRequest(`/checkout-invoice/confirm/${encodeURIComponent(token)}`, { method: 'GET' });
  return {
    status: String(data.status || '').toLowerCase(),
    responseText: data.response_text || '',
    token,
    invoice: data.invoice || null,
    receiptUrl: data.receipt_url || null,
    customer: data.customer || null,
    hash: data.hash || null,
    customData: data.custom_data || null,
    totalAmount: data.invoice?.total_amount != null ? Number(data.invoice.total_amount) : null,
  };
}

// Vérifie le hash d'un IPN PayDunya : hash SHA-512 de la clé principale.
// C'est la preuve que la notification provient bien des serveurs PayDunya.
export function verifyIpnHash(hash) {
  if (!hash) return false;
  const expected = crypto.createHash('sha512').update(paydunyaConfig().masterKey).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(String(hash), 'utf8'));
  } catch {
    return false;
  }
}

// Versement « Payment ET Redistribution » : crédite le compte PayDunya
// d'un destinataire (alias = email ou numéro mobile de son compte PayDunya).
export async function creditPaydunyaAccount(accountAlias, amount) {
  const data = await paydunyaRequest('/direct-pay/credit-account', {
    body: { account_alias: String(accountAlias), amount: Number(amount) },
  });
  return {
    responseCode: data.response_code,
    responseText: data.response_text,
    description: data.description || '',
    transactionId: data.transaction_id != null ? String(data.transaction_id) : null,
  };
}