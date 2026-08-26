// ============================================================
// Client officiel CinetPay — implémente les deux APIs documentées :
//
//  1) Checkout v2 (encaissement)
//     POST {checkout}/payment        création d'une session de paiement
//     POST {checkout}/payment/check  vérification du statut réel
//     Notification IPN : POST form-urlencoded sur notify_url (sans statut
//     fiable) => TOUJOURS re-vérifier via /payment/check. Ping GET aussi.
//     Authenticité : header x-token = HMAC-SHA256(secret, concat ordonnée).
//
//  2) Transfer v1 (reversements)
//     POST {transfer}/auth/login                  token (apikey+password)
//     GET  {transfer}/transfer/check/balance      solde
//     POST {transfer}/transfer/contact            ajouter un bénéficiaire
//     POST {transfer}/transfer/money/send/contact envoyer l'argent
//     GET  {transfer}/transfer/check/money        statut du transfert
//     treatment_status : NEW/REC/NOS transitionnels, VAL succès final,
//     REJ rejet final.
//
// Sources : https://docs.cinetpay.com/api/1.0-en/checkout/*
//           https://docs.cinetpay.com/api/1.0-en/transfert/utilisation
// Aucun paramètre n'est inventé ; les URLs sont surchargées par env pour
// les tests (CINETPAY_CHECKOUT_API_URL / CINETPAY_TRANSFER_API_URL).
// ============================================================

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const CHECKOUT_DEFAULT = 'https://api-checkout.cinetpay.com/v2';
const TRANSFER_DEFAULT = 'https://client.cinetpay.com/v1';

export function cinetpayConfig() {
    return {
        apiKey: process.env.CINETPAY_API_KEY || '',
        siteId: process.env.CINETPAY_SITE_ID || '',
        secret: process.env.CINETPAY_SECRET || process.env.CINETPAY_WEBHOOK_SECRET || '',
        webhookSecret: process.env.CINETPAY_WEBHOOK_SECRET || process.env.CINETPAY_SECRET || '',
        environment: (process.env.CINETPAY_ENVIRONMENT || 'test').toLowerCase(),
        currency: (process.env.CINETPAY_CURRENCY || 'XOF').toUpperCase(),
        channels: process.env.CINETPAY_CHANNELS || 'ALL',
        defaultPrefix: (process.env.CINETPAY_DEFAULT_PREFIX || '221').replace(/\D/g, '') || '221',
        transferPassword: process.env.CINETPAY_TRANSFER_PASSWORD || '',
        checkoutBase: (process.env.CINETPAY_CHECKOUT_API_URL || CHECKOUT_DEFAULT).replace(/\/+$/, ''),
        transferBase: (process.env.CINETPAY_TRANSFER_API_URL || TRANSFER_DEFAULT).replace(/\/+$/, ''),
    };
}

export function cinetpayEnabled() {
    const c = cinetpayConfig();
    return Boolean(c.apiKey && c.siteId);
}

export class CinetPayError extends Error {
    constructor(message, code = null, details = null) {
        super(message);
        this.name = 'CinetPayError';
        this.code = code;
        this.details = details;
    }
}

async function postJson(url, payload) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* réponse non-JSON */ }
    if (!res.ok && !body) {
        throw new CinetPayError(`HTTP ${res.status} sur ${url}`, String(res.status), text?.slice(0, 300));
    }
    return body;
}

