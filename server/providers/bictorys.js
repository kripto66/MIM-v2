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

// Consultation du statut d'une transaction Bictorys (fallback si le
// webhook n'est jamais arrivé). On utilise l'endpoint officiel
// « status check » /transactions/{id}/status : c'est le seul lisible
// avec la clé publique (GET /transactions/{id} renvoie 403 E403-1).
// Il ne renvoie que le statut ; reconcileOnePayment tolère l'absence
// de détails (montant figé au checkout + garde SQL du RPC d'activation).
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

  const res = await fetch(`${baseUrl()}/transactions/${encodeURIComponent(transactionId)}/status`, {
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
    amount: data?.amount ?? null,
    currency: data?.currency ?? null,
    paymentReference: data?.paymentReference || null,
    merchantReference: data?.merchantReference || null,
    // Date de règlement annoncée par Bictorys si l'endpoint la renvoie
    // (elle est absente de l'endpoint /status : le polling retombe sur
    // l'horloge locale via reconcileOnePayment).
    paidAt: data?.paidAt || data?.paid_at || data?.completedAt || data?.completed_at || null,
  };
}

// Vérification de l'authenticité d'un webhook Bictorys.
// Documentation officielle (docs.bictorys.com) :
//   * Méthode 1 — X-Webhook-Signature + X-Webhook-Timestamp présents :
//     HMAC-SHA256(secret, `${timestamp}.${corps_brut}`) en hex,
//     timestamp de moins de 5 minutes (anti-replay) ;
//   * Méthode 2 — fallback « clé statique » : si le HMAC n'est pas
//     envoyé (non activé sur le dashboard), seul X-Secret-Key fait foi.
export function verifyWebhook({ rawBody, headers }) {
  const secret = webhookSecret();
  if (!secret) return { ok: false, code: 'WEBHOOK_NOT_CONFIGURED' };

  const sent = headers['x-secret-key'] || headers['X-Secret-Key'] || '';
  const signature = String(headers['x-webhook-signature'] || headers['X-Webhook-Signature'] || '');
  const timestamp = String(headers['x-webhook-timestamp'] || headers['X-Webhook-Timestamp'] || '');

  if (signature && timestamp) {
    // Méthode 1 — HMAC-SHA256 sur le corps BRUT (pas hexé).
    if (sent && !safeEqual(sent, secret)) {
      return { ok: false, code: 'INVALID_WEBHOOK_SECRET' };
    }
    const timestampNumber = Number(timestamp);
    const timestampMs = timestampNumber > 100000000000 ? timestampNumber : timestampNumber * 1000;
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) {
      return { ok: false, code: 'WEBHOOK_TIMESTAMP_INVALID' };
    }
    const bodyText = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
    const expected = createHmacSecret(secret, `${timestamp}.${bodyText}`);
    const normalized = signature.replace(/^sha256=/i, '');
    if (!safeEqual(normalized, expected)) {
      return { ok: false, code: 'INVALID_WEBHOOK_SIGNATURE' };
    }
    return { ok: true, method: 'hmac' };
  }

  // Méthode 2 — clé statique (HMAC non envoyé par Bictorys).
  if (sent && safeEqual(sent, secret)) return { ok: true, method: 'static' };
  if (!sent) return { ok: false, code: 'WEBHOOK_SIGNATURE_REQUIRED' };
  return { ok: false, code: 'INVALID_WEBHOOK_SECRET' };
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