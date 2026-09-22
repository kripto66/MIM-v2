import 'dotenv/config';
const BASE = 'http://localhost:3000/api';
async function req(path, { method = 'GET', jar, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(jar ? { cookie: jar } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return { status: res.status, data: await res.json().catch(() => null), jar: setCookies.length ? setCookies.join('; ') : jar };
}
const email = `diag${Date.now() % 100000000}@test.mim`;
let r = await req('/auth/register', { method: 'POST', body: { account_type: 'proprietaire', name: 'Diag', email, phone: '+221771000001', password: 'Test1234!', password_confirm: 'Test1234!' } });
console.log('register', r.status, r.data?.success);
r = await req('/auth/login', { method: 'POST', body: { identifier: email, password: 'Test1234!' } });
const jar = r.jar; console.log('login', r.status, jar ? 'cookie OK' : 'NO COOKIE');
r = await req('/subscription/plans', { jar });
console.log('plans', r.status, JSON.stringify(r.data?.plans?.map((p) => ({ code: p.code, prix: p.prix, duree: p.duree_abonnement })) || r.data));
r = await req('/subscription/checkout', { method: 'POST', jar, body: { plan: 'standard' } });
console.log('checkout', r.status, JSON.stringify(r.data?.checkout || r.data));
r = await req('/subscription/checkout/refresh', { method: 'POST', jar });
console.log('refresh', r.status, JSON.stringify(r.data));
r = await req('/subscription/me', { jar });
console.log('me', r.status, JSON.stringify(r.data?.subscription?.statut), r.data?.message || '');
process.exit(0);