function postForm(url, params) {
    return new Promise((resolve, reject) => {
        const data = new URLSearchParams(params).toString();
        const req = httpsRequest(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(data),
            },
        }, (res) => {
            let raw = '';
            res.on('data', (c) => (raw += c));
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(raw); } catch { /* non-JSON */ }
                resolve(parsed ?? { __raw: raw, __status: res.statusCode });
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

function httpsRequest(url, options, cb) {
    const mod = url.startsWith('https') ? https : http;
    return mod.request(url, options, cb);
}

// ------------------------------------------------------------
// Checkout v2
// ------------------------------------------------------------

export async function createCheckout({ transactionId, amount, currency, description, customer = {}, metadata = null, notifyUrl = null, returnUrl = null, channels = null, lockPhoneNumber = false }) {
    const c = cinetpayConfig();
    const payload = {
        apikey: c.apiKey,
        site_id: c.siteId,
        transaction_id: transactionId,
        amount: Math.round(Number(amount)),
        currency: (currency || c.currency).toUpperCase(),
        description: String(description || `Paiement ${transactionId}`),
        channels: channels || c.channels,
    };
    if (notifyUrl) payload.notify_url = notifyUrl;
    if (returnUrl) payload.return_url = returnUrl;
    if (metadata != null) payload.metadata = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
    if (customer.name) payload.customer_name = customer.name;
    if (customer.surname) payload.customer_surname = customer.surname;
    if (customer.email) payload.customer_email = customer.email;
    if (customer.phone) {
        payload.customer_phone_number = customer.phone;
        // Paramètre officiel (docs « Initialisation d'un paiement ») : avec
        // lock_phone_number=true, le guichet ne demande PAS de numéro, le
        // client valide simplement son paiement (push USSD / app wallet).
        // Toujours accompagné de customer_phone_number.
        if (lockPhoneNumber) payload.lock_phone_number = true;
    }

    const body = await postJson(`${c.checkoutBase}/payment`, payload);
    if (body?.code !== '201' || !body?.data?.payment_url) {
        throw new CinetPayError(body?.message || 'Création Checkout CinetPay échouée', body?.code, body);
    }
    return {
        paymentToken: body.data.payment_token || null,
        paymentUrl: body.data.payment_url,
        raw: body,
    };
}

const CHECKOUT_STATUS_MAP = {
    ACCEPTED: 'success',
    REFUSED: 'failed',
    CANCELLED: 'cancelled',
};

export async function checkPayment(transactionId) {
    const c = cinetpayConfig();
    const body = await postJson(`${c.checkoutBase}/payment/check`, {
        apikey: c.apiKey,
        site_id: c.siteId,
        transaction_id: transactionId,
    });
    if (body?.code !== '00' || !body?.data) {
        throw new CinetPayError(body?.message || 'Vérification CinetPay échouée', body?.code, body);
    }
    const d = body.data;
    return {
        status: CHECKOUT_STATUS_MAP[String(d.status || '').toUpperCase()] || 'pending',
        providerStatus: d.status || null,
        amount: d.amount != null ? Number(d.amount) : null,
        currency: d.currency ? String(d.currency).toUpperCase() : null,
        paymentMethod: d.payment_method || null,
        operatorId: d.operator_id || null,
        metadata: d.metadata ?? null,
        raw: d,
    };
}

// ------------------------------------------------------------
// Transfer v1
// ------------------------------------------------------------

let tokenCache = { token: null, createdAt: 0 };
const TOKEN_TTL_MS = 45 * 60 * 1000; // tokens valides ~50min chez CinetPay

export async function transferLogin(force = false) {
    const c = cinetpayConfig();
    if (!c.apiKey || !c.transferPassword) {
        throw new CinetPayError('Transferts CinetPay non configurés (CINETPAY_API_KEY / CINETPAY_TRANSFER_PASSWORD)', 'NO_CONFIG');
    }
    if (!force && tokenCache.token && Date.now() - tokenCache.createdAt < TOKEN_TTL_MS) {
        return tokenCache.token;
    }
    const body = await postForm(`${c.transferBase}/auth/login`, {
        apikey: c.apiKey,
        password: c.transferPassword,
    });
    if (body?.code !== 0 || !body?.data?.token) {
        tokenCache = { token: null, createdAt: 0 };
        throw new CinetPayError(body?.message || 'Authentification Transfert CinetPay échouée', String(body?.code), body);
    }
    tokenCache = { token: body.data.token, createdAt: Date.now() };
    return tokenCache.token;
}

export function resetTransferToken() {
    tokenCache = { token: null, createdAt: 0 };
}

export async function transferAddContact({ prefix, phone, name = '', surname = '', email = '' }) {
    const token = await transferLogin();
    const body = await postForm(`${cinetpayConfig().transferBase}/transfer/contact?token=${encodeURIComponent(token)}`, {
        data: JSON.stringify([{ prefix: String(prefix), phone: String(phone), name, surname, email }]),
    });
    // Le contact peut déjà exister : ce n'est PAS une erreur bloquante.
    if (body?.code !== 0) {
        const msg = String(body?.message || '').toUpperCase();
        if (msg.includes('ALREADY') || body?.code === 726) return { already: true, raw: body };
        throw new CinetPayError(body?.message || 'Ajout contact CinetPay échoué', String(body?.code), body);
    }
    return { already: false, raw: body };
}

/**
 * Envoie de l'argent vers un numéro. Retourne le statut initial du
 * transfert (généralement NEW / NOS en attente de confirmation email).
 */
export async function transferSendMoney({ prefix, phone, amount, clientTransactionId, notifyUrl = null, paymentMethod = null }) {
    const token = await transferLogin();
    const entry = {
        prefix: String(prefix),
        phone: String(phone),
        amount: Math.round(Number(amount)),
        client_transaction_id: String(clientTransactionId),
    };
    if (notifyUrl) entry.notify_url = notifyUrl;
    if (paymentMethod) entry.payment_method = paymentMethod;
    const body = await postForm(`${cinetpayConfig().transferBase}/transfer/money/send/contact?token=${encodeURIComponent(token)}`, {
        data: JSON.stringify([entry]),
    });
    if (body?.code !== 0) {
        throw new CinetPayError(body?.message || 'Envoi Transfert CinetPay échoué', String(body?.code), body);
    }
    const first = Array.isArray(body?.data) ? body.data[0] : (body?.data || {});
    return {
        providerTransferId: first?.transaction_id || null,
        lot: first?.lot || null,
        treatmentStatus: String(first?.treatment_status || 'NEW').toUpperCase(),
        sendingStatus: first?.sending_status || null,
        raw: body,
    };
}

const TREATMENT_STATUS_MAP = {
    VAL: 'success',
    REJ: 'failed',
    NEW: 'processing',
    REC: 'processing',
    NOS: 'processing',
};

export async function transferCheckMoney({ clientTransactionId = null, providerTransactionId = null, lot = null }) {
    const token = await transferLogin();
    const params = new URLSearchParams({ token });
    if (clientTransactionId) params.set('client_transaction_id', clientTransactionId);
    else if (providerTransactionId) params.set('transaction_id', providerTransactionId);
    else if (lot) params.set('lot', lot);
    else throw new CinetPayError('transferCheckMoney : un identifiant est requis', '-1');
    const body = await getJson(`${cinetpayConfig().transferBase}/transfer/check/money?${params.toString()}`);
    if (body?.code !== 0) {
        throw new CinetPayError(body?.message || 'Vérification Transfert CinetPay échouée', String(body?.code), body);
    }
    const first = Array.isArray(body?.data) ? body.data[0] : (body?.data || {});
    const treatment = String(first?.treatment_status || '').toUpperCase();
    return {
        status: TREATMENT_STATUS_MAP[treatment] || 'processing',
        treatmentStatus: treatment || null,
        sendingStatus: first?.sending_status || null,
        providerTransferId: first?.transaction_id || null,
        lot: first?.lot || null,
        raw: first,
    };
}

function getJson(url) {
    return new Promise((resolve, reject) => {
        httpsGet(url, (res) => {
            let raw = '';
            res.on('data', (c) => (raw += c));
            res.on('end', () => {
                try { resolve(JSON.parse(raw)); } catch { resolve({ __raw: raw, __status: res.statusCode }); }
            });
        }).on('error', reject);
    });
}

function httpsGet(url, cb) {
    const mod = url.startsWith('https') ? https : http;
    return mod.get(url, cb);
}

export async function transferBalance() {
    const token = await transferLogin();
    return getJson(`${cinetpayConfig().transferBase}/transfer/check/balance?token=${encodeURIComponent(token)}`);
}

// ------------------------------------------------------------
// Vérification d'authenticité de la notification (x-token)
// hash_hmac('SHA256', concaténation ordonnée des champs, secret)
// ------------------------------------------------------------

const HMAC_FIELD_ORDER = [
    'cpm_site_id', 'cpm_trans_id', 'cpm_trans_date', 'cpm_amount',
    'cpm_currency', 'signature', 'payment_method', 'cel_phone_num',
    'cpm_phone_prefixe', 'cpm_language', 'cpm_version', 'cpm_payment_config',
    'cpm_page_action', 'cpm_custom', 'cpm_designation', 'cpm_error_message',
];

export function verifyWebhookHmac(payload, receivedToken) {
    const secret = cinetpayConfig().webhookSecret;
    if (!secret || !receivedToken) return false;
    const concatenated = HMAC_FIELD_ORDER.map((f) => (payload?.[f] == null ? '' : String(payload[f]))).join('');
    const expected = crypto.createHmac('sha256', secret).update(concatenated).digest('hex');
    const a = Buffer.from(String(expected));
    const b = Buffer.from(String(receivedToken));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}
