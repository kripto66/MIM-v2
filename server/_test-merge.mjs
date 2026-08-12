import fs from 'fs';

const BASE = 'http://localhost:3000';
let cookie = '';

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner.test20260812@example.com', password: 'OwnerTest2026!' }),
  });
  const d = await r.json();
  if (!d.success) throw new Error('login failed: ' + JSON.stringify(d));
  cookie = r.headers.get('set-cookie').split(';')[0];
  console.log('[login] OK');
}

async function req(path, method = 'GET', body = null, expect) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const d = JSON.parse(text || '{}');
  const ok = expect ? r.status === expect : r.ok;
  if (!ok) throw new Error(`${method} ${path} -> ${r.status}: ${text.slice(0, 300)}`);
  return d;
}

await login();

// Nettoyage du tenant de test créé par le debug (id 9, direct.test2)
try {
  const list = await req('/locataires');
  const orphan = list.data.find((t) => t.username === 'direct.test2');
  if (orphan) {
    await req(`/locataires/${orphan.id}`, 'DELETE', null, 200);
    console.log('[cleanup] tenant direct.test2 supprimé');
  }
} catch (e) {
  console.warn('[cleanup]', e.message);
}

const rnd = Date.now().toString().slice(-6);
const username = `test.merge.${rnd}`;
let tenantId;
let lgId;

console.log('=== 1. Création locataire AVEC logement embarqué ===');
const created = await req('/locataires', 'POST', {
  nom: 'Test Fusion ' + rnd,
  username,
  password: 'FusionTest2026!',
  jour_echeance: '5',
  logement: {
    bien_id: 2,
    nom: 'Appartement Fusion ' + rnd,
    type: 'appartement',
    nombre_chambres: 2,
    loyer_mensuel: '75000',
    adresse: 'Rue Test ' + rnd,
    statut: 'libre',
  },
}, 201);
tenantId = created.data.id;
lgId = created.data.logement_id;
console.log('tenant id:', tenantId, '| logement id:', lgId);
if (!lgId) throw new Error('logement non rattaché !');

const lg = await req(`/logements/${lgId}`);
console.log('logement créé:', lg.data.nom, '| statut:', lg.data.statut, '| loyer:', lg.data.loyer_mensuel);
if (lg.data.statut !== 'occupe') throw new Error('logement devrait être occupé');

console.log('=== 2. Login du nouveau locataire (compte actif) ===');
const tenantLogin = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password: 'FusionTest2026!' }),
});
const tl = await tenantLogin.json();
if (!tl.success || !tl.mustChangePassword) throw new Error('login locataire attendu avec mustChangePassword');
console.log('login locataire OK (mustChangePassword:', tl.mustChangePassword, ')');

console.log('=== 3. Modification du logement embarqué (loyer + adresse) ===');
const edited = await req(`/locataires/${tenantId}`, 'PUT', {
  nom: 'Test Fusion ' + rnd,
  statut: 'actif',
  logement_update: { id: lgId, loyer_mensuel: '82000', adresse: 'Rue Test Modifiée ' + rnd },
});
console.log('tenant à jour, logement_id:', edited.data.logement_id);
const lg2 = await req(`/logements/${lgId}`);
console.log('loyer modifié:', lg2.data.loyer_mensuel, '| adresse:', lg2.data.adresse);
if (lg2.data.loyer_mensuel !== 82000) throw new Error('loyer non mis à jour');

console.log('=== 4. Garde : suppression d\'un logement occupé ===');
try {
  await req('/logements/2', 'DELETE', null, 400);
  console.log('suppression bloquée (logement 2 occupé) : OK');
} catch (e) {
  throw new Error('la garde ne fonctionne pas: ' + e.message);
}

console.log('=== 5. Suppression du locataire -> compte désactivé + logement libéré ===');
const del = await req(`/locataires/${tenantId}`, 'DELETE', null, 200);
console.log('delete:', del.message);
const lg3 = await req(`/logements/${lgId}`);
console.log('logement après suppression, statut:', lg3.data.statut);
if (lg3.data.statut !== 'libre') throw new Error('logement devrait être libre');

const relogin = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username, password: 'FusionTest2026!' }),
});
const rl = await relogin.json();
console.log('re-login après suppression, success:', rl.success, '| status:', relogin.status);
if (rl.success) throw new Error('le compte devrait être désactivé !');

console.log('=== 6. Duplication de username -> 409 sans logement orphelin ===');
const before = await req('/logements');
const dup = await fetch(`${BASE}/api/locataires`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({
    nom: 'Doublon Test',
    username: 'jean.diop2',
    password: 'FusionTest2026!',
    logement: { bien_id: 2, nom: 'Orphelin ' + rnd, type: 'chambre', loyer_mensuel: '5000', adresse: 'X' },
  }),
});
const dupData = await dup.json();
console.log('dup status:', dup.status, '| message:', dupData.message);
if (dup.status !== 409) throw new Error('attendu 409');
const after = await req('/logements');
if (after.data.length !== before.data.length) throw new Error('un logement orphelin a été créé !');
console.log('aucun logement orphelin : OK');

console.log('=== 7. Pages servies ===');
for (const p of ['PartProprietaires/locataires.html', 'PartProprietaires/biens.html', 'PartProprietaires/dashboard.html']) {
  const r = await fetch(`${BASE}/${p}`);
  if (r.status !== 200) throw new Error(`${p} -> ${r.status}`);
}
console.log('locataires.html, biens.html, dashboard.html : 200 OK');

console.log('\nTOUS LES TESTS PASSENT');
