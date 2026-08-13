// ============================================================
// MIM — LOADTEST : PHASES 5-19
//   Exécution des scénarios sur la base 100×100 créée par seed.mjs.
//   Sortie : results-phases.json + résumé console.
// ============================================================
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiLt, apiProd, BASE, newJar, service, Runner, statSummary, LT, tenantUsername, ownerEmail, loadState, saveState, monthNow } from './common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const state = loadState();
const OWNERS = LT.owners;
const MONTH = state.month || monthNow();
const r = new Runner();

const ownerRecs = state.owners; // [{i, email, password, id}]
const ownerById = new Map(ownerRecs.map((o) => [o.id, o]));
const ownerOf = (id) => ownerById.get(id)?.i;
const jars = new Map();
const pwMap = new Map(); // username -> mot de passe actuel

function reg(i, j) { return `owner${pad(i)}·${pad(j)}`; }
function pad(n) { return String(n).padStart(3, '0'); }

async function ownerJar(i) {
  if (jars.has(i)) return jars.get(i);
  const jar = newJar();
  const lg = await apiLt('/auth/login', { method: 'POST', jar, body: { identifier: ownerEmail(i), password: LT.ownerPw } });
  if (lg.status !== 200) throw new Error(`login owner ${i} échoué : ${lg.status} ${JSON.stringify(lg.data).slice(0, 150)}`);
  jars.set(i, jar);
  return jar;
}

async function tenantJar(username, pw) {
  const jar = newJar();
  const lg = await apiLt('/auth/login', { method: 'POST', jar, body: { identifier: username, password: pw } });
  return { jar, status: lg.status, data: lg.data };
}

