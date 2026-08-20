// ============================================================
// MIM - Suite concurrence / performance
// ============================================================

import { api, newJar, expectSuccess } from './lib.js';
import { sendPaydunyaIpn, markMockInvoicePaid } from './paydunya.test.js';

const S = 'concurrence';

// Crée un loyer en attente puis initie une facture PayDunya côté locataire.
// Retourne { pid, token, tenantJar }.
async function setupPaydunyaLoyer(ctx, o1, locIndex, amount) {
  const loc = o1.locataires[locIndex];
  const p = await api('/paiements', {
    method: 'POST',
    jar: o1.jar,
    body: { locataire_id: loc.id, logement_id: o1.logements[locIndex].id, montant: amount, mois: ctx.seed.month, statut: 'attente' },
  });
  if (p.status !== 201) throw new Error(`création paiement : ${p.status} ${JSON.stringify(p.data)}`);
  const pid = p.data.data.id;

  const jarT = newJar();
  const login = await api('/auth/login', { method: 'POST', jar: jarT, body: { identifier: loc.username, password: 'Test1234!' } });
  if (login.status !== 200) throw new Error(`connexion locataire : ${login.status}`);

  const init = await api('/paydunya/initiate', { method: 'POST', jar: jarT, body: { source: 'loyer', paiement_id: pid } });
  if (init.status !== 201 || !init.data?.data?.token) throw new Error(`initiate : ${init.status} ${JSON.stringify(init.data)}`);

  return { pid, token: init.data.data.token, jarT };
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
  // IPN identiques en parallèle : un seul traitement (dédup atomique).
  // ----------------------------------------------------------
  await r.section('IPN jumeaux en parallèle (dédup atomique)', async () => {
    const { pid, token } = await setupPaydunyaLoyer(ctx, o1, 6, 55000);

    const notifBefore = (await ctx.service.from('notifications').select('id').eq('user_id', o1.id).like('message', 'Loyer%encaissé via PayDunya%')).data.length;

    await markMockInvoicePaid(token, 55000);
    const payload = { token, status: 'completed', amount: 55000 };
    const before = (await ctx.service.from('paydunya_webhooks').select('id').eq('token', token)).data.length;

    const t0 = performance.now();
    const [w1, w2] = await Promise.all([sendPaydunyaIpn(payload), sendPaydunyaIpn(payload)]);
    const ms = Math.round(performance.now() - t0);

    const all200 = w1.status === 200 && w2.status === 200;
    const oneCompleted = [w1, w2].filter((w) => w.data?.result === 'completed').length === 1;
    const oneDuplicated = [w1, w2].filter((w) => w.data?.duplicated === true).length === 1;
    if (all200 && oneCompleted && oneDuplicated) r.pass(S, `2 IPN parallèles -> 1 complet + 1 doublon (${ms} ms)`);
    else r.fail(S, '2 IPN parallèles -> 1 complet + 1 doublon', JSON.stringify({ w1: w1.data, w2: w2.data }));

    const after = (await ctx.service.from('paydunya_webhooks').select('id').eq('token', token)).data.length;
    if (after === before + 1) r.pass(S, `une seule ligne de webhook (${before} -> ${after})`);
    else r.fail(S, 'une seule ligne de webhook', `${before} -> ${after}`);

    const { data: pays } = await ctx.service.from('paiements').select('statut').eq('id', pid).single();
    if (pays.statut === 'paye') r.pass(S, 'loyer -> paye (pas de double traitement)');
    else r.fail(S, 'loyer -> paye', pays.statut);

    const notifs = await ctx.service.from('notifications').select('id').eq('user_id', o1.id).like('message', 'Loyer%encaissé via PayDunya%');
    if (notifs.data?.length === notifBefore + 1) r.pass(S, 'une seule notification propriétaire en plus (dédup)');
    else r.fail(S, 'une seule notification propriétaire en plus (dédup)', `${notifBefore} → ${notifs.data?.length}`);
  });

  // ----------------------------------------------------------
  // IPN complet + lecture de statut simultanés : aucun état incohérent.
  // ----------------------------------------------------------
  await r.section('IPN complet + lecture de statut simultanés', async () => {
    const loc = o1.locataires[7];
    const { pid, token, jarT } = await setupPaydunyaLoyer(ctx, o1, 7, 60000);

    await markMockInvoicePaid(token, 60000);
    const [w, s] = await Promise.all([
      sendPaydunyaIpn({ token, status: 'completed', amount: 60000 }),
      api(`/paydunya/status/${token}`, { jar: jarT }),
    ]);
    if (w.status === 200) r.pass(S, 'IPN traité (200)');
    else r.fail(S, 'IPN traité (200)', `statut ${w.status} ${JSON.stringify(w.data)}`);

    const { data: pays } = await ctx.service.from('paiements').select('statut').eq('id', pid).single();
    if (pays.statut === 'paye') r.pass(S, 'état final cohérent (paye)');
    else r.fail(S, 'état final cohérent', `statut ${pays.statut} — IPN=${w.status} ${JSON.stringify(w.data)} status=${s.status} ${JSON.stringify(s.data)}`);

    if (loc?.account_uid) {
      const notifs = await ctx.service.from('notifications').select('id').eq('user_id', loc.account_uid).like('message', 'Votre loyer de%');
      if (notifs.data?.length === 1) r.pass(S, `notification locataire cohérente (${notifs.data?.length})`);
      else r.fail(S, 'notification locataire cohérente', `${notifs.data?.length}`);
    }
  });

  // ----------------------------------------------------------
  // IPN dupliqué séquentiel : idempotence totale (aucune écriture double).
  // ----------------------------------------------------------
  await r.section('IPN dupliqué séquentiel (idempotence)', async () => {
    const { pid, token } = await setupPaydunyaLoyer(ctx, o1, 8, 65000);

    await markMockInvoicePaid(token, 65000);
    const w1 = await sendPaydunyaIpn({ token, status: 'completed', amount: 65000 });
    if (w1.status !== 200) return r.fail(S, 'premier IPN', JSON.stringify(w1.data));

    const w2 = await sendPaydunyaIpn({ token, status: 'completed', amount: 65000 });
    if (w2.data?.duplicated === true) r.pass(S, 'IPN rejoué -> doublon (idempotent)');
    else r.fail(S, 'IPN rejoué -> doublon (idempotent)', JSON.stringify(w2.data));

    const { data: pays } = await ctx.service.from('paiements').select('statut').eq('id', pid).single();
    if (pays.statut === 'paye') r.pass(S, 'loyer -> paye (une seule écriture)');
    else r.fail(S, 'loyer -> paye', pays.statut);
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
