const r = await fetch('http://localhost:3000/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'owner.test20260812@example.com', password: 'OwnerTest2026!' }),
});
console.log('STATUS:', r.status);
console.log('CTYPE:', r.headers.get('content-type'));
console.log('LOCATION:', r.headers.get('location'));
console.log('SET-COOKIE:', r.headers.get('set-cookie'));
console.log('BODY:', (await r.text()).slice(0, 200));
