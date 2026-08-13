// ============================================================
// MIM — LOADTEST : PHASES 2-4
//   100 propriétaires × 100 locataires = 10 000 locataires
//   + biens, logements, paiements, incidents, prestataires,
//   interventions, notifications.
// Namespace : loadtest.owner.*@loadtest.mim / loadtest.tenant.*
// Provisioning propriétaires via rôle service (le limiteur GoTrue
// d'inscriptions, sign_in_sign_ups=30/5min, rendrait /register
// impossible pour 100 comptes) ; le login réel (/auth/login) est
// ensuite testé pour chacun. 2 inscriptions réelles /register sont
// vérifiées pour prouver le flux.
// ============================================================
import { apiLt, LT, pad, ownerEmail, ownerName, tenantUsername, tenantName, monthNow, service, saveState, newJar, countAll } from './common.mjs';

const OWNERS = LT.owners;
const PER_OWNER = LT.perOwner;
const month = monthNow();

const results = [];

function record(name, ok, detail = '') { results.push({ name, ok, detail }); }

async function pool(items, limit, worker) {
  const queue = [...items];
  const active = new Set();
  let next = 0;
  await new Promise((resolve, reject) => {
    function start() {
      while (active.size < limit && next < queue.length) {
        const idx = next++;
        const item = queue[idx];
        const p = Promise.resolve().then(() => worker(item, idx)).then(
          () => { active.delete(p); start(); },
          (e) => { active.delete(p); start(); reject(e); }
        );
        active.add(p);
      }
      if (!active.size) resolve();
    }
    start();
  });
}

async function provisionOwners() {
  const ids = new Map();
  const BATCH = 10;
  for (let b = 0; b < OWNERS; b += BATCH) {
    const slice = Array.from({ length: Math.min(BATCH, OWNERS - b) }, (_, k) => b + k + 1);
    const res = await Promise.all(
      slice.map(async (i) => {
        const email = ownerEmail(i);
        let { data, error } = await service.auth.admin.createUser({
          email,
          password: LT.ownerPw,
          email_confirm: true,
          user_metadata: { account_type: 'proprietaire', role: 'proprietaire', name: ownerName(i) },
        });
        if (error && /already been registered|already exists/i.test(error.message)) {
          // Idempotence : reprise de run sans nettoyage préalable.
          const { data: existing } = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
          const found = existing?.users?.find((u) => u.email === email);
          if (found) data = { user: found };
          else throw new Error(`createUser owner ${i} : ${error.message}`);
        } else if (error) {
          throw new Error(`createUser owner ${i} : ${error.message}`);
        }
        ids.set(i, data.user.id);
        return true;
      })
    );
    if (res.length !== slice.length) throw new Error('provision owners partiel');
  }
  return ids;
}

async function registerReal(i) {  const jar = newJar();
  const email = `loadtest.register.${pad(i)}@loadtest.mim`;
  const r = await apiLt('/auth/register', {
    method: 'POST',
    jar,
    body: {
      account_type: 'proprietaire',
      name: `Register LT ${pad(i)}`,
      email,
      phone: `+22190${pad(i)}000`,
      password: LT.ownerPw,
      password_confirm: LT.ownerPw,
    },
  });
  if (r.status !== 201 || !r.data?.success) return { ok: false, detail: `${r.status} ${JSON.stringify(r.data).slice(0, 200)}` };
  const me = await apiLt('/auth/me', { jar });
  await apiLt('/auth/logout', { method: 'POST', jar });
  return { ok: me.status === 200 && me.data?.user?.account_type === 'proprietaire', detail: `me ${me.status}` };
}

// Retry de la création d'un locataire (échecs transitoires de admin.createUser
// sous charge — GoTrue/DB) avec backoff. Renvoie la dernière réponse après épuisement.
async function createTenant(jar, body) {
  const backoff = [3000, 8000, 15000, 25000, 40000];
  let loc = null;
  for (let a = 1; a <= backoff.length + 1; a++) {
    loc = await apiLt('/locataires', { method: 'POST', jar, body });
    if (loc.status === 201 && loc.data?.accountCreated) return loc;
    if (loc.status === 409) return loc;
    if (a <= backoff.length) {
      console.log(`  retry locataire (${body.username}) tentative ${a} → ${loc.status} ${String(loc.data?.message).slice(0, 80)}`);
      await new Promise((r) => setTimeout(r, backoff[a - 1]));
    }
  }
  return loc;
}

