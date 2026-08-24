// ============================================================
// MIM - Reversements automatiques aux propriétaires via CinetPay
// (Transfer API v1 : contact + money/send/contact + check/money).
//
// Règles de sûreté :
//  - UNE SEULE ligne cinetpay_payouts par encaissement (index unique
//    sur cinetpay_payment_id) : les retries mettent la même ligne à
//    jour (retry_count), jamais de duplication d'ordre de transfert.
//  - client_transaction_id généré par MIM et réutilisé à l'identique :
//    si CinetPay répond 805 (CLIENT_TRANSACTION_ID_EXIST), l'état réel
//    est récupéré via /transfer/check/money au lieu de renvoyer l'argent.
//  - Le statut final n'est jamais déduit du seul appel d'envoi : il est
//    confirmé par check/money ou par le notify_url des transferts,
//    lui-même recoupé avec check/money.
//  - Retry contrôlé : max_retries (défaut 5), ensuite FAILED définitif ;
//    un administrateur peut relancer manuellement.
// ============================================================

import { getProvider } from '../providers/index.js';
import { serviceClient } from '../app.js';

const sb = () => serviceClient();
const provider = () => getProvider('cinetpay');

// Numéro national (chiffres seuls) sans préfixe pays.
function nationalNumber(numero, defaultPrefix) {
    let digits = String(numero || '').replace(/\D+/g, '');
    for (const p of [defaultPrefix, '221', '225', '223', '229', '226', '228', '227', '237', '243']) {
        if (digits.length > 9 && digits.startsWith(p)) {
            digits = digits.slice(p.length);
            break;
        }
    }
    return digits || null;
}

// ------------------------------------------------------------
// Destinataire du reversement pour un propriétaire :
//   1) moyen marqué pour_versement (numéro mobile money),
//   2) sinon premier moyen actif avec numéro,
//   3) sinon téléphone du profil.
// Retour : { prefix, phone, name, label } | null
// ------------------------------------------------------------
export async function resolveCinetpayTargetOfOwner(ownerId) {
    const defaultPrefix = (process.env.CINETPAY_DEFAULT_PREFIX || '221').replace(/\D/g, '') || '221';
    const { data: moyens } = await sb()
        .from('moyens_paiement')
        .select('type, numero, pour_versement')
        .eq('user_id', ownerId)
        .eq('actif', true)
        .order('updated_at', { ascending: false });
    const list = moyens || [];
    const candidates = [
        list.find((m) => m.pour_versement === true && m.numero),
        list.find((m) => m.numero),
    ];
    for (const m of candidates) {
        if (!m) continue;
        const phone = nationalNumber(m.numero, defaultPrefix);
        if (phone) {
            const { data: profile } = await sb().from('profiles').select('name').eq('id', ownerId).maybeSingle();
            return {
                prefix: defaultPrefix,
                phone,
                name: profile?.name || '',
                label: m.type || 'mobile_money',
            };
        }
    }
    const { data: profile } = await sb().from('profiles').select('name, phone').eq('id', ownerId).maybeSingle();
    const phone = nationalNumber(profile?.phone, defaultPrefix);
    if (phone) {
        return { prefix: defaultPrefix, phone, name: profile?.name || '', label: 'profil' };
    }
    return null;
}

