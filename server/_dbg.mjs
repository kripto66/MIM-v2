const BASE = 'http://localhost:3000';
const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'owner.test20260812@example.com', password: 'OwnerTest2026!' }),
});
const loginText = await login.text();
console.log('login status:', login.status, '| body:', loginText.slice(0, 80));
const cookie = login.headers.get('set-cookie').split(';')[0];
console.log('cookie head:', cookie.slice(0, 30));

const r = await fetch(`${BASE}/api/locataires`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ nom: 'Direct Test', username: 'direct.test2', password: 'DirectTest2026!' }),
  redirect: 'manual',
});
console.log('POST status:', r.status);
console.log('POST location:', r.headers.get('location'));
console.log('POST body:', (await r.text()).slice(0, 200));
