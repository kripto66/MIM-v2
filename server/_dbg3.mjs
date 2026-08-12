const BASE = 'http://localhost:3000';
let cookie = '';

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner.test20260812@example.com', password: 'OwnerTest2026!' }),
  });
  const d = await r.json();
  if (!d.success) throw new Error('login failed');
  cookie = r.headers.get('set-cookie').split(';')[0];
}

async function req(path, method = 'GET', body = null) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  console.log(`[req] ${method} ${path} -> ${r.status} | ${text.slice(0, 80)}`);
  return JSON.parse(text || '{}');
}

await login();
console.log('login OK, cookie len:', cookie.length);

try {
  const list = await req('/locataires');
  console.log('cleanup GET ok, rows:', list.data.length);
} catch (e) {
  console.log('cleanup GET failed:', e.message);
}

const rnd = Date.now().toString().slice(-6);
try {
  const created = await req('/locataires', 'POST', {
    nom: 'Test Fusion ' + rnd,
    username: `test.merge.${rnd}`,
    password: 'FusionTest2026!',
    logement: { bien_id: 2, nom: 'Appt ' + rnd, type: 'chambre', loyer_mensuel: '10000', adresse: 'X' },
  });
  console.log('POST ok, id:', created.data?.id);
} catch (e) {
  console.log('POST failed:', e.message);
}
