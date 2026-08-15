// ============================================================
// MIM - Suite UnitechPay (paiement mobile money des loyers)
//
// Pendant les tests, le serveur MIM (3100) pointe vers un MOCK
// UnitechPay local (127.0.0.1:64330) : aucun appel réel, aucune
// transaction. La clé API est la vraie clé de test (signature HMAC
// vérifiée par le serveur MIM, jamais exposée au frontend).
// ============================================================

import http from 'node:http';
import crypto from 'node:crypto';
import { api, newJar, BASE } from './lib.js';

const S = 'unitech';
const MOCK_PORT = 64330;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}/api`;

let mockServer = null;
let mockRequests = [];
let mockSeq = 0;

export async function startUnitechMock() {
  if (mockServer) return;
  mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch { /* ignoré */ }
      const action = new URL(req.url, MOCK_BASE).searchParams.get('action');
      mockRequests.push({ action, method: req.method, body: parsed });
      mockSeq++;

      let out;
      if (action === 'create_wave_payment' || action === 'create_orange_qr' || action === 'create_orange_maxit' || action === 'create_orange_om') {
        out = {
          success: true,
          data: {
            transaction_id: mockSeq,
            reference: `mock_ref_${mockSeq}_${Date.now()}`,
            payment_url: `https://mock-unitech/pay/${mockSeq}`,
            amount: parsed.amount,
            status: 'pending',
            type: action.replace('create_', ''),
          },
        };
        if (action === 'create_orange_qr') out.data.qr_code = 'data:image/png;base64,MOCKQR';
      } else if (action === 'withdraw_funds') {
        out = {
          success: true,
          data: {
            transaction_id: mockSeq,
            reference: `mock_withdraw_${mockSeq}_${Date.now()}`,
            amount: parsed.amount,
            status: 'pending',
            type: 'withdraw',
          },
        };
      } else if (action === 'balance') {
        out = { success: true, data: { sold_wave: 0, sold_om: 0, sold_intl: 0, total: 0, currency: 'XOF' } };
      } else {
        out = { success: false, message: 'Not found', code: 404 };
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((resolve, reject) => {
    mockServer.once('error', reject);
    mockServer.listen(MOCK_PORT, '127.0.0.1', resolve);
  });
  mockRequests = [];
  mockSeq = 0;
}

export function stopUnitechMock() {
  if (!mockServer) return;
  mockServer.close();
  mockServer = null;
}

function check(r, name, cond, detail = '') {
  if (cond) r.pass(S, name, detail);
  else r.fail(S, name, detail);
}