// Un propriétaire complet : login, me, bien, logements, locataires, paiements…
async function buildOwner(i, ownerId) {
  const jar = newJar();
  const email = ownerEmail(i);

  const login = await apiLt('/auth/login', { method: 'POST', jar, body: { identifier: email, password: LT.ownerPw } });
  if (login.status !== 200) throw new Error(`login owner ${i} : ${login.status} ${JSON.stringify(login.data).slice(0, 200)}`);

  const me = await apiLt('/auth/me', { jar });
  if (me.status !== 200 || !me.data?.user?.id || me.data.user.account_type !== 'proprietaire') {
    throw new Error(`me owner ${i} : ${JSON.stringify(me.data).slice(0, 200)}`);
  }

  // Bien (Phase 3)
  const bien = await apiLt('/biens', {
    method: 'POST', jar,
    body: { nom: `Bien LT ${pad(i)}`, type: 'immeuble', adresse: `${i} Av. Test`, ville: 'Dakar', pays: 'Sénégal' },
  });
  if (bien.status !== 201) throw new Error(`bien owner ${i} : ${bien.status} ${JSON.stringify(bien.data).slice(0, 200)}`);
  const bienId = bien.data.data.id;

  // 100 logements (Phase 3)
  const logements = [];
  for (let j = 1; j <= PER_OWNER; j++) {
    const type = j % 3 === 0 ? 'chambre' : 'appartement';
    const loyer = 80000 + i * 1000 + j * 500;
    const log = await apiLt('/logements', {
      method: 'POST', jar,
      body: {
        bien_id: bienId,
        nom: `Log LT-${pad(i)}-${pad(j)}`,
        type,
        nombre_chambres: type === 'appartement' ? ((j % 4) + 1) : null,
        adresse: `${pad(i)}-${pad(j)} Rue Test`,
        loyer_mensuel: loyer,
        statut: 'libre',
      },
    });
    if (log.status !== 201) throw new Error(`logement o${i}-${j} : ${log.status} ${JSON.stringify(log.data).slice(0, 200)}`);
    logements.push({ id: log.data.data.id, loyer });
  }

  // 100 locataires AVEC compte (Phase 4)
  const locataires = [];
  for (let j = 1; j <= PER_OWNER; j++) {
    const username = tenantUsername(i, j);
    const loc = await createTenant(jar, {
      logement_id: logements[j - 1].id,
      nom: tenantName(i, j),
      username,
      password: LT.tenantPw,
      phone: `+2217${pad(i)}${pad(j)}`,
      date_entree: '2026-06-01',
      jour_echeance: (j % 28) + 1,
      statut: 'actif',
    });
    if (loc.status !== 201 || !loc.data?.accountCreated) {
      throw new Error(`locataire o${i}-${j} : ${loc.status} ${JSON.stringify(loc.data).slice(0, 200)}`);
    }
    locataires.push({ id: loc.data.data.id, logement_id: logements[j - 1].id });
  }

  // Username dupliqué → 409 (Phase 4)
  const dup = await apiLt('/locataires', {
    method: 'POST', jar,
    body: { logement_id: logements[0].id, nom: 'Dup', username: tenantUsername(i, 1), password: LT.tenantPw, statut: 'actif' },
  });
  if (dup.status !== 409) record(`duplicate-username o${pad(i)}`, false, `attendu 409, reçu ${dup.status}`);

  // 100 paiements (Phase 11 base)
  for (let j = 1; j <= PER_OWNER; j++) {
    const statut = j % 3 === 0 ? 'paye' : j % 3 === 1 ? 'attente' : 'retard';
    const p = await apiLt('/paiements', {
      method: 'POST', jar,
      body: {
        locataire_id: locataires[j - 1].id,
        logement_id: logements[j - 1].id,
        montant: logements[j - 1].loyer,
        mois: month,
        statut,
        ...(statut === 'paye' ? { date_paiement: new Date().toISOString().slice(0, 10) } : {}),
      },
    });
    if (p.status !== 201) throw new Error(`paiement o${i}-${j} : ${p.status} ${JSON.stringify(p.data).slice(0, 200)}`);
  }

  // Incidents (Phase 12)
  const inc1 = await apiLt('/incidents', { method: 'POST', jar, body: { logement_id: logements[0].id, titre: `Fuite LT ${pad(i)}`, description: 'Fuite à réparer', statut: 'nouveau' } });
  if (inc1.status !== 201) throw new Error(`incident1 o${i} : ${inc1.status}`);
  const inc2 = await apiLt('/incidents', { method: 'POST', jar, body: { logement_id: logements[1].id, titre: `Résolu LT ${pad(i)}`, statut: 'resolu' } });
  if (inc2.status !== 201) throw new Error(`incident2 o${i} : ${inc2.status}`);

  // Prestataire + intervention (Phase 13)
  const prest = await apiLt('/prestataires', { method: 'POST', jar, body: { nom: `Presta LT ${pad(i)}`, specialite: 'Plomberie', phone: '+221770000000' } });
  if (prest.status !== 201) throw new Error(`prestataire o${i} : ${prest.status}`);
  const inter = await apiLt('/interventions', {
    method: 'POST', jar,
    body: { incident_id: inc1.data.data.id, prestataire_id: prest.data.data.id, logement_id: logements[0].id, titre: `Interv LT ${pad(i)}`, statut: 'planifie' },
  });
  if (inter.status !== 201) throw new Error(`intervention o${i} : ${inter.status}`);

  // Vérifications de comptage par listes (Phase 6 partiel)
  const list = async (path, expected) => {
    const r = await apiLt(path, { jar });
    return r.status === 200 && (r.data?.data?.length ?? -1) === expected;
  };
  record(`owner ${pad(i)} logements=100`, await list('/logements', PER_OWNER), '');
  record(`owner ${pad(i)} locataires=100`, await list('/locataires', PER_OWNER), '');
  record(`owner ${pad(i)} paiements=100`, await list('/paiements', PER_OWNER), '');
  record(`owner ${pad(i)} biens=1`, await list('/biens', 1), '');
  record(`owner ${pad(i)} incidents=2`, await list('/incidents', 2), '');
  record(`owner ${pad(i)} prestataires=1`, await list('/prestataires', 1), '');
  record(`owner ${pad(i)} interventions=1`, await list('/interventions', 1), '');

  await apiLt('/auth/logout', { method: 'POST', jar });

  return { i, email, password: LT.ownerPw, id: ownerId, bienId, logementIds: logements.map((l) => l.id), locataireIds: locataires.map((l) => l.id) };
}

