const BASE = 'http://localhost:3030';
async function test(identifier, password) {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
    redirect: 'manual',
  });
  const body = await r.text();
  console.log(`${identifier} → status ${r.status} | ${body.slice(0, 200)}`);
}
await test('UltraEsNova', 'amdi2009&!');
await test('ultraesnova@mim.local', 'amdi2009&!');
