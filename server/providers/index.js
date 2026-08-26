// ============================================================
// Abstraction provider de paiement / reversement.
//
// Interface commune :
//   available()                          -> bool (config complète ?)
//   createPayment({...})                 -> { providerRef, paymentUrl, raw }
//   verifyPayment({ reference })         -> { status, amount, currency, paymentMethod, operatorId, metadata, raw }
//   createPayout({ clientTransactionId, prefix, phone, beneficiaryName,
//                  amount, notifyUrl, paymentMethod })
//                                        -> { status, providerTransferId, lot, raw }
//   checkPayout({ clientTransactionId }) -> { status, treatmentStatus?, raw }
//
// Statuts normalisés :
//   paiement  : success | pending | failed | cancelled
//   reversemt : success | processing | failed | pending
//
// Deux providers enregistrés : cinetpay (Checkout v2 + Transfer v1)
// et paydunya (adaptateur sur l'existant server/utils/paydunya.js).
// ============================================================

import * as cinetpay from './cinetpay.js';
import {
    createPaydunyaInvoice,
    confirmPaydunyaInvoice,
    creditPaydunyaAccount,
    paydunyaConfig,
} from '../utils/paydunya.js';

const PAYDUNYA_CHECKOUT_MAP = {
    completed: 'success',
    cancelled: 'cancelled',
    failed: 'failed',
    pending: 'pending',
};

const paydunyaProvider = {
    name: 'paydunya',
    available() {
        return Boolean(paydunyaConfig().masterKey);
    },
    async createPayment({ reference: _reference, amount, description, customer = {}, returnUrl = null, cancelUrl = null, customData = {} }) {
        const inv = await createPaydunyaInvoice({
            totalAmount: Number(amount),
            description: String(description || 'Paiement'),
            customer: { name: customer.name || '', email: customer.email || '', phone: customer.phone || '' },
            returnUrl,
            cancelUrl,
            customData,
        });
        return { providerRef: inv.token, paymentUrl: inv.invoiceUrl || null, raw: inv };
    },
    async verifyPayment({ reference }) {
        const res = await confirmPaydunyaInvoice(reference);
        return {
            status: PAYDUNYA_CHECKOUT_MAP[res.status] || 'pending',
            amount: res.totalAmount,
            currency: 'XOF',
            paymentMethod: null,
            operatorId: null,
            metadata: res.customData ?? null,
            raw: res,
        };
    },
    // PayDunya : versement direct immédiat (pas d'état intermédiaire).
    async createPayout({ accountAlias, amount }) {
        const res = await creditPaydunyaAccount(accountAlias, Number(amount));
        const ok = String(res.responseCode) === '00';
        return {
            status: ok ? 'success' : 'failed',
            providerTransferId: res.transactionId || null,
            lot: null,
            raw: res,
        };
    },
    async checkPayout({ reference: _reference }) {
        throw new Error('checkPayout non supporté par le provider paydunya (versements synchrones)');
    },
};

const cinetpayProvider = {
    name: 'cinetpay',
    available() {
        return cinetpay.cinetpayEnabled();
    },
    async createPayment({ reference, amount, currency, description, customer = {}, metadata = null, notifyUrl = null, returnUrl = null, channels = null, lockPhoneNumber = false }) {
        const res = await cinetpay.createCheckout({
            transactionId: reference,
            amount,
            currency,
            description,
            customer,
            metadata,
            notifyUrl,
            returnUrl,
            channels,
            lockPhoneNumber,
        });
        return { providerRef: res.paymentToken, paymentUrl: res.paymentUrl, raw: res.raw };
    },
    verifyPayment({ reference }) {
        return cinetpay.checkPayment(reference);
    },
    async createPayout({ clientTransactionId, prefix, phone, beneficiaryName = '', amount, notifyUrl = null, paymentMethod = null }) {
        await cinetpay.transferAddContact({
            prefix,
            phone,
            name: beneficiaryName.split(/\s+/)[0] || '',
            surname: beneficiaryName.split(/\s+/).slice(1).join(' ') || '',
        });
        const res = await cinetpay.transferSendMoney({
            prefix,
            phone,
            amount,
            clientTransactionId,
            notifyUrl,
            paymentMethod,
        });
        return {
            // NEW/REC/NOS => processing ; VAL ne survient pas à la création
            // en pratique mais on le gère proprement.
            status: res.treatmentStatus === 'VAL' ? 'success'
                : res.treatmentStatus === 'REJ' ? 'failed'
                : 'processing',
            providerTransferId: res.providerTransferId,
            lot: res.lot,
            raw: res.raw,
        };
    },
    checkPayout({ clientTransactionId }) {
        return cinetpay.transferCheckMoney({ clientTransactionId });
    },
};

const PROVIDERS = {
    cinetpay: cinetpayProvider,
    paydunya: paydunyaProvider,
};

export function getProvider(name = 'cinetpay') {
    const p = PROVIDERS[name];
    if (!p) throw new Error(`Provider inconnu : ${name}`);
    return p;
}

export function listProviders() {
    return Object.values(PROVIDERS).map((p) => ({ name: p.name, available: p.available() }));
}