// Envoie un webhook signé HMAC (comme le ferait UnitechPay).
async function sendWebhook(payloadObj) {
  const raw = JSON.stringify(payloadObj);
  const sig = crypto.createHmac('sha256', process.env.UNITECH_API_KEY || '').update(raw).digest('hex');
  const res = await fetch(BASE + '/unitech/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-UNITECHPAY-SIGNATURE': sig },
    body: raw,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// Signature invalide volontairement.
async function sendWebhookBadSig(payloadObj) {
  const raw = JSON.stringify(payloadObj);
  const res = await fetch(BASE + '/unitech/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-UNITECHPAY-SIGNATURE': 'signature-fausse' },
    body: raw,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

export async function runUnitech(r, ctx) {
  const service = ctx.service;
  if (!ctx.seed?.owners) {
    r.blocked(S, 'seed requis', '--no-seed n\'est pas compatible avec cette suite');
    return;
  }
  await startUnitechMock();

  const owner = ctx.seed.owners[0];
  const other = ctx.seed.owners[1];
  const ownerJar = owner.jar;
  const otherJar = other.jar;

  // Dépendance d'ordre : la suite « abonnement » laisse owner1 avec un
  // abonnement EXPIRÉ (section isolation), ce qui suspend son accès.
  // On rétablit un état neutre et valide (aucun abonnement enregistré =
  // accès conservé, cf. utils/subscription.js) puis on attend que le
  // cache serveur d'abonnement (~2 s) exprime le nouvel état.
  const { error: subResetErr } = await service
    .from('subscriptions')
    .delete()
    .eq('user_id', owner.id);
  if (subResetErr) {
    r.blocked(S, 'données de départ', `réinitialisation abonnement : ${subResetErr.message}`);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 2600));

  // Relecture des paiements du propriétaire via l'API (comme le frontend).
  const pays = await api('/paiements', { jar: ownerJar });
  const list = pays.data?.data || [];
  const paiementAttente = list.find(
    (p) => String(p.locataire_id) === String(owner.locataires[0].id) && p.statut === 'attente'
  );
  const paiementPaye = list.find(
    (p) => String(p.locataire_id) === String(owner.locataires[1].id) && p.statut === 'paye'
  );
  if (!paiementAttente || !paiementPaye) {
    r.blocked(S, 'données de départ', `attente=${Boolean(paiementAttente)} paye=${Boolean(paiementPaye)}`);
    return;
  }

  // ----------------------------------------------------------
  // 1. Sécurité : aucune écriture sans auth, pas de données client.
  // ----------------------------------------------------------
  await r.section('unitech : sécurité de base', async () => {
    const noAuth = await api('/unitech/initiate', { method: 'POST', body: { paiement_id: paiementAttente.id, operator: 'wave' } });
    check(r, 'initiate sans auth -> 401', noAuth.status === 401, `statut ${noAuth.status}`);

    const notMine = await api('/unitech/initiate', { method: 'POST', jar: otherJar, body: { paiement_id: paiementAttente.id, operator: 'wave' } });
    check(r, 'initiate sur paiement d\'un autre propriétaire -> 404', notMine.status === 404, `statut ${notMine.status} ${JSON.stringify(notMine.data)}`);

    const alreadyPaid = await api('/unitech/initiate', { method: 'POST', jar: ownerJar, body: { paiement_id: paiementPaye.id, operator: 'wave' } });
    check(r, 'initiate sur paiement déjà payé -> 400', alreadyPaid.status === 400, `statut ${alreadyPaid.status} ${JSON.stringify(alreadyPaid.data)}`);
  });

  // ----------------------------------------------------------
  // 2. Flux nominal : initiate -> checkout pending.
  // ----------------------------------------------------------
  let checkoutWave = null;
  await r.section('unitech : initiation du checkout', async () => {
    mockRequests = [];
    // Le client envoie un montant et un numéro bidon : tout doit être ignoré.
    const res = await api('/unitech/initiate', {
      method: 'POST',
      jar: ownerJar,
      body: { paiement_id: paiementAttente.id, operator: 'wave', amount: 1, customer_number: '000000000', statut: 'paye' },
    });
    check(r, 'initiate wave -> 201', res.status === 201, `statut ${res.status} ${JSON.stringify(res.data)}`);
    const c = res.data?.data?.checkout;
    checkoutWave = c;
    if (c) {
      check(r, 'checkout créé en status pending', c.status === 'pending', `status ${c.status}`);
      check(r, 'montant du checkout = montant en base', Number(c.amount) === Number(paiementAttente.montant), `checkout ${c.amount} vs base ${paiementAttente.montant}`);
      check(r, 'description = référence interne MIM', c.description === `MIM-PAIEMENT-${paiementAttente.id}`, c.description);
      check(r, 'unitech_reference enregistrée', Boolean(c.unitech_reference), c.unitech_reference);
      check(r, 'payment_url renvoyée au propriétaire', Boolean(c.payment_url), c.payment_url);
    }

    // Le montant et le téléphone envoyés par le client sont ignorés :
    // le mock a reçu le montant réel et le téléphone du locataire (base).
    const sent = mockRequests.find((m) => m.action === 'create_wave_payment');
    if (sent) {
      check(r, 'montant envoyé à UnitechPay = montant base (client ignoré)', Number(sent.body.amount) === Number(paiementAttente.montant), `reçu ${sent.body.amount}`);
      const phoneBase = String(owner.locataires[0].phone || '');
      check(r, 'téléphone envoyé = téléphone du locataire (base)', String(sent.body.customer_number) === phoneBase, `reçu ${sent.body.customer_number} vs ${phoneBase}`);
      check(r, 'statut client ignoré (jamais payé par le frontend)', sent.body.statut === undefined, String(sent.body.statut));
    }

    // Aucune clé API ne doit transiter dans les réponses.
    const apiKey = process.env.UNITECH_API_KEY || '';
    const bodyStr = JSON.stringify(res.data || {});
    check(r, 'aucune clé API dans la réponse initiate', !apiKey || !bodyStr.includes(apiKey));
  });

  if (checkoutWave) {
    // ----------------------------------------------------------
    // 3. Idempotence d'initiation : re-créer ne duplique pas.
    // ----------------------------------------------------------
    await r.section('unitech : reprise d\'une session en attente', async () => {
      const res = await api('/unitech/initiate', { method: 'POST', jar: ownerJar, body: { paiement_id: paiementAttente.id, operator: 'wave' } });
      check(r, 're-initiate -> 200 resumed', res.status === 200 && res.data?.data?.resumed === true, `statut ${res.status} ${JSON.stringify(res.data?.data)}`);
      const rows = (await service.from('unitech_checkouts').select('id').eq('paiement_id', paiementAttente.id)).data;
      check(r, 'une seule session créée', rows?.length === 1, `nb=${rows?.length}`);
    });

    // ----------------------------------------------------------
    // 4. Webhook : signature invalide -> 401, rien n'est traité.
    // ----------------------------------------------------------
    await r.section('unitech : webhook signature', async () => {
      const w = await sendWebhookBadSig({ event: 'payment_completed', reference: checkoutWave.unitech_reference, amount: checkoutWave.amount, status: 'completed' });
      check(r, 'signature invalide -> 401', w.status === 401, `statut ${w.status}`);

      const { data: paysAfter } = await service.from('paiements').select('statut').eq('id', paiementAttente.id).single();
      check(r, 'paiement non modifié après signature invalide', paysAfter.statut === 'attente', paysAfter.statut);
    });

    // ----------------------------------------------------------
    // 5. Webhook valide -> paiement payé + références.
    // ----------------------------------------------------------
    await r.section('unitech : webhook valide (payment_completed)', async () => {
      const w = await sendWebhook({ event: 'payment_completed', transaction_id: 42, reference: checkoutWave.unitech_reference, amount: checkoutWave.amount, status: 'completed' });
      check(r, 'webhook valide -> 200', w.status === 200, `statut ${w.status} ${JSON.stringify(w.data)}`);
      check(r, 'résultat = completed', w.data?.result === 'completed', JSON.stringify(w.data));

      const { data: paysAfter } = await service.from('paiements').select('*').eq('id', paiementAttente.id).single();
      check(r, 'paiement -> payé', paysAfter.statut === 'paye', paysAfter.statut);
      check(r, 'date_paiement renseignée', Boolean(paysAfter.date_paiement), String(paysAfter.date_paiement));
      check(r, 'methode_paiement = mobile_money', paysAfter.methode_paiement === 'mobile_money', String(paysAfter.methode_paiement));
      check(r, 'référence UnitechPay enregistrée sur le paiement', paysAfter.reference === checkoutWave.unitech_reference, String(paysAfter.reference));

      const { data: co } = await service.from('unitech_checkouts').select('status').eq('id', checkoutWave.id).single();
      check(r, 'checkout -> completed', co.status === 'completed', co.status);
    });

    // ----------------------------------------------------------
    // 6. Dédup : rejouer le même payload ne double pas le traitement.
    // ----------------------------------------------------------
    await r.section('unitech : dédup du webhook', async () => {
      const payload = { event: 'payment_completed', transaction_id: 42, reference: checkoutWave.unitech_reference, amount: checkoutWave.amount, status: 'completed' };
      const before = (await service.from('unitech_webhooks').select('id').eq('event', 'payment_completed').eq('unitech_reference', checkoutWave.unitech_reference)).data.length;
      const w1 = await sendWebhook(payload);
      const w2 = await sendWebhook(payload);
      const after = (await service.from('unitech_webhooks').select('id').eq('event', 'payment_completed').eq('unitech_reference', checkoutWave.unitech_reference)).data.length;
      check(r, 'rejeu -> duplicated:true', w1.data?.duplicated === true && w2.data?.duplicated === true, JSON.stringify({ w1: w1.data, w2: w2.data }));
      check(r, 'un seul enregistrement de webhook', before === 1 && after === 1, `${before} -> ${after}`);

      const { data: paysAfter } = await service.from('paiements').select('statut, date_paiement').eq('id', paiementAttente.id).single();
      check(r, 'paiement inchangé après dédup', paysAfter.statut === 'paye', paysAfter.statut);
    });

    // ----------------------------------------------------------
    // 7. Événement tardif (failed) sur paiement déjà payé : ignoré.
    // ----------------------------------------------------------
    await r.section('unitech : pas de rétrogradation après succès', async () => {
      const w = await sendWebhook({ event: 'payment_failed', reference: checkoutWave.unitech_reference, amount: checkoutWave.amount, status: 'failed' });
      check(r, 'failed tardif -> already_completed', w.data?.result === 'already_completed', JSON.stringify(w.data));
      const { data: co } = await service.from('unitech_checkouts').select('status').eq('id', checkoutWave.id).single();
      check(r, 'checkout reste completed', co.status === 'completed', co.status);
      const { data: paysAfter } = await service.from('paiements').select('statut').eq('id', paiementAttente.id).single();
      check(r, 'paiement reste payé', paysAfter.statut === 'paye', paysAfter.statut);
    });
  }

  // ----------------------------------------------------------
  // 8. Montant erroné : jamais payé.
  // ----------------------------------------------------------
  await r.section('unitech : montant incohérent', async () => {
    const pNew = await api('/paiements', { method: 'POST', jar: ownerJar, body: { locataire_id: owner.locataires[2].id, logement_id: owner.logements[2].id, montant: 25000, mois: ctx.seed.month, statut: 'attente' } });
    const pid = pNew.data?.data?.id;
    if (!pid) return r.fail(S, 'création paiement pour test montant', JSON.stringify(pNew.data));

    const init = await api('/unitech/initiate', { method: 'POST', jar: ownerJar, body: { paiement_id: pid, operator: 'wave' } });
    const ref = init.data?.data?.checkout?.unitech_reference;
    if (!ref) return r.fail(S, 'initiate paiement test montant', JSON.stringify(init.data));

    const w = await sendWebhook({ event: 'payment_completed', reference: ref, amount: 99999, status: 'completed' });
    check(r, 'montant erroné -> amount_mismatch', w.data?.result === 'amount_mismatch', JSON.stringify(w.data));

    const { data: co } = await service.from('unitech_checkouts').select('status').eq('unitech_reference', ref).single();
    check(r, 'checkout -> failed (montant incohérent)', co.status === 'failed', co.status);

    const { data: paysAfter } = await service.from('paiements').select('statut').eq('id', pid).single();
    check(r, 'paiement jamais payé', paysAfter.statut === 'attente', paysAfter.statut);
  });

  // ----------------------------------------------------------
  // 9. Événements failed / expired / cancelled / inconnu.
  // ----------------------------------------------------------
  await r.section('unitech : états failed / expired / cancelled / inconnu', async () => {
    async function setupPaiement() {
      const p = await api('/paiements', { method: 'POST', jar: ownerJar, body: { locataire_id: owner.locataires[3].id, logement_id: owner.logements[3].id, montant: 30000, mois: ctx.seed.month, statut: 'attente' } });
      const pid = p.data?.data?.id;
      const init = await api('/unitech/initiate', { method: 'POST', jar: ownerJar, body: { paiement_id: pid, operator: 'orange', orange_mode: 'maxit' } });
      return { pid, ref: init.data?.data?.checkout?.unitech_reference, cid: init.data?.data?.checkout?.id };
    }

    const { pid: pf, ref: rf } = await setupPaiement();
    if (rf) {
      const wf = await sendWebhook({ event: 'payment_failed', reference: rf, amount: 30000, status: 'failed' });
      check(r, 'payment_failed -> failed', wf.data?.result === 'failed', JSON.stringify(wf.data));
      const { data: pays } = await service.from('paiements').select('statut').eq('id', pf).single();
      check(r, 'paiement reste en attente (failed)', pays.statut === 'attente', pays.statut);
    }

    const { pid: pe, ref: re } = await setupPaiement();
    if (re) {
      const we = await sendWebhook({ event: 'payment_expired', reference: re, amount: 30000, status: 'expired' });
      check(r, 'payment_expired -> expired', we.data?.result === 'expired', JSON.stringify(we.data));
      const { data: pays } = await service.from('paiements').select('statut').eq('id', pe).single();
      check(r, 'paiement reste en attente (expired)', pays.statut === 'attente', pays.statut);
    }

    const { pid: pc, ref: rc } = await setupPaiement();
    if (rc) {
      const wc = await sendWebhook({ event: 'payment_cancelled', reference: rc, amount: 30000, status: 'cancelled' });
      check(r, 'payment_cancelled -> cancelled', wc.data?.result === 'cancelled', JSON.stringify(wc.data));
      const { data: pays } = await service.from('paiements').select('statut').eq('id', pc).single();
      check(r, 'paiement reste en attente (cancelled)', pays.statut === 'attente', pays.statut);
    }

    // Événement non terminal (pending) : aucune transition vers payé.
    const { pid: pp, ref: rp } = await setupPaiement();
    if (rp) {
      const wp = await sendWebhook({ event: 'payment_pending', reference: rp, amount: 30000, status: 'pending' });
      const { data: co } = await service.from('unitech_checkouts').select('status').eq('unitech_reference', rp).single();
      check(r, 'status pending -> aucune transition', co.status === 'pending', co.status);
      const { data: pays } = await service.from('paiements').select('statut').eq('id', pp).single();
      check(r, 'paiement reste en attente (pending)', pays.statut === 'attente', pays.statut);
      check(r, 'webhook pending traité sans erreur', wp.status === 200, `statut ${wp.status}`);
    }

    const wu = await sendWebhook({ event: 'payment_completed', reference: 'REFERENCE_INCONNUE_' + Date.now(), amount: 30000, status: 'completed' });
    check(r, 'référence inconnue -> 200 sans modification', wu.status === 200 && wu.data?.reference === 'unknown', JSON.stringify(wu.data));
  });

  // ----------------------------------------------------------
  // 10. Locataire sans téléphone -> refus avant tout appel.
  // ----------------------------------------------------------
  await r.section('unitech : locataire sans téléphone', async () => {
    const t = owner.locataires[2];
    const originalPhone = t.phone;
    await service.from('locataires').update({ phone: '' }).eq('id', t.id);
    const p = await api('/paiements', { method: 'POST', jar: ownerJar, body: { locataire_id: t.id, logement_id: owner.logements[2].id, montant: 20000, mois: ctx.seed.month, statut: 'attente' } });
    const pid = p.data?.data?.id;
    const init = await api('/unitech/initiate', { method: 'POST', jar: ownerJar, body: { paiement_id: pid, operator: 'wave' } });
    check(r, 'locataire sans téléphone -> 400', init.status === 400, `statut ${init.status} ${JSON.stringify(init.data)}`);
    await service.from('locataires').update({ phone: originalPhone }).eq('id', t.id);
  });

  // ----------------------------------------------------------
  // 11. Solde + isolation entre propriétaires.
  // ----------------------------------------------------------
  await r.section('unitech : solde et isolation', async () => {
    const bal = await api('/unitech/balance', { jar: ownerJar });
    check(r, '/unitech/balance -> 200', bal.status === 200 && bal.data?.success === true, `statut ${bal.status}`);
    const balBody = JSON.stringify(bal.data || {});
    check(r, 'aucune clé API dans /unitech/balance', !process.env.UNITECH_API_KEY || !balBody.includes(process.env.UNITECH_API_KEY));

    const oth = await api('/unitech/checkouts?paiement_id=' + paiementAttente.id, { jar: otherJar });
    check(r, 'un autre propriétaire ne voit pas les sessions', oth.status === 200 && (oth.data?.data?.length || 0) === 0, JSON.stringify(oth.data));

    const mine = await api('/unitech/checkouts?paiement_id=' + paiementAttente.id, { jar: ownerJar });
    check(r, 'le propriétaire voit ses sessions', mine.status === 200 && (mine.data?.data?.length || 0) >= 1, JSON.stringify(mine.data));

    // Aucune clé API dans le code frontend servi.
    const front = await fetch('http://127.0.0.1:3100/PartProprietaires/paiements.html');
    const html = await front.text();
    check(r, 'aucune clé API dans la page frontend', !html.includes(process.env.UNITECH_API_KEY || '!!!NEVER!!!'));
  });

  // ----------------------------------------------------------
  // 12. Salaire : versement (payout) via UnitechPay.
  // ----------------------------------------------------------
  await r.section('unitech : versement de salaire (payout)', async () => {
    const uname = `emp_unitech_${Date.now().toString().slice(-8)}`;
    const created = await api('/employes', {
      method: 'POST',
      jar: ownerJar,
      body: { username: uname, password: 'Test1234!', nom: 'Employé Unitech', poste: 'Gardien', salaire: 45000, phone: '+221771234567', statut: 'actif' },
    });
    if (created.status !== 201) return r.fail(S, 'création employé pour le test salaire', `statut ${created.status} ${JSON.stringify(created.data)}`);
    const empId = created.data?.data?.id || created.data?.id;
    if (!empId) return r.fail(S, 'création employé : id manquant', JSON.stringify(created.data));

    const pay = await api(`/employes/${empId}/paiements`, {
      method: 'POST',
      jar: ownerJar,
      body: { montant: 45000, mois: ctx.seed.month, statut: 'attente', methode_paiement: 'mobile_money' },
    });
    const payId = pay.data?.data?.id || pay.data?.id;
    if (!payId) return r.fail(S, 'création paiement de salaire', JSON.stringify(pay.data));

    mockRequests = [];
    const init = await api('/unitech/initiate', {
      method: 'POST',
      jar: ownerJar,
      body: { source: 'salaire', paiement_employe_id: payId, operator: 'wave' },
    });
    check(r, 'initiate salaire -> 201', init.status === 201, `statut ${init.status} ${JSON.stringify(init.data)}`);
    const co = init.data?.data?.checkout;
    if (co) {
      check(r, 'checkout salaire en status pending', co.status === 'pending', `status ${co.status}`);
      check(r, 'source = salaire', co.source === 'salaire', String(co.source));
      check(r, 'paiement_employe_id lié au checkout', String(co.paiement_employe_id) === String(payId), String(co.paiement_employe_id));
      check(r, 'description = MIM-SALAIRE-<id>', co.description === `MIM-SALAIRE-${payId}`, co.description);
    }

    const sent = mockRequests.find((m) => m.action === 'withdraw_funds');
    if (sent) {
      check(r, 'payout envoyé à UnitechPay (withdraw_funds)', true);
      check(r, 'montant du versement = salaire en base', Number(sent.body.amount) === 45000, String(sent.body.amount));
      check(r, 'téléphone du versement = téléphone employé (base)', String(sent.body.customer_number) === '+221771234567', String(sent.body.customer_number));
    } else {
      r.fail(S, 'payout envoyé à UnitechPay (withdraw_funds)', 'action withdraw_funds non reçue par le mock');
    }

    if (co?.unitech_reference) {
      const w = await sendWebhook({ event: 'payment_completed', reference: co.unitech_reference, amount: 45000, status: 'completed' });
      check(r, 'webhook salaire -> completed', w.status === 200 && w.data?.result === 'completed', `statut ${w.status} ${JSON.stringify(w.data)}`);
      const { data: payAfter } = await service.from('paiements_employes').select('*').eq('id', payId).single();
      check(r, 'paiement de salaire -> payé', payAfter.statut === 'paye', payAfter.statut);
      check(r, 'salaire methode_paiement = mobile_money', payAfter.methode_paiement === 'mobile_money', String(payAfter.methode_paiement));
      check(r, 'salaire date_paiement renseignée', Boolean(payAfter.date_paiement), String(payAfter.date_paiement));
      check(r, 'salaire référence UnitechPay enregistrée', payAfter.reference === co.unitech_reference, String(payAfter.reference));
    }

    // Sécurité : versement sur un salaire d'un AUTRE propriétaire -> 404.
    const otherUname = `emp_unitech_o_${Date.now().toString().slice(-8)}`;
    const createdOther = await api('/employes', {
      method: 'POST',
      jar: otherJar,
      body: { username: otherUname, password: 'Test1234!', nom: 'Employé Autre', poste: 'Gardien', salaire: 30000, phone: '+221701111111', statut: 'actif' },
    });
    const otherEmpId = createdOther.data?.data?.id || createdOther.data?.id;
    if (otherEmpId) {
      const otherPay = await api(`/employes/${otherEmpId}/paiements`, {
        method: 'POST',
        jar: otherJar,
        body: { montant: 30000, mois: ctx.seed.month, statut: 'attente', methode_paiement: 'mobile_money' },
      });
      const otherPayId = otherPay.data?.data?.id || otherPay.data?.id;
      if (otherPayId) {
        const notMine = await api('/unitech/initiate', {
          method: 'POST',
          jar: ownerJar,
          body: { source: 'salaire', paiement_employe_id: otherPayId, operator: 'wave' },
        });
        check(r, 'versement sur salaire d\'un autre propriétaire -> 404', notMine.status === 404, `statut ${notMine.status} ${JSON.stringify(notMine.data)}`);
      }
    }
  });
}
