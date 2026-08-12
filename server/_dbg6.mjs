const BASE = 'http://localhost:3000';

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'owner.test20260812@example.com', password: 'OwnerTest2026!' }),
});
const cookie = login.headers.get('set-cookie').split(';')[0];

async function t(label, opts) {
  const r = await fetch(`${BASE}/api/locataires`, { headers: { cookie, ...opts.headers }, ...opts });
  const text = await r.text();
  console.log(`${label} -> ${r.status} | ${text.slice(0, 60).replace(/\n/g, ' ')}`);
}

await t('A: cookie seul               ', {});
await t('B: cookie + content-type     ', { headers: { 'content-type': 'application/json' } });
await t('C: cookie + body undefined   ', { body: undefined });
await t('D: cookie + ct + body undef  ', { headers: { 'content-type': 'application/json' }, body: undefined });
await t('E: cookie + ct + body {}     ', { headers: { 'content-type': 'application/json' }, body: '{}' });
