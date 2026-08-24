// ============================================================
// MIM - Encaissements CinetPay (loyers locataires)
//
// Rôle : initiation d'une session Checkout + réconciliation unique.
// La réconciliation est LA source de vérité partagée par :
//   - le webhook IPN (routes/cinetpay.js)
//   - le polling GET /status (self-healing si notification perdue)
// Comme pour PayDunya : le statut annoncé n'est JAMAIS pris au pied de
// la lettre, il est re-vérifié auprès de l'API /payment/check.
// ============================================================

import { getProvider } from '../providers/index.js';
import { serviceClient } from '../app.js';
import { creerEcheanceSuivante } from './echeances.js';
import { ensurePayoutForPayment } from './cinetpayPayouts.js';

const sb = () => serviceClient();
const provider = () => getProvider('cinetpay');

export const PAYABLE_STATUS = ['attente', 'retard', 'refuse', 'a_confirmer', 'en_validation'];

const ACTIVE_STATUS = ['PENDING', 'PROCESSING'];

// URL notifiée par CinetPay après chaque changement de statut.
// Passée à la création de session ; doit répondre 200 à GET et POST.
function cinetpayUrls() {
    const base = process.env.APP_URL || '';
    try {
        const u = new URL(base);
        const root = base.replace(/\/+$/, '');
        return {
            notifyUrl: `${root}/api/cinetpay/webhook`,
            returnUrl: `${root}/paiement-succes`,
        };
    } catch {
        return { notifyUrl: null, returnUrl: null };
    }
}