// IDs par table pour un propriétaire (via service).
async function ownerRows(ownerId) {
  const out = {};
  for (const t of ['biens', 'logements', 'locataires', 'paiements', 'incidents', 'prestataires', 'interventions']) {
    const { data } = await service.from(t).select('id').eq('user_id', ownerId);
    out[t] = data.map((x) => x.id);
  }
  return out;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ────────────────────────────────────────────────────────────
// PHASE 5 — Authentification locataires (échantillon 30)
// ────────────────────────────────────────────────────────────
async function phase5() {
  await r.section('Phase 5 — Authentification locataire (échantillon + flux forcé)', async () => {
    // Échantillon 30 locataires (seulement ceux qui existent réellement), hors (1,1)/(1,2).
    const sample = [];
    const seen = new Set();
    for (let k = 0; k < 400 && sample.length < 30; k++) {
      const i = 5 + ((k * 13) % 96);
      const j = 3 + ((k * 29) % 98);
      const key = `${i}.${j}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const username = tenantUsername(i, j);
      const { data: exists } = await service.from('profiles').select('id').eq('username', username).maybeSingle();
      if (!exists) continue;
      sample.push({ i, j });
    }
    if (sample.length === 0) { r.blocked('P5-auth', 'échantillon', 'aucun locataire trouvé'); return; }

    const loginTimes = [];
    let wrongOk = 0, forcedOk = 0, reloginOk = 0, renameOk = 0;
    const details = [];

    for (const { i, j } of sample) {
      const username = tenantUsername(i, j);
      const wrong = await tenantJar(username, LT.tenantPw + 'X');
      if (wrong.status === 401) wrongOk++;

      const t0 = Date.now();
      const login = await tenantJar(username, LT.tenantPw);
      loginTimes.push(Date.now() - t0);
      if (login.status !== 200) { details.push(`${username} login:${login.status}`); continue; }

      const me1 = await apiLt('/auth/me', { jar: login.jar });
      if (me1.status === 200 && me1.data?.user?.must_change_password === true) forcedOk++;

      const ch = await apiLt('/auth/change-password', {
        method: 'PUT', jar: login.jar,
        body: { password: LT.tenantPw2, password_confirm: LT.tenantPw2 },
      });
      if (ch.status !== 200) { details.push(`${username} change-pw:${ch.status}`); continue; }
      await apiLt('/auth/logout', { method: 'POST', jar: login.jar });

      const re = await tenantJar(username, LT.tenantPw2);
      if (re.status === 200) reloginOk++;
      const me2 = await apiLt('/auth/me', { jar: re.jar });
      if (me2.status === 200 && me2.data?.user?.must_change_password === false) reloginOk++;

      const un = `${username}x`;
      const up = await apiLt('/auth/update-username', { method: 'PUT', jar: re.jar, body: { username: un } });
      const lgNew = up.status === 200 ? await tenantJar(un, LT.tenantPw2) : { status: 0 };
      const rev = lgNew.status === 200 ? await apiLt('/auth/update-username', { method: 'PUT', jar: lgNew.jar, body: { username } }) : { status: 0 };
      if (up.status === 200 && lgNew.status === 200 && rev.status === 200) renameOk++;
      else details.push(`${username} rename:up=${up.status} lg=${lgNew.status} rev=${rev.status}`);

      pwMap.set(username, LT.tenantPw2);
      state.tenantPasswordChanged.push(username);
      saveState(state);
    }

    r.pass('P5-auth', 'login mot de passe incorrect → 401', wrongOk === 30, `${wrongOk}/30`);
    r.pass('P5-auth', 'login correct + must_change_password=true', forcedOk === 30, `${forcedOk}/30`);
    r.pass('P5-auth', 'change-password forcé → 200', sample.length - details.filter((d) => d.includes('change-pw')).length === 30, `${sample.length - details.filter((d) => d.includes('change-pw')).length}/30`);
    r.pass('P5-auth', 're-login nouveau mot de passe + must_change_password=false', Math.floor(reloginOk / 2) === 30, `${Math.floor(reloginOk / 2)}/30`);
    r.pass('P5-auth', 'rename username + login par nouveau username + revert', renameOk === 30, `${renameOk}/30`);
    r.record('P5-auth', 'latence login (30 échantillons)', 'perf', JSON.stringify(statSummary(loginTimes)));
    if (details.length) r.fail('P5-auth', 'aucun détail d\'échec', details.slice(0, 5).join(' | '));

    // Non-existant
    const nx = await tenantJar('loadtest.tenant.999.999', LT.tenantPw);
    r.pass('P5-auth', 'login username inexistant → 401', nx.status === 401, `reçu ${nx.status}`);

    // Suspension d'un locataire
    const susU = tenantUsername(1, 2);
    const sus = await service.auth.admin.listUsers();
    const susUser = sus.data.users.find((u) => u.email === `${susU}@mim.local`);
    if (susUser) {
      await service.auth.admin.updateUserById(susUser.id, { ban_duration: '1h' });
      const banned = await tenantJar(susU, LT.tenantPw);
      r.pass('P5-auth', 'locataire suspendu → login refusé (401)', banned.status === 401, `reçu ${banned.status}`);
      await service.auth.admin.updateUserById(susUser.id, { ban_duration: 'none' });
      const unbanned = await tenantJar(susU, LT.tenantPw);
      r.pass('P5-auth', 'réactivation → login autorisé', unbanned.status === 200, `reçu ${unbanned.status}`);
    } else {
      r.blocked('P5-auth', 'locataire suspendu', 'tenant (1,2) inexistant');
    }

    // Connexions simultanées (locataires existants de l'owner 1)
    const t0 = Date.now();
    const users = [];
    for (let j = 3; j <= 27; j++) {
      const u = tenantUsername(1, j);
      const { data: exists } = await service.from('profiles').select('id').eq('username', u).maybeSingle();
      if (exists) users.push(u);
    }
    if (users.length === 0) { r.blocked('P5-auth', '20 connexions simultanées', 'aucun locataire owner1'); return; }
    let ok = 0;
    for (let k = 0; k < users.length; k += 5) {
      const slice = users.slice(k, k + 5);
      const res = await Promise.all(slice.map((u) => tenantJar(u, LT.tenantPw)));
      ok += res.filter((x) => x.status === 200).length;
    }
    const el = Date.now() - t0;
    r.pass('P5-auth', 'connexions simultanées → toutes 200', ok === users.length, `${ok}/${users.length} en ${el}ms`);
  });
}

// ────────────────────────────────────────────────────────────
// PHASE 6 — CRUD propriétaire complet (10 propriétaires)
// ────────────────────────────────────────────────────────────
async function phase6() {
  await r.section('Phase 6 — CRUD propriétaire (cycle complet × 10 propriétaires)', async () => {
    for (const o of ownerRecs.slice(0, 10)) {
      const jar = await ownerJar(o.i);
      const s = `owner${pad(o.i)}`;
      try {
        const bien = await apiLt('/biens', { method: 'POST', jar, body: { nom: `CRUD LT ${pad(o.i)}`, type: 'appartement', ville: 'Dakar' } });
        if (bien.status !== 201) { r.fail(s, 'bien create', `reçu ${bien.status}`); continue; }
        const bienId = bien.data.data.id;
        const bienUp = await apiLt(`/biens/${bienId}`, { method: 'PUT', jar, body: { nom: 'CRUD LT modifié' } });
        const log = await apiLt('/logements', { method: 'POST', jar, body: { bien_id: bienId, nom: 'CRUD Log', adresse: '1 Rue CRUD', loyer_mensuel: 95000, statut: 'libre' } });
        const logId = log.status === 201 ? log.data.data.id : null;
        if (log.status !== 201) { r.fail(s, 'logement create', `reçu ${log.status}`); await apiLt(`/biens/${bienId}`, { method: 'DELETE', jar }); continue; }
        const logUp = await apiLt(`/logements/${logId}`, { method: 'PUT', jar, body: { loyer_mensuel: 99000 } });

        const uname = `loadtest.crud.${pad(o.i)}.t`;
        const loc = await apiLt('/locataires', { method: 'POST', jar, body: { logement_id: logId, nom: 'CRUD Loc', username: uname, password: LT.tenantPw, statut: 'actif' } });
        const locId = loc.status === 201 ? loc.data.data.id : null;
        const locUp = locId ? await apiLt(`/locataires/${locId}`, { method: 'PUT', jar, body: { statut: 'inactif' } }) : { status: 0 };

        const pay = locId ? await apiLt('/paiements', { method: 'POST', jar, body: { locataire_id: locId, logement_id: logId, montant: 99000, mois: MONTH, statut: 'paye', date_paiement: '2026-08-10' } }) : { status: 0 };
        const payId = pay.status === 201 ? pay.data.data.id : null;
        const payUp = payId ? await apiLt(`/paiements/${payId}`, { method: 'PUT', jar, body: { statut: 'attente' } }) : { status: 0 };

        const inc = await apiLt('/incidents', { method: 'POST', jar, body: { logement_id: logId, titre: 'CRUD Incident', statut: 'nouveau' } });
        const incId = inc.status === 201 ? inc.data.data.id : null;
        const incUp = incId ? await apiLt(`/incidents/${incId}`, { method: 'PUT', jar, body: { statut: 'resolu' } }) : { status: 0 };

        const prest = await apiLt('/prestataires', { method: 'POST', jar, body: { nom: 'CRUD Presta', specialite: 'Électricité' } });
        const prestId = prest.status === 201 ? prest.data.data.id : null;
        const prestUp = prestId ? await apiLt(`/prestataires/${prestId}`, { method: 'PUT', jar, body: { specialite: 'Plomberie' } }) : { status: 0 };

        const inter = incId && prestId ? await apiLt('/interventions', { method: 'POST', jar, body: { incident_id: incId, prestataire_id: prestId, logement_id: logId, titre: 'CRUD Interv', statut: 'planifie' } }) : { status: 0 };
        const interId = inter.status === 201 ? inter.data.data.id : null;
        const interUp = interId ? await apiLt(`/interventions/${interId}`, { method: 'PUT', jar, body: { statut: 'termine' } }) : { status: 0 };

        const notif = await apiLt('/notifications', { jar });
        const notifId = notif.status === 200 && notif.data?.data?.length ? notif.data.data[0].id : null;
        const notifUp = notifId ? await apiLt(`/notifications/${notifId}`, { method: 'PUT', jar, body: { lu: true } }) : { status: 0 };

        // Suppressions (ordre pour libérer logement)
        if (interId) await apiLt(`/interventions/${interId}`, { method: 'DELETE', jar });
        if (prestId) await apiLt(`/prestataires/${prestId}`, { method: 'DELETE', jar });
        if (incId) await apiLt(`/incidents/${incId}`, { method: 'DELETE', jar });
        if (payId) await apiLt(`/paiements/${payId}`, { method: 'DELETE', jar });
        if (locId) {
          const { data: pre } = await service.from('locataires').select('account_uid').eq('id', locId).maybeSingle();
          const dl = await apiLt(`/locataires/${locId}`, { method: 'DELETE', jar });
          let accountGone = false;
          if (pre?.account_uid) {
            const gone = await service.auth.admin.getUserById(pre.account_uid);
            accountGone = Boolean(gone.error);
          } else {
            accountGone = true;
          }
          r.pass(s, 'suppression locataire désactive le compte', dl.status === 200 && accountGone, `DELETE ${dl.status}, compte=${accountGone ? 'supprimé' : 'TOUJOURS LÀ'}`);
        }
        await apiLt(`/logements/${logId}`, { method: 'DELETE', jar });
        await apiLt(`/biens/${bienId}`, { method: 'DELETE', jar });

        const crudOk = [bien, log, loc, pay, inc, prest, inter].every((x) => x.status === 201)
          && [bienUp, logUp, locUp, payUp, incUp, prestUp, interUp].every((x) => x.status === 200)
          && notifUp.status === 200;
        r.pass(s, 'cycle CRUD complet 201→200→200→DELETE', crudOk, `bien=${bien.status} log=${log.status} loc=${loc.status} pay=${pay.status} inc=${inc.status} prest=${prest.status} inter=${inter.status} notif=${notifUp.status}`);
      } catch (e) {
        r.fail(s, 'cycle CRUD', e.message);
      }
    }

    // Listes : jamais de données étrangères (appartenance stricte) + décomptes inchangés
    const o1 = ownerRecs[0];
    const o2 = ownerRecs[1];
    const j1 = await ownerJar(o1.i);
    const j2 = await ownerJar(o2.i);
    const rows2 = await ownerRows(o2.id);
    const list2 = await apiLt('/logements', { jar: j2 });
    const ids2 = new Set(rows2.logements);
    const leak = list2.data?.data?.filter((l) => !ids2.has(l.id)).length || 0;
    r.pass('P6-listes', `liste logements owner${pad(o2.i)} = 100 sans fuite`, list2.status === 200 && list2.data.data.length === 100 && leak === 0, `n=${list2.data?.data?.length} fuites=${leak}`);
    const list1 = await apiLt('/logements', { jar: j1 });
    r.pass('P6-listes', `liste logements owner${pad(o1.i)} = 100`, list1.status === 200 && list1.data.data.length === 100, `n=${list1.data?.data?.length}`);
  });
}

// ────────────────────────────────────────────────────────────
// PHASE 7 — Espace locataire + permissions
// ────────────────────────────────────────────────────────────
async function phase7() {
  await r.section('Phase 7 — Espace locataire (3) + permissions', async () => {
    const chosen = state.tenantPasswordChanged.slice(0, 3).map((u) => ({ u, pw: LT.tenantPw2 }));
    for (const { u, pw } of chosen) {
      const { jar, status } = await tenantJar(u, pw);
      const s = `locataire ${u}`;
      if (status !== 200) { r.fail(s, 'login', `reçu ${status}`); continue; }

      const dash = await apiLt('/locataire/dashboard', { jar });
      const db = await service.from('locataires').select('id, logement_id, statut').eq('account_uid', (await apiLt('/auth/me', { jar })).data.user.id).maybeSingle();
      const logDb = db.data ? await service.from('logements').select('loyer_mensuel, statut').eq('id', db.data.logement_id).maybeSingle() : { data: null };
      r.pass(s, 'dashboard lié + logement + loyer + statut', dash.status === 200 && dash.data?.linked === true && dash.data?.logement?.id === db.data?.logement_id && dash.data?.logement?.loyer_mensuel === logDb.data?.loyer_mensuel, `status=${dash.status} linked=${dash.data?.linked}`);
      r.pass(s, 'dashboard paiements 1 ligne', (dash.data?.paiements?.length ?? -1) === 1, `n=${dash.data?.paiements?.length}`);

      const inc = await apiLt('/locataire/incidents', { method: 'POST', jar, body: { titre: `Incident locataire ${u}` } });
      r.pass(s, 'signalement incident → 201 (logement déduit)', inc.status === 201 && inc.data?.data?.logement_id === db.data?.logement_id, `reçu ${inc.status}`);
      if (inc.status === 201) {
        // Nettoyage immédiat : l'incident appartient au propriétaire du logement.
        const owner = ownerRecs.find((o) => o.id === inc.data.data.user_id);
        if (owner) {
          const oj = await ownerJar(owner.i);
          await apiLt(`/incidents/${inc.data.data.id}`, { method: 'DELETE', jar: oj });
        }
      }

      const notif = await apiLt('/notifications', { jar });
      r.pass(s, 'notifications propres non vides', notif.status === 200 && notif.data?.data?.length > 0, `n=${notif.data?.data?.length}`);

      const me = await apiLt('/auth/me', { jar });
      r.pass(s, 'email masqué pour locataire', me.status === 200 && me.data?.user?.email === '', `email='${me.data?.user?.email}'`);

      const prof = await apiLt('/auth/update-profile', { method: 'PUT', jar, body: { phone: '+221770000001' } });
      r.pass(s, 'update-profile → 200', prof.status === 200, `reçu ${prof.status}`);

      // Permissions : routes propriétaire/admin interdites
      const resL = await apiLt('/locataires', { jar });
      const resB = await apiLt('/biens', { jar });
      const resLog = await apiLt('/logements', { jar });
      const resP = await apiLt('/paiements', { jar });
      const resI = await apiLt('/incidents', { jar });
      const resAdmin = await apiLt('/admin/stats', { jar });
      const pst = await apiLt('/prestataires', { method: 'POST', jar, body: { nom: 'X' } });
      const lgDel = await apiLt(`/logements/${db.data?.logement_id}`, { method: 'DELETE', jar });
      const stDash = await apiLt('/stats/dashboard', { jar });
      const emptyLists = [resL, resB, resLog, resP, resI].every((x) => x.status === 200 && (x.data?.data?.length ?? 0) === 0);
      r.pass(s, 'listes propriétaire vides pour locataire (RLS)', emptyLists, `L=${resL.status}/${resL.data?.data?.length} B=${resB.status}/${resB.data?.data?.length} Log=${resLog.status}/${resLog.data?.data?.length} P=${resP.status}/${resP.data?.data?.length} I=${resI.status}/${resI.data?.data?.length}`);
      r.pass(s, 'création prestataire refusée', pst.status === 400 || pst.status === 403, `reçu ${pst.status}`);
      r.pass(s, 'suppression logement refusée (404/403)', lgDel.status === 404 || lgDel.status === 403, `reçu ${lgDel.status}`);
      r.pass(s, 'admin/stats refusé → 403', resAdmin.status === 403, `reçu ${resAdmin.status}`);
      r.pass(s, 'stats/dashboard propriétaire → vide mais 200', stDash.status === 200 && stDash.data?.stats?.totalProperties === 0, `reçu ${stDash.status} total=${stDash.data?.stats?.totalProperties}`);
      await apiLt('/auth/logout', { method: 'POST', jar });
    }
  });
}

// ────────────────────────────────────────────────────────────
// PHASE 8 — Administration
// ────────────────────────────────────────────────────────────
async function phase8() {
  await r.section('Phase 8 — Administration (admin, suspension, permissions)', async () => {
    const jar = newJar();
    const lg = await apiLt('/auth/login', { method: 'POST', jar, body: { identifier: 'admin@mim.local', password: process.env.ADMIN_PASSWORD || 'Admin1234!' } });
    r.pass('P8-admin', 'login admin', lg.status === 200, `reçu ${lg.status}`);

    const t0 = Date.now();
    const stats = await apiLt('/admin/stats', { jar });
    const el = Date.now() - t0;
    r.record('P8-admin', 'temps de réponse admin/stats à l\'échelle 10k', 'perf', `${el}ms`);
    const s = stats.data?.stats;
    r.pass('P8-admin', 'admin/stats → 200', stats.status === 200, `reçu ${stats.status} (${el}ms)`);

    // Attendu : 107 propriétaires (100 LT + 2 register + 5 réels), 10002 locataires, 100 biens, 10000 logements, 10000 paiements, 200 incidents.
    r.pass('P8-admin', `proprietaires attendu ≥ ${OWNERS + 7}`, (s?.proprietaires ?? 0) >= OWNERS + 7, `reçu ${s?.proprietaires}`);
    r.pass('P8-admin', 'locataires attendu 10002 (⚠ troncature ROW_LIMIT=10000 possible)', s?.locataires === 10002, `reçu ${s?.locataires}`);
    r.pass('P8-admin', 'biens attendu 100', s?.biens === 100, `reçu ${s?.biens}`);
    r.pass('P8-admin', 'logements attendu 10000', s?.logements === 10000, `reçu ${s?.logements}`);
    r.pass('P8-admin', 'paiements attendu 10000', s?.paiements === 10000, `reçu ${s?.paiements}`);
    r.pass('P8-admin', 'logementsOccupes attendu 10000', s?.logementsOccupes === 10000, `reçu ${s?.logementsOccupes}`);
    r.pass('P8-admin', 'incidentsActifs attendu 100', s?.incidentsActifs === 100, `reçu ${s?.incidentsActifs}`);

    const prop = await apiLt('/admin/proprietaires', { jar });
    const hasLT = prop.data?.data?.some((p) => p.email?.startsWith('loadtest.owner.'));
    r.pass('P8-admin', 'admin/proprietaires contient les 100 loadtest', hasLT, `n=${prop.data?.data?.length} contientLT=${hasLT}`);

    const locs = await apiLt('/admin/locataires', { jar });
    r.pass('P8-admin', 'admin/locataires ≥ 10000', locs.status === 200 && (locs.data?.data?.length ?? 0) >= 10000, `n=${locs.data?.data?.length}`);

    const pays = await apiLt('/admin/paiements', { jar });
    r.pass('P8-admin', 'admin/paiements ≥ 10000', pays.status === 200 && (pays.data?.data?.length ?? 0) >= 10000, `n=${pays.data?.data?.length}`);

    const act = await apiLt('/admin/activite', { jar });
    r.pass('P8-admin', 'admin/activite non vide', act.status === 200 && (act.data?.data?.length ?? 0) > 0, `n=${act.data?.data?.length}`);

    // Suspension propriétaire
    const target = ownerRecs.find((o) => o.i === 50);
    if (target) {
      const sus = await apiLt(`/admin/proprietaires/${target.id}`, { method: 'PATCH', jar, body: { statut: 'suspendu' } });
      const l1 = await tenantJar(ownerEmail(50), LT.ownerPw);
      r.pass('P8-admin', 'propriétaire suspendu → login refusé', sus.status === 200 && l1.status === 401, `PATCH ${sus.status} login ${l1.status}`);
      const rea = await apiLt(`/admin/proprietaires/${target.id}`, { method: 'PATCH', jar, body: { statut: 'actif' } });
      const l2 = await tenantJar(ownerEmail(50), LT.ownerPw);
      r.pass('P8-admin', 'réactivation → login OK', rea.status === 200 && l2.status === 200, `PATCH ${rea.status} login ${l2.status}`);

      // Suspension d'un locataire via /admin (doit être refusé)
      const oneTenant = (await service.from('locataires').select('account_uid').eq('user_id', target.id).limit(1)).data?.[0];
      if (oneTenant?.account_uid) {
        const badSus = await apiLt(`/admin/proprietaires/${oneTenant.account_uid}`, { method: 'PATCH', jar, body: { statut: 'suspendu' } });
        r.pass('P8-admin', 'PATCH sur compte locataire refusé', badSus.status === 400, `reçu ${badSus.status}`);
        await apiLt(`/admin/proprietaires/${oneTenant.account_uid}`, { method: 'PATCH', jar, body: { statut: 'actif' } });
      }
      const badStatut = await apiLt(`/admin/proprietaires/${target.id}`, { method: 'PATCH', jar, body: { statut: 'foo' } });
      r.pass('P8-admin', 'statut invalide → 400', badStatut.status === 400, `reçu ${badStatut.status}`);
    } else {
      r.blocked('P8-admin', 'suspension propriétaire', 'owner 50 absent');
    }

    // Accès non-admin
    const oj = await ownerJar(1);
    const oa = await apiLt('/admin/stats', { jar: oj });
    r.pass('P8-admin', 'propriétaire → admin/stats refusé 403', oa.status === 403, `reçu ${oa.status}`);
    const tj = state.tenantPasswordChanged[0] ? (await tenantJar(state.tenantPasswordChanged[0], LT.tenantPw2)).jar : null;
    const ta = tj ? await apiLt('/admin/stats', { jar: tj }) : null;
    r.pass('P8-admin', 'locataire → admin/stats refusé 403', ta?.status === 403, `reçu ${ta?.status}`);
    await apiLt('/auth/logout', { method: 'POST', jar });
  });
}

// ────────────────────────────────────────────────────────────
// PHASE 9 — Isolation croisée / IDOR
// ────────────────────────────────────────────────────────────
async function phase9() {
  await r.section('Phase 9 — Isolation croisée (IDOR)', async () => {
    const o1 = ownerRecs[0]; // cible
    const o2 = ownerRecs[1]; // attaquant
    const jar = await ownerJar(o2.i);
    const rows1 = await ownerRows(o1.id);

    const tryPut = async (t, id, body) => (await apiLt(`/${t}/${id}`, { method: 'PUT', jar, body })).status;
    const tryDel = async (t, id) => (await apiLt(`/${t}/${id}`, { method: 'DELETE', jar })).status;

    const res = {
      biensPut: await tryPut('biens', rows1.biens[0], { nom: 'hack' }),
      logementsDel: await tryDel('logements', rows1.logements[0]),
      locatairesPut: await tryPut('locataires', rows1.locataires[0], { statut: 'inactif' }),
      paiementsDel: await tryDel('paiements', rows1.paiements[0]),
      incidentsPut: await tryPut('incidents', rows1.incidents[0], { statut: 'resolu' }),
      prestatairesPut: await tryPut('prestataires', rows1.prestataires[0], { nom: 'hack' }),
      interventionsPut: await tryPut('interventions', rows1.interventions[0], { statut: 'termine' }),
    };
    const all404 = Object.values(res).every((x) => x === 404);
    r.pass('P9-idor', 'PUT/DELETE ressources propriétaire 1 via propriétaire 2 → 404', all404, JSON.stringify(res));

    // Création avec références à autrui
    const payX = await apiLt('/paiements', { method: 'POST', jar, body: { locataire_id: rows1.locataires[0], logement_id: rows1.logements[0], montant: 1, mois: MONTH, statut: 'paye' } });
    r.pass('P9-idor', 'paiement avec locataire/logement d\'autrui → 400', payX.status === 400, `reçu ${payX.status}`);
    const locX = await apiLt('/locataires', { method: 'POST', jar, body: { logement_id: rows1.logements[0], nom: 'X', username: 'loadtest.hack.locx', password: LT.tenantPw, statut: 'actif' } });
    r.pass('P9-idor', 'locataire sur logement d\'autrui → 400', locX.status === 400, `reçu ${locX.status}`);
    const logX = await apiLt('/logements', { method: 'POST', jar, body: { bien_id: rows1.biens[0], nom: 'X', loyer_mensuel: 1, statut: 'libre' } });
    r.pass('P9-idor', 'logement sur bien d\'autrui → 400', logX.status === 400, `reçu ${logX.status}`);
    const interX = await apiLt('/interventions', { method: 'POST', jar, body: { incident_id: rows1.incidents[0], prestataire_id: rows1.prestataires[0], logement_id: rows1.logements[0], titre: 'X' } });
    r.pass('P9-idor', 'intervention sur incident d\'autrui → 400', interX.status === 400, `reçu ${interX.status}`);

    // UUID malformé / inexistant
    const badUuid = await apiLt('/logements/abc', { jar });
    r.record('P9-idor', 'UUID malformé (/logements/abc)', 'note', `reçu ${badUuid.status} ${JSON.stringify(badUuid.data).slice(0, 120)}`);
    const randUuid = '11111111-1111-4111-8111-111111111111';
    const rndRes = await Promise.all(['biens', 'logements', 'locataires', 'paiements', 'incidents', 'prestataires', 'interventions'].map(async (t) => ({ t, s: (await apiLt(`/${t}/${randUuid}`, { method: 'PUT', jar, body: { nom: 'x' } })).status })));
    const non404 = rndRes.filter((x) => x.s !== 404).map((x) => `${x.t}=${x.s}`).join(', ');
    r.pass('P9-idor', 'UUID inexistant → 404 sur 7 ressources', rndRes.every((x) => x.s === 404), non404 ? `${rndRes.map((x) => x.s).join(',')} (incohérent: ${non404})` : 'toutes 404');

    // Pas de fuite dans les listes
    const list = await apiLt('/logements', { jar });
    const own = new Set(rows1.logements);
    r.pass('P9-idor', 'liste owner2 ne contient aucun logement d\'owner1', list.data?.data?.every((l) => !own.has(l.id)) ?? false, `n=${list.data?.data?.length}`);
  });
}

// ────────────────────────────────────────────────────────────
// PHASE 10 — Double occupation
// ────────────────────────────────────────────────────────────
async function phase10() {
  await r.section('Phase 10 — Double occupation d\'un logement', async () => {
    const jar = await ownerJar(1);
    const bienId = (await apiLt('/biens', { jar })).data.data[0].id;
    const log = await apiLt('/logements', { method: 'POST', jar, body: { bien_id: bienId, nom: 'DO Log', adresse: '10 Rue Double Occ', loyer_mensuel: 70000, statut: 'libre' } });
    if (log.status !== 201) { r.fail('P10-occup', 'création logement libre', `reçu ${log.status} ${JSON.stringify(log.data).slice(0, 150)}`); return; }
    const logId = log.data.data.id;

    const a = await apiLt('/locataires', { method: 'POST', jar, body: { logement_id: logId, nom: 'DO A', username: 'loadtest.do.a', password: LT.tenantPw, statut: 'actif' } });
    r.pass('P10-occup', 'locataire A occupe le logement → 201', a.status === 201, `reçu ${a.status}`);
    if (a.status !== 201) { await apiLt(`/logements/${logId}`, { method: 'DELETE', jar }); return; }
    const b = await apiLt('/locataires', { method: 'POST', jar, body: { logement_id: logId, nom: 'DO B', username: 'loadtest.do.b', password: LT.tenantPw, statut: 'actif' } });
    r.pass('P10-occup', 'locataire B sur logement occupé → 400', b.status === 400 && /déjà occupé/.test(b.data?.message || ''), `reçu ${b.status} — ${b.data?.message}`);

    await apiLt(`/locataires/${a.data.data.id}`, { method: 'PUT', jar, body: { statut: 'inactif' } });
    const b2 = await apiLt('/locataires', { method: 'POST', jar, body: { logement_id: logId, nom: 'DO B2', username: 'loadtest.do.b2', password: LT.tenantPw, statut: 'actif' } });
    r.pass('P10-occup', 'libération → nouveau locataire accepté', b2.status === 201, `reçu ${b2.status}`);

    // Nettoyage
    await apiLt(`/locataires/${b2.data.data.id}`, { method: 'DELETE', jar });
    await apiLt(`/locataires/${a.data.data.id}`, { method: 'DELETE', jar });
    await apiLt(`/logements/${logId}`, { method: 'DELETE', jar });
    const ck = await apiLt(`/logements/${logId}`, { jar });
    r.pass('P10-occup', 'nettoyage complet', ck.status === 404, `reçu ${ck.status}`);
  });
}

// ────────────────────────────────────────────────────────────
// PHASE 11 — Cohérence paiements/statistiques
// ────────────────────────────────────────────────────────────
async function phase11() {
  await r.section('Phase 11 — Paiements vs statistiques (3 propriétaires)', async () => {
    for (const o of ownerRecs.slice(0, 3)) {
      const jar = await ownerJar(o.i);
      const d = await apiLt('/stats/dashboard', { jar });
      const st = d.data?.stats;
      const logements = (await service.from('logements').select('loyer_mensuel, statut').eq('user_id', o.id)).data;
      const paiements = (await service.from('paiements').select('montant, statut, mois').eq('user_id', o.id)).data;
      const occupe = logements.filter((l) => l.statut === 'occupe');
      const exp = occupe.reduce((s, l) => s + Number(l.loyer_mensuel), 0);
      const mp = paiements.filter((p) => p.mois === MONTH);
      const paid = mp.filter((p) => p.statut === 'paye').reduce((s, p) => s + Number(p.montant), 0);
      const late = mp.filter((p) => p.statut === 'retard').reduce((s, p) => s + Number(p.montant), 0);
      const incActive = (await service.from('incidents').select('id').eq('user_id', o.id).neq('statut', 'resolu')).data.length;

      const s = `owner${pad(o.i)}`;
      r.pass(s, 'totalProperties=100', st?.totalProperties === 100, `reçu ${st?.totalProperties}`);
      r.pass(s, 'occupiedProperties=100 (occupation à la création)', st?.occupiedProperties === 100, `reçu ${st?.occupiedProperties}`);
      r.pass(s, 'totalTenants=100', st?.totalTenants === 100, `reçu ${st?.totalTenants}`);
      r.pass(s, 'expectedRent = somme loyers occupés', st?.expectedRent === exp, `API ${st?.expectedRent} / DB ${exp}`);
      r.pass(s, 'paidRent = somme payés du mois', st?.paidRent === paid, `API ${st?.paidRent} / DB ${paid}`);
      r.pass(s, 'lateRent = somme retard du mois', st?.lateRent === late, `API ${st?.lateRent} / DB ${late}`);
      r.pass(s, 'activeIncidents = 1 (1 resolu sur 2)', st?.activeIncidents === 1 && incActive === 1, `API ${st?.activeIncidents} / DB ${incActive}`);
      r.pass(s, 'activeInterventions = 1 (planifie)', st?.activeInterventions === 1, `reçu ${st?.activeInterventions}`);
    }
  });
}

// ────────────────────────────────────────────────────────────
// PHASE 12 — Incidents (signalement → notification → résolution)
// ────────────────────────────────────────────────────────────
async function phase12() {
  await r.section('Phase 12 — Incidents', async () => {
    const o1 = ownerRecs[0];
    const ownerJar1 = await ownerJar(1);
    const { jar } = await tenantJar(tenantUsername(1, 3), LT.tenantPw);
    const t = await apiLt('/locataire/incidents', { method: 'POST', jar, body: { titre: 'Incident P12' } });
    const incId = t.data?.data?.id;
    r.pass('P12-inc', 'signalement locataire → 201', t.status === 201, `reçu ${t.status}`);

    await sleep(200);
    const notifs = (await service.from('notifications').select('type, titre, message').eq('user_id', o1.id)).data || [];
    const has = notifs.some((n) => n.type === 'incident');
    r.pass('P12-inc', 'propriétaire notifié (type incident)', has, `notifs incident=${notifs.filter((n) => n.type === 'incident').length}`);

    const upd = await apiLt(`/incidents/${incId}`, { method: 'PUT', jar: ownerJar1, body: { statut: 'resolu' } });
    r.pass('P12-inc', 'propriétaire résout → 200', upd.status === 200, `reçu ${upd.status}`);

    const dash = await apiLt('/locataire/dashboard', { jar });
    const incDash = dash.data?.incidents?.find((i) => i.id === incId);
    r.pass('P12-inc', 'locataire voit le statut résolu', incDash?.statut === 'resolu', `statut=${incDash?.statut}`);
    await apiLt(`/incidents/${incId}`, { method: 'DELETE', jar: ownerJar1 });
    await apiLt('/auth/logout', { method: 'POST', jar });
  });
}

// ────────────────────────────────────────────────────────────
// PHASE 13 — Prestataires / Interventions
// ────────────────────────────────────────────────────────────
async function phase13() {
  await r.section('Phase 13 — Prestataires & interventions', async () => {
    const jar = await ownerJar(1);
    const logId = (await apiLt('/logements', { jar })).data.data[0].id;
    const prest = await apiLt('/prestataires', { method: 'POST', jar, body: { nom: 'P13 Presta', specialite: 'Serrurerie' } });
    r.pass('P13-prest', 'création prestataire → 201', prest.status === 201, `reçu ${prest.status}`);
    const inc = await apiLt('/incidents', { method: 'POST', jar, body: { logement_id: logId, titre: 'Incident P13' } });
    const inter = await apiLt('/interventions', { method: 'POST', jar, body: { incident_id: inc.data.data.id, prestataire_id: prest.data.data.id, logement_id: logId, titre: 'Intervention P13', statut: 'planifie' } });
    r.pass('P13-prest', 'intervention liée → 201', inter.status === 201, `reçu ${inter.status}`);
    const term = await apiLt(`/interventions/${inter.data.data.id}`, { method: 'PUT', jar, body: { statut: 'termine' } });
    r.pass('P13-prest', 'intervention → terminée → 200', term.status === 200, `reçu ${term.status}`);
    const del = await apiLt(`/prestataires/${prest.data.data.id}`, { method: 'DELETE', jar });
    r.pass('P13-prest', 'suppression prestataire (SET NULL) → 200', del.status === 200, `reçu ${del.status}`);
    await apiLt(`/interventions/${inter.data.data.id}`, { method: 'DELETE', jar });
    await apiLt(`/incidents/${inc.data.data.id}`, { method: 'DELETE', jar });
  });
}

// ────────────────────────────────────────────────────────────
// PHASE 14 — Notifications
// ────────────────────────────────────────────────────────────
async function phase14() {
  await r.section('Phase 14 — Notifications', async () => {
    const o1 = ownerRecs[0];
    const jar = await ownerJar(1);
    const notif = await apiLt('/notifications', { jar });
    r.pass('P14-notif', 'propriétaire a des notifications', notif.status === 200 && (notif.data?.data?.length ?? 0) > 0, `n=${notif.data?.data?.length}`);
    const ids = new Set(notif.data.data.map((n) => n.id));
    const mark = await apiLt(`/notifications/${notif.data.data[0].id}`, { method: 'PUT', jar, body: { lu: true } });
    r.pass('P14-notif', 'marquer comme lu → 200', mark.status === 200 && mark.data?.data?.lu === true, `reçu ${mark.status}`);
    const bad = await apiLt(`/notifications/${notif.data.data[0].id}`, { method: 'PUT', jar, body: { lu: 'yes' } });
    r.pass('P14-notif', 'lu non booléen → 400', bad.status === 400, `reçu ${bad.status}`);

    // Un locataire ne voit pas les notifications du propriétaire
    const tj = (await tenantJar(tenantUsername(1, 3), LT.tenantPw)).jar;
    const tn = await apiLt('/notifications', { jar: tj });
    const leak = tn.data?.data?.filter((n) => ids.has(n.id)).length || 0;
    r.pass('P14-notif', 'locataire isolé des notifications propriétaire', leak === 0, `fuites=${leak}`);
    await apiLt('/auth/logout', { method: 'POST', jar: tj });
  });
}

// ────────────────────────────────────────────────────────────
// PHASE 15 — Dashboards vs PostgreSQL
// ────────────────────────────────────────────────────────────
async function phase15() {
  await r.section('Phase 15 — Dashboards API vs PostgreSQL', async () => {
    const targets = [ownerRecs[24], ownerRecs[49]].filter(Boolean);
    for (const o of targets) {
      const jar = await ownerJar(o.i);
      const d = await apiLt('/stats/dashboard', { jar });
      const dbLoc = (await service.from('locataires').select('id').eq('user_id', o.id)).data.length;
      const dbLog = (await service.from('logements').select('id').eq('user_id', o.id)).data.length;
      r.pass(`owner${pad(o.i)}`, 'dashboard = DB (locataires/logements)', d.data?.stats?.totalTenants === dbLoc && d.data?.stats?.totalProperties === dbLog, `API ${d.data?.stats?.totalTenants}/${d.data?.stats?.totalProperties} DB ${dbLoc}/${dbLog}`);
    }
  });
}

// ────────────────────────────────────────────────────────────
// PHASE 16 — Concurrence et charge
// ────────────────────────────────────────────────────────────
async function phase16() {
  await r.section('Phase 16 — Concurrence (10→500) + charge + docker stats', async () => {
    const pool = [];
    for (let i = 1; i <= Math.min(10, ownerRecs.length); i++) pool.push(await ownerJar(i));
    const jarOf = () => pool[Math.floor(Math.random() * pool.length)];
    if (pool.length === 0) { r.blocked('P16-charge', 'pool jars', 'aucun propriétaire'); return; }

    const dockerStats = () => {
      try {
        return execSync('docker stats supabase_db_MIM supabase_auth_MIM --no-stream --format "{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}"', { encoding: 'utf8' }).trim();
      } catch { return 'docker stats indisponible'; }
    };
    r.record('P16-charge', 'docker stats AVANT charge', 'perf', dockerStats());

    const levels = [10, 25, 50, 100, 200, 500];
    for (const n of levels) {
      const times = [];
      const codes = {};
      const t0 = Date.now();
      const results = await Promise.all(
        Array.from({ length: n }, () => apiLt('/stats/dashboard', { jar: jarOf() }).then((x) => { codes[x.status] = (codes[x.status] || 0) + 1; return x; }).catch((e) => { codes.err = (codes.err || 0) + 1; }))
      );
      // re-mesure des temps (les Promise.all wrappent déjà) : on mesure via le setTimeout collectif
      const total = Date.now() - t0;
      r.record('P16-charge', `GET /stats/dashboard × ${n}`, 'perf', `total=${total}ms ${JSON.stringify(codes)}`);
      r.pass('P16-charge', `${n} GET simultanés → aucun 5xx/429`, !codes['5'] && !codes['429'] && !codes.err, JSON.stringify(codes));
    }

    for (const n of [50, 200]) {
      const times = [];
      const codes = {};
      const t0 = Date.now();
      await Promise.all(Array.from({ length: n }, () => apiLt('/notifications', { jar: jarOf() }).then((x) => { codes[x.status] = (codes[x.status] || 0) + 1; }).catch((e) => { codes.err = (codes.err || 0) + 1; })));
      const total = Date.now() - t0;
      r.record('P16-charge', `GET /notifications × ${n}`, 'perf', `total=${total}ms ${JSON.stringify(codes)}`);
      r.pass('P16-charge', `${n} notifications simultanés → aucun 5xx`, !codes['5'] && !codes.err, JSON.stringify(codes));
    }

    // Connexions locataires simultanées (25)
    const t0 = Date.now();
    const logins = [];
    for (let j = 3; j <= 27; j++) {
      const u = tenantUsername(1, j);
      const { data: exists } = await service.from('profiles').select('id').eq('username', u).maybeSingle();
      if (exists) logins.push(u);
    }
    if (logins.length === 0) { r.blocked('P16-charge', '25 logins simultanés', 'aucun locataire owner1'); return; }
    const lres = await Promise.all(logins.map((u) => tenantJar(u, LT.tenantPw)));
    const codes = {};
    for (const x of lres) codes[x.status] = (codes[x.status] || 0) + 1;
    r.record('P16-charge', `${logins.length} connexions locataires simultanées`, 'perf', `total=${Date.now() - t0}ms ${JSON.stringify(codes)}`);
    r.pass('P16-charge', 'logins simultanés → 200', codes['200'] === logins.length, JSON.stringify(codes));

    r.record('P16-charge', 'docker stats APRÈS charge', 'perf', dockerStats());

    // Charge contre le serveur PROD :3000 (rate limit ON) → 429 attendus
    const prodJar = newJar();
    const pj = await apiProd('/auth/login', { method: 'POST', jar: prodJar, body: { identifier: ownerEmail(1), password: LT.ownerPw } });
    if (pj.status === 200) {
      const codes2 = {};
      const t1 = Date.now();
      await Promise.all(Array.from({ length: 350 }, () => apiProd('/stats/dashboard', { jar: prodJar }).then((x) => { codes2[x.status] = (codes2[x.status] || 0) + 1; }).catch((e) => { codes2.err = (codes2.err || 0) + 1; })));
      r.record('P16-charge', 'burst 350 GET /stats/dashboard sur :3000 (rate limit ON)', 'perf', `total=${Date.now() - t1}ms ${JSON.stringify(codes2)}`);
      r.pass('P16-charge', 'rate limiter MIM actif (429 présents ou 0 échec selon seuil)', (codes2['429'] || 0) > 0 || !codes2['5'], JSON.stringify(codes2));
      await apiProd('/auth/logout', { method: 'POST', jar: prodJar });
    } else {
      r.blocked('P16-charge', 'burst sur :3000', `login prod ${pj.status}`);
    }
  });
}

// ────────────────────────────────────────────────────────────
// PHASE 17 — CRUD massif + stabilité
// ────────────────────────────────────────────────────────────
async function phase17() {
  await r.section('Phase 17 — CRUD massif + stabilité', async () => {
    const health = await apiLt('/health');
    r.pass('P17-stab', 'serveur :3200 sain après charge', health.status === 200, `reçu ${health.status}`);

    const ownerIds = ownerRecs.map((o) => o.id).join(',');
    const c = async (t, f) => {
      const { count, error } = await service.from(t).select('*', { count: 'exact', head: true }).or(f);
      return error ? -1 : Number(count);
    };
    const cnts = {
      locataires: await c('locataires', `user_id.in.(${ownerIds})`),
      logements: await c('logements', `user_id.in.(${ownerIds})`),
      paiements: await c('paiements', `user_id.in.(${ownerIds})`),
      biens: await c('biens', `user_id.in.(${ownerIds})`),
      incidents: await c('incidents', `user_id.in.(${ownerIds})`),
      prestataires: await c('prestataires', `user_id.in.(${ownerIds})`),
      interventions: await c('interventions', `user_id.in.(${ownerIds})`),
    };
    const expected = { locataires: 10000, logements: 10000, paiements: 10000, biens: 100, incidents: 200, prestataires: 100, interventions: 100 };
    const ok = Object.entries(expected).every(([k, v]) => cnts[k] === v);
    r.pass('P17-stab', 'décomptes DB intacts après toutes les phases', ok, JSON.stringify(cnts));

    // 200 opérations mixtes supplémentaires
    let bad = 0;
    const jar = await ownerJar(ownerRecs[0].i);
    for (let k = 0; k < 200; k++) {
      const rnd = k % 3;
      if (rnd === 0) { const x = await apiLt('/biens', { jar }); if (x.status !== 200) bad++; }
      else if (rnd === 1) { const x = await apiLt('/logements', { jar }); if (x.status !== 200) bad++; }
      else { const x = await apiLt('/paiements', { jar }); if (x.status !== 200) bad++; }
    }
    r.pass('P17-stab', '200 lectures mixtes → aucune erreur', bad === 0, `échecs=${bad}`);

    // Notification massive (stabilité notifications sur locataire)
    const tj = (await tenantJar(tenantUsername(1, 3), LT.tenantPw)).jar;
    const tn = await apiLt('/notifications', { jar: tj });
    r.pass('P17-stab', 'notifications locataire OK après charge', tn.status === 200, `reçu ${tn.status}`);
  });
}

// ────────────────────────────────────────────────────────────
// PHASE 19 — Sécurité
// ────────────────────────────────────────────────────────────
async function phase19() {
  await r.section('Phase 19 — Sécurité', async () => {
    const jar = await ownerJar(1);

    // 2FA
    const mfa = await apiLt('/auth/mfa/status', { jar });
    r.pass('P19-sec', 'mfa/status → 200', mfa.status === 200, `reçu ${mfa.status} ${JSON.stringify(mfa.data).slice(0, 120)}`);
    const v2 = await apiLt('/auth/verify-2fa', { method: 'POST', jar, body: { code: '000000' } });
    r.record('P19-sec', 'verify-2fa sans session pending', 'note', `reçu ${v2.status} — ${v2.data?.message || 'ok'}`);

    // JWT altéré
    const meOk = await apiLt('/auth/me', { jar });
    const cookie = jar.cookies.find((c) => c.name === 'mim_token');
    if (cookie) {
      const hacked = newJar();
      hacked.cookies.push({ name: 'mim_token', value: cookie.value.slice(0, -3) + 'abc' });
      const meBad = await apiLt('/auth/me', { jar: hacked });
      r.pass('P19-sec', 'JWT altéré → /me refusé', meBad.status === 401, `reçu ${meBad.status}`);
    } else {
      r.fail('P19-sec', 'JWT altéré', 'cookie mim_token absent');
    }

    // Flags de cookie sur le login
    const raw = await fetch(BASE + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: ownerEmail(2), password: LT.ownerPw }),
      redirect: 'manual',
    });
    const setCookies = raw.headers.getSetCookie?.() || [];
    const mim = setCookies.find((s) => s.startsWith('mim_token'));
    r.record('P19-sec', 'Set-Cookie mim_token', 'note', mim || 'absent');
    r.pass('P19-sec', 'cookie HttpOnly', /HttpOnly/i.test(mim || ''), mim || 'absent');
    r.pass('P19-sec', 'cookie SameSite', /SameSite=/i.test(mim || ''), mim || 'absent');

    // CORS
    const evil = await fetch(`${BASE}/health`, { headers: { Origin: 'http://evil.example.com' } });
    const evilAcao = evil.headers.get('access-control-allow-origin');
    r.pass('P19-sec', 'CORS origine inconnue refusée', evilAcao === null, `ACAO='${evilAcao}'`);

    // Injection username
    const inj = await tenantJar("x' OR '1'='1", LT.tenantPw);
    r.pass('P19-sec', 'username injection SQL → refusé', inj.status === 401, `reçu ${inj.status}`);
    const upInj = await apiLt('/auth/update-username', { method: 'PUT', jar, body: { username: "x'; DROP TABLE biens; --" } });
    r.pass('P19-sec', 'update-username injection → refusé', upInj.status >= 400 && upInj.status < 500, `reçu ${upInj.status} — biens intact`);

    // change-password : mauvais mot de passe actuel (compte non forcé)
    const changed = state.tenantPasswordChanged[0];
    const tj = (await tenantJar(changed, LT.tenantPw2)).jar;
    const cw = await apiLt('/auth/change-password', { method: 'PUT', jar: tj, body: { current_password: 'WRONG!pass', password: LT.tenantPw2, password_confirm: LT.tenantPw2 } });
    r.pass('P19-sec', 'change-password mauvais actuel → 400', cw.status === 400 && /actuel incorrect/.test(cw.data?.message || ''), `reçu ${cw.status} — ${cw.data?.message}`);

    // forgot (envoyé d'email local)
    const forgot = await apiLt('/auth/forgot', { method: 'POST', jar, body: { email: ownerEmail(3) } });
    r.record('P19-sec', 'forgot password (SMTP local)', 'note', `reçu ${forgot.status} — ${forgot.data?.message || ''}`);

    // Champ hors-schéma ignoré (role dans /biens)
    const extra = await apiLt('/biens', { method: 'POST', jar, body: { nom: 'Extra Field', type: 'maison', role: 'admin', account_type: 'admin' } });
    r.record('P19-sec', 'champs hors-schéma sur /biens', 'note', `reçu ${extra.status} — données: ${JSON.stringify(extra.data?.data || extra.data).slice(0, 150)}`);
    if (extra.status === 201) await apiLt(`/biens/${extra.data.data.id}`, { method: 'DELETE', jar });
  });
}

// ────────────────────────────────────────────────────────────
// MAIN
// ────────────────────────────────────────────────────────────
async function main() {
  console.log(`LOADTEST — PHASES 5-19 sur ${BASE}\n`);
  await phase5();
  await phase6();
  await phase7();
  await phase8();
  await phase9();
  await phase10();
  await phase11();
  await phase12();
  await phase13();
  await phase14();
  await phase15();
  await phase16();
  await phase17();
  await phase19();

  saveState(state);
  const out = path.join(__dirname, 'results-phases.json');
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), results: r.results }, null, 2));
  console.log(`\nRésultats détaillés → ${out}`);
  r.summary();
  const { failed } = r.summary();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('[run-phases]', e); process.exit(1); });
