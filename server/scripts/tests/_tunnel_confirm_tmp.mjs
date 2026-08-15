// ============================================================
// MIM - Flux « Confirmer mon paiement » sur un paiement RÉELLEMENT
// confirmé par le webhook UnitechPay via le tunnel (statut a_confirmer).
//   locataire confirme  -> en_validation
//   propriétaire valide -> paye
//   + vérifications de cloisonnement (A vs B)
// ============================================================
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const envPath = 'C:\\xampp\\htdocs\\MIM2.1\\MIM\\server\\.env';
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim();
}

const BASE = 'http://localhost:3000/api';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${ok ? '' : `  (${detail})`}`);
  ok ? pass++ : fail++;
}

async function api(path, { method = 'GET', jar = '', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (jar) headers.cookie = jar;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  return { status: res.status, data, cookie: res.headers.get('set-cookie') || '' };
}

// --- Dernier paiement a_confirmer de owner1 (confirmé par webhook réel) ---
const { data: owner } = await sb.from('profiles').select('id').eq('email', 'owner1@mimtest.com').single();
const { data: paiement } = await sb
  .from('paiements')
  .select('id, locataire_id, montant, mois, statut, reference, user_id')
  .eq('user_id', owner.id)
  .eq('statut', 'a_confirmer')
  .order('created_at', { ascending: false })
  .limit(1)
  .maybeSingle();
if (!paiement) { console.error('Aucun paiement a_confirmer trouvé'); process.exit(1); }
console.log(`Paiement cible : id=${paiement.id} statut=${paiement.statut} référence=${String(paiement.reference).slice(0, 12)}…`);

// Remise à zéro propre du paiement (test itérable, données de test uniquement).
await sb.from('paiements').update({ statut: 'a_confirmer' }).eq('id', paiement.id);

const { data: loc } = await sb.from('locataires').select('id, username').eq('id', paiement.locataire_id).single();
const loginT = await api('/auth/login', { method: 'POST', body: { identifier: loc.username, password: 'Test1234!' } });
check('connexion locataire', loginT.status === 200, String(loginT.status));
const jarT = loginT.cookie;

const loginO = await api('/auth/login', { method: 'POST', body: { identifier: 'owner1@mimtest.com', password: 'Test1234!' } });
check('connexion propriétaire', loginO.status === 200, String(loginO.status));
const jarO = loginO.cookie;

// --- Cloisonnement : locataire d'un AUTRE propriétaire -> 404 ---
const { data: otherLoc } = await sb
  .from('locataires')
  .select('username')
  .eq('user_id', (await sb.from('profiles').select('id').eq('email', 'owner2@mimtest.com').single()).data.id)
  .limit(1)
  .maybeSingle();
if (otherLoc) {
  const loginB = await api('/auth/login', { method: 'POST', body: { identifier: otherLoc.username, password: 'Test1234!' } });
  const foreign = await api(`/locataire/paiements/${paiement.id}/confirmer`, { method: 'POST', jar: loginB.cookie });
  check('locataire B ne peut pas confirmer le paiement de A -> 404', foreign.status === 404, `statut ${foreign.status}`);
}

// --- Confirmation nominale du locataire ---
const confirm = await api(`/locataire/paiements/${paiement.id}/confirmer`, { method: 'POST', jar: jarT });
check('confirmation locataire -> 200 (en_validation)', confirm.status === 200, `${confirm.status} ${JSON.stringify(confirm.data)}`);
const { data: afterC } = await sb.from('paiements').select('statut').eq('id', paiement.id).single();
check('paiement -> en_validation', afterC.statut === 'en_validation', afterC.statut);

// --- Le locataire ne peut pas valider lui-même (/unitech/valider réservé propriétaire) ---
const tenantValidate = await api('/unitech/valider', { method: 'POST', jar: jarT, body: { paiement_id: paiement.id, action: 'valider' } });
check('locataire ne peut pas valider lui-même (403)', tenantValidate.status === 403, `statut ${tenantValidate.status}`);

// --- Propriétaire d'un AUTRE compte -> 404 ---
const otherOwner = { email: 'owner2@mimtest.com' };
{
  const loginB = await api('/auth/login', { method: 'POST', body: { identifier: otherOwner.email, password: 'Test1234!' } });
  const foreignV = await api('/unitech/valider', { method: 'POST', jar: loginB.cookie, body: { paiement_id: paiement.id, action: 'valider' } });
  check('propriétaire B ne peut pas valider le paiement de A -> 404', foreignV.status === 404, `statut ${foreignV.status}`);
}

// --- Validation métier du propriétaire A -> paye ---
const validate = await api('/unitech/valider', { method: 'POST', jar: jarO, body: { paiement_id: paiement.id, action: 'valider' } });
check('validation propriétaire -> 200 (paye)', validate.status === 200 && validate.data?.success === true, `${validate.status} ${JSON.stringify(validate.data)}`);
const { data: afterV } = await sb.from('paiements').select('statut, date_paiement').eq('id', paiement.id).single();
check('paiement -> paye', afterV.statut === 'paye', afterV.statut);
check('date_paiement renseignée', Boolean(afterV.date_paiement), String(afterV.date_paiement));

// --- Double validation -> 400 ---
const again = await api('/unitech/valider', { method: 'POST', jar: jarO, body: { paiement_id: paiement.id, action: 'valider' } });
check('double validation -> 400 (déjà traité)', again.status === 400, `statut ${again.status}`);

// --- Notification propriétaire créée ? ---
const { data: notifs } = await sb.from('notifications').select('id').eq('user_id', owner.id).order('created_at', { ascending: false }).limit(5);
console.log('  → dernières notifications propriétaire :', notifs.length, 'ligne(s)');

console.log(`\nRÉSULTAT : ${pass} PASS, ${fail} FAIL`);
process.exit(fail > 0 ? 1 : 0);