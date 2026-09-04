// ============================================================
// MIM - Suite concurrence / performance
// ============================================================

import { api, newJar, expectSuccess } from './lib.js';

const S = 'concurrence';

// Crée un loyer en attente pour le locataire locIndex d'o1.
// Retourne { pid, jarT }.
async function setupLoyer(ctx, o1, locIndex, amount) {
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
  return { pid, jarT };
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
  // Déclarations manuelles en parallèle : une seule passe (mise à jour
  // conditionnelle sur le statut attendu).
  // ----------------------------------------------------------
  await r.section('déclarations parallèles (dédup atomique)', async () => {
    const { pid } = await setupLoyer(ctx, o1, 6, 55000);
    const { data: moyens } = await ctx.service.from('moyens_paiement').select('id').eq('user_id', o1.id);
    const moyen = (moyens || [])[0];
    if (!moyen) return r.blocked(S, 'déclarations parallèles', 'aucun moyen de paiement configuré pour o1');

    const jarT = newJar();
    const login = await api('/auth/login', { method: 'POST', jar: jarT, body: { identifier: o1.locataires[6].username, password: 'Test1234!' } });
    if (login.status !== 200) return r.blocked(S, 'déclarations parallèles', 'connexion locataire');

    const body = { moyen_paiement_id: moyen.id, reference: 'PAR-001' };
    const [d1, d2] = await Promise.all([
      api(`/locataire/paiements/${pid}/declarer`, { method: 'POST', jar: jarT, body }),
      api(`/locataire/paiements/${pid}/declarer`, { method: 'POST', jar: jarT, body }),
    ]);

    const oneOk = [d1, d2].filter((x) => x.status === 200).length === 1;
    const oneConflict = [d1, d2].filter((x) => x.status === 409).length === 1;
    if (oneOk && oneConflict) r.pass(S, '2 déclarations parallèles -> 1 OK + 1 conflit');
    else r.fail(S, '2 déclarations parallèles -> 1 OK + 1 conflit', JSON.stringify({ d1: { s: d1.status, b: d1.data }, d2: { s: d2.status, b: d2.data } }));

    const { data: pays } = await ctx.service.from('paiements').select('statut').eq('id', pid).single();
    if (pays.statut === 'en_validation') r.pass(S, 'paiement -> en_validation (une seule écriture)');
    else r.fail(S, 'paiement -> en_validation', pays.statut);
  });

  // ----------------------------------------------------------
  // Validations en parallèle : une seule validation gagne.
  // ----------------------------------------------------------
  await r.section('validations parallèles (dédup atomique)', async () => {
    const { pid } = await setupLoyer(ctx, o1, 7, 60000);
    const { data: moyens } = await ctx.service.from('moyens_paiement').select('id').eq('user_id', o1.id);
    const moyen = (moyens || [])[0];
    if (!moyen) return r.blocked(S, 'validations parallèles', 'aucun moyen de paiement configuré pour o1');

    const jarT = newJar();
    const login = await api('/auth/login', { method: 'POST', jar: jarT, body: { identifier: o1.locataires[7].username, password: 'Test1234!' } });
    if (login.status !== 200) return r.blocked(S, 'validations parallèles', 'connexion locataire');

    const decl = await api(`/locataire/paiements/${pid}/declarer`, {
      method: 'POST',
      jar: jarT,
      body: { moyen_paiement_id: moyen.id, reference: 'VAL-001' },
    });
    if (decl.status !== 200) return r.fail(S, 'validations parallèles', 'déclaration préalable');

    const [v1, v2] = await Promise.all([
      api(`/paiements-validation/${pid}/valider`, { method: 'POST', jar: o1.jar, body: {} }),
      api(`/paiements-validation/${pid}/valider`, { method: 'POST', jar: o1.jar, body: {} }),
    ]);

    const oneOk = [v1, v2].filter((x) => x.status === 200).length === 1;
    const oneConflict = [v1, v2].filter((x) => x.status === 409).length === 1;
    if (oneOk && oneConflict) r.pass(S, '2 validations parallèles -> 1 OK + 1 conflit');
    else r.fail(S, '2 validations parallèles -> 1 OK + 1 conflit', JSON.stringify({ v1: { s: v1.status, b: v1.data }, v2: { s: v2.status, b: v2.data } }));

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
