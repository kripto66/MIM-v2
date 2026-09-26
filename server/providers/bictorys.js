import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseMoney } from '../utils/inputValidation.js';

// ============================================================
// MIM - Client Bictorys (paiement en ligne des abonnements)
//
// Seul point de contact avec l'API Bictorys. Toute la configuration
// vient de l'environnement (jamais du frontend) :
//
//   BICTORYS_API_URL         base API  (défaut : sandbox test)
//   BICTORYS_API_KEY         clé publique marchand   (X-API-Key)
//   BICTORYS_WEBHOOK_SECRET  clé secrète du webhook  (X-Secret-Key)
//   BICTORYS_SIMULATE=1      mode simulation : aucun appel HTTP réel
//   BICTORYS_COUNTRY         pays par défaut (SN)
//
// En mode simulation (BICTORYS_SIMULATE=1) aucune requête n'est émise
// vers Bictorys : le checkout renvoie un lien factice et le statut
// reste 'pending' jusqu'à réception du webhook (qui seul active).
// ============================================================

function envBool(value) {
  return value === '1' || value === 'true' || value === 'TRUE';
}

export const baseUrl = () => (process.env.BICTORYS_API_URL || 'https://api.test.bictorys.com/pay/v1').replace(/\/+$/, '');
export const apiKey = () => process.env.BICTORYS_API_KEY || '';
export const isSimulate = () => envBool(process.env.BICTORYS_SIMULATE) && process.env.NODE_ENV !== 'production';

// La clé secrète effective : celle du .env. En mode simulation, une
// valeur par défaut est tolérée pour permettre les tests (fail open
// UNIQUEMENT en simulation ; en production, pas de secret => refus).
export function webhookSecret() {
  return process.env.BICTORYS_WEBHOOK_SECRET || null;
}

export function isConfigured() {
  return isSimulate() || Boolean(process.env.BICTORYS_API_KEY && (process.env.NODE_ENV !== 'production' || webhookSecret()));
}

function validAmount(value) {
  return parseMoney(value) !== null;
}

function validCurrency(value) {
  return /^[A-Z]{3}$/.test(String(value || '').trim().toUpperCase());
}

function validCountry(value) {
  return /^[A-Z]{2}$/.test(String(value || '').trim().toUpperCase());
}

function safeHttpsUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function requestSignal() {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(10000) : undefined;
}

// Nom de la devise acceptée (XOF par défaut).
export function country() {
  return process.env.BICTORY_COUNTRY || process.env.BICTORYS_COUNTRY || 'SN';
}

