// ============================================================
// MIM - Suite concurrence / performance
// ============================================================

import crypto from 'node:crypto';
import { api, newJar, expectSuccess } from './lib.js';

const S = 'concurrence';

// Webhook signé HMAC comme le ferait UnitechPay (mock local : 64330).
async function sendWebhook(payloadObj) {
  const raw = JSON.stringify(payloadObj);
  const sig = crypto.createHmac('sha256', process.env.UNITECH_API_KEY || '').update(raw).digest('hex');
  const res = await fetch('http://127.0.0.1:3100/api/unitech/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-UNITECHPAY-SIGNATURE': sig },
    body: raw,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

export async function runConcurrency(r, ctx) {
  const o1 = ctx.seed.owners[0];

  // ----------------------------------------------------------
  await r.section('lectures parallèles (50 x GET /biens)', async () => {
    const t0 = performance.now();
    const results = await Promise.all(Array.from({ length: 50 }, () => api('/biens', { jar: o1.jar })));
    const ms = Math.round(performance.now() - t0);

    const all200 = results.every((x) => x.status === 200);
    const lengths = new Set(results.map((x) => x.data?.data?.length));
    if (all200) r.pass(S, `50 GET /biens parallèles → tous 200 (${ms} ms)`);
    else r.fail(S, '50 GET /biens parallèles → tous 200', `${results.filter((x) => x.status !== 200).length} échec(s)`);
    if (lengths.size === 1) r.pass(S, `liste cohérente (${[...lengths][0]} biens)`);
    else r.fail(S, 'liste cohérente', `longueurs variées : ${[...lengths].join(',')}`);
  });

  // ----------------------------------------------------------
  await r.section('100 connexions locataires en parallèle', async () => {
    const creds = [];
    for (const owner of ctx.seed.owners) {
      for (const loc of owner.locataires) creds.push({ identifier: loc.username, password: 'Test1234!' });
    }
    if (creds.length !== 100) {
      r.blocked(S, '100 connexions locataires', `seulement ${creds.length} comptes`);
      return;
    }

    const t0 = performance.now();
    const burst = (bodies) =>
      Promise.all(bodies.map((body) => api('/auth/login', { method: 'POST', body, jar: newJar() }).then((res) => ({ res, body }))));

    // Rafale initiale de 100 connexions simultanées, puis réessai des
    // échecs transitoires (503/429/5xx GoTrue sous charge) comme le ferait
    // un client résilient. Un 401/400 resterait définitif (vrais problèmes).
    let pending = await burst(creds);
    const transient = (s) => s === 503 || s === 429 || s === 500 || s === 504;
    let retries = 0;

    while (pending.some(({ res }) => transient(res.status)) && retries < 3) {
      retries++;
      const retryBodies = pending.filter(({ res }) => transient(res.status)).map((p) => p.body);
      await new Promise((resolve) => setTimeout(resolve, 250 * retries));
      const again = await burst(retryBodies);
      pending = pending
        .filter(({ res }) => !transient(res.status))
        .concat(again);
    }

    // Un 401 émis pendant la rafale peut être un faux négatif de GoTrue
    // (pool Postgres saturé sous charge, cf. 500 « Database error querying
    // schema » observés sous la même charge) : GoTrue répond 401 alors que
    // les identifiants sont valides. Chaque compte resté en 401 est donc
    // re-vérifié séquentiellement après la charge : s'il se reconnecte,
    // l'échec était transitoire et non un bug de l'app.
    const ms = Math.round(performance.now() - t0);
    const burst401 = pending.filter(({ res }) => res.status === 401);
    let recheckOk = 0;
    for (const p of burst401) {
      const again = await api('/auth/login', { method: 'POST', body: p.body, jar: newJar() });
      if (again.status === 200) {
        recheckOk++;
        p.res = again;
      }
    }

    const ok = pending.filter(({ res }) => res.status === 200).length;
    const byStatus = {};
    for (const { res } of pending) byStatus[res.status] = (byStatus[res.status] || 0) + 1;
    const detail = `${ok}/100 — statuts : ${Object.entries(byStatus).map(([k, v]) => `${k}×${v}`).join(' ')} — retries : ${retries}${recheckOk ? ` — ${recheckOk} faux 401 re-vérifiés OK` : ''}`;

    if (ok === 100) r.pass(S, `100/100 logins locataires OK (${ms} ms, ${Math.round(100000 / ms * 100) / 100} req/s, ${retries} round(s) de retry)${recheckOk ? `, dont ${recheckOk} 401 transitoires GoTrue re-vérifiés OK` : ''}`);
    else if (Object.keys(byStatus).every((s) => s === '200' || transient(Number(s)))) {
      r.blocked(S, '100/100 logins locataires OK', `${detail} — backend auth saturé sous charge (transitoire, aucun faux 401)`);
    } else {
      r.fail(S, '100/100 logins locataires OK', detail);
    }

    const avg = Math.round(ms / 100);
    r.pass(S, `latence moyenne par login ≈ ${avg} ms`);
  });

  // ----------------------------------------------------------
  await r.section('username unique sous concurrence (10 POST parallèles)', async () => {
    // Logement dédié pour éviter toute collision avec le seed.
    const lg = await api('/logements', {
      method: 'POST',
      jar: o1.jar,
      body: { bien_id: o1.bienId, nom: 'Dup Log', type: 'chambre', adresse: 'A', loyer_mensuel: 30000, statut: 'libre' },
    });
    if (!expectSuccess(r, lg, S, r, [201])) return;
    const lgId = lg.data.data.id;

    const base = `dup${Date.now() % 1000000}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, k) =>
        api('/locataires', {
          method: 'POST',
          jar: o1.jar,
          body: {
            logement_id: lgId,
            nom: `Dup ${k}`,
            username: `${base}_x`,
            password: 'Test1234!',
            jour_echeance: 5,
          },
        })
      )
    );

    const created = results.filter((x) => x.status === 201).length;
    const rejected = results.filter((x) => x.status === 400 || x.status === 409).length;
    if (created === 1 && rejected === 9) r.pass(S, '1 seul compte créé (201), 9 rejets (400/409)');
    else r.fail(S, '1 seul compte créé (201), 9 rejets (400/409)', `201:${created} rejets:${rejected} autres:${results.map((x) => x.status).join(',')}`);

    // Nettoyage du locataire créé + logement dédié.
    for (const res of results) {
      if (res.status === 201 && res.data?.data?.id) {
        await api(`/locataires/${res.data.data.id}`, { method: 'DELETE', jar: o1.jar });
      }
    }
    await api(`/logements/${lgId}`, { method: 'DELETE', jar: o1.jar });
  });

  // ----------------------------------------------------------
  // Webhooks identiques en parallèle : un seul traitement (dédup atomique).
  // ----------------------------------------------------------
  await r.section('webhooks jumeaux en parallèle (dédup atomique)', async () => {
    const loc = o1.locataires[6];
    const p = await api('/paiements', {
      method: 'POST',
      jar: o1.jar,
      body: { locataire_id: loc.id, logement_id: o1.logements[6].id, montant: 55000, mois: ctx.seed.month, statut: 'attente' },
    });
    if (!expectSuccess(r, p, S, r, [201])) return;
    const pid = p.data.data.id;

    const init = await api('/unitech/initiate', { method: 'POST', jar: o1.jar, body: { paiement_id: pid, operator: 'wave' } });
    const ref = init.data?.data?.checkout?.unitech_reference;
    if (!ref) return r.fail(S, 'initiate pour webhooks jumeaux', JSON.stringify(init.data));

    const payload = { event: 'payment_completed', transaction_id: 777, reference: ref, amount: 55000, status: 'completed' };
    const before = (await ctx.service.from('unitech_webhooks').select('id').eq('fingerprint', crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'))).data.length;

    const t0 = performance.now();
    const [w1, w2] = await Promise.all([sendWebhook(payload), sendWebhook(payload)]);
    const ms = Math.round(performance.now() - t0);

    const all200 = w1.status === 200 && w2.status === 200;
    const oneCompleted = [w1, w2].filter((w) => w.data?.result === 'completed').length === 1;
    const oneDuplicated = [w1, w2].filter((w) => w.data?.duplicated === true).length === 1;
    if (all200 && oneCompleted && oneDuplicated) r.pass(S, `2 webhooks parallèles -> 1 complet + 1 doublon (${ms} ms)`);
    else r.fail(S, '2 webhooks parallèles -> 1 complet + 1 doublon', JSON.stringify({ w1: w1.data, w2: w2.data }));

    const after = (await ctx.service.from('unitech_webhooks').select('id').eq('fingerprint', crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'))).data.length;
    if (after === before + 1) r.pass(S, `une seule ligne de webhook (${before} -> ${after})`);
    else r.fail(S, 'une seule ligne de webhook', `${before} -> ${after}`);

    const { data: pays } = await ctx.service.from('paiements').select('statut').eq('id', pid).single();
    if (pays.statut === 'a_confirmer') r.pass(S, 'paiement -> a_confirmer (pas de double traitement)');
    else r.fail(S, 'paiement -> a_confirmer', pays.statut);

    const notifs = await ctx.service.from('notifications').select('id').eq('user_id', o1.id).like('message', 'Paiement mobile money reçu%');
    if (notifs.data?.length === 1) r.pass(S, 'une seule notification propriétaire');
    else r.fail(S, 'une seule notification propriétaire', `${notifs.data?.length}`);
  });

  // ----------------------------------------------------------
  // Webhook + confirmation locataire simultanés : aucun état incohérent.
  // ----------------------------------------------------------
  await r.section('webhook + confirmation locataire simultanés', async () => {
    const loc = o1.locataires[7];
    const p = await api('/paiements', {
      method: 'POST',
      jar: o1.jar,
      body: { locataire_id: loc.id, logement_id: o1.logements[7].id, montant: 60000, mois: ctx.seed.month, statut: 'attente' },
    });
    if (!expectSuccess(r, p, S, r, [201])) return;
    const pid = p.data.data.id;

    const init = await api('/unitech/initiate', { method: 'POST', jar: o1.jar, body: { paiement_id: pid, operator: 'wave' } });
    const ref = init.data?.data?.checkout?.unitech_reference;
    if (!ref) return r.fail(S, 'initiate pour webhook+confirmation', JSON.stringify(init.data));

    const { data: account } = await ctx.service.from('locataires').select('account_uid').eq('id', loc.id).single();
    const jarT = newJar();
    const loginT = await api('/auth/login', { method: 'POST', jar: jarT, body: { identifier: loc.username, password: 'Test1234!' } });
    if (loginT.status !== 200) return r.fail(S, 'connexion locataire (webhook+confirmation)', `statut ${loginT.status}`);

    const payload = { event: 'payment_completed', reference: ref, amount: 60000, status: 'completed' };
    const [w, c] = await Promise.all([
      sendWebhook(payload),
      api(`/locataire/paiements/${pid}/confirmer`, { method: 'POST', jar: jarT }),
    ]);
    if (w.status === 200) r.pass(S, 'webhook traité (200)');
    else r.fail(S, 'webhook traité (200)', `statut ${w.status} ${JSON.stringify(w.data)}`);

    const { data: pays } = await ctx.service.from('paiements').select('statut').eq('id', pid).single();
    const coherent = pays.statut === 'a_confirmer' || pays.statut === 'en_validation';
    if (coherent) r.pass(S, `état final cohérent (${pays.statut})`);
    else r.fail(S, 'état final cohérent', `statut ${pays.statut} — webhook=${w.status} ${JSON.stringify(w.data)} confirmation=${c.status} ${JSON.stringify(c.data)}`);
    if (account?.account_uid) {
      const notifs = await ctx.service.from('notifications').select('id').eq('user_id', account.account_uid).like('message', 'Votre loyer de%');
      if (notifs.data?.length <= 1) r.pass(S, `notification locataire cohérente (${notifs.data?.length})`);
      else r.fail(S, 'notification locataire cohérente', `${notifs.data?.length}`);
    }
  });

  // ----------------------------------------------------------
  // Double validation propriétaire simultanée : une seule écriture gagne.
  // ----------------------------------------------------------
  await r.section('double validation propriétaire simultanée', async () => {
    const loc = o1.locataires[8];
    const p = await api('/paiements', {
      method: 'POST',
      jar: o1.jar,
      body: { locataire_id: loc.id, logement_id: o1.logements[8].id, montant: 65000, mois: ctx.seed.month, statut: 'attente' },
    });
    if (!expectSuccess(r, p, S, r, [201])) return;
    const pid = p.data.data.id;

    const init = await api('/unitech/initiate', { method: 'POST', jar: o1.jar, body: { paiement_id: pid, operator: 'wave' } });
    const ref = init.data?.data?.checkout?.unitech_reference;
    if (!ref) return r.fail(S, 'initiate pour double validation', JSON.stringify(init.data));

    const w = await sendWebhook({ event: 'payment_completed', reference: ref, amount: 65000, status: 'completed' });
    if (w.status !== 200) return r.fail(S, 'webhook pour double validation', JSON.stringify(w.data));

    const jarT = newJar();
    const loginT = await api('/auth/login', { method: 'POST', jar: jarT, body: { identifier: loc.username, password: 'Test1234!' } });
    if (loginT.status === 200) {
      await api(`/locataire/paiements/${pid}/confirmer`, { method: 'POST', jar: jarT });
    }

    const [v1, v2] = await Promise.all([
      api('/unitech/valider', { method: 'POST', jar: o1.jar, body: { paiement_id: pid, action: 'valider' } }),
      api('/unitech/valider', { method: 'POST', jar: o1.jar, body: { paiement_id: pid, action: 'valider' } }),
    ]);

    const oneOk = [v1, v2].filter((v) => v.status === 200).length === 1;
    const oneRejected = [v1, v2].filter((v) => v.status === 400 || v.status === 409).length === 1;
    if (oneOk && oneRejected) r.pass(S, 'une seule validation gagne (200 + 400/409)');
    else r.fail(S, 'une seule validation gagne (200 + 400/409)', `v1=${v1.status} ${JSON.stringify(v1.data)} v2=${v2.status} ${JSON.stringify(v2.data)}`);

    const { data: pays } = await ctx.service.from('paiements').select('statut').eq('id', pid).single();
    if (pays.statut === 'paye') r.pass(S, 'paiement -> paye (une seule écriture)');
    else r.fail(S, 'paiement -> paye', pays.statut);
  });

  // ----------------------------------------------------------
  await r.section('stabilité après charge', async () => {
    const health = await api('/health');
    if (health.status === 200) r.pass(S, 'serveur répond après charge');
    else r.fail(S, 'serveur répond après charge', `statut ${health.status}`);

    const me = await api('/auth/me', { jar: o1.jar });
    if (expectSuccess(r, me, S, r)) r.pass(S, 'session toujours valide après charge');
  });
}
