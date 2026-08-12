const BASE = 'http://localhost:3000';

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'owner.test20260812@example.com', password: 'OwnerTest2026!' }),
});
const cookie = login.headers.get('set-cookie').split(';')[0];
console.log('login status:', login.status, '| cookie len:', cookie.length);

const r = await fetch(`${BASE}/api/locataires`, { headers: { cookie } });
console.log('GET /api/locataires ->', r.status);
console.log('FULL BODY:');
console.log(await r.text());