async function edgeTenantChecks() {
  const jar = newJar();
  const login = await apiLt('/auth/login', { method: 'POST', jar, body: { identifier: ownerEmail(1), password: LT.ownerPw } });
  if (login.status !== 200) return;
  const cases = [
    ['edge uppercase username', { username: 'LOADTEST.EDGE.UP', password: LT.tenantPw }, 400],
    ['edge email invalide', { username: 'loadtest.edge.bademail', email: 'nope', password: LT.tenantPw }, 400],
    ['edge jour_echeance 32', { username: 'loadtest.edge.jour', jour_echeance: 32, password: LT.tenantPw }, 400],
    ['edge password faible', { username: 'loadtest.edge.weak', password: 'abc', password_confirm: 'abc' }, 400],
    ['edge nom manquant', { username: 'loadtest.edge.noname', password: LT.tenantPw }, 400],
  ];
  for (const [name, body, expected] of cases) {
    const r = await apiLt('/locataires', { method: 'POST', jar, body });
    record(name, r.status === expected, `attendu ${expected}, reçu ${r.status} — ${JSON.stringify(r.data).slice(0, 150)}`);
  }
  // locataire sans email (fiche) → autorisé (logement libre créé pour l'occasion)
  const bienId = (await apiLt('/biens', { jar })).data.data[0].id;
  const tmpLog = await apiLt('/logements', { method: 'POST', jar, body: { bien_id: bienId, nom: 'Edge Log', adresse: 'Edge Adresse', loyer_mensuel: 70000, statut: 'libre' } });
  const ok = await apiLt('/locataires', {
    method: 'POST', jar,
    body: { logement_id: tmpLog.data.data.id, nom: 'Edge NoEmail', username: 'loadtest.edge.noemail', password: LT.tenantPw, statut: 'actif' },
  });
  record('edge locataire sans email (fiche) → 201', ok.status === 201, `reçu ${ok.status} ${JSON.stringify(ok.data).slice(0, 150)}`);
  if (ok.status === 201) {
    await apiLt(`/locataires/${ok.data.data.id}`, { method: 'DELETE', jar });
  }
  await apiLt(`/logements/${tmpLog.data.data.id}`, { method: 'DELETE', jar });
  await apiLt('/auth/logout', { method: 'POST', jar });
}