// ------------------------------------------------------------
// Initiation : le locataire règle son loyer via CinetPay.
// Montant / propriétaire / locataire relus en base — jamais fournis
// par le client. Une seule session active par loyer (index unique
// partiel + rattrapage applicatif sur code 23505).
// Retour : { payment, resumed }
// ------------------------------------------------------------
export async function initiateCinetpayRentPayment({ userId, paiementId }) {
    // Fiche locataire déduite du compte : impossible de payer le loyer
    // d'un autre locataire.
    const { data: locataire } = await sb()
        .from('locataires')
        .select('id, nom')
        .eq('account_uid', userId)
        .maybeSingle();
    if (!locataire) {
        const e = new Error("Votre compte n'est pas lié à une fiche locataire.");
        e.httpStatus = 403;
        throw e;
    }

    const { data: paiement, error } = await sb()
        .from('paiements')
        .select('id, user_id, locataire_id, montant, mois, statut, reference')
        .eq('id', paiementId)
        .eq('locataire_id', locataire.id)
        .single();
    if (error || !paiement) {
        const e = new Error('Paiement introuvable.');
        e.httpStatus = 404;
        throw e;
    }
    if (paiement.statut === 'paye') {
        const e = new Error('Ce paiement est déjà payé.');
        e.httpStatus = 400;
        throw e;
    }
    if (!PAYABLE_STATUS.includes(paiement.statut)) {
        const e = new Error('Ce paiement ne peut pas être réglé en ligne pour le moment.');
        e.httpStatus = 400;
        throw e;
    }

    // Reprise d'une session active existante au lieu d'en créer une autre.
    const pending = await findActivePayment({ paiementId: Number(paiementId) });
    if (pending) return { payment: pending, resumed: true };

    const { data: profile } = await sb().from('profiles').select('name, phone').eq('id', userId).maybeSingle();

    // Référence unique générée côté serveur (envoyée telle quelle à
    // CinetPay comme transaction_id).
    const transactionId = `MIMCP-${paiement.id}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const amount = Number(paiement.montant);

    let inserted = null;
    const insertRow = async () => {
        const { data, error: insErr } = await sb()
            .from('cinetpay_payments')
            .insert({
                user_id: userId,
                paiement_id: paiement.id,
                owner_id: paiement.user_id,
                transaction_id: transactionId,
                amount,
                currency: (process.env.CINETPAY_CURRENCY || 'XOF').toUpperCase(),
                status: 'PENDING',
            })
            .select()
            .single();
        if (insErr && insErr.code !== '23505') throw insErr;
        inserted = insErr ? null : data;
    };
    await insertRow();
    if (!inserted) {
        // Course concurrente perdue : on reprend la ligne gagnante.
        const winner = await findActivePayment({ paiementId: Number(paiementId) });
        if (!winner) throw new Error('Conflit lors de la création du paiement.');
        return { payment: winner, resumed: true };
    }

    // Appel Checkout v2 (hors transaction : la ligne PENDING existe déjà,
    // une erreur réseau laisse un PENDING rattrapable par le statut/retry).
    const urls = cinetpayUrls();
    try {
        const res = await provider().createPayment({
            reference: transactionId,
            amount,
            currency: inserted.currency,
            description: `MIM-LOYER-${paiement.id} (${paiement.mois})`,
            customer: { name: profile?.name || locataire.nom || '', phone: profile?.phone || '' },
            metadata: JSON.stringify({ source: 'loyer', paiement_id: paiement.id }),
            notifyUrl: urls.notifyUrl,
            returnUrl: urls.returnUrl,
        });
        const { data: fresh } = await sb()
            .from('cinetpay_payments')
            .update({
                payment_token: res.providerRef,
                payment_url: res.paymentUrl,
                last_check: { created_at: new Date().toISOString() },
            })
            .eq('id', inserted.id)
            .select()
            .single();
        return { payment: fresh || { ...inserted, payment_token: res.providerRef, payment_url: res.paymentUrl }, resumed: false };
    } catch (err) {
        await sb()
            .from('cinetpay_payments')
            .update({
                status: 'FAILED',
                last_check: { error: err.message, at: new Date().toISOString() },
            })
            .eq('id', inserted.id)
            .eq('status', 'PENDING');
        err.httpStatus = 502;
        throw err;
    }
}

async function findActivePayment({ paiementId }) {
    const { data } = await sb()
        .from('cinetpay_payments')
        .select('*')
        .eq('paiement_id', paiementId)
        .in('status', ACTIVE_STATUS)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    return data || null;
}

// ------------------------------------------------------------
// Réconciliation : vérifie AUPRÈS DE CINETPAY puis applique les effets
// métier. Idempotent : rejouable sans double effet.
//
// Retour : { status, result }
//   result : success | already_success | amount_mismatch | pending |
//            failed | cancelled | unchanged | provider_error
// ------------------------------------------------------------
export async function reconcileCinetpayPayment(paymentRow, { webhookPayload = null } = {}) {
    let check;
    try {
        check = await provider().verifyPayment({ reference: paymentRow.transaction_id });
    } catch (err) {
        console.error(`[cinetpay/reconcile] vérification impossible (${paymentRow.transaction_id}):`, err.message);
        const e = new Error('Vérification CinetPay indisponible.');
        e.transient = true;
        throw e;
    }

    // Cohérence montant/devise : un « ACCEPTED » avec un montant différent
    // est refusé (jamais de validation d'un mauvais montant).
    if (check.status === 'success') {
        const okAmount = check.amount > 0 && Number(check.amount) === Number(paymentRow.amount);
        const okCurrency = !check.currency || String(check.currency).toUpperCase() === String(paymentRow.currency).toUpperCase();
        if (!okAmount || !okCurrency) {
            console.error(
                `[cinetpay/reconcile] incohérence: confirmé=${check.amount}/${check.currency} attendu=${paymentRow.amount}/${paymentRow.currency} (${paymentRow.transaction_id})`
            );
            await sb()
                .from('cinetpay_payments')
                .update({
                    status: 'FAILED',
                    last_check: { ...check.raw, error: 'amount_mismatch', checked_at: new Date().toISOString() },
                    webhook_payload: webhookPayload || paymentRow.webhook_payload,
                    updated_at: new Date().toISOString(),
                })
                .eq('id', paymentRow.id);
            return { status: 'FAILED', result: 'amount_mismatch' };
        }
    }

    // On n'abaisse jamais un succès déjà acté.
    if (paymentRow.status === 'SUCCESS') {
        return { status: 'SUCCESS', result: 'already_success' };
    }
    const isReplay = false;

    const nextStatus =
        check.status === 'success'
            ? 'SUCCESS'
            : check.status === 'failed'
              ? 'FAILED'
              : check.status === 'cancelled'
                ? 'CANCELLED'
                : ACTIVE_STATUS.includes(check.status) ? 'PROCESSING' : paymentRow.status;

    // Transition conditionnelle : seul le premier appel qui passe de
    // PENDING/PROCESSING vers SUCCESS gagne et notifie.
    let updated = null;
    if (nextStatus !== paymentRow.status) {
        const from = nextStatus === 'SUCCESS'
            ? ACTIVE_STATUS
            : [...ACTIVE_STATUS];
        const { data } = await sb()
            .from('cinetpay_payments')
            .update({
                status: nextStatus,
                payment_method: check.paymentMethod || paymentRow.payment_method,
                operator_id: check.operatorId || paymentRow.operator_id,
                paid_at: nextStatus === 'SUCCESS' ? new Date().toISOString() : paymentRow.paid_at,
                last_check: { ...check.raw, checked_at: new Date().toISOString() },
                webhook_payload: webhookPayload || paymentRow.webhook_payload,
                updated_at: new Date().toISOString(),
            })
            .eq('id', paymentRow.id)
            .in('status', from.filter((s) => s !== nextStatus))
            .select()
            .maybeSingle();
        updated = data;
        if (nextStatus === 'SUCCESS' && !updated) {
            // Un autre worker vient de finaliser cette ligne.
            return { status: 'SUCCESS', result: 'already_success' };
        }
    } else {
        // Statut inchangé : on archive quand même le dernier contrôle.
        await sb()
            .from('cinetpay_payments')
            .update({
                last_check: { ...check.raw, checked_at: new Date().toISOString() },
                webhook_payload: webhookPayload || paymentRow.webhook_payload,
                updated_at: new Date().toISOString(),
            })
            .eq('id', paymentRow.id);
    }

    if (nextStatus === 'SUCCESS') {
        await applyLoyerPaid(paymentRow, updated != null || isReplay);
    }

    const result = nextStatus === 'SUCCESS' && paymentRow.status === 'SUCCESS'
        ? 'already_success'
        : nextStatus === paymentRow.status ? 'unchanged' : nextStatus.toLowerCase();
    return { status: nextStatus, result };
}

// ------------------------------------------------------------
// LOYER payé : statut « paye », échéance suivante, reversement au
// propriétaire (PENDING puis tentative), notifications (une seule fois).
// ------------------------------------------------------------
export async function applyLoyerPaid(paymentRow, isFirstTransition) {
    const { data: paiement } = await sb()
        .from('paiements')
        .select('id, user_id, locataire_id, logement_id, mois, montant, statut, reference')
        .eq('id', paymentRow.paiement_id)
        .maybeSingle();
    if (!paiement) return;

    const { data: updPaiement, error: payErr } = await sb()
        .from('paiements')
        .update({
            statut: 'paye',
            date_paiement: new Date().toISOString().slice(0, 10),
            methode_paiement: 'cinetpay',
            reference: paiement.reference || paymentRow.transaction_id,
        })
        .eq('id', paiement.id)
        .in('statut', PAYABLE_STATUS)
        .select()
        .maybeSingle();
    if (payErr) throw payErr;

    try {
        await creerEcheanceSuivante(sb(), paiement);
    } catch (e) {
        console.warn('[cinetpay/reconcile] échéance suivante :', e.message);
    }

    // Reversement automatique au propriétaire : dédoublonné par index
    // unique sur cinetpay_payment_id.
    try {
        await ensurePayoutForPayment(paymentRow);
    } catch (e) {
        console.warn('[cinetpay/reconcile] reversement loyer :', e.message);
    }

    if (isFirstTransition || updPaiement) {
        try {
            const { notify, tenantUidOfLocataire } = await import('./notifications.js');
            await notify(
                paiement.user_id,
                'success',
                `Loyer ${paiement.mois} encaissé via CinetPay (${Number(paiement.montant).toLocaleString('fr-FR')} FCFA). Reversement au propriétaire en cours.`
            );
            const tenantUid = await tenantUidOfLocataire(paiement.locataire_id);
            if (tenantUid) {
                await notify(tenantUid, 'paiement', `Votre loyer de ${paiement.mois} a été réglé avec succès via CinetPay.`);
            }
        } catch (e) {
            console.warn('[cinetpay/reconcile] notification loyer :', e.message);
        }
    }
}
