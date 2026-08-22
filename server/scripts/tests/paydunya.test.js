// ============================================================
// MIM - Suite PayDunya (paiements en ligne : loyers, salaires,
// sessions d'encaissement et redistribution / décaissement)
//
// Un mock local (127.0.0.1:64330) simule l'API PayDunya :
//   POST   /checkout-invoice/create          -> crée une facture
//   GET    /checkout-invoice/confirm/:token  -> statut de la facture
//   POST   /direct-pay/credit-account        -> versement PER (compte à compte)
//   POST   /api/v2/disburse/get-invoice      -> ordre de décaissement (v2)
//   POST   /api/v2/disburse/submit-invoice   -> soumission à l'opérateur (v2)
//   POST   /api/v2/disburse/check-status     -> statut d'un décaissement (v2)
//   POST   /mock/pay   { token, amount }     -> marque la facture payée
//   POST   /mock/fail-confirm { on }         -> simule une panne de l'API
//   POST   /mock/settle-disburse { token, status } -> statut final différé
//   POST   /mock/reset                       -> réinitialise le mock
// L'IPN est envoyé comme PayDunya le fait vraiment : POST
// application/x-www-form-urlencoded avec hash SHA-512(Master Key).
//
// Comportements spéciaux du mock :
//   - un alias contenant « .reject. » fait ÉCHOUER le versement
//     (compte destinataire introuvable) ;
//   - un numéro contenant « .pending. » laisse le décaissement v2 en
//     attente chez l'opérateur jusqu'à /mock/settle-disburse ;
//   - fail-confirm=true fait répondre 500 à toute confirmation
//     (simule une indisponibilité transitoire de PayDunya).
// ============================================================

import http from 'node:http';
import crypto from 'node:crypto';
import { api, newJar, expectSuccess } from './lib.js';
import { nextMois } from '../../utils/echeances.js';

const S = 'paydunya';
const MOCK_PORT = 64330;
const ADMIN_PASSWORD = 'Admin1234!';

let invoices = {};
let creditLog = [];
let disburseInvoices = {}; // token -> { status, alias, mode, amount, transactionId }
let disburseLog = [];      // versements réellement exécutés (submit success)
let usedDisburseIds = [];
let seq = 0;
let failConfirm = false;
// Identifiant unique par exécution : évite toute collision de fingerprint
// avec des exécutions précédentes (les tables paydunya_* sont purgées au
// seed, mais par précaution les tokens diffèrent d'une campagne à l'autre).
const RUN_ID = Date.now() % 1000000;

function safeJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

// Déclencheur de scénario pour un décaissement v2 : l'alias envoyé est
// soit un alias PayDunya (chaîne libre), soit le numéro wallet normalisé
// (chiffres seuls) — d'où les numéros magiques de sandbox.
const REJECT_NUMBERS = ['000000001'];
const PENDING_NUMBERS = ['000000002'];

function disburseTrigger(alias) {
  const a = String(alias || '');
  if (a.includes('.reject.') || REJECT_NUMBERS.includes(a)) return 'reject';
  if (a.includes('.pending.') || PENDING_NUMBERS.includes(a)) return 'pending';
  return null;
}

export function startPaydunyaMock() {
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

      if (u.pathname === '/sandbox-api/v1/checkout-invoice/create') {
        seq++;
        const token = `mock_${RUN_ID}_${seq}`;
        invoices[token] = {
          status: 'pending',
          total_amount: Number(parsed?.invoice?.total_amount || 0),
          customer: parsed?.invoice?.customer || null,
        };
        return json(200, {
          response_code: '00',
          response_text: `http://127.0.0.1:${MOCK_PORT}/pay/${token}`,
          token,
        });
      }

      const confirmMatch = u.pathname.match(/^\/sandbox-api\/v1\/checkout-invoice\/confirm\/([^/]+)$/);
      if (confirmMatch) {
        if (failConfirm) return json(500, { error: 'API momentanément indisponible' });
        const token = decodeURIComponent(confirmMatch[1]);
        const inv = invoices[token];
        if (!inv) return json(200, { response_code: '01', response_text: 'Facture introuvable' });
        // Comme l'API PayDunya réelle : response_code '00' même pour une
        // facture non encore payée — le statut est porté par le champ status.
        return json(200, {
          response_code: '00',
          response_text: inv.status === 'completed' ? 'http://mock-receipt/' + token : 'Facture en attente de paiement',
          token,
          status: inv.status,
          invoice: { total_amount: inv.total_amount },
          receipt_url: inv.status === 'completed' ? 'http://mock-receipt/' + token : null,
        });
      }

      if (u.pathname === '/sandbox-api/v1/direct-pay/credit-account') {
        seq++;
        const alias = String(parsed?.account_alias || '');
        creditLog.push({
          account_alias: alias,
          amount: Number(parsed?.amount),
          at: new Date().toISOString(),
        });
        // Simulation d'un compte destinataire refusant le versement.
        if (alias.includes('.reject.')) {
          return json(200, {
            response_code: '501',
            response_text: 'Compte destinataire introuvable',
            description: 'TEST',
          });
        }
        return json(200, {
          response_code: '00',
          response_text: 'Credit effectue avec succes',
          description: 'TEST',
          transaction_id: `mock_txn_${seq}`,
        });
      }

      if (u.pathname === '/api/v2/disburse/get-invoice') {
        seq++;
        const alias = String(parsed?.account_alias || '');
        const mode = String(parsed?.withdraw_mode || '');
        if (!['paydunya', 'wave-senegal', 'orange-money-senegal'].includes(mode)) {
          return json(400, { response_code: '1001', response_text: 'withdraw_mode non pris en charge' });
        }
        const token = `mock_disb_${RUN_ID}_${seq}`;
        disburseInvoices[token] = {
          status: 'created',
          alias,
          mode,
          amount: Number(parsed?.amount),
          transactionId: null,
        };
        return json(200, { response_code: '00', disburse_token: token });
      }

      if (u.pathname === '/api/v2/disburse/submit-invoice') {
        const token = String(parsed?.disburse_invoice || '');
        const inv = disburseInvoices[token];
        if (!inv) return json(200, { response_code: '01', response_text: 'Token de décaissement inconnu' });
        const disburseId = parsed?.disburse_id != null ? String(parsed.disburse_id) : null;
        if (disburseId && usedDisburseIds.includes(disburseId)) {
          return json(200, { response_code: '5000', response_text: 'disburse_id already used' });
        }
        if (disburseId) usedDisburseIds.push(disburseId);
        // Déjà soumis : idempotent (même statut, pas de double exécution).
        if (inv.status !== 'created') {
          return json(200, {
            response_code: '00',
            status: inv.status,
            response_text: 'Transaction deja traitee',
            description: 'TEST',
            ...(inv.transactionId ? { transaction_id: inv.transactionId } : {}),
          });
        }
        // Déclencheurs : alias contenant « .reject. » / « .pending. », ou
        // numéros magiques de sandbox (le numéro EST l'alias en v2) :
        //   000000001 -> versement refusé (compte introuvable)
        //   000000002 -> traitement différé chez l'opérateur
        const trig = disburseTrigger(inv.alias);
        if (trig === 'reject') {
          inv.status = 'failed';
          return json(200, {
            response_code: '00',
            status: 'failed',
            response_text: 'Transaction failed',
            description: 'Compte introuvable',
          });
        }
        if (trig === 'pending') {
          inv.status = 'pending';
          inv.transactionId = `mock_dttxn_${seq}`;
          return json(200, {
            response_code: '00',
            status: 'pending',
            response_text: 'Transaction pending',
            description: 'Transaction pending, please check the final status later through our status API',
            transaction_id: inv.transactionId,
          });
        }
        inv.status = 'success';
        inv.transactionId = `mock_dttxn_${seq}`;
        disburseLog.push({
          account_alias: inv.alias,
          withdraw_mode: inv.mode,
          amount: inv.amount,
          transaction_id: inv.transactionId,
          provider_ref: `mock_pref_${seq}`,
          at: new Date().toISOString(),
        });
        return json(200, {
          response_code: '00',
          status: 'success',
          response_text: 'Transaction completed successfully',
          description: `Success! Amount of ${inv.amount} FCFA has been transfered`,
          transaction_id: inv.transactionId,
          provider_ref: `mock_pref_${seq}`,
        });
      }

      if (u.pathname === '/api/v2/disburse/check-status') {
        const token = String(parsed?.disburse_invoice || '');
        const inv = disburseInvoices[token];
        if (!inv) return json(200, { response_code: '01', response_text: 'Token de décaissement inconnu' });
        return json(200, {
          response_code: '00',
          status: inv.status,
          token,
          withdraw_mode: inv.mode,
          amount: String(inv.amount),
          ...(inv.transactionId ? { transaction_id: inv.transactionId } : {}),
        });
      }

      if (u.pathname === '/mock/pay') {
        // Crée la facture si inconnue : permet de simuler des sessions
        // insérées directement en base (ex. abonnement).
        let inv = invoices[parsed?.token];
        if (!inv) inv = invoices[parsed?.token] = { status: 'pending', total_amount: 0, customer: null };
        inv.status = ['completed', 'pending', 'cancelled'].includes(parsed?.status) ? parsed.status : 'completed';
        if (parsed?.amount != null) inv.total_amount = Number(parsed.amount);
        return json(200, { ok: true });
      }

      if (u.pathname === '/mock/fail-confirm') {
        failConfirm = Boolean(parsed?.on);
        return json(200, { ok: true, failConfirm });
      }

      if (u.pathname === '/mock/settle-disburse') {
        // Fait évoluer le statut final d'un décaissement resté 'pending'
        // (simule la confirmation différée de l'opérateur).
        const inv = disburseInvoices[parsed?.token];
        if (!inv) return json(200, { ok: false });
        const next = ['success', 'failed', 'pending'].includes(parsed?.status) ? parsed.status : 'success';
        if (inv.status === 'pending' && next === 'success') {
          inv.status = 'success';
          inv.transactionId = inv.transactionId || `mock_dttxn_settle_${seq}`;
          disburseLog.push({
            account_alias: inv.alias,
            withdraw_mode: inv.mode,
            amount: inv.amount,
            transaction_id: inv.transactionId,
            provider_ref: `mock_pref_settle_${seq}`,
            at: new Date().toISOString(),
          });
        } else if (inv.status === 'pending') {
          inv.status = next;
        }
        return json(200, { ok: true, status: inv.status });
      }

      if (u.pathname === '/mock/reset') {
        invoices = {};
        creditLog = [];
        disburseInvoices = {};
        disburseLog = [];
        usedDisburseIds = [];
        failConfirm = false;
        return json(200, { ok: true });
      }

      return json(404, { error: 'not found' });
    });
  });
  server.listen(MOCK_PORT, '127.0.0.1');
  return server;
}

