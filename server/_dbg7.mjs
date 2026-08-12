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
  console.log(`[req] ${method} ${path} -> ${r.status}`);
  if (r.status >= 400) console.log('FULL BODY:\n' + text);
  return JSON.parse(text || '{}');
}

await login();
console.log('login OK');
await req('/locataires');