// Référence de paiement unique générée côté serveur : inclut l'UID du
// propriétaire (court) et un horodatage. C'est elle qui fait foi pour
// rattacher le webhook au paiement (paymentReference).
export function newPaymentReference(userId) {
  const uid = String(userId || 'unknown').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  return `MIM-${uid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
}

// Création d'une charge Bictorys → lien de paiement/confirmation.
// Retourne { transactionId, link, status, simulated }.
export async function createCharge({
  amount,
  currency = 'XOF',
  countryCode = country(),
  paymentReference,
  merchantReference,
  successRedirectUrl,
  errorRedirectUrl,
  customerObject = {},
}) {
  const okCfg = isConfigured();
  if (!okCfg) {
    throw new Error("Paiement en ligne indisponible : Bictorys n'est pas configuré (BICTORYS_API_KEY manquant).");
  }
  if (!validAmount(amount)) {
    throw new Error('Montant invalide.');
  }
  if (!validCurrency(currency) || !validCountry(countryCode)) {
    throw new Error('Devise ou pays invalide.');
  }
  if (!paymentReference || String(paymentReference).length > 200) {
    throw new Error('Référence de paiement requise.');
  }

  if (isSimulate()) {
    const simUrl = (() => {
      try {
        const u = new URL(successRedirectUrl || '/');
        u.searchParams.set('paiement', 'simule');
        u.searchParams.set('ref', paymentReference);
        return u.toString();
      } catch {
        return `${successRedirectUrl || '/'}?paiement=simule&ref=${encodeURIComponent(paymentReference)}`;
      }
    })();
    return {
      transactionId: `sim_${Date.now()}_${randomBytes(8).toString('hex')}`,
      link: simUrl,
      status: 'pending',
      simulated: true,
    };
  }

  const body = {
    amount: Number(amount),
    currency: String(currency).trim().toUpperCase(),
    country: String(countryCode).trim().toUpperCase(),
    paymentReference,
    merchantReference: merchantReference || null,
    successRedirectUrl,
    errorRedirectUrl,
    customerObject: customerObject || {},
  };

  const res = await fetch(`${baseUrl()}/charges`, {
    method: 'POST',
    signal: requestSignal(),
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey(),
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.message || data?.error || JSON.stringify(data);
    throw new Error(`Bictorys a refusé le paiement (HTTP ${res.status}) : ${detail}`);
  }

  // 201 ConfirmationLinkObject | 202 CheckoutLinkObject
  const transactionId = data?.transactionId || data?.chargeId || data?.id || null;
  const link = safeHttpsUrl(data?.redirectUrl || data?.link);
  if (!transactionId || !link) {
    throw new Error('Réponse Bictorys incomplète ou non sécurisée.');
  }

  return { transactionId, link: link.toString(), status: 'pending', simulated: false };
}

// Consultation d'une transaction Bictorys (fallback si le webhook n'est
// jamais arrivé). Retourne le statut Bictorys ('succeeded', 'failed'…).
export async function getTransaction(transactionId) {
  if (!transactionId) throw new Error('Identifiant de transaction manquant.');

  if (isSimulate()) {
    // En simulation, le webhook est LA seule source de vérité : le
    // fallback de polling ne doit jamais « activer » à la place de
    // Bictorys. On renvoie donc un statut en attente.
    return { status: 'pending', simulated: true };
  }

  if (!apiKey()) {
    throw new Error('Bictorys non configuré (BICTORYS_API_KEY manquant).');
  }

  const res = await fetch(`${baseUrl()}/transactions/${encodeURIComponent(transactionId)}`, {
    method: 'GET',
    signal: requestSignal(),
    headers: { 'X-API-Key': apiKey() },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Bictorys transactions (HTTP ${res.status}) : ${data?.message || JSON.stringify(data)}`);
  }
  return {
    id: data?.id || transactionId,
    status: String(data?.status || '').toLowerCase(),
    amount: data?.amount,
    currency: data?.currency,
    paymentReference: data?.paymentReference || null,
    merchantReference: data?.merchantReference || null,
  };
}

// Vérification de l'authenticité d'un webhook Bictorys.
// Le header X-Secret-Key DOIT être égal à la clé secrète du webhook
// (documentation officielle). X-Webhook-Signature et
// X-Webhook-Timestamp sont obligatoires et vérifiés en HMAC-SHA256.
export function verifyWebhook({ rawBody, headers }) {
  const secret = webhookSecret();
  if (!secret) return { ok: false, code: 'WEBHOOK_NOT_CONFIGURED' };

  const sent = headers['x-secret-key'] || headers['X-Secret-Key'] || '';
  if (!sent || !safeEqual(sent, secret)) {
    return { ok: false, code: 'INVALID_WEBHOOK_SECRET' };
  }

  const signature = String(headers['x-webhook-signature'] || headers['X-Webhook-Signature'] || '');
  const timestamp = String(headers['x-webhook-timestamp'] || headers['X-Webhook-Timestamp'] || '');
  if (!signature || !timestamp) return { ok: false, code: 'WEBHOOK_SIGNATURE_REQUIRED' };

  const timestampNumber = Number(timestamp);
  const timestampMs = timestampNumber > 100000000000 ? timestampNumber : timestampNumber * 1000;
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) {
    return { ok: false, code: 'WEBHOOK_TIMESTAMP_INVALID' };
  }

  const bodyHex = Buffer.from(rawBody || '').toString('hex');
  const expected = createHmacSecret(secret, `${timestamp}.${bodyHex}`);
  const normalized = signature.replace(/^sha256=/i, '');
  if (!safeEqual(normalized, expected)) {
    return { ok: false, code: 'INVALID_WEBHOOK_SIGNATURE' };
  }

  return { ok: true };
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function createHmacSecret(secret, data) {
  return createHmac('sha256', secret).update(data).digest('hex');
}