export function stopPaydunyaMock(server) {
  if (server) server.close();
}

export function markMockInvoicePaid(token, amount, status = 'completed') {
  return fetch(`http://127.0.0.1:${MOCK_PORT}/mock/pay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, amount: Number(amount), status }),
  });
}

export function resetPaydunyaMock() {
  return fetch(`http://127.0.0.1:${MOCK_PORT}/mock/reset`, { method: 'POST' });
}

// Simule une indisponibilité transitoire de l'API PayDunya (les
// confirmations de facture répondent 500).
export function setMockConfirmFailure(on) {
  return fetch(`http://127.0.0.1:${MOCK_PORT}/mock/fail-confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: Boolean(on) }),
  });
}

export function paydunyaCreditLog() {
  return creditLog.slice();
}

export function paydunyaDisburseLog() {
  return disburseLog.slice();
}

// Fait évoluer le statut final d'un décaissement resté 'pending'.
export function settleMockDisbursement(token, status = 'success') {
  return fetch(`http://127.0.0.1:${MOCK_PORT}/mock/settle-disburse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, status }),
  });
}

// Construit le corps form-urlencoded d'un IPN PayDunya (identique à ce
// que PayDunya enverrait : data[...] imbriqué + hash SHA-512 du Master Key).
// « hashOverride » permet de simuler une signature invalide.
export function buildIpnForm({ token, status = 'completed', amount = 0, receiptUrl = null, hashOverride = null }) {
  const data = {
    token,
    status,
    hash: hashOverride || crypto.createHash('sha512').update(process.env.PAYDUNYA_MASTER_KEY || '').digest('hex'),
    invoice: { total_amount: status === 'completed' ? Number(amount) : 0 },
    receipt_url: status === 'completed' ? receiptUrl || `http://mock-receipt/${token}` : null,
    customer: { name: 'Test MIM', phone: '771111111' },
  };
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(data)) {
    if (v == null) continue;
    if (typeof v === 'object') {
      for (const [kk, vv] of Object.entries(v)) form.append(`data[${k}][${kk}]`, String(vv));
    } else {
      form.append(`data[${k}]`, String(v));
    }
  }
  return form.toString();
}

