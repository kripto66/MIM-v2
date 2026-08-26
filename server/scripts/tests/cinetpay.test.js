// ============================================================
// MIM - Suite CinetPay (encaissement mobile money des loyers +
// reversements automatiques aux propriétaires)
//
// Un mock local (127.0.0.1:64331) simule les deux APIs officielles :
//   POST /v2/payment                       -> création Checkout
//   POST /v2/payment/check                 -> statut réel d'une transaction
//   POST /v1/auth/login                    -> token Transfert
//   POST /v1/transfer/contact              -> ajout bénéficiaire
//   POST /v1/transfer/money/send/contact   -> envoi d'argent
//   GET  /v1/transfer/check/money          -> statut du transfert
//   POST /mock/set-checkout                -> force le statut/montant Checkout
//   POST /mock/set-transfer                -> fait évoluer treatment_status
//   POST /mock/reset                       -> réinitialise le mock
// L'IPN est envoyé comme CinetPay le fait vraiment : le serveur de test
// expose /cinetpay/test-webhook qui rejoue un form-urlencoded signé
// HMAC-SHA256 (x-token) vers le vrai webhook.
//
// Déclencheurs par numéro de versement :
//   ...0001 -> transfert accepté (NEW puis VAL au check)
//   ...0002 -> transfert rejeté (REJ dès l'envoi)
// ============================================================

import http from 'node:http';
import { api, newJar, expectSuccess } from './lib.js';
import { nextMois } from '../../utils/echeances.js';

const S = 'cinetpay';
const MOCK_PORT = 64331;
const ADMIN_PASSWORD = 'Admin1234!';
const RUN_ID = Date.now() % 1000000000;

let checkouts = {};   // transaction_id -> { amount, currency, checkoutStatus, overrideAmount, payload }
let transfers = {};   // client_transaction_id -> { treatment, providerTx, lot, amount, phone }
let seq = 0;

function safeJson(body) {
    try {
        return JSON.parse(body);
    } catch {
        return null;
    }
}

