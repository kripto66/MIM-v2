// ============================================================
// MIM - Test SIGNÉ du webhook via le tunnel HTTPS temporaire
// (TEST RÉEL : payloads signés HMAC-SHA256 envoyés depuis le
//  poste local vers https://tunnel/api/unitech/webhook ->
//  Cloudflare -> localhost:3000)
//
// La clé API est lue depuis server/.env (jamais affichée).
// Un checkout Wave RÉEL est initié via l'API UnitechPay.
// ============================================================
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const envPath = 'C:\\xampp\\htdocs\\MIM2.1\\MIM\\server\\.env';
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
}

const TUNNEL = process.argv[2] || 'https://merchants-thinkpad-wishes-hub.trycloudflare.com';
const BASE = 'http://localhost:3000/api';
const KEY = process.env.UNITECH_API_KEY;
if (!KEY) { console.error('UNITECH_API_KEY absente'); process.exit(1); }

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function sign(raw) {
  return crypto.createHmac('sha256', KEY).update(raw).digest('hex');
}

async function sendWebhook(payloadObj, { raw = null, signature = null } = {}) {
  const rawBody = raw ?? JSON.stringify(payloadObj);
  const sig = signature ?? sign(rawBody);
  const res = await fetch(`${TUNNEL}/api/unitech/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-UNITECHPAY-SIGNATURE': sig },
    body: rawBody,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${ok ? '' : `  (${detail})`}`);
  ok ? pass++ : fail++;
}

// --- 1) Connexion propriétaire seed ---
const login = await fetch(BASE + '/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ identifier: 'owner1@mimtest.com', password: 'Test1234!' }),
});
const cookie = login.headers.get('set-cookie');
check('connexion owner1', login.status === 200, String(login.status));
if (!cookie) process.exit(1);

// --- 2) Paiement attente + checkout Wave RÉEL ---
const ownerId = (await sb.from('profiles').select('id').eq('email', 'owner1@mimtest.com').single()).data.id;
const { data: loc } = await sb
  .from('locataires')
  .select('id, phone')
  .eq('user_id', ownerId)
  .not('phone', 'is', null)
  .limit(1)
  .maybeSingle();
const { data: logement } = await sb.from('logements').select('id').eq('user_id', ownerId).limit(1).maybeSingle();

const pay = await fetch(BASE + '/paiements', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', cookie },
  body: JSON.stringify({ locataire_id: loc.id, logement_id: logement.id, montant: 25000, mois: '2026-08', statut: 'attente' }),
});
const payData = await pay.json();
const paiementId = payData.data?.id;
check('création paiement attente', pay.status === 201 && paiementId, JSON.stringify(payData));

const init = await fetch(BASE + '/unitech/initiate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', cookie },
  body: JSON.stringify({ paiement_id: paiementId, operator: 'wave' }),
});
const initData = await init.json();
const ref = initData.data?.checkout?.unitech_reference || initData.data?.reference;
check('initiation checkout Wave RÉEL', init.status === 201 && ref, JSON.stringify(initData).slice(0, 300));
console.log('  → payment_url :', initData.data?.payment_url || initData.data?.checkout?.payment_url || '(aucune)');
console.log('  → unitech_reference :', ref ? `${ref.slice(0, 10)}…` : '(aucune)');

// --- 3) Signature invalide -> 401 ---
const bad = await sendWebhook({ event: 'payment_completed', reference: ref, amount: 25000, status: 'completed' }, { signature: 'deadbeef' });
check('signature invalide -> 401', bad.status === 401, `${bad.status} ${JSON.stringify(bad.data)}`);

// --- 4) JSON invalide (signature valide) -> 400 ---
const badJson = await sendWebhook(null, { raw: '{ pas du json', signature: sign('{ pas du json') });
check('payload JSON invalide -> 400', badJson.status === 400, `${badJson.status} ${JSON.stringify(badJson.data)}`);

// --- 5) Référence inconnue (signature valide) -> rejet ---
const unknown = await sendWebhook({ event: 'payment_completed', reference: 'REF_INCONNUE_TUNNEL_TEST', amount: 25000, status: 'completed' });
check('référence inconnue -> rejet', unknown.status === 200 && unknown.data?.reference === 'unknown', `${unknown.status} ${JSON.stringify(unknown.data)}`);

// --- 6) Montant incohérent -> amount_mismatch ---
const mismatch = await sendWebhook({ event: 'payment_completed', reference: ref, amount: 99999, status: 'completed' });
check('montant incohérent -> amount_mismatch', mismatch.status === 200 && mismatch.data?.result === 'amount_mismatch', `${mismatch.status} ${JSON.stringify(mismatch.data)}`);

// --- 7) Webhook VALIDE -> completed -> paiement a_confirmer ---
const ok = await sendWebhook({ event: 'payment_completed', reference: ref, amount: 25000, status: 'completed' });
check('webhook valide -> completed', ok.status === 200 && ok.data?.result === 'completed', `${ok.status} ${JSON.stringify(ok.data)}`);
const after = await sb.from('paiements').select('statut, reference, methode_paiement, date_paiement').eq('id', paiementId).single();
check('paiement -> a_confirmer (pas directement payé)', after.data?.statut === 'a_confirmer', String(after.data?.statut));
check('methode = mobile_money', after.data?.methode_paiement === 'mobile_money', String(after.data?.methode_paiement));
check('référence enregistrée', after.data?.reference === ref, String(after.data?.reference));

// --- 8) Doublon -> pas de double traitement ---
const { data: webhookRows } = await sb.from('unitech_webhooks').select('id').eq('unitech_reference', ref);
const dup = await sendWebhook({ event: 'payment_completed', reference: ref, amount: 25000, status: 'completed' });
check('doublon -> duplicated', dup.status === 200 && dup.data?.duplicated === true, `${dup.status} ${JSON.stringify(dup.data)}`);
const { data: dupCheck } = await sb.from('paiements').select('statut').eq('id', paiementId).single();
check('paiement inchangé après doublon', dupCheck?.statut === 'a_confirmer', String(dupCheck?.statut));
check('aucune écriture webhook supplémentaire', webhookRows.length === 1, `found ${webhookRows.length}`);

console.log(`\nRÉSULTAT : ${pass} PASS, ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);