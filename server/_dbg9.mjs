const BASE = 'http://localhost:3000';

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'owner.test20260812@example.com', password: 'OwnerTest2026!' }),
});
const cookie = login.headers.get('set-cookie').split(';')[0];

for (let i = 1; i <= 5; i++) {
  const r = await fetch(`${BASE}/api/locataires`, {
    headers: { cookie, 'content-type': 'application/json' },
  });
  const text = await r.text();
  const ok = text.startsWith('{"success":true');
  console.log(`req ${i}: ${r.status} ${ok ? 'JSON OK' : '--- ' + text.slice(0, 60)}`);
}
