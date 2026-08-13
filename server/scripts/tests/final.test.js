// ============================================================
// MIM - Suite finale : balayage complet (10 propriétaires x 10
// locataires) + audit d'intégrité référentielle en base.
// ============================================================

import { api, newJar } from './lib.js';

const S = 'final';

export async function runFinal(r, ctx) {
  const { service, seed } = ctx;
  const PW = 'Test1234!';

  // ----------------------------------------------------------
  await r.section('balayage 10 propriétaires', async () => {
    let ok = 0;
    const problems = [];

    for (const owner of seed.owners) {
      const jar = newJar();
      const login = await api('/auth/login', { method: 'POST', jar, body: { email: owner.email, password: PW } });
      if (login.status !== 200) {
        problems.push(`o${owner.i} : login ${login.status}`);
        continue;
      }

      const [biens, logements, locataires, paiements, stats] = await Promise.all([
        api('/biens', { jar }),
        api('/logements', { jar }),
        api('/locataires', { jar }),
        api('/paiements', { jar }),
        api('/stats/dashboard', { jar }),
      ]);

      const b = biens.data?.data?.length || 0;
      const l = logements.data?.data?.length || 0;
      const t = locataires.data?.data?.length || 0;
      const p = paiements.data?.data?.length || 0;

      if (b !== 1) problems.push(`o${owner.i} : ${b} biens`);
      if (l !== 10) problems.push(`o${owner.i} : ${l} logements`);
      if (t !== 10) problems.push(`o${owner.i} : ${t} locataires`);
      if (p < 10) problems.push(`o${owner.i} : ${p} paiements`);
      if (stats.data?.stats?.totalTenants !== 10) problems.push(`o${owner.i} : stats.totalTenants=${stats.data?.stats?.totalTenants}`);

      if (!problems.some((x) => x.startsWith(`o${owner.i}`))) ok++;
    }

    if (ok === seed.owners.length) r.pass(S, `${ok}/${seed.owners.length} propriétaires cohérents (1 bien / 10 logements / 10 locataires / ≥10 paiements)`);
    else r.fail(S, 'tous les propriétaires cohérents', problems.join(' ; '));
  });

  // ----------------------------------------------------------
  await r.section('balayage 100 locataires', async () => {
    const creds = [];
    for (const owner of seed.owners) {
      for (const loc of owner.locataires) creds.push({ owner: owner.i, loc, username: loc.username });
    }

    let ok = 0;
    const problems = [];
    for (const { owner, loc, username } of creds) {
      const jar = newJar();
      const login = await api('/auth/login', { method: 'POST', jar, body: { identifier: username, password: PW } });
      if (login.status !== 200) {
        problems.push(`${username} : login ${login.status}`);
        continue;
      }
      const dash = await api('/locataire/dashboard', { jar });
      if (dash.status !== 200 || dash.data?.linked !== true) {
        problems.push(`${username} : linked=${dash.data?.linked} status=${dash.status}`);
        continue;
      }
      if (!dash.data?.logement) {
        problems.push(`${username} : pas de logement`);
        continue;
      }
      if (!Array.isArray(dash.data?.paiements) || dash.data.paiements.length === 0) {
        problems.push(`${username} : pas de paiements`);
        continue;
      }
      ok++;
    }

    if (ok === creds.length) r.pass(S, `${ok}/100 locataires connectés + dashboard lié`);
    else r.fail(S, '100/100 locataires fonctionnels', problems.slice(0, 8).join(' ; '));
  });

  // ----------------------------------------------------------
  await r.section('audit d’intégrité référentielle (toute la base)', async () => {
    const issues = [];

    const load = async (table) => (await service.from(table).select('*')).data || [];

    const [biens, logements, locataires, paiements, incidents, prestataires, interventions] = await Promise.all([
      load('biens'),
      load('logements'),
      load('locataires'),
      load('paiements'),
      load('incidents'),
      load('prestataires'),
      load('interventions'),
    ]);

    const byId = (arr) => new Map(arr.map((x) => [String(x.id), x]));
    const lgMap = byId(logements);
    const locMap = byId(locataires);
    const bienMap = byId(biens);
    const incMap = byId(incidents);
    const prestMap = byId(prestataires);

    for (const lg of logements) {
      if (lg.bien_id && bienMap.get(String(lg.bien_id))?.user_id !== lg.user_id) {
        issues.push(`logement ${lg.id} → bien étranger`);
      }
    }

    for (const loc of locataires) {
      if (loc.logement_id) {
        const lg = lgMap.get(String(loc.logement_id));
        if (!lg) issues.push(`locataire ${loc.id} → logement introuvable`);
        else if (lg.user_id !== loc.user_id) issues.push(`locataire ${loc.id} → logement d’un autre propriétaire`);
      }
    }

    for (const p of paiements) {
      const lg = p.logement_id ? lgMap.get(String(p.logement_id)) : null;
      const loc = locMap.get(String(p.locataire_id));
      if (p.logement_id && (!lg || lg.user_id !== p.user_id)) issues.push(`paiement ${p.id} → logement étranger`);
      if (!loc) issues.push(`paiement ${p.id} → locataire introuvable`);
      else if (loc.user_id !== p.user_id) issues.push(`paiement ${p.id} → locataire d’un autre propriétaire`);
    }

    for (const i of incidents) {
      const lg = i.logement_id ? lgMap.get(String(i.logement_id)) : null;
      if (i.logement_id && (!lg || lg.user_id !== i.user_id)) issues.push(`incident ${i.id} → logement étranger`);
    }

    for (const iv of interventions) {
      const inc = incMap.get(String(iv.incident_id));
      const prest = prestMap.get(String(iv.prestataire_id));
      const lg = iv.logement_id ? lgMap.get(String(iv.logement_id)) : null;
      if (iv.incident_id && (!inc || inc.user_id !== iv.user_id)) issues.push(`intervention ${iv.id} → incident étranger`);
      if (iv.prestataire_id && (!prest || prest.user_id !== iv.user_id)) issues.push(`intervention ${iv.id} → prestataire étranger`);
      if (iv.logement_id && (!lg || lg.user_id !== iv.user_id)) issues.push(`intervention ${iv.id} → logement étranger`);
    }

    if (issues.length === 0) r.pass(S, `aucune référence croisée (${biens.length} biens, ${logements.length} logements, ${locataires.length} locataires, ${paiements.length} paiements)`);
    else r.fail(S, 'aucune référence croisée', issues.slice(0, 10).join(' ; '));
  });

  // ----------------------------------------------------------
  await r.section('invariant occupation : 0 ou 1 locataire actif par logement', async () => {
    const { data: locataires } = await service.from('locataires').select('id, logement_id, statut');
    const { data: logements } = await service.from('logements').select('id, statut');

    const activeByLogement = {};
    for (const loc of locataires || []) {
      if (loc.statut === 'actif' && loc.logement_id) {
        activeByLogement[loc.logement_id] = (activeByLogement[loc.logement_id] || 0) + 1;
      }
    }

    const doubles = Object.entries(activeByLogement).filter(([, n]) => n > 1);
    if (doubles.length === 0) r.pass(S, 'aucun logement avec 2+ locataires actifs');
    else r.fail(S, 'aucun logement avec 2+ locataires actifs', `${doubles.length} logement(s) : ${doubles.map(([id, n]) => `#${id}(${n})`).join(' ')}`);

    const occupeWithoutTenant = (logements || []).filter((l) => l.statut === 'occupe' && !activeByLogement[l.id]);
    if (occupeWithoutTenant.length === 0) r.pass(S, 'aucun logement occupe sans locataire actif');
    else r.fail(S, 'aucun logement occupe sans locataire actif', `${occupeWithoutTenant.length} logement(s) #${occupeWithoutTenant.map((l) => l.id).join(',')}`);
  });
}
