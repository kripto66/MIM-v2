import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const envPath = 'C:/xampp/htdocs/MIM2.1/MIM/server/.env';
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1').trim();
}
const BASE = 'http://localhost:3000';
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const ts = Date.now().toString().slice(-8);
const accounts = {
  owner:  { email: `owneraudit${ts}@mim.local`, pw: 'Azerty123!', type: 'proprietaire' },
  locataire: { username: `locaudit${ts}`, pw: 'Azerty123!', type: 'locataire' },
  employe: { username: `empaudit${ts}`, pw: 'Azerty123!', type: 'employe' },
};
accounts.locataire.email = `${accounts.locataire.username}@mim.local`;
accounts.employe.email = `${accounts.employe.username}@mim.local`;

let createdUids = [];
let cookieByRole = {};
let pass = 0, fail = 0;
const results = [];
function check(label, cond, detail = '') {
  if (cond) { pass++; results.push(`PASS ${label}`); }
  else { fail++; results.push(`FAIL ${label} ${detail}`); }
}

async function login(email, pw) {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: email, password: pw }),
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie') || '';
  const token = (setCookie.match(/mim_token=([^;]+)/) || [])[1] || '';
  let body = {};
  try { body = await res.json(); } catch {}
  return { status: res.status, token, body };
}
async function page(role, url) {
  const cookie = cookieByRole[role];
  const res = await fetch(BASE + url, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
  return res.status;
}
async function api(role, method, url, body) {
  const cookie = cookieByRole[role];
  const res = await fetch(BASE + url, {
    method, headers: { Cookie: cookie || '', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.status;
}

async function cleanup(uids) {
  for (const uid of uids) {
    try { await sb.from('locataires').delete().eq('account_uid', uid); } catch {}
    try { await sb.from('employes').delete().eq('account_uid', uid); } catch {}
    try { await sb.auth.admin.deleteUser(uid); } catch {}
  }
}

try {
  const owner = await sb.auth.admin.createUser({ email: accounts.owner.email, password: accounts.owner.pw, email_confirm: true, user_metadata: { account_type: 'proprietaire', role: 'proprietaire', name: 'Owner Audit', username: '', phone: '' } });
  if (!owner.data?.user?.id) throw new Error('owner createUser: ' + owner.error?.message);
  createdUids.push(owner.data.user.id);

  const loc = await sb.auth.admin.createUser({ email: accounts.locataire.email, password: accounts.locataire.pw, email_confirm: true, user_metadata: { account_type: 'locataire', role: 'locataire', name: 'Loc Audit', username: accounts.locataire.username, phone: '', must_change_password: true } });
  if (!loc.data?.user?.id) throw new Error('loc createUser: ' + loc.error?.message);
  createdUids.push(loc.data.user.id);
  try { await sb.from('locataires').insert({ user_id: owner.data.user.id, account_uid: loc.data.user.id, username: accounts.locataire.username, nom: 'Loc Audit', statut: 'actif' }); } catch (e) { console.log('warn fiche locataire:', e.message); }

  const emp = await sb.auth.admin.createUser({ email: accounts.employe.email, password: accounts.employe.pw, email_confirm: true, user_metadata: { account_type: 'employe', role: 'employe', name: 'Emp Audit', username: accounts.employe.username, phone: '', must_change_password: true } });
  if (!emp.data?.user?.id) throw new Error('emp createUser: ' + emp.error?.message);
  createdUids.push(emp.data.user.id);
  try { await sb.from('employes').insert({ user_id: owner.data.user.id, account_uid: emp.data.user.id, username: accounts.employe.username, nom: 'Emp Audit', salaire: 100000, statut: 'actif' }); } catch (e) { console.log('warn fiche employe:', e.message); }

  for (const key of ['owner', 'locataire', 'employe']) {
    const a = accounts[key];
    const r = await login(a.email, a.pw);
    cookieByRole[key] = 'mim_token=' + r.token;
    check(`login ${key} -> 200`, r.status === 200 && r.token, `status=${r.status}`);
  }
  const adminLogin = await login('admin@mim.local', 'Admin1234!');
  cookieByRole['admin'] = 'mim_token=' + adminLogin.token;
  check('login admin -> 200', adminLogin.status === 200 && adminLogin.token, `status=${adminLogin.status}`);

  const pageMatrix = [
    ['admin',  '/PartAdmin/admin.html', 200],
    ['owner',  '/PartProprietaires/dashboard.html', 200],
    ['owner',  '/PartProprietaires/employes.html', 200],
    ['locataire', '/PartLocataires/LocaDash.html', 200],
    ['locataire', '/PartLocataires/paiements.html', 200],
    ['employe', '/PartEmployes/employe.html', 200],
    ['admin',  '/PartProprietaires/dashboard.html', 302],
    ['owner',  '/PartAdmin/admin.html', 302],
    ['owner',  '/PartLocataires/LocaDash.html', 302],
    ['owner',  '/PartEmployes/employe.html', 302],
    ['locataire', '/PartProprietaires/dashboard.html', 302],
    ['locataire', '/PartEmployes/employe.html', 302],
    ['employe', '/PartProprietaires/dashboard.html', 302],
    ['employe', '/PartLocataires/LocaDash.html', 302],
  ];
  for (const [role, url, expected] of pageMatrix) {
    const got = await page(role, url);
    check(`page ${role} ${url} = ${expected}`, got === expected, `got=${got}`);
  }

  const apiMatrix = [
    ['owner', 'GET', '/api/stats/dashboard', 200],
    ['owner', 'GET', '/api/employes', 200],
    ['owner', 'GET', '/api/tasks', 200],
    ['owner', 'GET', '/api/biens', 200],
    ['owner', 'GET', '/api/locataires', 200],
    ['admin', 'GET', '/api/admin/stats', 200],
    ['locataire', 'GET', '/api/locataire/dashboard', 200],
    ['locataire', 'GET', '/api/employes', 403],
    ['locataire', 'POST', '/api/employes', 403],
    ['locataire', 'POST', '/api/tasks', 403],
    ['locataire', 'GET', '/api/stats/dashboard', 403],
    ['locataire', 'GET', '/api/admin/stats', 403],
    ['locataire', 'GET', '/api/biens', 403],
    ['locataire', 'POST', '/api/locataires', 403],
    ['employe', 'GET', '/api/employe/me', 200],
    ['employe', 'GET', '/api/employe/dashboard', 200],
    ['employe', 'GET', '/api/employes', 403],
    ['employe', 'GET', '/api/locataire/dashboard', 403],
    ['employe', 'POST', '/api/employes', 403],
    ['admin', 'GET', '/api/biens', 403],
    ['admin', 'GET', '/api/employes', 403],
    ['owner', 'GET', '/api/employe/me', 403],
    ['owner', 'GET', '/api/locataire/dashboard', 403],
  ];
  for (const [role, method, url, expected] of apiMatrix) {
    const got = await api(role, method, url);
    check(`api ${role} ${method} ${url} = ${expected}`, got === expected, `got=${got}`);
  }

  const ownerUid = owner.data.user.id;
  const banRes = await api('admin', 'PATCH', '/api/admin/proprietaires/' + ownerUid, { statut: 'suspendu' });
  check('admin suspend owner -> 200', banRes === 200, `got=${banRes}`);
  check('owner page après ban -> 302', (await page('owner', '/PartProprietaires/dashboard.html')) === 302);
  check('owner api après ban -> 401', (await api('owner', 'GET', '/api/employes')) === 401);
  await api('admin', 'PATCH', '/api/admin/proprietaires/' + ownerUid, { statut: 'actif' });
  check('owner page après réactivation -> 200', (await page('owner', '/PartProprietaires/dashboard.html')) === 200);

  await sb.from('profiles').update({ account_type: 'locataire' }).eq('id', ownerUid);
  check('owner rétrogradé -> PartProprietaires 302', (await page('owner', '/PartProprietaires/dashboard.html')) === 302);
  check('owner rétrogradé -> /api/employes 403', (await api('owner', 'GET', '/api/employes')) === 403);
  check('owner rétrogradé -> PartLocataires 200', (await page('owner', '/PartLocataires/LocaDash.html')) === 200);
  await sb.from('profiles').update({ account_type: 'proprietaire' }).eq('id', ownerUid);
  check('owner restauré -> PartProprietaires 200', (await page('owner', '/PartProprietaires/dashboard.html')) === 200);

} catch (err) {
  fail++;
  results.push('FAIL EXCEPTION ' + err.message);
} finally {
  await cleanup(createdUids);
  let rest = 0;
  if (createdUids.length) {
    const { count } = await sb.from('profiles').select('id', { count: 'exact' }).in('id', createdUids);
    rest = count || 0;
  }
  const { count: locLeft } = await sb.from('locataires').select('id', { count: 'exact' }).eq('username', accounts.locataire.username);
  const { count: empLeft } = await sb.from('employes').select('id', { count: 'exact' }).eq('username', accounts.employe.username);
  console.log('profiles restants:', rest, '| fiches locataires restantes:', locLeft || 0, '| fiches employes restantes:', empLeft || 0);
  console.log('RÉSULTATS: ' + pass + ' PASS / ' + fail + ' FAIL');
  for (const r of results) console.log('  ' + r);
  process.exit(fail ? 1 : 0);
}