// Envoie un IPN vers le webhook réel du serveur de test.
export async function sendPaydunyaIpn(opts) {
  const res = await fetch('http://127.0.0.1:3100/api/paydunya/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: buildIpnForm(opts),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

export async function runPaydunya(r, ctx) {
  const service = ctx.service;
  // owners[1] reste actif pendant toute la campagne (owners[0] est
  // suspendu/réactivé par la suite « abonnement »).
  const owner = ctx.seed.owners[1];
  const other = ctx.seed.owners[2];

  const adminEmail = `admin.paydunya.${Date.now()}@mim.local`;
  const { error: adminError } = await service.auth.admin.createUser({
    email: adminEmail,
    password: ADMIN_PASSWORD,
    email_confirm: true,
    user_metadata: { account_type: 'admin', name: 'Admin PayDunya', role: 'admin' },
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

  const ownerJar = owner.jar;

  async function tenantJar(loc) {
    const jar = newJar();
    const login = await api('/auth/login', {
      method: 'POST',
      jar,
      body: { identifier: loc.username, password: 'Test1234!' },
    });
    return { jar, ok: login.status === 200, login };
  }

  async function createPaiement(locIndex, amount, opts = {}) {
    const loc = owner.locataires[locIndex];
    const p = await api('/paiements', {
      method: 'POST',
      jar: ownerJar,
      body: {
        locataire_id: loc.id,
        logement_id: owner.logements[locIndex].id,
        montant: amount,
        mois: ctx.seed.month,
        statut: 'attente',
        ...opts,
      },
    });
    return { res: p, loc };
  }

  async function initiateLoyer(loc, paiementId) {
    const { jar } = await tenantJar(loc);
    const res = await api('/paydunya/initiate', {
      method: 'POST',
      jar,
      body: { source: 'loyer', paiement_id: paiementId },
    });
    return { jar, res };
  }

  // ----------------------------------------------------------
  await r.section('paydunya : sécurité (initiate)', async () => {
    const anon = await api('/paydunya/initiate', { method: 'POST', body: { source: 'loyer' } });
    if (anon.status === 401) r.pass(S, 'initiate sans session → 401');
    else r.fail(S, 'initiate sans session → 401', `statut ${anon.status}`);

    const { res: p } = await createPaiement(0, 55000);
    const ownerInit = await api('/paydunya/initiate', {
      method: 'POST',
      jar: ownerJar,
      body: { source: 'loyer', paiement_id: p.data?.data?.id },
    });
    if (ownerInit.status === 403) r.pass(S, 'un propriétaire ne peut pas initier un loyer (403)');
    else r.fail(S, 'un propriétaire ne peut pas initier un loyer (403)', `statut ${ownerInit.status}`);

    const tenantInitSalaire = await api('/paydunya/initiate', {
      method: 'POST',
      jar: (await tenantJar(owner.locataires[1])).jar,
      body: { source: 'salaire', paiement_employe_id: 1 },
    });
    if (tenantInitSalaire.status === 403) r.pass(S, 'un locataire ne peut pas initier un salaire (403)');
    else r.fail(S, 'un locataire ne peut pas initier un salaire (403)', `statut ${tenantInitSalaire.status}`);
  });

  // ----------------------------------------------------------
  await r.section('paydunya : initiation loyer par le locataire', async () => {
    const { res: p, loc } = await createPaiement(0, 55000);
    if (!expectSuccess(r, p, S, 'création du loyer en attente', [201])) return;
    const pid = p.data.data.id;

    const { res: init } = await initiateLoyer(loc, pid);
    if (!expectSuccess(r, init, S, 'initiation de la facture', [201])) return;
    const d = init.data.data;
    if (d.payment_url && d.token && !d.resumed) r.pass(S, 'facture créée : lien + token');
    else r.fail(S, 'facture créée : lien + token', JSON.stringify(d));

    // Reprise : une seconde initiation ne duplique pas la facture.
    const { res: init2 } = await initiateLoyer(loc, pid);
    if (init2.data?.data?.resumed === true && init2.data?.data?.token === d.token) {
      r.pass(S, 'seconde initiation → reprise de la même facture (resumed)');
    } else {
      r.fail(S, 'seconde initiation → reprise de la même facture (resumed)', JSON.stringify(init2.data));
    }

    const { data: inv } = await service.from('paydunya_invoices').select('*').eq('token', d.token).single();
    if (inv && inv.source === 'loyer' && inv.user_id === loc.account_uid && Number(inv.amount) === 55000) {
      r.pass(S, 'session en base : source loyer + initiateur + montant relu côté serveur');
    } else {
      r.fail(S, 'session en base : source loyer + initiateur + montant relu côté serveur', JSON.stringify(inv));
    }

    // Statut consultable par l'initiateur uniquement.
    const { jar } = await tenantJar(loc);
    const status = await api(`/paydunya/status/${d.token}`, { jar });
    if (status.data?.data?.status === 'pending') r.pass(S, 'statut de la facture consultable (pending)');
    else r.fail(S, 'statut de la facture consultable (pending)', JSON.stringify(status.data));

    const otherOwner = await api(`/paydunya/status/${d.token}`, { jar: other.jar });
    if (otherOwner.status === 404) r.pass(S, 'un autre utilisateur ne peut pas lire la facture (404)');
    else r.fail(S, 'un autre utilisateur ne peut pas lire la facture (404)', `statut ${otherOwner.status}`);
  });

  // ----------------------------------------------------------
  await r.section('paydunya : IPN rejeté (mauvais hash)', async () => {
    const { res: p, loc } = await createPaiement(2, 60000);
    if (!expectSuccess(r, p, S, 'création du loyer', [201])) return;
    const { res: init } = await initiateLoyer(loc, p.data.data.id);
    if (!expectSuccess(r, init, S, 'initiation de la facture', [201])) return;
    const token = init.data.data.token;

    const form = buildIpnForm({ token, status: 'completed', amount: 60000, hashOverride: 'f'.repeat(128) });
    const res = await fetch('http://127.0.0.1:3100/api/paydunya/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (res.status === 401) r.pass(S, 'IPN avec mauvais hash → 401');
    else r.fail(S, 'IPN avec mauvais hash → 401', `statut ${res.status}`);
  });

  // ----------------------------------------------------------
  await r.section('paydunya : IPN validé → loyer payé + redistribution', async () => {
    const { res: p, loc } = await createPaiement(3, 65000);
    if (!expectSuccess(r, p, S, 'création du loyer', [201])) return;
    const pid = p.data.data.id;

    const { res: init } = await initiateLoyer(loc, pid);
    if (!expectSuccess(r, init, S, 'initiation de la facture', [201])) return;
    const token = init.data.data.token;

    await markMockInvoicePaid(token, 65000);
    const w = await sendPaydunyaIpn({ token, status: 'completed', amount: 65000 });
    if (w.status === 200 && w.data?.result === 'completed') r.pass(S, 'IPN validé → webhook completed');
    else r.fail(S, 'IPN validé → webhook completed', `statut ${w.status} ${JSON.stringify(w.data)}`);

    const { data: pays } = await service.from('paiements').select('statut, methode_paiement, reference').eq('id', pid).single();
    if (pays.statut === 'paye' && pays.methode_paiement === 'paydunya' && pays.reference === token) {
      r.pass(S, 'loyer passé « paye » (méthode paydunya, référence = token)');
    } else {
      r.fail(S, 'loyer passé « paye » (méthode paydunya, référence = token)', JSON.stringify(pays));
    }

    const { data: redist } = await service
      .from('paydunya_redistributions')
      .select('*')
      .eq('paiement_id', pid)
      .maybeSingle();
    if (redist?.status === 'success' && Number(redist.amount) === 65000 && redist.recipient_alias) {
      r.pass(S, `redistribution PER au propriétaire (${redist.recipient_alias})`);
    } else {
      r.fail(S, 'redistribution PER au propriétaire', JSON.stringify(redist));
    }

    const notifOwner = await service.from('notifications').select('id').eq('user_id', owner.id).like('message', 'Loyer%encaissé via PayDunya%');
    if (notifOwner.data?.length === 1) r.pass(S, 'notification propriétaire envoyée');
    else r.fail(S, 'notification propriétaire envoyée', `${notifOwner.data?.length}`);
  });

  // ----------------------------------------------------------
  await r.section('paydunya : dédup des IPN', async () => {
    const { res: p, loc } = await createPaiement(4, 70000);
    if (!expectSuccess(r, p, S, 'création du loyer', [201])) return;
    const pid = p.data.data.id;

    const { res: init } = await initiateLoyer(loc, pid);
    if (!expectSuccess(r, init, S, 'initiation de la facture', [201])) return;
    const token = init.data.data.token;

    const notifBefore = (await service.from('notifications').select('id').eq('user_id', owner.id).like('message', 'Loyer%encaissé via PayDunya%')).data.length;

    await markMockInvoicePaid(token, 70000);
    const w1 = await sendPaydunyaIpn({ token, status: 'completed', amount: 70000 });
    const w2 = await sendPaydunyaIpn({ token, status: 'completed', amount: 70000 });
    const oneCompleted = w1.data?.result === 'completed' || w2.data?.result === 'completed';
    const oneDuplicated = w1.data?.duplicated === true || w2.data?.duplicated === true;
    if (w1.status === 200 && w2.status === 200 && oneCompleted && oneDuplicated) {
      r.pass(S, 'deux IPN identiques → 1 complet + 1 dupliqué');
    } else {
      r.fail(S, 'deux IPN identiques → 1 complet + 1 dupliqué', JSON.stringify({ w1: w1.data, w2: w2.data }));
    }

    const { data: pays } = await service.from('paiements').select('statut').eq('id', pid).single();
    if (pays.statut === 'paye') r.pass(S, 'loyer reste « paye » (pas de double traitement)');
    else r.fail(S, 'loyer reste « paye » (pas de double traitement)', pays.statut);

    const notifAfter = (await service.from('notifications').select('id').eq('user_id', owner.id).like('message', 'Loyer%encaissé via PayDunya%')).data.length;
    if (notifAfter === notifBefore + 1) r.pass(S, 'une seule notification propriétaire en plus (dédup)');
    else r.fail(S, 'une seule notification propriétaire en plus (dédup)', `${notifBefore} → ${notifAfter}`);
  });

  // ----------------------------------------------------------
  await r.section('paydunya : pas de rétrogradation après paiement', async () => {
    const { res: p, loc } = await createPaiement(5, 75000);
    if (!expectSuccess(r, p, S, 'création du loyer', [201])) return;
    const pid = p.data.data.id;

    const { res: init } = await initiateLoyer(loc, pid);
    if (!expectSuccess(r, init, S, 'initiation de la facture', [201])) return;
    const token = init.data.data.token;

    await markMockInvoicePaid(token, 75000);
    await sendPaydunyaIpn({ token, status: 'completed', amount: 75000 });

    // Un IPN « pending » ne doit pas abaisser une facture déjà complétée.
    // Le mock repasse la facture en pending : la confirmation API renvoie
    // donc pending, et le webhook doit refuser la rétrogradation.
    await markMockInvoicePaid(token, 0, 'pending');
    const w = await sendPaydunyaIpn({ token, status: 'pending', amount: 0 });
    if (w.data?.result === 'already_completed') r.pass(S, 'IPN pending après completion → already_completed');
    else r.fail(S, 'IPN pending après completion → already_completed', JSON.stringify(w.data));

    const { data: pays } = await service.from('paiements').select('statut').eq('id', pid).single();
    if (pays.statut === 'paye') r.pass(S, 'loyer reste « paye »');
    else r.fail(S, 'loyer reste « paye »', pays.statut);
  });

  // ----------------------------------------------------------
  await r.section('paydunya : montant incohérent rejeté', async () => {
    const { res: p, loc } = await createPaiement(6, 80000);
    if (!expectSuccess(r, p, S, 'création du loyer', [201])) return;
    const pid = p.data.data.id;

    const { res: init } = await initiateLoyer(loc, pid);
    if (!expectSuccess(r, init, S, 'initiation de la facture', [201])) return;
    const token = init.data.data.token;

    await markMockInvoicePaid(token, 1000); // montant différent de l'attendu
    const w = await sendPaydunyaIpn({ token, status: 'completed', amount: 1000 });
    if (w.data?.result === 'amount_mismatch') r.pass(S, 'IPN au mauvais montant → amount_mismatch');
    else r.fail(S, 'IPN au mauvais montant → amount_mismatch', JSON.stringify(w.data));

    const { data: pays } = await service.from('paiements').select('statut').eq('id', pid).single();
    if (pays.statut === 'attente') r.pass(S, 'loyer non marqué payé (montant incohérent)');
    else r.fail(S, 'loyer non marqué payé (montant incohérent)', pays.statut);
  });

  // ----------------------------------------------------------
  await r.section('paydunya : salaire (propriétaire → employé)', async () => {
    const username = `payemp${Date.now() % 1000000000}`;
    const emp = await api('/employes', {
      method: 'POST',
      jar: ownerJar,
      body: {
        nom: 'Employé PayDunya',
        username,
        password: 'Test1234!',
        salaire: 90000,
        date_embauche: '2026-01-01',
        phone: '+221761234567',
      },
    });
    if (!expectSuccess(r, emp, S, 'création de l\'employé', [201])) return;
    const empId = emp.data.data.id;

    const pay = await api(`/employes/${empId}/paiements`, {
      method: 'POST',
      jar: ownerJar,
      body: {
        montant: 90000,
        mois: ctx.seed.month,
        statut: 'attente',
        methode_paiement: 'paydunya',
      },
    });
    if (!expectSuccess(r, pay, S, 'création du paiement de salaire', [201])) return;
    const payId = pay.data.data.id;

    const init = await api('/paydunya/initiate', {
      method: 'POST',
      jar: ownerJar,
      body: { source: 'salaire', paiement_employe_id: payId },
    });
    if (!expectSuccess(r, init, S, 'initiation de la facture salaire', [201])) return;
    const token = init.data.data.token;

    const { data: inv } = await service.from('paydunya_invoices').select('*').eq('token', token).single();
    if (inv?.source === 'salaire' && inv.paiement_employe_id === payId) {
      r.pass(S, 'session salaire raccordée au paiement employé');
    } else {
      r.fail(S, 'session salaire raccordée au paiement employé', JSON.stringify(inv));
    }

    await markMockInvoicePaid(token, 90000);
    const w = await sendPaydunyaIpn({ token, status: 'completed', amount: 90000 });
    if (w.data?.result === 'completed') r.pass(S, 'IPN salaire → completed');
    else r.fail(S, 'IPN salaire → completed', JSON.stringify(w.data));

    const { data: payRow } = await service.from('paiements_employes').select('statut, methode_paiement').eq('id', payId).single();
    if (payRow.statut === 'paye' && payRow.methode_paiement === 'paydunya') {
      r.pass(S, 'salaire passé « paye » via PayDunya');
    } else {
      r.fail(S, 'salaire passé « paye » via PayDunya', JSON.stringify(payRow));
    }

    const { data: redist } = await service
      .from('paydunya_redistributions')
      .select('*')
      .eq('paiement_employe_id', payId)
      .maybeSingle();
    if (redist?.status === 'success' && redist.recipient_alias) {
      r.pass(S, `redistribution PER à l'employé (${redist.recipient_alias})`);
    } else {
      r.fail(S, 'redistribution PER à l\'employé', JSON.stringify(redist));
    }
  });

  // ----------------------------------------------------------
  await r.section('paydunya : alias PayDunya prioritaire pour la redistribution', async () => {
    const OWNER_ALIAS = `owner.pd.${RUN_ID}@mim.test`;
    const EMP_ALIAS = `emp.pd.${RUN_ID}@mim.test`;

    const moyen = await api('/moyens-paiement', {
      method: 'POST',
      jar: ownerJar,
      body: { type: 'wave', nom_titulaire: 'Owner PD', numero: '771000000', paydunya_alias: OWNER_ALIAS },
    });
    if (!expectSuccess(r, moyen, S, 'moyen du propriétaire avec alias PayDunya', [201])) return;
    const moyenId = moyen.data.data.id;

    const { data: savedMoyen } = await service
      .from('moyens_paiement')
      .select('paydunya_alias')
      .eq('id', moyenId)
      .single();
    if (savedMoyen?.paydunya_alias === OWNER_ALIAS) r.pass(S, 'alias persisté en base (moyens_paiement)');
    else r.fail(S, 'alias persisté en base (moyens_paiement)', JSON.stringify(savedMoyen));

    // Loyer payé → la redistribution doit viser l'alias, pas le téléphone.
    const { res: p, loc } = await createPaiement(7, 60000);
    if (!expectSuccess(r, p, S, 'création du loyer', [201])) return;
    const pid = p.data.data.id;
    const { res: init } = await initiateLoyer(loc, pid);
    if (!expectSuccess(r, init, S, 'initiation de la facture', [201])) return;
    const token = init.data.data.token;
    await markMockInvoicePaid(token, 60000);
    const w = await sendPaydunyaIpn({ token, status: 'completed', amount: 60000 });
    if (w.data?.result === 'completed') r.pass(S, 'IPN loyer → completed');
    else r.fail(S, 'IPN loyer → completed', JSON.stringify(w.data));

    const { data: redist } = await service
      .from('paydunya_redistributions')
      .select('*')
      .eq('paiement_id', pid)
      .maybeSingle();
    if (redist?.recipient_alias === OWNER_ALIAS) {
      r.pass(S, `redistribution au propriétaire → alias prioritaire (${OWNER_ALIAS})`);
    } else {
      r.fail(S, 'redistribution au propriétaire → alias prioritaire', JSON.stringify(redist));
    }

    // Salaire payé → même logique pour l'employé (moyen créé par le propriétaire).
    const username = `payempalias${Date.now() % 1000000000}`;
    const emp = await api('/employes', {
      method: 'POST',
      jar: ownerJar,
      body: {
        nom: 'Employé Alias',
        username,
        password: 'Test1234!',
        salaire: 50000,
        date_embauche: '2026-01-01',
        phone: '+221770000000',
      },
    });
    if (!expectSuccess(r, emp, S, 'création de l\'employé', [201])) return;
    const empId = emp.data.data.id;

    const empMoyen = await api(`/employes/${empId}/moyens-paiement`, {
      method: 'POST',
      jar: ownerJar,
      body: { type: 'orange_money', nom_titulaire: 'Employé Alias', numero: '770000001', paydunya_alias: EMP_ALIAS },
    });
    if (!expectSuccess(r, empMoyen, S, "moyen de l'employé avec alias PayDunya", [201])) return;

    const pay = await api(`/employes/${empId}/paiements`, {
      method: 'POST',
      jar: ownerJar,
      body: { montant: 50000, mois: ctx.seed.month, statut: 'attente', methode_paiement: 'paydunya' },
    });
    if (!expectSuccess(r, pay, S, 'création du paiement de salaire', [201])) return;
    const payId = pay.data.data.id;

    const initPay = await api('/paydunya/initiate', {
      method: 'POST',
      jar: ownerJar,
      body: { source: 'salaire', paiement_employe_id: payId },
    });
    if (!expectSuccess(r, initPay, S, 'initiation de la facture salaire', [201])) return;
    const payToken = initPay.data.data.token;
    await markMockInvoicePaid(payToken, 50000);
    const wPay = await sendPaydunyaIpn({ token: payToken, status: 'completed', amount: 50000 });
    if (wPay.data?.result === 'completed') r.pass(S, 'IPN salaire → completed');
    else r.fail(S, 'IPN salaire → completed', JSON.stringify(wPay.data));

    const { data: redistEmp } = await service
      .from('paydunya_redistributions')
      .select('*')
      .eq('paiement_employe_id', payId)
      .maybeSingle();
    if (redistEmp?.recipient_alias === EMP_ALIAS) {
      r.pass(S, `redistribution à l'employé → alias prioritaire (${EMP_ALIAS})`);
    } else {
      r.fail(S, "redistribution à l'employé → alias prioritaire", JSON.stringify(redistEmp));
    }

    // Nettoyage : ces moyens ne doivent pas polluer les suites suivantes
    // (`declarations` vérifie que le propriétaire n'a aucun moyen).
    await service.from('moyens_paiement').delete().eq('id', moyenId);
    await service.from('moyens_paiement_employes').delete().eq('id', empMoyen.data.data.id);
    r.pass(S, 'nettoyage des moyens créés');
  });

  // ----------------------------------------------------------
  await r.section('paydunya : rattrapage par consultation de statut (IPN perdu)', async () => {
    const { res: p, loc } = await createPaiement(8, 66000);
    if (!expectSuccess(r, p, S, 'création du loyer', [201])) return;
    const pid = p.data.data.id;

    const { res: init } = await initiateLoyer(loc, pid);
    if (!expectSuccess(r, init, S, 'initiation de la facture', [201])) return;
    const token = init.data.data.token;

    // Le locataire paie sur PayDunya mais l'IPN ne arrive JAMAIS.
    await markMockInvoicePaid(token, 66000);

    // La simple consultation de la page de statut doit tout rattraper :
    // confirmation API + effets métier (self-healing).
    const { jar } = await tenantJar(loc);
    const status = await api(`/paydunya/status/${token}`, { jar });
    if (status.data?.data?.status === 'completed') r.pass(S, 'statut consulté → completed (sans IPN)');
    else r.fail(S, 'statut consulté → completed (sans IPN)', JSON.stringify(status.data));

    const { data: pays } = await service.from('paiements').select('statut').eq('id', pid).single();
    if (pays.statut === 'paye') r.pass(S, 'loyer passé « paye » via le polling de statut');
    else r.fail(S, 'loyer passé « paye » via le polling de statut', pays.statut);

    const moisSuivant = nextMois(ctx.seed.month);
    const { data: echeances } = await service
      .from('paiements')
      .select('id')
      .eq('locataire_id', loc.id)
      .eq('mois', moisSuivant);
    if (echeances?.length === 1) r.pass(S, `échéance du mois suivant créée (${moisSuivant})`);
    else r.fail(S, `échéance du mois suivant créée (${moisSuivant})`, `${echeances?.length ?? 0} trouvée(s)`);

    const { data: redist } = await service.from('paydunya_redistributions').select('*').eq('paiement_id', pid).maybeSingle();
    if (redist?.status === 'success') r.pass(S, 'redistribution PER effectuée via le polling');
    else r.fail(S, 'redistribution PER effectuée via le polling', JSON.stringify(redist));

    // L'IPN finit par arriver (PayDunya retente) : aucun double effet.
    const notifBefore = (await service.from('notifications').select('id').eq('user_id', owner.id).like('message', 'Loyer%encaissé via PayDunya%')).data.length;
    const w = await sendPaydunyaIpn({ token, status: 'completed', amount: 66000 });
    if (w.status === 200 && w.data?.result === 'already_completed') r.pass(S, 'IPN tardif reconnu comme redondant (already_completed)');
    else r.fail(S, 'IPN tardif reconnu comme redondant (already_completed)', `statut ${w.status} ${JSON.stringify(w.data)}`);

    const notifAfter = (await service.from('notifications').select('id').eq('user_id', owner.id).like('message', 'Loyer%encaissé via PayDunya%')).data.length;
    if (notifAfter === notifBefore) r.pass(S, 'IPN tardif : aucune notification en double');
    else r.fail(S, 'IPN tardif : aucune notification en double', `${notifBefore} → ${notifAfter}`);

    const { data: redists } = await service.from('paydunya_redistributions').select('id').eq('paiement_id', pid);
    if (redists?.length === 1) r.pass(S, 'IPN tardif : une seule redistribution (dédoublonnée)');
    else r.fail(S, 'IPN tardif : une seule redistribution (dédoublonnée)', `${redists?.length}`);
  });

  // ----------------------------------------------------------
  await r.section('paydunya : échec transitoire de l\'API puis re-traitement de l\'IPN', async () => {
    const { res: p, loc } = await createPaiement(9, 67000);
    if (!expectSuccess(r, p, S, 'création du loyer', [201])) return;
    const pid = p.data.data.id;

    const { res: init } = await initiateLoyer(loc, pid);
    if (!expectSuccess(r, init, S, 'initiation de la facture', [201])) return;
    const token = init.data.data.token;

    await markMockInvoicePaid(token, 67000);

    // PayDunya est injoignable au moment de la confirmation.
    await setMockConfirmFailure(true);
    const w = await sendPaydunyaIpn({ token, status: 'completed', amount: 67000 });
    if (w.status === 503 && w.data?.result === 'confirm_unavailable') {
      r.pass(S, 'API injoignable → webhook 503 confirm_unavailable');
    } else {
      r.fail(S, 'API injoignable → webhook 503 confirm_unavailable', `statut ${w.status} ${JSON.stringify(w.data)}`);
    }

    const { data: journal } = await service.from('paydunya_webhooks').select('handled, error').eq('token', token).limit(1).maybeSingle();
    if (journal && journal.handled === false && journal.error) {
      r.pass(S, 'journal IPN conservé « non traité » avec erreur horodatée');
    } else {
      r.fail(S, 'journal IPN conservé « non traité » avec erreur horodatée', JSON.stringify(journal));
    }

    const { data: paysAvant } = await service.from('paiements').select('statut').eq('id', pid).single();
    if (paysAvant.statut === 'attente') r.pass(S, 'aucun effet métier pendant la panne');
    else r.fail(S, 'aucun effet métier pendant la panne', paysAvant.statut);

    // L'API revient : le MÊME payload renvoyé par PayDunya est re-traité.
    await setMockConfirmFailure(false);
    const w2 = await sendPaydunyaIpn({ token, status: 'completed', amount: 67000 });
    if (w2.status === 200 && w2.data?.result === 'completed') r.pass(S, 're-traitement du même IPN après retour de l\'API');
    else r.fail(S, 're-traitement du même IPN après retour de l\'API', `statut ${w2.status} ${JSON.stringify(w2.data)}`);

    const { data: pays } = await service.from('paiements').select('statut').eq('id', pid).single();
    if (pays.statut === 'paye') r.pass(S, 'loyer passé « paye » après re-traitement');
    else r.fail(S, 'loyer passé « paye » après re-traitement', pays.statut);

    const { data: journalOk } = await service.from('paydunya_webhooks').select('handled, handled_at, error').eq('token', token).limit(1).maybeSingle();
    if (journalOk?.handled === true && journalOk.handled_at && !journalOk.error) {
      r.pass(S, 'journal clos : traité + horodaté + sans erreur');
    } else {
      r.fail(S, 'journal clos : traité + horodaté + sans erreur', JSON.stringify(journalOk));
    }

    const { data: redists } = await service.from('paydunya_redistributions').select('id').eq('paiement_id', pid);
    if (redists?.length === 1 && redists[0]) r.pass(S, 'une seule redistribution malgré le re-traitement');
    else r.fail(S, 'une seule redistribution malgré le re-traitement', `${redists?.length}`);
  });

  // ----------------------------------------------------------
  await r.section('paydunya : annulation puis nouvelle tentative', async () => {
    const { res: p, loc } = await createPaiement(0, 68000);
    if (!expectSuccess(r, p, S, 'création du loyer', [201])) return;
    const pid = p.data.data.id;

    const { res: init } = await initiateLoyer(loc, pid);
    if (!expectSuccess(r, init, S, 'initiation de la facture', [201])) return;
    const token = init.data.data.token;

    // Le locataire abandonne sur la page de paiement.
    await markMockInvoicePaid(token, 0, 'cancelled');
    const w = await sendPaydunyaIpn({ token, status: 'cancelled', amount: 0 });
    if (w.status === 200 && w.data?.result === 'cancelled') r.pass(S, 'IPN cancelled → session annulée');
    else r.fail(S, 'IPN cancelled → session annulée', `statut ${w.status} ${JSON.stringify(w.data)}`);

    const { data: inv } = await service.from('paydunya_invoices').select('status').eq('token', token).single();
    if (inv?.status === 'cancelled') r.pass(S, 'session en base → cancelled');
    else r.fail(S, 'session en base → cancelled', JSON.stringify(inv));

    const { data: pays } = await service.from('paiements').select('statut').eq('id', pid).single();
    if (pays.statut === 'attente') r.pass(S, 'loyer reste « attente » après annulation');
    else r.fail(S, 'loyer reste « attente » après annulation', pays.statut);

    // Une NOUVELLE initiation est possible (l'index unique ne bloque que
    // les sessions PENDING) : le locataire peut réessayer.
    const { res: init2 } = await initiateLoyer(loc, pid);
    if (init2.status === 201 && init2.data?.data?.token && init2.data.data.token !== token) {
      r.pass(S, 'ré-initiation possible après annulation (nouveau token)');
    } else {
      r.fail(S, 'ré-initiation possible après annulation (nouveau token)', `statut ${init2.status} ${JSON.stringify(init2.data)}`);
    }
  });

  // ----------------------------------------------------------
  await r.section('paydunya : course d\'initiation (double-clic)', async () => {
    const { res: p, loc } = await createPaiement(2, 69000);
    if (!expectSuccess(r, p, S, 'création du loyer', [201])) return;
    const pid = p.data.data.id;

    // Deux initiations strictement simultanées (deux sessions distinctes,
    // comme deux onglets du même locataire).
    const [a, b] = await Promise.all([initiateLoyer(loc, pid), initiateLoyer(loc, pid)]);
    const okA = a.res.status === 200 || a.res.status === 201;
    const okB = b.res.status === 200 || b.res.status === 201;
    if (okA && okB) r.pass(S, 'double initiation simultanée : les deux réponses sont valides');
    else r.fail(S, 'double initiation simultanée : les deux réponses sont valides', `${a.res.status}/${b.res.status}`);

    const { data: pendings } = await service
      .from('paydunya_invoices')
      .select('id')
      .eq('source', 'loyer')
      .eq('paiement_id', pid)
      .eq('status', 'pending');
    if (pendings?.length === 1) r.pass(S, 'une SEULE facture pending en base (index unique partiel)');
    else r.fail(S, 'une SEULE facture pending en base (index unique partiel)', `${pendings?.length}`);

    // Les deux réponses pointent vers la même facture.
    const tokA = a.res.data?.data?.token;
    const tokB = b.res.data?.data?.token;
    if (tokA && tokA === tokB) r.pass(S, 'les deux initiations convergent vers le même token');
    else r.fail(S, 'les deux initiations convergent vers le même token', `${tokA} / ${tokB}`);
  });

  // ----------------------------------------------------------
  await r.section('paydunya : double-clic salaire PayDunya (anti-doublon)', async () => {
    const username = `payempdbl${Date.now() % 1000000000}`;
    const emp = await api('/employes', {
      method: 'POST',
      jar: ownerJar,
      body: {
        nom: 'Employé Double-Clic',
        username,
        password: 'Test1234!',
        salaire: 45000,
        date_embauche: '2026-01-01',
        phone: '+221765554444',
      },
    });
    if (!expectSuccess(r, emp, S, "création de l'employé", [201])) return;
    const empId = emp.data.data.id;

    const first = await api(`/employes/${empId}/paiements`, {
      method: 'POST',
      jar: ownerJar,
      body: { montant: 45000, mois: ctx.seed.month, statut: 'attente', methode_paiement: 'paydunya' },
    });
    if (!expectSuccess(r, first, S, 'première déclaration PayDunya', [201])) return;

    // Deuxième clic immédiat : doit reprendre la même ligne, pas créer.
    const second = await api(`/employes/${empId}/paiements`, {
      method: 'POST',
      jar: ownerJar,
      body: { montant: 45000, mois: ctx.seed.month, statut: 'attente', methode_paiement: 'paydunya' },
    });
    if (second.status === 200 && second.data?.data?.id === first.data.data.id) {
      r.pass(S, 'second clic → même ligne reprise (200, pas de doublon)');
    } else {
      r.fail(S, 'second clic → même ligne reprise (200, pas de doublon)', `statut ${second.status} ${JSON.stringify(second.data)}`);
    }

    const { data: rows } = await service
      .from('paiements_employes')
      .select('id')
      .eq('employe_id', empId)
      .eq('mois', ctx.seed.month)
      .eq('methode_paiement', 'paydunya');
    if (rows?.length === 1) r.pass(S, 'une seule ligne de paiement employé en base');
    else r.fail(S, 'une seule ligne de paiement employé en base', `${rows?.length}`);
  });

  // ----------------------------------------------------------
  await r.section('paydunya : redistribution bloquée puis relancée (admin)', async () => {
    const BAD_ALIAS = `owner.reject.${RUN_ID}@mim.test`;
    const GOOD_ALIAS = `owner.fixed.${RUN_ID}@mim.test`;

    // Alias volontairement refusé par le mock (compte introuvable).
    const moyen = await api('/moyens-paiement', {
      method: 'POST',
      jar: ownerJar,
      body: { type: 'wave', nom_titulaire: 'Owner Reject', numero: '772000000', paydunya_alias: BAD_ALIAS },
    });
    if (!expectSuccess(r, moyen, S, 'moyen avec alias destinataire invalide', [201])) return;
    const moyenId = moyen.data.data.id;

    const notifWarnBefore = (await service.from('notifications').select('id').eq('user_id', owner.id).like('message', 'Versement PayDunya en attente%')).data.length;

    const { res: p, loc } = await createPaiement(3, 71000);
    if (!expectSuccess(r, p, S, 'création du loyer', [201])) return;
    const pid = p.data.data.id;
    const { res: init } = await initiateLoyer(loc, pid);
    if (!expectSuccess(r, init, S, 'initiation de la facture', [201])) return;
    const token = init.data.data.token;
    await markMockInvoicePaid(token, 71000);
    const w = await sendPaydunyaIpn({ token, status: 'completed', amount: 71000 });
    if (w.data?.result === 'completed') r.pass(S, 'paiement principal validé malgré le versement en échec');
    else r.fail(S, 'paiement principal validé malgré le versement en échec', JSON.stringify(w.data));

    const { data: redist } = await service.from('paydunya_redistributions').select('*').eq('paiement_id', pid).maybeSingle();
    if (redist?.status === 'pending' && redist.attempt_count === 2) {
      r.pass(S, 'versement PER en échec → redistribution pending (2 tentatives)');
    } else {
      r.fail(S, 'versement PER en échec → redistribution pending (2 tentatives)', JSON.stringify(redist));
    }

    const notifWarnAfter = (await service.from('notifications').select('id').eq('user_id', owner.id).like('message', 'Versement PayDunya en attente%')).data.length;
    if (notifWarnAfter === notifWarnBefore + 1) r.pass(S, 'propriétaire notifié du versement bloqué');
    else r.fail(S, 'propriétaire notifié du versement bloqué', `${notifWarnBefore} → ${notifWarnAfter}`);

    // Le propriétaire corrige son alias ; l'admin relance le versement.
    await api(`/moyens-paiement/${moyenId}`, {
      method: 'PUT',
      jar: ownerJar,
      body: { paydunya_alias: GOOD_ALIAS },
    });
    const retry = await api(`/paydunya/redistributions/${redist.id}/retry`, { method: 'POST', jar: adminJar });
    if (retry.status === 200 && retry.data?.data?.status === 'success' && retry.data.data.recipient_alias === GOOD_ALIAS) {
      r.pass(S, `relance admin → versement effectué vers ${GOOD_ALIAS}`);
    } else {
      r.fail(S, 'relance admin → versement effectué', JSON.stringify(retry.data));
    }

    const notifOk = (await service.from('notifications').select('id').eq('user_id', owner.id).like('message', 'Versement PayDunya effectué%')).data.length;
    if (notifOk >= 1) r.pass(S, 'propriétaire notifié du versement réussi après relance');
    else r.fail(S, 'propriétaire notifié du versement réussi après relance', `${notifOk}`);

    // Relance d'une redistribution DÉJÀ réussie : idempotent, sans erreur.
    const retryAgain = await api(`/paydunya/redistributions/${redist.id}/retry`, { method: 'POST', jar: adminJar });
    if (retryAgain.status === 200 && retryAgain.data?.data?.status === 'success') {
      r.pass(S, 'relance sur versement déjà réussi → succès sans duplication');
    } else {
      r.fail(S, 'relance sur versement déjà réussi → succès sans duplication', JSON.stringify(retryAgain.data));
    }

    await service.from('moyens_paiement').delete().eq('id', moyenId);
    r.pass(S, 'nettoyage du moyen créé');
  });

  // ----------------------------------------------------------
  await r.section('paydunya : validation du format des alias', async () => {
    const bad = await api('/moyens-paiement', {
      method: 'POST',
      jar: ownerJar,
      body: { type: 'wave', nom_titulaire: 'X', numero: '773000000', paydunya_alias: 'abc!!def' },
    });
    if (bad.status === 400 && bad.data?.errors?.paydunya_alias) {
      r.pass(S, 'alias aberrant refusé (400 + erreur champ paydunya_alias)');
    } else {
      r.fail(S, 'alias aberrant refusé (400 + erreur champ paydunya_alias)', `statut ${bad.status} ${JSON.stringify(bad.data)}`);
    }

    const phone = await api('/moyens-paiement', {
      method: 'POST',
      jar: ownerJar,
      body: { type: 'wave', nom_titulaire: 'Y', numero: '773000001', paydunya_alias: '+221 77 123 45 67' },
    });
    if (phone.status === 201) r.pass(S, 'alias téléphone valide accepté (+221 77 123 45 67)');
    else r.fail(S, 'alias téléphone valide accepté (+221 77 123 45 67)', `statut ${phone.status}`);

    const cleared = await api(`/moyens-paiement/${phone.data.data.id}`, {
      method: 'PUT',
      jar: ownerJar,
      body: { paydunya_alias: '' },
    });
    if (cleared.status === 200 && cleared.data?.data?.paydunya_alias === null) {
      r.pass(S, 'alias vide accepté (retour au fallback téléphone/email)');
    } else {
      r.fail(S, 'alias vide accepté (retour au fallback téléphone/email)', JSON.stringify(cleared.data));
    }

    // Côté employé (moyen créé par le propriétaire) : même validation.
    const username = `payempaliasval${Date.now() % 1000000000}`;
    const emp = await api('/employes', {
      method: 'POST',
      jar: ownerJar,
      body: { nom: 'Employé Alias Valide', username, password: 'Test1234!', salaire: 30000, date_embauche: '2026-01-01', phone: '+221774443333' },
    });
    if (!expectSuccess(r, emp, S, "création de l'employé", [201])) return;
    const empBad = await api(`/employes/${emp.data.data.id}/moyens-paiement`, {
      method: 'POST',
      jar: ownerJar,
      body: { type: 'orange_money', nom_titulaire: 'Z', numero: '774444444', paydunya_alias: 'pas-un-alias!' },
    });
    if (empBad.status === 400 && empBad.data?.errors?.paydunya_alias) {
      r.pass(S, "alias aberrant refusé côté employé (400)");
    } else {
      r.fail(S, "alias aberrant refusé côté employé (400)", `statut ${empBad.status}`);
    }

    // Nettoyage complet pour les suites suivantes.
    await service.from('moyens_paiement').delete().in('id', [phone.data.data.id]);
    const { data: empMoyens } = await service
      .from('moyens_paiement_employes')
      .select('id')
      .eq('employe_uid', emp.data.data.account_uid);
    if (empMoyens?.length) await service.from('moyens_paiement_employes').delete().in('id', empMoyens.map((m) => m.id));
    r.pass(S, 'nettoyage des moyens de test');
  });

  // ----------------------------------------------------------
  await r.section("paydunya : abonnement — replay d'IPN sans double activation", async () => {
    // Compte propriétaire DÉDIÉ : l'activation d'un abonnement ne doit
    // pas perturber les propriétaires seedés utilisés par les suites
    // suivantes (limites de plan, suspensions, etc.).
    const subOwnerEmail = `owner.abo.${Date.now()}@mim.local`;
    const { data: subOwner, error: subOwnerErr } = await service.auth.admin.createUser({
      email: subOwnerEmail,
      password: ADMIN_PASSWORD,
      email_confirm: true,
      user_metadata: { account_type: 'proprietaire', name: 'Owner Abonnement', role: 'proprietaire' },
    });
    if (subOwnerErr || !subOwner?.user?.id) {
      r.fail(S, 'création du compte propriétaire dédié', subOwnerErr?.message || 'uid manquant');
      return;
    }
    const subOwnerId = subOwner.user.id;

    // Session d'abonnement insérée directement (l'initiation admin est
    // couverte par la suite « abonnement ») : on teste ici uniquement
    // l'idempotence du traitement IPN.
    const now = new Date();
    const expiration = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
    const { data: apRow, error: apErr } = await service
      .from('abonnement_paiements')
      .insert({
        user_id: subOwnerId,
        plan: 'pro',
        montant: 15000,
        date_paiement: null,
        methode_paiement: null,
        date_debut: now.toISOString(),
        date_expiration: expiration.toISOString(),
      })
      .select()
      .single();
    if (apErr) {
      r.fail(S, 'préparation abonnement_paiements', apErr.message);
      return;
    }
    const abToken = `mock_${RUN_ID}_abo_${Date.now() % 1000000}`;
    const { error: invErr } = await service.from('paydunya_invoices').insert({
      token: abToken,
      source: 'abonnement',
      user_id: subOwnerId,
      amount: 15000,
      status: 'pending',
      abonnement_paiement_id: apRow.id,
    });
    if (invErr) {
      r.fail(S, 'préparation session abonnement', invErr.message);
      return;
    }

    await markMockInvoicePaid(abToken, 15000);
    const w1 = await sendPaydunyaIpn({ token: abToken, status: 'completed', amount: 15000 });
    if (w1.data?.result === 'completed') r.pass(S, 'IPN abonnement → completed');
    else r.fail(S, 'IPN abonnement → completed', JSON.stringify(w1.data));

    const { data: sub1 } = await service.from('subscriptions').select('*').eq('user_id', subOwnerId).maybeSingle();
    if (sub1?.statut === 'actif' && sub1.plan === 'pro') r.pass(S, 'abonnement activé (plan pro)');
    else r.fail(S, 'abonnement activé (plan pro)', JSON.stringify(sub1));

    const { data: hist1 } = await service.from('abonnement_paiements').select('date_paiement, reference').eq('id', apRow.id).single();
    if (hist1?.date_paiement && hist1.reference === abToken) r.pass(S, 'historique de paiement complété (référence = token)');
    else r.fail(S, 'historique de paiement complété (référence = token)', JSON.stringify(hist1));

    // Replay avec un payload DIFFÉRENT (autre empreinte) : aucun double effet.
    const w2 = await sendPaydunyaIpn({ token: abToken, status: 'completed', amount: 15000, receiptUrl: `http://mock-receipt/replay-${abToken}` });
    if (w2.data?.result === 'already_completed') r.pass(S, 'replay IPN différent → already_completed');
    else r.fail(S, 'replay IPN différent → already_completed', JSON.stringify(w2.data));

    const { data: sub2 } = await service.from('subscriptions').select('*').eq('user_id', subOwnerId).maybeSingle();
    if (sub2?.date_expiration === sub1.date_expiration && sub2.date_debut === sub1.date_debut) {
      r.pass(S, 'abonnement NON prolongé par le replay');
    } else {
      r.fail(S, 'abonnement NON prolongé par le replay', JSON.stringify({ sub1, sub2 }));
    }

    const { data: notifsAbo } = await service.from('notifications').select('id').eq('user_id', subOwnerId).like('message', '%abonnement MIM est actif%');
    if (notifsAbo?.length === 1) r.pass(S, 'une seule notification d\'activation malgré le replay');
    else r.fail(S, "une seule notification d'activation malgré le replay", `${notifsAbo?.length}`);
  });

  // ----------------------------------------------------------
  await r.section('paydunya : décaissement direct (Wave / Orange Money)', async () => {
    // Callback « statut final d'un décaissement » tel que PayDunya
    // l'enverrait : form-urlencoded signé (hash SHA-512 Master Key).
    async function sendDisburseCallback(opts) {
      const res = await fetch('http://127.0.0.1:3100/api/paydunya/disburse-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: buildIpnForm(opts),
      });
      const data = await res.json().catch(() => null);
      return { status: res.status, data };
    }

    // 1) « Pour versement » exige un numéro exploitable ou un alias.
    const badPv = await api('/moyens-paiement', {
      method: 'POST',
      jar: ownerJar,
      body: { type: 'wave', nom_titulaire: 'Owner Vir', pour_versement: true },
    });
    if (badPv.status === 400) r.pass(S, 'versement wave sans numéro ni alias → refusé');
    else r.fail(S, 'versement wave sans numéro ni alias → refusé', `statut ${badPv.status}`);

    // 2) Moyen Wave du propriétaire choisi pour recevoir les versements.
    const moyenV = await api('/moyens-paiement', {
      method: 'POST',
      jar: ownerJar,
      body: {
        type: 'wave',
        nom_titulaire: 'Owner Vir',
        numero: '+221 78 123 45 67',
        paydunya_alias: `owner.vir.${RUN_ID}@mim.test`,
        pour_versement: true,
      },
    });
    if (!expectSuccess(r, moyenV, S, 'moyen wave « pour versement » créé', [201])) return;
    const moyenVId = moyenV.data.data.id;
    if (moyenV.data.data.pour_versement === true) r.pass(S, 'pour_versement persisté sur le moyen');
    else r.fail(S, 'pour_versement persisté sur le moyen', JSON.stringify(moyenV.data?.data));

    // 3) Loyer payé → versement DIRECT via l'API Déboursement v2
    //    (Wave), et PAS un crédit compte-à-compte PayDunya.
    const creditBefore = paydunyaCreditLog().length;
    const { res: pV, loc: locV } = await createPaiement(4, 72000);
    if (!expectSuccess(r, pV, S, 'création du loyer (virement Wave)', [201])) return;
    const pidV = pV.data.data.id;
    const { res: initV } = await initiateLoyer(locV, pidV);
    if (!expectSuccess(r, initV, S, 'initiation de la facture (virement Wave)', [201])) return;
    await markMockInvoicePaid(initV.data.data.token, 72000);
    const wV = await sendPaydunyaIpn({ token: initV.data.data.token, status: 'completed', amount: 72000 });
    if (wV.data?.result === 'completed') r.pass(S, 'IPN loyer → completed');
    else r.fail(S, 'IPN loyer → completed', JSON.stringify(wV.data));

    const { data: redistV } = await service.from('paydunya_redistributions').select('*').eq('paiement_id', pidV).maybeSingle();
    if (
      redistV?.status === 'success' &&
      redistV.withdraw_mode === 'wave-senegal' &&
      redistV.recipient_alias === '781234567' &&
      Number(redistV.amount) === 72000 &&
      String(redistV.provider_token || '').startsWith('mock_disb_') &&
      redistV.transaction_id
    ) {
      r.pass(S, `versement direct Wave effectué (${redistV.recipient_alias} sans indicatif, token opérateur conservé)`);
    } else {
      r.fail(S, 'versement direct Wave effectué (mode wave-senegal)', JSON.stringify(redistV));
    }

    if (paydunyaCreditLog().length === creditBefore) r.pass(S, 'aucun crédit PER utilisé (pas de compte-à-compte)');
    else r.fail(S, 'aucun crédit PER utilisé', `${creditBefore} → ${paydunyaCreditLog().length}`);

    const ordreV2 = paydunyaDisburseLog().find((d) => d.account_alias === '781234567' && d.withdraw_mode === 'wave-senegal');
    if (ordreV2) r.pass(S, "le mock a reçu l'ordre de décaissement v2 (withdraw_mode Wave)");
    else r.fail(S, "le mock a reçu l'ordre de décaissement v2 (withdraw_mode Wave)", JSON.stringify(paydunyaDisburseLog()));

    // 4) Un seul moyen « pour versement » à la fois (exclusivité).
    const moyenO = await api('/moyens-paiement', {
      method: 'POST',
      jar: ownerJar,
      body: { type: 'orange_money', nom_titulaire: 'Owner Vir OM', numero: '782345678', pour_versement: true },
    });
    if (!expectSuccess(r, moyenO, S, 'second moyen « pour versement » créé', [201])) return;
    const moyenOId = moyenO.data.data.id;
    const { data: pvRows } = await service.from('moyens_paiement').select('id, pour_versement').in('id', [moyenVId, moyenOId]);
    const vRow = pvRows?.find((m) => m.id === moyenVId);
    const oRow = pvRows?.find((m) => m.id === moyenOId);
    if (vRow?.pour_versement === false && oRow?.pour_versement === true) {
      r.pass(S, 'exclusivité : le nouveau choix retire automatiquement le précédent');
    } else {
      r.fail(S, 'exclusivité : le nouveau choix retire automatiquement le précédent', JSON.stringify(pvRows));
    }

    // 5) Salaire employé versé directement sur son Orange Money.
    const usernameOm = `payempvir${Date.now() % 1000000000}`;
    const empOm = await api('/employes', {
      method: 'POST',
      jar: ownerJar,
      body: {
        nom: 'Employé Versement OM',
        username: usernameOm,
        password: 'Test1234!',
        salaire: 42000,
        date_embauche: '2026-01-01',
        phone: '+221783456789',
      },
    });
    if (!expectSuccess(r, empOm, S, "création de l'employé (OM)", [201])) return;
    const empOmMoyen = await api(`/employes/${empOm.data.data.id}/moyens-paiement`, {
      method: 'POST',
      jar: ownerJar,
      body: { type: 'orange_money', nom_titulaire: 'Employé OM', numero: '783456789', pour_versement: true },
    });
    if (!expectSuccess(r, empOmMoyen, S, "moyen OM « pour versement » de l'employé", [201])) return;

    const payOm = await api(`/employes/${empOm.data.data.id}/paiements`, {
      method: 'POST',
      jar: ownerJar,
      body: { montant: 42000, mois: ctx.seed.month, statut: 'attente', methode_paiement: 'paydunya' },
    });
    if (!expectSuccess(r, payOm, S, 'création du paiement de salaire (OM)', [201])) return;
    const initOm = await api('/paydunya/initiate', {
      method: 'POST',
      jar: ownerJar,
      body: { source: 'salaire', paiement_employe_id: payOm.data.data.id },
    });
    if (!expectSuccess(r, initOm, S, 'initiation de la facture salaire (OM)', [201])) return;
    await markMockInvoicePaid(initOm.data.data.token, 42000);
    const wOm = await sendPaydunyaIpn({ token: initOm.data.data.token, status: 'completed', amount: 42000 });
    if (wOm.data?.result === 'completed') r.pass(S, 'IPN salaire OM → completed');
    else r.fail(S, 'IPN salaire OM → completed', JSON.stringify(wOm.data));

    const { data: redistOm } = await service
      .from('paydunya_redistributions')
      .select('*')
      .eq('paiement_employe_id', payOm.data.data.id)
      .maybeSingle();
    if (redistOm?.status === 'success' && redistOm.withdraw_mode === 'orange-money-senegal' && redistOm.recipient_alias === '783456789') {
      r.pass(S, "salaire versé directement sur l'Orange Money de l'employé");
    } else {
      r.fail(S, "salaire versé directement sur l'Orange Money de l'employé", JSON.stringify(redistOm));
    }

    // 6) Décaissement différé : soumis à l'opérateur, confirmé ensuite
    //    par le callback signé (jamais rejeté aveuglément).
    const moyenP = await api('/moyens-paiement', {
      method: 'POST',
      jar: ownerJar,
      body: { type: 'wave', nom_titulaire: 'Owner Différé', numero: '000000002', pour_versement: true },
    });
    if (!expectSuccess(r, moyenP, S, 'moyen wave différé créé', [201])) return;
    const moyenPId = moyenP.data.data.id;

    const notifConfBefore = (await service.from('notifications').select('id').eq('user_id', owner.id).like('message', 'Versement PayDunya confirmé%')).data.length;

    const { res: pP, loc: locP } = await createPaiement(5, 73000);
    if (!expectSuccess(r, pP, S, 'création du loyer (décaissement différé)', [201])) return;
    const pidP = pP.data.data.id;
    const { res: initP } = await initiateLoyer(locP, pidP);
    if (!expectSuccess(r, initP, S, 'initiation de la facture (décaissement différé)', [201])) return;
    await markMockInvoicePaid(initP.data.data.token, 73000);
    await sendPaydunyaIpn({ token: initP.data.data.token, status: 'completed', amount: 73000 });

    const { data: redistP } = await service.from('paydunya_redistributions').select('*').eq('paiement_id', pidP).maybeSingle();
    if (
      redistP?.status === 'pending' &&
      String(redistP.provider_token || '').startsWith('mock_disb_') &&
      redistP.attempt_count === 1
    ) {
      r.pass(S, 'décaissement soumis puis « pending » chez l’opérateur (conservé, non rejoué)');
    } else {
      r.fail(S, 'décaissement soumis puis « pending » chez l’opérateur', JSON.stringify(redistP));
    }

    // Relance AVANT confirmation du statut : vérification d'abord, pas de rejeu.
    const retryPending = await api(`/paydunya/redistributions/${redistP.id}/retry`, { method: 'POST', jar: adminJar });
    if (
      retryPending.status === 200 &&
      retryPending.data?.data?.status === 'pending' &&
      retryPending.data.data.attempt_count === 1 &&
      String(retryPending.data?.message || '').includes('attente')
    ) {
      r.pass(S, 'relance sur décaissement soumis → statut revérifié, aucun second envoi');
    } else {
      r.fail(S, 'relance sur décaissement soumis → statut revérifié, aucun second envoi', JSON.stringify(retryPending.data));
    }

    // L'opérateur confirme le succès ; PayDunya pousse son callback.
    await settleMockDisbursement(redistP.provider_token, 'success');

    const badCb = await sendDisburseCallback({
      token: redistP.provider_token,
      status: 'success',
      amount: 73000,
      hashOverride: 'e'.repeat(128),
    });
    if (badCb.status === 401) r.pass(S, 'callback décaissement avec mauvais hash → 401');
    else r.fail(S, 'callback décaissement avec mauvais hash → 401', `statut ${badCb.status}`);

    const cbOk = await sendDisburseCallback({ token: redistP.provider_token, status: 'success', amount: 73000 });
    if (cbOk.status === 200 && cbOk.data?.result === 'redistribution_success') {
      r.pass(S, 'callback PayDunya signé → redistribution_success');
    } else {
      r.fail(S, 'callback PayDunya signé → redistribution_success', `statut ${cbOk.status} ${JSON.stringify(cbOk.data)}`);
    }

    const { data: redistPFinal } = await service.from('paydunya_redistributions').select('*').eq('id', redistP.id).single();
    const notifConfAfter = (await service.from('notifications').select('id').eq('user_id', owner.id).like('message', 'Versement PayDunya confirmé%')).data.length;
    if (redistPFinal?.status === 'success' && notifConfAfter === notifConfBefore + 1) {
      r.pass(S, 'versement différé finalisé « success » + propriétaire notifié');
    } else {
      r.fail(S, 'versement différé finalisé « success » + propriétaire notifié', `${redistPFinal?.status}, notifs ${notifConfBefore} → ${notifConfAfter}`);
    }

    // Callback rejoué : idempotent, aucune notification en double.
    await sendDisburseCallback({ token: redistP.provider_token, status: 'success', amount: 73000 });
    const notifConfReplay = (await service.from('notifications').select('id').eq('user_id', owner.id).like('message', 'Versement PayDunya confirmé%')).data.length;
    if (notifConfReplay === notifConfAfter) r.pass(S, 'callback rejoué : aucune notification dupliquée');
    else r.fail(S, 'callback rejoué : aucune notification dupliquée', `${notifConfAfter} → ${notifConfReplay}`);

    // 7) Échec différé confirmé par callback, puis relance admin après
    //    correction du numéro PAR L'EMPLOYÉ lui-même.
    const usernameFail = `payempdiff${Date.now() % 1000000000}`;
    const empFail = await api('/employes', {
      method: 'POST',
      jar: ownerJar,
      body: {
        nom: 'Employé Différé',
        username: usernameFail,
        password: 'Test1234!',
        salaire: 36000,
        date_embauche: '2026-01-01',
        phone: '+221785555000',
      },
    });
    if (!expectSuccess(r, empFail, S, "création de l'employé (échec différé)", [201])) return;
    const empFailMoyen = await api(`/employes/${empFail.data.data.id}/moyens-paiement`, {
      method: 'POST',
      jar: ownerJar,
      body: { type: 'orange_money', nom_titulaire: 'Employé Différé', numero: '000000002', pour_versement: true },
    });
    if (!expectSuccess(r, empFailMoyen, S, "moyen OM de l'employé (numéro différé)", [201])) return;

    const payF = await api(`/employes/${empFail.data.data.id}/paiements`, {
      method: 'POST',
      jar: ownerJar,
      body: { montant: 36000, mois: ctx.seed.month, statut: 'attente', methode_paiement: 'paydunya' },
    });
    if (!expectSuccess(r, payF, S, 'création du paiement de salaire (échec différé)', [201])) return;
    const initF = await api('/paydunya/initiate', {
      method: 'POST',
      jar: ownerJar,
      body: { source: 'salaire', paiement_employe_id: payF.data.data.id },
    });
    if (!expectSuccess(r, initF, S, 'initiation de la facture salaire (échec différé)', [201])) return;
    await markMockInvoicePaid(initF.data.data.token, 36000);
    await sendPaydunyaIpn({ token: initF.data.data.token, status: 'completed', amount: 36000 });

    const { data: redistF } = await service
      .from('paydunya_redistributions')
      .select('*')
      .eq('paiement_employe_id', payF.data.data.id)
      .maybeSingle();
    if (redistF?.status !== 'pending' || !redistF.provider_token) {
      r.fail(S, 'préparation du décaissement différé (employé)', JSON.stringify(redistF));
      return;
    }

    const notifRefusBefore = (await service.from('notifications').select('id').eq('user_id', owner.id).like('message', 'Versement PayDunya refusé%')).data.length;

    await settleMockDisbursement(redistF.provider_token, 'failed');
    const cbFail = await sendDisburseCallback({ token: redistF.provider_token, status: 'failed', amount: 36000 });
    if (cbFail.status === 200 && cbFail.data?.result === 'redistribution_failed') {
      r.pass(S, 'callback PayDunya → redistribution_failed');
    } else {
      r.fail(S, 'callback PayDunya → redistribution_failed', `statut ${cbFail.status} ${JSON.stringify(cbFail.data)}`);
    }

    const { data: redistFFinal } = await service.from('paydunya_redistributions').select('*').eq('id', redistF.id).single();
    const notifRefusAfter = (await service.from('notifications').select('id').eq('user_id', owner.id).like('message', 'Versement PayDunya refusé%')).data.length;
    if (
      redistFFinal?.status === 'pending' &&
      redistFFinal.response?.source === 'callback' &&
      String(redistFFinal.response?.message || '').includes('refus') &&
      notifRefusAfter === notifRefusBefore + 1
    ) {
      r.pass(S, 'échec confirmé par l’opérateur : versement relançable + destinataire notifié');
    } else {
      r.fail(S, 'échec confirmé par l’opérateur : versement relançable + destinataire notifié', JSON.stringify(redistFFinal));
    }

    // L'employé corrige son numéro depuis SON espace.
    const empFailJar = newJar();
    const empLogin = await api('/auth/login', {
      method: 'POST',
      jar: empFailJar,
      body: { identifier: usernameFail, password: 'Test1234!' },
    });
    if (empLogin.status !== 200) {
      r.fail(S, 'connexion du compte employé', `statut ${empLogin.status}`);
      return;
    }
    const { data: empFailMoyensRows } = await service
      .from('moyens_paiement_employes')
      .select('id')
      .eq('employe_uid', empFail.data.data.account_uid);
    const fixRes = await api(`/employe/moyens-paiement/${empFailMoyensRows[0].id}`, {
      method: 'PUT',
      jar: empFailJar,
      body: { numero: '785555555' },
    });
    if (fixRes.status === 200 && fixRes.data?.data?.numero === '785555555') {
      r.pass(S, "l'employé corrige son numéro de réception depuis son espace");
    } else {
      r.fail(S, "l'employé corrige son numéro de réception depuis son espace", `statut ${fixRes.status} ${JSON.stringify(fixRes.data)}`);
    }

    // La relance admin repart automatiquement sur la cible corrigée.
    const retryFixed = await api(`/paydunya/redistributions/${redistF.id}/retry`, { method: 'POST', jar: adminJar });
    if (retryFixed.status === 200 && retryFixed.data?.data?.status === 'success' && retryFixed.data.data.recipient_alias === '785555555') {
      r.pass(S, 'relance admin → nouveau décaissement réussi vers le numéro corrigé');
    } else {
      r.fail(S, 'relance admin → nouveau décaissement réussi vers le numéro corrigé', JSON.stringify(retryFixed.data));
    }

    // 8) Nettoyage : aucun moyen résiduel pour les suites suivantes.
    await service.from('moyens_paiement').delete().in('id', [moyenVId, moyenOId, moyenPId]);
    await service.from('moyens_paiement_employes').delete().in(
      'id',
      [empOmMoyen.data.data.id, empFailMoyen.data.data.id].filter(Boolean)
    );
    const { data: restants } = await service.from('moyens_paiement').select('id').eq('user_id', owner.id);
    if ((restants?.length ?? 0) === 0) r.pass(S, 'nettoyage des moyens créés');
    else r.fail(S, 'nettoyage des moyens créés', `${restants?.length} moyen(s) restant(s)`);
  });

  // ----------------------------------------------------------
  await r.section('paydunya : accès admin uniquement', async () => {
    const ownerCheckouts = await api('/paydunya/checkouts', { jar: ownerJar });
    if (ownerCheckouts.status === 403) r.pass(S, '/checkouts interdit au propriétaire (403)');
    else r.fail(S, '/checkouts interdit au propriétaire (403)', `statut ${ownerCheckouts.status}`);

    const adminCheckouts = await api('/paydunya/checkouts', { jar: adminJar });
    if (expectSuccess(r, adminCheckouts, S, '/checkouts admin') && adminCheckouts.data.data.length > 0) {
      r.pass(S, 'l\'admin liste les sessions d\'encaissement');
    } else {
      r.fail(S, 'l\'admin liste les sessions d\'encaissement', JSON.stringify(adminCheckouts.data).slice(0, 200));
    }

    const ownerRedist = await api('/paydunya/redistributions', { jar: ownerJar });
    if (ownerRedist.status === 403) r.pass(S, '/redistributions interdit au propriétaire (403)');
    else r.fail(S, '/redistributions interdit au propriétaire (403)', `statut ${ownerRedist.status}`);

    const adminRedist = await api('/paydunya/redistributions', { jar: adminJar });
    if (expectSuccess(r, adminRedist, S, '/redistributions admin') && adminRedist.data.data.length > 0) {
      r.pass(S, 'l\'admin liste les redistributions');
    } else {
      r.fail(S, 'l\'admin liste les redistributions', JSON.stringify(adminRedist.data).slice(0, 200));
    }
  });
}