export function startCinetpayMock() {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
            const u = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);
            const json = (code, obj) => {
                res.writeHead(code, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(obj));
            };
            const parsed = body ? safeJson(body) : null;
            // Les APIs Transfert v1 parlent form-urlencoded (« data= »),
            // contrairement au Checkout v2 qui parle JSON.
            const form = new URLSearchParams(body || '');
            const formData = (() => {
                const raw = form.get('data');
                try {
                    return raw ? JSON.parse(raw) : [];
                } catch {
                    return [];
                }
            })();

            // ---------- Checkout v2 ----------
            if (u.pathname === '/v2/payment') {
                seq++;
                const txId = String(parsed?.transaction_id || '');
                checkouts[txId] = {
                    amount: Number(parsed?.amount || 0),
                    currency: String(parsed?.currency || 'XOF'),
                    checkoutStatus: 'PENDING',
                    overrideAmount: null,
                    payload: parsed,
                };
                return json(200, {
                    code: '201',
                    message: 'CREATED',
                    data: {
                        payment_token: `cptok_${RUN_ID}_${seq}`,
                        payment_url: `http://127.0.0.1:${MOCK_PORT}/guichet/${encodeURIComponent(txId)}`,
                    },
                });
            }

            if (u.pathname === '/v2/payment/check') {
                const tx = checkouts[String(parsed?.transaction_id || '')];
                if (!tx) return json(200, { code: '600', message: 'TRANSACTION_NOT_FOUND', description: 'La transaction n\'existe pas' });
                return json(200, {
                    code: '00',
                    message: 'OK',
                    data: {
                        transaction_id: String(parsed?.transaction_id),
                        status: tx.checkoutStatus,
                        amount: tx.overrideAmount != null ? tx.overrideAmount : tx.amount,
                        currency: tx.currency,
                        payment_method: 'ORANGE_MONEY',
                        operator_id: `OPTG_${RUN_ID}_${seq}`,
                        metadata: tx.payload?.metadata ?? null,
                    },
                });
            }

            // ---------- Transfer v1 ----------
            if (u.pathname === '/v1/auth/login') {
                return json(200, { code: 0, message: 'OPERATION_SUCCES', data: { token: `cptok_login_${RUN_ID}` } });
            }

            if (u.pathname === '/v1/transfer/contact') {
                return json(200, { code: 0, message: 'OPERATION_SUCCES' });
            }

            if (u.pathname === '/v1/transfer/money/send/contact') {
                seq++;
                const entry = formData[0] || {};
                const phone = String(entry.phone || '');
                // ...0002 -> rejet immédiat ; sinon NEW (confirmation différée).
                const treatment = phone.endsWith('0002') ? 'REJ' : 'NEW';
                const stored = {
                    treatment,
                    providerTx: `cpptx_${RUN_ID}_${seq}`,
                    lot: `lot_${RUN_ID}_${seq}`,
                    amount: Number(entry.amount || 0),
                    phone,
                };
                transfers[String(entry.client_transaction_id || '')] = stored;
                return json(200, {
                    code: 0,
                    message: 'OPERATION_SUCCES',
                    data: [
                        {
                            transaction_id: stored.providerTx,
                            lot: stored.lot,
                            treatment_status: treatment,
                        },
                    ],
                });
            }

            if (u.pathname === '/v1/transfer/check/money') {
                const key = u.searchParams.get('client_transaction_id') || '';
                const t = transfers[key];
                if (!t) return json(200, { code: 723, message: 'NOT_FOUND', description: 'Transfert introuvable' });
                return json(200, {
                    code: 0,
                    message: 'OPERATION_SUCCES',
                    data: [
                        {
                            transaction_id: t.providerTx,
                            lot: t.lot,
                            treatment_status: t.treatment,
                            sending_status: 'SENT',
                        },
                    ],
                });
            }

            if (u.pathname === '/v1/transfer/check/balance') {
                return json(200, { code: 0, message: 'OPERATION_SUCCES', data: { available_amount: '10000000', currency: 'XOF' } });
            }

            // ---------- Pilotage du mock ----------
            if (u.pathname === '/mock/set-checkout') {
                const tx = checkouts[String(parsed?.transaction_id || '')];
                if (!tx) return json(200, { ok: false });
                if (parsed?.status) tx.checkoutStatus = String(parsed.status).toUpperCase();
                if (parsed?.amount != null) tx.overrideAmount = Number(parsed.amount);
                return json(200, { ok: true, status: tx.checkoutStatus });
            }

            if (u.pathname === '/mock/set-transfer') {
                const t = transfers[String(parsed?.client_transaction_id || '')];
                if (!t) return json(200, { ok: false });
                t.treatment = String(parsed?.treatment || 'VAL').toUpperCase();
                return json(200, { ok: true, treatment: t.treatment });
            }

            if (u.pathname === '/mock/reset') {
                checkouts = {};
                transfers = {};
                seq = 0;
                return json(200, { ok: true });
            }

            return json(404, { error: 'not found' });
        });
    });
    server.listen(MOCK_PORT, '127.0.0.1');
    return server;
}

export function stopCinetpayMock(server) {
    if (server) server.close();
}

export function resetCinetpayMock() {
    return fetch(`http://127.0.0.1:${MOCK_PORT}/mock/reset`, { method: 'POST' });
}

// Payload exact reçu par le mock à la création Checkout (pour vérifier
// le passthrough channels / customer_phone_number / lock_phone_number).
export function mockCapturedCheckout(transactionId) {
    return checkouts[String(transactionId)]?.payload || null;
}

export function setMockCheckoutStatus(transactionId, { status, amount } = {}) {
    return fetch(`http://127.0.0.1:${MOCK_PORT}/mock/set-checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_id: transactionId, status, amount }),
    }).then((r) => r.json());
}

export function setMockTransferTreatment(clientTransactionId, treatment = 'VAL') {
    return fetch(`http://127.0.0.1:${MOCK_PORT}/mock/set-transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_transaction_id: clientTransactionId, treatment }),
    }).then((r) => r.json());
}

async function tenantJar(loc) {
    const jar = newJar();
    const login = await api('/auth/login', {
        method: 'POST',
        jar,
        body: { identifier: loc.username, password: 'Test1234!' },
    });
    return { jar, ok: login.status === 200 };
}