// ============================================================
async function main() {
  const t0 = Date.now();
  console.log(`LOADTEST — création ${OWNERS} propriétaires × ${PER_OWNER} locataires = ${OWNERS * PER_OWNER}`);
  console.log(`Namespace : ${LT.ownerPrefix}*@loadtest.mim / ${LT.tenantPrefix}*`);
  console.log(`Serveur : ${process.env.LOADTEST_BASE || 'http://127.0.0.1:3200/api'}\n`);

  // Phase 2 : provisions
  console.log('[Phase 2] Provision des propriétaires (rôle service)...');
  const ownerIds = await provisionOwners();
  record('owners provisionnés = 100', ownerIds.size === OWNERS, `reçu ${ownerIds.size}`);

  const reg1 = await registerReal(1);
  record('register réel #1', reg1.ok, reg1.detail);
  const reg2 = await registerReal(2);
  record('register réel #2', reg2.ok, reg2.detail);

  console.log('[Phase 2] Login + /me + biens/logements/locataires...');
  const owners = [];
  const idx = Array.from({ length: OWNERS }, (_, k) => k + 1);
  let done = 0;
  await pool(idx, 10, async (i) => {
    const o = await buildOwner(i, ownerIds.get(i));
    owners.push(o);
    done++;
    if (done % 5 === 0 || done === OWNERS) {
      const el = Math.round((Date.now() - t0) / 1000);
      console.log(`  ${done}/${OWNERS} propriétaires (${el}s)`);
    }
  });

  console.log('[Phase 4] Vérifications aux limites (username/email/validation)...');
  await edgeTenantChecks();

  // Comptages globaux loadtest
  const cOwners = await countAll('profiles', 'email.like.loadtest.owner.%');
  const cTenants = await countAll('profiles', 'username.like.loadtest.%');
  const cBiens = await countAll('biens', `user_id.in.(${owners.map((o) => o.id).join(',')})`);
  const cLogs = await countAll('logements', `user_id.in.(${owners.map((o) => o.id).join(',')})`);
  const cLocs = await countAll('locataires', `user_id.in.(${owners.map((o) => o.id).join(',')})`);
  const cPays = await countAll('paiements', `user_id.in.(${owners.map((o) => o.id).join(',')})`);
  const cIncs = await countAll('incidents', `user_id.in.(${owners.map((o) => o.id).join(',')})`);
  const cPrest = await countAll('prestataires', `user_id.in.(${owners.map((o) => o.id).join(',')})`);
  const cInters = await countAll('interventions', `user_id.in.(${owners.map((o) => o.id).join(',')})`);

  record('loadtest proprietaires = 100', cOwners === OWNERS, `reçu ${cOwners}`);
  record('loadtest locataires = 10 000', cTenants === OWNERS * PER_OWNER, `reçu ${cTenants}`);
  record('loadtest biens = 100', cBiens === OWNERS, `reçu ${cBiens}`);
  record('loadtest logements = 10 000', cLogs === OWNERS * PER_OWNER, `reçu ${cLogs}`);
  record('loadtest fiches locataires = 10 000', cLocs === OWNERS * PER_OWNER, `reçu ${cLocs}`);
  record('loadtest paiements = 10 000', cPays === OWNERS * PER_OWNER, `reçu ${cPays}`);
  record('loadtest incidents = 200', cIncs === OWNERS * 2, `reçu ${cIncs}`);
  record('loadtest prestataires = 100', cPrest === OWNERS, `reçu ${cPrest}`);
  record('loadtest interventions = 100', cInters === OWNERS, `reçu ${cInters}`);

  const state = {
    ts: LT.ts,
    port: Number(process.env.LOADTEST_PORT || '3200'),
    owners: OWNERS,
    perOwner: PER_OWNER,
    month,
    owners: owners.map((o) => ({ i: o.i, email: o.email, password: o.password, id: o.id })),
    tenantPasswordChanged: [],
    createdAt: new Date().toISOString(),
  };
  saveState(state);

  const fails = results.filter((r) => !r.ok);
  console.log('\n──────────────────────────────────────────');
  console.log(`SEED TERMINÉ en ${Math.round((Date.now() - t0) / 1000)}s — ${results.length} vérifications, ${fails.length} échec(s)`);
  for (const f of fails) console.log(`  ❌ ${f.name} — ${f.detail}`);
  console.log('──────────────────────────────────────────');
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error('[seed]', e); process.exit(1); });
