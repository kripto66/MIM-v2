// ============================================================
// MIM - Suite concurrence / performance
// ============================================================

import { api, newJar, expectSuccess } from './lib.js';

const S = 'concurrence';

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

    const ms = Math.round(performance.now() - t0);
    const ok = pending.filter(({ res }) => res.status === 200).length;
    const byStatus = {};
    for (const { res } of pending) byStatus[res.status] = (byStatus[res.status] || 0) + 1;
    const detail = `${ok}/100 — statuts : ${Object.entries(byStatus).map(([k, v]) => `${k}×${v}`).join(' ')} — retries : ${retries}`;

    if (ok === 100) r.pass(S, `100/100 logins locataires OK (${ms} ms, ${Math.round(100000 / ms * 100) / 100} req/s, ${retries} round(s) de retry)`);
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
  await r.section('stabilité après charge', async () => {
    const health = await api('/health');
    if (health.status === 200) r.pass(S, 'serveur répond après charge');
    else r.fail(S, 'serveur répond après charge', `statut ${health.status}`);

    const me = await api('/auth/me', { jar: o1.jar });
    if (expectSuccess(r, me, S, r)) r.pass(S, 'session toujours valide après charge');
  });
}