export async function runCinetpay(r, ctx) {
    const service = ctx.service;
    // Owners 5 et 6 : non utilisés par les autres suites (paydunya prend
    // owners[1..3], complet owners[0..2], etc.). Chaque owner garde son
    // numéro de versement dédié (voir déclencheurs du mock).
    const owner = ctx.seed.owners[5];
    const otherOwner = ctx.seed.owners[6];
    const ownerJar = owner.jar;
    const moisSuivant = nextMois(ctx.seed.month);
    // Contexte partagé entre sections (reversement issu du webhook).
    let payoutCtx = null;

    // Admin dédié (même recette que la suite paydunya).
    const adminEmail = `admin.cinetpay.${Date.now()}@mim.local`;
    const { error: adminError } = await service.auth.admin.createUser({
        email: adminEmail,
        password: ADMIN_PASSWORD,
        email_confirm: true,
        user_metadata: { account_type: 'admin', name: 'Admin CinetPay', role: 'admin' },
    });
    if (adminError) {
        r.fail(S, 'compte admin de test', adminError.message);
        return;
    }
    const adminJar = newJar();
    const adminLogin = await api('/auth/login', {
        method: 'POST',
        jar: adminJar,
        body: { identifier: adminEmail, password: ADMIN_PASSWORD },
    });
    if (adminLogin.status !== 200) {
        r.fail(S, 'connexion admin', `statut ${adminLogin.status}`);
        return;
    }

    async function createPaiement(ownerObj, locIndex, montant) {
        const loc = ownerObj.locataires[locIndex];
        const p = await api('/paiements', {
            method: 'POST',
            jar: ownerObj.jar,
            body: {
                locataire_id: loc.id,
                logement_id: ownerObj.logements[locIndex].id,
                montant,
                mois: ctx.seed.month,
                statut: 'attente',
            },
        });
        return { res: p, loc, pid: p.data?.data?.id };
    }

    async function initiate(loc, pid, extra = {}) {
        const { jar } = await tenantJar(loc);
        const res = await api('/cinetpay/initiate', {
            method: 'POST',
            jar,
            body: { paiement_id: pid, ...extra },
        });
        return { res, d: res.data?.data || {} };
    }

    async function loyerNotifCount(ownerId) {
        const { data } = await service.from('notifications').select('id').eq('user_id', ownerId).like('message', 'Loyer%encaissé via CinetPay%');
        return data?.length ?? 0;
    }

    // ----------------------------------------------------------
    await r.section('cinetpay : configuration et sécurité', async () => {
        await resetCinetpayMock();

        const tm = await api('/cinetpay/test-mode', { jar: ownerJar });
        if (tm.data?.testMode === true) r.pass(S, 'mode test actif (CINETPAY_TEST_MODE)');
        else r.fail(S, 'mode test actif (CINETPAY_TEST_MODE)', JSON.stringify(tm.data));

        const en = await api('/cinetpay/enabled', { jar: ownerJar });
        if (
            en.data?.data?.enabled === true &&
            en.data?.data?.environment === 'test' &&
            en.data?.data?.transferReady === true
        ) {
            r.pass(S, 'cinetpay activé avec transferts (mock configuré)');
        } else {
            r.fail(S, 'cinetpay activé avec transferts (mock configuré)', JSON.stringify(en.data));
        }

        const anon = await api('/cinetpay/initiate', { method: 'POST', body: { paiement_id: 1 } });
        if (anon.status === 401) r.pass(S, 'initiate sans session → 401');
        else r.fail(S, 'initiate sans session → 401', `statut ${anon.status}`);

        const ownerInit = await api('/cinetpay/initiate', { method: 'POST', jar: ownerJar, body: { paiement_id: 1 } });
        if (ownerInit.status === 403) r.pass(S, 'un propriétaire ne peut pas initier un loyer (403)');
        else r.fail(S, 'un propriétaire ne peut pas initier un loyer (403)', `statut ${ownerInit.status}`);
    });

    // ----------------------------------------------------------
    await r.section('cinetpay : initiation téléphone + wallet (passthrough)', async () => {
        // Numéro de versement du propriétaire (déclencheur « succès » du mock).
        const moyen = await api('/moyens-paiement', {
            method: 'POST',
            jar: ownerJar,
            body: { type: 'orange_money', nom_titulaire: 'Owner CP', numero: '+221775550001', pour_versement: true },
        });
        if (!expectSuccess(r, moyen, S, 'moyen de versement du propriétaire', [201])) return;

        const { res: p, loc, pid } = await createPaiement(owner, 0, 45000);
        if (!expectSuccess(r, p, S, 'création du loyer en attente', [201])) return;

        // Téléphone trop court : rejet AVANT toute création de session.
        const bad = await initiate(loc, pid, { phone: '123' });
        if (bad.res.status === 400) r.pass(S, 'numéro invalide → 400 sans créer de session');
        else r.fail(S, 'numéro invalide → 400 sans créer de session', `statut ${bad.res.status}`);
        const { data: noneYet } = await service.from('cinetpay_payments').select('id').eq('paiement_id', pid);
        if ((noneYet?.length ?? 0) === 0) r.pass(S, 'aucune ligne créée pour un numéro invalide');
        else r.fail(S, 'aucune ligne créée pour un numéro invalide', `${noneYet?.length}`);

        const { res: init, d } = await initiate(loc, pid, { phone: '77 123 45 67', wallet: 'orange' });
        if (!expectSuccess(r, init, S, 'initiation avec téléphone + wallet', [201])) return;
        if (d.transaction_id && String(d.transaction_id).startsWith('MIMCP-')) r.pass(S, 'transaction_id généré côté serveur');
        else r.fail(S, 'transaction_id généré côté serveur', JSON.stringify(d));
        if (d.payment_url && d.payment_url.includes(`127.0.0.1:${MOCK_PORT}`)) r.pass(S, 'payment_url pointe vers le guichet');
        else r.fail(S, 'payment_url pointe vers le guichet', JSON.stringify(d));

        const captured = mockCapturedCheckout(d.transaction_id);
        if (!captured) {
            r.fail(S, 'payload Checkout capturé par le mock', 'aucun appel /payment reçu');
            return;
        }
        const meta = safeMeta(captured.metadata);
        const checks = [
            [captured.channels === 'MOBILE_MONEY', 'channels restreint à MOBILE_MONEY'],
            [captured.customer_phone_number === '771234567', 'customer_phone_number transmis (normalisé)'],
            [captured.lock_phone_number === true, 'lock_phone_number=true (validation directe au guichet)'],
            [Number(captured.amount) === 45000, 'montant relu côté serveur'],
            [String(captured.notify_url || '').endsWith('/api/cinetpay/webhook'), 'notify_url = webhook MIM'],
            [meta?.source === 'loyer' && meta?.wallet === 'orange' && Number(meta?.paiement_id) === Number(pid), 'metadata source/wallet/paiement_id'],
        ];
        for (const [ok, label] of checks) ok ? r.pass(S, label) : r.fail(S, label, JSON.stringify({ captured, meta }));

        const { data: row } = await service.from('cinetpay_payments').select('*').eq('transaction_id', d.transaction_id).single();
        if (row && row.status === 'PENDING' && Number(row.amount) === 45000 && row.user_id === loc.account_uid) {
            r.pass(S, 'session PENDING en base (initiateur + montant)');
        } else {
            r.fail(S, 'session PENDING en base (initiateur + montant)', JSON.stringify(row));
        }

        // Reprise : une seconde initiation ne duplique pas la session.
        const second = await initiate(loc, pid, { phone: '77 123 45 67', wallet: 'orange' });
        if (second.res.status === 200 && second.d.resumed === true && second.d.transaction_id === d.transaction_id) {
            r.pass(S, 'seconde initiation → reprise de la même session (resumed)');
        } else {
            r.fail(S, 'seconde initiation → reprise de la même session (resumed)', JSON.stringify(second.res.data));
        }
    });

    // ----------------------------------------------------------
    await r.section('cinetpay : webhook validé → loyer payé + échéance + reversement', async () => {
        const { res: p, loc, pid } = await createPaiement(owner, 1, 50000);
        if (!expectSuccess(r, p, S, 'création du loyer', [201])) return;
        const { res: init, d } = await initiate(loc, pid);
        if (!expectSuccess(r, init, S, 'initiation sans téléphone (univers ALL)', [201])) return;

        const captured = mockCapturedCheckout(d.transaction_id);
        if (captured?.channels === 'ALL' && captured?.lock_phone_number == null) {
            r.pass(S, 'sans téléphone : channels par défaut, pas de verrouillage');
        } else {
            r.fail(S, 'sans téléphone : channels par défaut, pas de verrouillage', JSON.stringify(captured));
        }

        // Le locataire a payé sur le guichet (mock -> ACCEPTED), puis
        // CinetPush envoie l'IPN ; /payment/check confirmera le statut.
        await setMockCheckoutStatus(d.transaction_id, { status: 'ACCEPTED' });
        const w = await api('/cinetpay/test-webhook', {
            method: 'POST',
            jar: ownerJar,
            body: { transaction_id: d.transaction_id },
        });
        if (w.status === 200 && w.data?.webhook?.result === 'success') r.pass(S, 'IPN simulé (HMAC valide) → success');
        else r.fail(S, 'IPN simulé (HMAC valide) → success', `statut ${w.status} ${JSON.stringify(w.data)}`);

        const { data: pays } = await service.from('paiements').select('statut, methode_paiement, reference').eq('id', pid).single();
        if (pays.statut === 'paye' && pays.methode_paiement === 'cinetpay' && pays.reference === d.transaction_id) {
            r.pass(S, 'loyer passé « paye » (méthode cinetpay, référence = transaction_id)');
        } else {
            r.fail(S, 'loyer passé « paye » (méthode cinetpay, référence = transaction_id)', JSON.stringify(pays));
        }

        const { data: ech } = await service.from('paiements').select('id').eq('locataire_id', loc.id).eq('mois', moisSuivant);
        if (ech?.length === 1) r.pass(S, `échéance du mois suivant créée (${moisSuivant})`);
        else r.fail(S, `échéance du mois suivant créée (${moisSuivant})`, `${ech?.length ?? 0}`);

        const notifs = await loyerNotifCount(owner.id);
        if (notifs >= 1) r.pass(S, 'notification propriétaire envoyée');
        else r.fail(S, 'notification propriétaire envoyée', `${notifs}`);

        const { data: payout } = await service.from('cinetpay_payouts').select('*').eq('paiement_id', pid).maybeSingle();
        if (payout && payout.status === 'PROCESSING' && payout.beneficiary_phone === '775550001' && payout.client_transaction_id) {
            r.pass(S, 'reversement créé et envoyé vers le moyen pour_versement (NEW → PROCESSING)');
        } else {
            r.fail(S, 'reversement créé et envoyé vers le moyen pour_versement (NEW → PROCESSING)', JSON.stringify(payout));
        }
        payoutCtx = { payout, tid: d.transaction_id, pid };
    });

    // ----------------------------------------------------------
    await r.section('cinetpay : consultation de statut (accès + self-healing déjà couvert ici)', async () => {
        const { payout, tid } = payoutCtx;
        const { jar } = await tenantJar(owner.locataires[1]);
        const st = await api(`/cinetpay/status/${tid}`, { jar });
        if (st.data?.data?.status === 'SUCCESS') r.pass(S, 'statut consultable par l\'initiateur (SUCCESS)');
        else r.fail(S, 'statut consultable par l\'initiateur (SUCCESS)', JSON.stringify(st.data));

        const forbidden = await api(`/cinetpay/status/${tid}`, { jar: otherOwner.jar });
        if (forbidden.status === 404) r.pass(S, 'un autre utilisateur ne peut pas lire la session (404)');
        else r.fail(S, 'un autre utilisateur ne peut pas lire la session (404)', `statut ${forbidden.status}`);

        // Transfert confirmé VAL chez CinetPay → passage admin finalize.
        await setMockTransferTreatment(payout.client_transaction_id, 'VAL');
        const proc = await api('/cinetpay/payouts/process', { method: 'POST', jar: adminJar });
        const mine = (proc.data?.data || []).find((x) => x.id === payout.id);
        if (proc.status === 200 && mine?.status === 'SUCCESS') r.pass(S, 'payouts/process (admin) → reversement SUCCESS');
        else r.fail(S, 'payouts/process (admin) → reversement SUCCESS', JSON.stringify(proc.data));

        const { data: done } = await service.from('cinetpay_payouts').select('*').eq('id', payout.id).single();
        if (done.status === 'SUCCESS' && done.completed_at && done.provider_transfer_id) {
            r.pass(S, 'reversement clos : SUCCESS + horodaté + référence opérateur');
        } else {
            r.fail(S, 'reversement clos : SUCCESS + horodaté + référence opérateur', JSON.stringify(done));
        }

        const { data: revNotif } = await service.from('notifications').select('id').eq('user_id', owner.id).like('message', 'Reversement de%via CinetPay%');
        if ((revNotif?.length ?? 0) >= 1) r.pass(S, 'propriétaire notifié du reversement');
        else r.fail(S, 'propriétaire notifié du reversement', `${revNotif?.length ?? 0}`);
    });

    // ----------------------------------------------------------
    await r.section('cinetpay : montant incohérent refusé', async () => {
        const { res: p, loc, pid } = await createPaiement(owner, 2, 48000);
        if (!expectSuccess(r, p, S, 'création du loyer', [201])) return;
        const { res: init, d } = await initiate(loc, pid);
        if (!expectSuccess(r, init, S, 'initiation', [201])) return;

        // CinetPay confirme « ACCEPTED » mais avec un mauvais montant.
        await setMockCheckoutStatus(d.transaction_id, { status: 'ACCEPTED', amount: 1000 });
        const w = await api('/cinetpay/test-webhook', { method: 'POST', jar: ownerJar, body: { transaction_id: d.transaction_id } });
        if (w.data?.webhook?.result === 'amount_mismatch') r.pass(S, 'IPN au mauvais montant → amount_mismatch');
        else r.fail(S, 'IPN au mauvais montant → amount_mismatch', JSON.stringify(w.data));

        const { data: sess } = await service.from('cinetpay_payments').select('status').eq('transaction_id', d.transaction_id).single();
        if (sess?.status === 'FAILED') r.pass(S, 'session marquée FAILED (jamais de validation d\'un mauvais montant)');
        else r.fail(S, 'session marquée FAILED (jamais de validation d\'un mauvais montant)', JSON.stringify(sess));

        const { data: pays } = await service.from('paiements').select('statut').eq('id', pid).single();
        if (pays.statut === 'attente') r.pass(S, 'loyer non marqué payé (montant incohérent)');
        else r.fail(S, 'loyer non marqué payé (montant incohérent)', pays.statut);

        // La session FAILED ne bloque pas une nouvelle tentative.
        const retry = await initiate(loc, pid);
        if (retry.res.status === 201 && retry.d.transaction_id !== d.transaction_id) {
            r.pass(S, 'ré-initiation possible après échec (nouvelle transaction)');
        } else {
            r.fail(S, 'ré-initiation possible après échec (nouvelle transaction)', `statut ${retry.res.status} ${JSON.stringify(retry.res.data)}`);
        }
    });

    // ----------------------------------------------------------
    await r.section('cinetpay : self-healing par polling (IPN jamais reçu)', async () => {
        const notifBefore = await loyerNotifCount(owner.id);

        const { res: p, loc, pid } = await createPaiement(owner, 3, 52000);
        if (!expectSuccess(r, p, S, 'création du loyer', [201])) return;
        const { res: init, d } = await initiate(loc, pid);
        if (!expectSuccess(r, init, S, 'initiation', [201])) return;

        // Le locataire paie sur le guichet mais l'IPN n'arrive JAMAIS.
        await setMockCheckoutStatus(d.transaction_id, { status: 'ACCEPTED' });

        // La simple consultation de la page de statut rattrape tout.
        const { jar } = await tenantJar(loc);
        const st = await api(`/cinetpay/status/${d.transaction_id}`, { jar });
        if (st.data?.data?.status === 'SUCCESS') r.pass(S, 'statut consulté → SUCCESS (réconciliation intégrée)');
        else r.fail(S, 'statut consulté → SUCCESS (réconciliation intégrée)', JSON.stringify(st.data));

        const { data: pays } = await service.from('paiements').select('statut').eq('id', pid).single();
        if (pays.statut === 'paye') r.pass(S, 'loyer passé « paye » via le polling de statut');
        else r.fail(S, 'loyer passé « paye » via le polling de statut', pays.statut);

        const { data: payout } = await service.from('cinetpay_payouts').select('*').eq('paiement_id', pid).maybeSingle();
        if (payout?.status === 'PROCESSING') r.pass(S, 'reversement déclenché via le polling (PROCESSING)');
        else r.fail(S, 'reversement déclenché via le polling (PROCESSING)', JSON.stringify(payout));

        // L'IPN finit par arriver : aucun double effet.
        const w = await api('/cinetpay/test-webhook', { method: 'POST', jar: ownerJar, body: { transaction_id: d.transaction_id } });
        if (w.data?.webhook?.result === 'already_success') r.pass(S, 'IPN tardif reconnu comme redondant (already_success)');
        else r.fail(S, 'IPN tardif reconnu comme redondant (already_success)', JSON.stringify(w.data));

        const notifAfter = await loyerNotifCount(owner.id);
        if (notifAfter === notifBefore + 1) r.pass(S, 'une seule notification propriétaire au total (dédup)');
        else r.fail(S, 'une seule notification propriétaire au total (dédup)', `${notifBefore} → ${notifAfter}`);
    });

    // ----------------------------------------------------------
    await r.section('cinetpay : reversement rejeté (REJ) puis relancé', async () => {
        // Numéro volontairement rejeté par le mock (...0002).
        const moyenBad = await api('/moyens-paiement', {
            method: 'POST',
            jar: otherOwner.jar,
            body: { type: 'wave', nom_titulaire: 'Owner CP Reject', numero: '+221775550002', pour_versement: true },
        });
        if (!expectSuccess(r, moyenBad, S, 'moyen de versement destinataire invalide', [201])) return;
        const warnBefore = (await service.from('notifications').select('id').eq('user_id', otherOwner.id).like('message', '%reversement%temporairement bloqué%')).data.length;

        const { res: p, loc, pid } = await createPaiement(otherOwner, 0, 47000);
        if (!expectSuccess(r, p, S, 'création du loyer', [201])) return;
        const { res: init, d } = await initiate(loc, pid);
        if (!expectSuccess(r, init, S, 'initiation', [201])) return;
        await setMockCheckoutStatus(d.transaction_id, { status: 'ACCEPTED' });
        const w = await api('/cinetpay/test-webhook', { method: 'POST', jar: otherOwner.jar, body: { transaction_id: d.transaction_id } });
        if (w.data?.webhook?.result !== 'success') {
            r.fail(S, 'paiement validé malgré le versement en échec', JSON.stringify(w.data));
            return;
        }

        const { data: payout } = await service.from('cinetpay_payouts').select('*').eq('paiement_id', pid).single();
        if (payout?.status === 'RETRYING' && payout.retry_count === 1 && payout.last_error) {
            r.pass(S, 'transfert REJ → reversement RETRYING (1 tentative, erreur tracée)');
        } else {
            r.fail(S, 'transfert REJ → reversement RETRYING (1 tentative, erreur tracée)', JSON.stringify(payout));
            return;
        }

        const warnAfter = (await service.from('notifications').select('id').eq('user_id', otherOwner.id).like('message', '%reversement%temporairement bloqué%')).data.length;
        if (warnAfter === warnBefore + 1) r.pass(S, 'propriétaire notifié du reversement bloqué');
        else r.fail(S, 'propriétaire notifié du reversement bloqué', `${warnBefore} → ${warnAfter}`);

        // Le propriétaire corrige son numéro ; l'admin relance.
        await api(`/moyens-paiement/${moyenBad.data.data.id}`, {
            method: 'PUT',
            jar: otherOwner.jar,
            body: { numero: '+221775550001' },
        });
        const retry = await api(`/cinetpay/payouts/${payout.id}/retry`, { method: 'POST', jar: adminJar });
        if (retry.status === 200 && retry.data?.data?.status === 'PROCESSING' && retry.data.data.beneficiary_phone === '775550001') {
            r.pass(S, 'relance admin → nouveau transfert vers le bon numéro (PROCESSING)');
        } else {
            r.fail(S, 'relance admin → nouveau transfert vers le bon numéro (PROCESSING)', JSON.stringify(retry.data));
            return;
        }

        await setMockTransferTreatment(retry.data.data.client_transaction_id, 'VAL');
        const proc = await api('/cinetpay/payouts/process', { method: 'POST', jar: adminJar });
        const mine = (proc.data?.data || []).find((x) => x.id === payout.id);
        if (mine?.status === 'SUCCESS') r.pass(S, 'confirmation VAL → reversement SUCCESS');
        else r.fail(S, 'confirmation VAL → reversement SUCCESS', JSON.stringify(proc.data));

        // Nettoyage : ce moyen ne doit pas polluer les suites suivantes.
        await service.from('moyens_paiement').delete().eq('id', moyenBad.data.data.id);
        r.pass(S, 'nettoyage du moyen créé');
    });
}

function safeMeta(raw) {
    try {
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return null;
    }
}
