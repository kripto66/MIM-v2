const BASE = 'http://localhost:3000';
const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'owner.test20260812@example.com', password: 'OwnerTest2026!' }),
});
const cookie = login.headers.get('set-cookie').split(';')[0];

for (let i = 0; i < 6; i++) {
  try {
    const r = await fetch(`${BASE}/api/locataires`, { headers: { cookie } });
    const text = await r.text();
    console.log(`--- GET ${i}: status=${r.status} ctype=${r.headers.get('content-type')}`);
    console.log('    body head:', JSON.stringify(text.slice(0, 150)));
  } catch (e) {
    console.log(`--- GET ${i}: ERROR ${e.message}`);
  }
}