function newClientTransactionId(paymentId) {
    return `MIMPO-${paymentId}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

// ------------------------------------------------------------
// Garantit qu'un reversement existe pour cet encaissement puis tente
// son envoi. Idempotent (index unique) : rejouable sans double effet.
// ------------------------------------------------------------
export async function ensurePayoutForPayment(paymentRow) {
    const { data: existing } = await sb()
        .from('cinetpay_payouts')
        .select('*')
        .eq('cinetpay_payment_id', paymentRow.id)
        .maybeSingle();
    if (existing) {
        // Une ligne existe déjà : si elle n'est pas encore partie, on
        // profite de l'appel pour relancer une tentative.
        if (['PENDING'].includes(existing.status)) {
            return attemptPayout(existing);
        }
        return existing;
    }

    const { data: inserted, error } = await sb()
        .from('cinetpay_payouts')
        .insert({
            cinetpay_payment_id: paymentRow.id,
            paiement_id: paymentRow.paiement_id,
            owner_id: paymentRow.owner_id,
            beneficiary_name: null,
            beneficiary_prefix: null,
            beneficiary_phone: null,
            amount: Number(paymentRow.amount),
            currency: paymentRow.currency || 'XOF',
            status: 'PENDING',
            client_transaction_id: newClientTransactionId(paymentRow.id),
        })
        .select()
        .single();
    if (error) {
        if (error.code === '23505') {
            const { data: winner } = await sb()
                .from('cinetpay_payouts')
                .select('*')
                .eq('cinetpay_payment_id', paymentRow.id)
                .maybeSingle();
            if (winner) return winner;
        }
        throw error;
    }
    return attemptPayout(inserted);
}

// ------------------------------------------------------------
// Tentative d'envoi effectif d'un reversement.
// Mapping statuts : NEW/REC/NOS -> PROCESSING ; VAL -> SUCCESS ;
// REJ / erreur opérateur -> RETRYING (ou FAILED après épuisement).
// ------------------------------------------------------------
export async function attemptPayout(payoutRow) {
    if (payoutRow.status === 'SUCCESS') {
        return payoutRow;
    }
    const fresh = await reloadPayout(payoutRow.id);
    if (['PROCESSING'].includes(fresh.status)) {
        // Un envoi a déjà eu lieu : vérifier avant de renvoyer.
        return checkAndFinalizePayout(fresh);
    }

    const target = await resolveCinetpayTargetOfOwner(fresh.owner_id);
    if (!target) {
        return applyFailure(fresh, 'Aucun numéro de versement configuré pour ce propriétaire.');
    }

    try {
        const res = await provider().createPayout({
            clientTransactionId: fresh.client_transaction_id,
            prefix: target.prefix,
            phone: target.phone,
            beneficiaryName: target.name,
            amount: Number(fresh.amount),
            notifyUrl: payoutNotifyUrl(),
            paymentMethod: null,
        });

        if (res.status === 'success') {
            return await finalizeSuccess(fresh, res);
        }
        if (res.status === 'processing') {
            const { data: updated } = await sb()
                .from('cinetpay_payouts')
                .update({
                    status: 'PROCESSING',
                    provider_transfer_id: res.providerTransferId || fresh.provider_transfer_id,
                    lot: res.lot || fresh.lot,
                    beneficiary_name: target.name || fresh.beneficiary_name,
                    beneficiary_prefix: target.prefix,
                    beneficiary_phone: target.phone,
                    payment_method: target.label,
                    last_attempt_at: new Date().toISOString(),
                    last_error: null,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', fresh.id)
                .select()
                .single();
            return updated || fresh;
        }
        // failed côté opérateur
        return await applyFailure(fresh, res.raw?.message || 'Transfert refusé par l\'opérateur.');
    } catch (err) {
        // 805 : l'identifiant a DÉJÀ été soumis — ne pas renvoyer l'argent,
        // interroger l'état réel auprès de CinetPay.
        if (String(err?.code) === '805') {
            console.warn(`[cinetpay/payout] ${fresh.client_transaction_id} déjà soumis (805), vérification.`);
            return checkAndFinalizePayout(fresh);
        }
        return applyFailure(fresh, err.message || 'Erreur Transfert CinetPay.');
    }
}

async function reloadPayout(id) {
    const { data } = await sb().from('cinetpay_payouts').select('*').eq('id', id).maybeSingle();
    if (!data) throw new Error('Reversement introuvable.');
    return data;
}

function payoutNotifyUrl() {
    const base = process.env.APP_URL || '';
    try {
        new URL(base);
        return `${base.replace(/\/+$/, '')}/api/cinetpay/payout-notify`;
    } catch {
        return null;
    }
}

async function finalizeSuccess(row, res) {
    const { data: updated } = await sb()
        .from('cinetpay_payouts')
        .update({
            status: 'SUCCESS',
            provider_transfer_id: res.providerTransferId || row.provider_transfer_id,
            lot: res.lot || row.lot,
            completed_at: new Date().toISOString(),
            last_error: null,
            last_attempt_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        })
        .eq('id', row.id)
        .neq('status', 'SUCCESS')
        .select()
        .maybeSingle();
    if (updated) {
        try {
            const { notify } = await import('./notifications.js');
            await notify(
                updated.owner_id,
                'success',
                `Reversement de ${Number(updated.amount).toLocaleString('fr-FR')} ${updated.currency} envoyé via CinetPay (${updated.beneficiary_prefix || ''}${updated.beneficiary_phone || ''}).`
            );
        } catch (e) {
            console.warn('[cinetpay/payout] notification succès :', e.message);
        }
    }
    return updated || (await reloadPayout(row.id));
}

// Échec d'une tentative : retry_count++ ; sous la limite -> RETRYING
// (une alerte est envoyée une fois), au-delà -> FAILED définitif.
async function applyFailure(row, message) {
    const nextCount = Number(row.retry_count || 0) + 1;
    const exhausted = nextCount > Number(row.max_retries || 5);
    const nextStatus = exhausted ? 'FAILED' : 'RETRYING';
    const { data: updated } = await sb()
        .from('cinetpay_payouts')
        .update({
            status: nextStatus,
            retry_count: nextCount,
            last_error: String(message || 'Erreur inconnue').slice(0, 500),
            last_attempt_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        })
        .eq('id', row.id)
        .neq('status', 'SUCCESS')
        .select()
        .maybeSingle();
    if (updated && nextStatus === 'RETRYING') {
        try {
            const { notify } = await import('./notifications.js');
            await notify(
                updated.owner_id,
                'warning',
                `Le reversement de votre loyer (${Number(updated.amount).toLocaleString('fr-FR')} ${updated.currency}) est temporairement bloqué : ${updated.last_error}. Nouvelle tentative en cours.`
            );
        } catch (e) {
            console.warn('[cinetpay/payout] notification échec :', e.message);
        }
    }
    return updated || (await reloadPayout(row.id));
}

// ------------------------------------------------------------
// Vérifie l'état réel d'un reversement PROCESSING (check/money ou
// notification transfert) et applique la décision finale.
// VAL -> SUCCESS ; REJ -> échec (retry possible) ; NEW/REC/NOS -> rien.
// ------------------------------------------------------------
export async function checkAndFinalizePayout(payoutRow) {
    const fresh = await reloadPayout(payoutRow.id);
    if (!['PROCESSING', 'RETRYING', 'FAILED'].includes(fresh.status)) return fresh;

    let check;
    try {
        check = await provider().checkPayout({
            clientTransactionId: fresh.client_transaction_id,
            providerTransactionId: fresh.provider_transfer_id,
            lot: fresh.lot,
        });
    } catch (err) {
        // 723 NOT_FOUND : pas encore visible chez CinetPay -> on attend.
        if (String(err?.code) === '723') return fresh;
        console.error(`[cinetpay/payout] check impossible (${fresh.client_transaction_id}):`, err.message);
        return fresh;
    }

    if (check.status === 'success') {
        return finalizeSuccess(fresh, check);
    }
    if (check.status === 'failed') {
        return applyFailure(fresh, 'Transfert rejeté par CinetPay (REJ).');
    }
    return fresh;
}

// Notification transfert (POST sur /api/cinetpay/payload) : on ne fait
// JAMAIS confiance au payload seul — il sert seulement à retrouver la
// ligne, puis l'état réel est confirmé auprès de l'API.
export async function finalizePayoutByNotify({ clientTransactionId = null, providerTransferId = null }) {
    let query = sb().from('cinetpay_payouts').select('*');
    if (clientTransactionId) query = query.eq('client_transaction_id', clientTransactionId);
    else if (providerTransferId) query = query.eq('provider_transfer_id', providerTransferId);
    else return null;
    const { data: row } = await query.maybeSingle();
    if (!row) return null;
    return checkAndFinalizePayout(row);
}

// ------------------------------------------------------------
// Relance manuelle (admin) : contrôle strict du nombre de tentatives.
// - SUCCESS          -> refus (déjà reversé)
// - PROCESSING       -> simple vérification d'état
// - PENDING/RETRYING/FAILED -> nouvelle tentative SI retry_count <
//   max_retries (sinon erreur métier explicite).
// ------------------------------------------------------------
export async function retryPayoutById(payoutId, { forceNewAttempt = false } = {}) {
    const row = await reloadPayout(payoutId);
    if (row.status === 'SUCCESS') {
        const e = new Error('Ce reversement a déjà abouti.');
        e.httpStatus = 400;
        throw e;
    }
    if (row.status === 'PROCESSING') {
        return checkAndFinalizePayout(row);
    }
    if (!forceNewAttempt && Number(row.retry_count) >= Number(row.max_retries)) {
        const e = new Error(`Limite de tentatives atteinte (${row.retry_count}/${row.max_retries}).`);
        e.httpStatus = 409;
        e.payout = row;
        throw e;
    }
    return attemptPayout({ ...row, status: row.status === 'FAILED' ? 'FAILED' : row.status });
}
