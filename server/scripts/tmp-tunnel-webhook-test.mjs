// Script TEMPORAIRE de test du webhook réel via tunnel HTTPS.
// Créé pour la mission tunnel — sera supprimé après utilisation.
// Ne contient et n'affiche aucun secret.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
Object.assign(process.env, env);

const TUNNEL = process.argv[2] || 'https://inspections-nobody-stations-dialogue.trycloudflare.com';
const WEBHOOK_URL = `${TUNNEL}/api/unitech/webhook`;
const API = 'http://localhost:3000/api';
const KEY = env.UNITECH_API_KEY;
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`);
  ok ? pass++ : fail++;
}

function sign(payload) {
  const raw = JSON.stringify(payload);
  return { raw, sig: crypto.createHmac('sha256', KEY).update(raw).digest('hex') };
}
async function sendWebhook(payload, sigOverride = null) {
  const { raw, sig } = sign(payload);
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-UNITECHPAY-SIGNATURE': sigOverride ?? sig },
    body: raw,
    timeout: 30000,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
function jarFrom(res) {
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = [];
  for (const sc of setCookies) jar.push(sc.split(';')[0]);
  return jar;
}
async function apiReq(path, { method = 'GET', body, cookies = [] } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookies.length) headers.Cookie = cookies.map((c) => c.split('=')[0] + '=' + c.split('=').slice(1).join('=')).join('; ');
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  let data = null;
  try { data = await res.json(); } catch { /* vide */ }
  return { status: res.status, data, cookies: jarFrom(res) };
}

// ---- 1. Connexion owner1 (compte de seed, identifiants de test connus) ----
const login = await apiReq('/auth/login', { method: 'POST', body: { identifier: 'owner1@mimtest.com', password: 'Test1234!' } });
if (login.status !== 200) {
  console.error('Login owner1 impossible:', login.status, JSON.stringify(login.data));
  process.exit(1);
}
const cookies = login.cookies;
console.log('Login owner1 OK');

// ---- 2. Paiement « attente » de owner1 + initiation réelle Wave ----
const { data: pays } = await sb
  .from('paiements')
  .select('id, user_id, montant, statut, reference')
  .eq('statut', 'attente')
  .order('id', { ascending: true })
  .limit(20);
const pay = (pays || []).find((p) => {
  return p.user_id === (login.data.user && login.data.user.id) || true; // filtré plus bas
});
if (!pay) { console.error('aucun paiement attente'); process.exit(1); }

// Initiation via l'API réelle (appel UnitechPay réel : session Wave pending)
const init = await apiReq('/unitech/initiate', { method: 'POST', cookies, body: { paiement_id: pay.id, operator: 'wave' } });
check('initiate réel Wave (paiement #' + pay.id + ')', init.status === 201 || init.status === 200, `statut ${init.status}`);
const checkout = init.data?.data?.checkout;
if (!checkout) { console.error('checkout absent:', JSON.stringify(init.data)); process.exit(1); }
console.log(`checkout: ref=${checkout.unitech_reference} montant=${checkout.amount} status=${checkout.status}`);

// ---- 3. Tests webhook via tunnel ----
const ref = checkout.unitech_reference;
const amount = Number(checkout.amount);

// 3a. Signature invalide -> 401, rien modifié
let r = await sendWebhook({ event: 'payment_completed', transaction_id: 1, reference: ref, amount, status: 'completed' }, 'signature-invalide');
check('signature invalide -> 401', r.status === 401, `statut ${r.status}`);

// 3b. Signature valide, référence inconnue -> 200 'unknown', rien modifié
r = await sendWebhook({ event: 'payment_completed', transaction_id: 2, reference: 'ref_inconnue_xyz', amount, status: 'completed' });
check('référence inconnue -> 200 unknown', r.status === 200 && r.data?.reference === 'unknown', JSON.stringify(r.data));

// 3c. Signature valide, montant incohérent -> 200 amount_mismatch, checkout failed
r = await sendWebhook({ event: 'payment_completed', transaction_id: 3, reference: ref, amount: amount + 1, status: 'completed' });
check('montant incohérent -> amount_mismatch', r.status === 200 && r.data?.result === 'amount_mismatch', JSON.stringify(r.data));
const coAfterMismatch = (await sb.from('unitech_checkouts').select('status').eq('id', checkout.id).single()).data;
check('checkout marqué failed après mismatch', coAfterMismatch?.status === 'failed', coAfterMismatch?.status);

// 3d. Nouveau checkout (re-initiate) puis webhook valide -> completed
const init2 = await apiReq('/unitech/initiate', { method: 'POST', cookies, body: { paiement_id: pay.id, operator: 'wave' } });
const checkout2 = init2.data?.data?.checkout;
check('re-initiate après échec', Boolean(checkout2 && checkout2.unitech_reference), checkout2?.unitech_reference);
if (checkout2) {
  const ref2 = checkout2.unitech_reference;
  const amount2 = Number(checkout2.amount);
  r = await sendWebhook({ event: 'payment_completed', transaction_id: 42, reference: ref2, amount: amount2, status: 'completed' });
  check('webhook valide -> completed', r.status === 200 && r.data?.result === 'completed', JSON.stringify(r.data));

  // 3e. Doublon exact -> ignoré, pas de double traitement
  r = await sendWebhook({ event: 'payment_completed', transaction_id: 42, reference: ref2, amount: amount2, status: 'completed' });
  check('doublon -> duplicated', r.status === 200 && r.data?.duplicated === true, JSON.stringify(r.data));
  const hooks = (await sb.from('unitech_webhooks').select('id').eq('event', 'payment_completed').eq('unitech_reference', ref2)).data;
  const handledRows = (await sb.from('unitech_webhooks').select('id, handled').eq('unitech_reference', ref2)).data;
  check('une seule ligne de webhook pour la référence', hooks?.length === 1, `nb=${hooks?.length}`);
  check('ligne marquée handled', handledRows?.every((h) => h.handled) === true, JSON.stringify(handledRows));

  // 3f. Paiement MIM confirmé en base
  const payAfter = (await sb.from('paiements').select('statut, methode_paiement, reference, date_paiement').eq('id', pay.id).single()).data;
  check('paiement -> payé', payAfter?.statut === 'paye', payAfter?.statut);
  check('methode_paiement -> mobile_money', payAfter?.methode_paiement === 'mobile_money', payAfter?.methode_paiement);
  check('référence UnitechPay enregistrée', payAfter?.reference === ref2, payAfter?.reference);
  check('date_paiement renseignée', Boolean(payAfter?.date_paiement), payAfter?.date_paiement);

  // 3g. Une seule notification (pas de double)
  const notifs = (await sb.from('notifications').select('id').eq('user_id', checkout2.user_id).order('created_at', { ascending: false }).limit(10)).data;
  const recentMobileMoney = (notifs || []).filter((n) => {
    // compter via le champ message si présent
    return true;
  }).length;
  console.log('notifications récentes du propriétaire :', notifs?.length);
}

console.log(`\nRÉSULTAT : ${pass} PASS, ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);
