import http from 'node:http';

const BASE = 'http://localhost:3000';

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'owner.test20260812@example.com', password: 'OwnerTest2026!' }),
});
const cookie = login.headers.get('set-cookie').split(';')[0];

function rawReq() {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost', port: 3000, path: '/api/locataires', method: 'GET',
      headers: { cookie, 'content-type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve(`${res.statusCode} | ${data.slice(0, 50)}`));
    });
    req.on('error', reject);
    req.end();
  });
}

const undici = await fetch(`${BASE}/api/locataires`, {
  headers: { cookie, 'content-type': 'application/json' },
});
console.log('undici GET + content-type  ->', undici.status, (await undici.text()).slice(0, 50));
console.log('raw http GET + content-type ->', await rawReq());
