// ============================================================
// MIM — LOADTEST : PHASE 20 — Vérification de la base
//   Comptages exacts + orphelins + cohérence via psql (docker).
//   Sortie : results-db.json
// ============================================================
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { service, loadState, LT, ownerEmail, tenantUsername } from './common.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const state = loadState();
// Sous-requête au lieu de la liste inline d'UUID (évite la limite de longueur
// de ligne de commande Windows ~8191 car. et reste correct après un re-seed).
const ownerSubq = "SELECT id FROM auth.users WHERE email LIKE 'loadtest.owner.%'";

function sql(q) {
  const out = execSync(
    `docker exec supabase_db_MIM psql -U postgres -d postgres -t -A -F, -c "${q.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  return out.trim();
}

const checks = [];
function add(name, ok, detail = '') { checks.push({ name, ok, detail }); }

async function main() {
  console.log('PHASE 20 — Vérification de la base (psql/service)\n');

  // --- Comptages globaux ---
  for (const t of ['profiles', 'biens', 'logements', 'locataires', 'paiements', 'incidents', 'prestataires', 'interventions', 'notifications', 'sessions']) {
    const n = sql(`SELECT count(*) FROM public.${t};`);
    add(`global ${t}`, true, `n=${n}`);
  }
  const authUsers = sql('SELECT count(*) FROM auth.users;');
  add('global auth.users', true, `n=${authUsers}`);

  // --- Comptages loadtest (par les propriétaires) ---
  const lt = {
    locataires: sql(`SELECT count(*) FROM public.locataires WHERE user_id IN (${ownerSubq});`),
    logements: sql(`SELECT count(*) FROM public.logements WHERE user_id IN (${ownerSubq});`),
    paiements: sql(`SELECT count(*) FROM public.paiements WHERE user_id IN (${ownerSubq});`),
    biens: sql(`SELECT count(*) FROM public.biens WHERE user_id IN (${ownerSubq});`),
    incidents: sql(`SELECT count(*) FROM public.incidents WHERE user_id IN (${ownerSubq});`),
    prestataires: sql(`SELECT count(*) FROM public.prestataires WHERE user_id IN (${ownerSubq});`),
    interventions: sql(`SELECT count(*) FROM public.interventions WHERE user_id IN (${ownerSubq});`),
    notifications: sql(`SELECT count(*) FROM public.notifications WHERE user_id IN (${ownerSubq});`),
    sessions: sql(`SELECT count(*) FROM public.sessions WHERE user_id IN (${ownerSubq});`),
  };
  const OWNERS = LT.owners, PER = LT.perOwner;
  const expected = { locataires: OWNERS * PER, logements: OWNERS * PER, paiements: OWNERS * PER, biens: OWNERS, prestataires: OWNERS, interventions: OWNERS };
  for (const [k, v] of Object.entries(expected)) {
    add(`loadtest ${k} = ${v}`, Number(lt[k]) === v, `reçu ${lt[k]}`);
  }
  add(`loadtest incidents = ${OWNERS * 2}`, Number(lt.incidents) === OWNERS * 2, `reçu ${lt.incidents}`);
  add(`loadtest notifications (prévu ≥ ${OWNERS * PER * 3})`, Number(lt.notifications) >= OWNERS * PER * 3, `reçu ${lt.notifications}`);
  add('loadtest sessions (logins/logouts) > 0', Number(lt.sessions) > 0, `reçu ${lt.sessions}`);

  // --- Orphelins ---
  const orphans = {
    'paiements sans locataire': sql(`SELECT count(*) FROM public.paiements p LEFT JOIN public.locataires l ON l.id = p.locataire_id WHERE p.user_id IN (${ownerSubq}) AND l.id IS NULL;`),
    'locataires sans logement': sql(`SELECT count(*) FROM public.locataires WHERE user_id IN (${ownerSubq}) AND logement_id IS NULL;`),
    'locataires sur logement absent': sql(`SELECT count(*) FROM public.locataires lo LEFT JOIN public.logements lg ON lg.id = lo.logement_id WHERE lo.user_id IN (${ownerSubq}) AND lo.logement_id IS NOT NULL AND lg.id IS NULL;`),
    'logements sans bien': sql(`SELECT count(*) FROM public.logements WHERE user_id IN (${ownerSubq}) AND bien_id IS NULL;`),
    'logements sur bien absent': sql(`SELECT count(*) FROM public.logements lo LEFT JOIN public.biens b ON b.id = lo.bien_id WHERE lo.user_id IN (${ownerSubq}) AND lo.bien_id IS NOT NULL AND b.id IS NULL;`),
    'incidents sans logement': sql(`SELECT count(*) FROM public.incidents WHERE user_id IN (${ownerSubq}) AND logement_id IS NULL;`),
    'incidents sur logement absent': sql(`SELECT count(*) FROM public.incidents i LEFT JOIN public.logements lg ON lg.id = i.logement_id WHERE i.user_id IN (${ownerSubq}) AND i.logement_id IS NOT NULL AND lg.id IS NULL;`),
    'interventions sans incident': sql(`SELECT count(*) FROM public.interventions WHERE user_id IN (${ownerSubq}) AND incident_id IS NULL;`),
    'interventions sans prestataire': sql(`SELECT count(*) FROM public.interventions WHERE user_id IN (${ownerSubq}) AND prestataire_id IS NULL;`),
    'prestataires sans intervention (possibles)': sql(`SELECT count(*) FROM public.prestataires pr LEFT JOIN public.interventions i ON i.prestataire_id = pr.id WHERE pr.user_id IN (${ownerSubq}) AND i.id IS NULL;`),
    'fiches locataires sans compte (account_uid NULL)': sql(`SELECT count(*) FROM public.locataires WHERE user_id IN (${ownerSubq}) AND account_uid IS NULL;`),
    'fiches locataires avec compte supprimé': sql(`SELECT count(*) FROM public.locataires lo LEFT JOIN auth.users u ON u.id = lo.account_uid WHERE lo.user_id IN (${ownerSubq}) AND lo.account_uid IS NOT NULL AND u.id IS NULL;`),
    'notifications sans utilisateur': sql(`SELECT count(*) FROM public.notifications n LEFT JOIN auth.users u ON u.id = n.user_id WHERE n.user_id IN (${ownerSubq}) AND u.id IS NULL;`),
    'sessions sans utilisateur': sql(`SELECT count(*) FROM public.sessions s LEFT JOIN auth.users u ON u.id = s.user_id WHERE s.user_id IN (${ownerSubq}) AND u.id IS NULL;`),
  };
  for (const [k, v] of Object.entries(orphans)) {
    add(`orphelin ${k}`, Number(v) === 0, `reçu ${v}`);
  }

  // --- Cohérence occupation ---
  const occupeSansActif = sql(`SELECT count(*) FROM public.logements lg WHERE lg.user_id IN (${ownerSubq}) AND lg.statut='occupe' AND NOT EXISTS (SELECT 1 FROM public.locataires lo WHERE lo.logement_id = lg.id AND lo.statut='actif');`);
  add('logements "occupe" sans locataire actif', Number(occupeSansActif) === 0, `reçu ${occupeSansActif}`);
  const libreAvecActif = sql(`SELECT count(*) FROM public.logements lg WHERE lg.user_id IN (${ownerSubq}) AND lg.statut='libre' AND EXISTS (SELECT 1 FROM public.locataires lo WHERE lo.logement_id = lg.id AND lo.statut='actif');`);
  add('logements "libre" avec locataire actif', Number(libreAvecActif) === 0, `reçu ${libreAvecActif}`);

  // --- Doublons / email interne ---
  const dupUsernames = sql(`SELECT count(*) FROM (SELECT username FROM public.profiles WHERE username LIKE 'loadtest.%' GROUP BY username HAVING count(*) > 1) d;`);
  add('doublons de username loadtest', Number(dupUsernames) === 0, `reçu ${dupUsernames}`);
  const badEmail = sql(`SELECT count(*) FROM public.profiles WHERE username LIKE 'loadtest.tenant.%' AND email <> username || '@mim.local';`);
  add('email interne = username@mim.local', Number(badEmail) === 0, `reçu ${badEmail}`);
  const mustChange = sql(`SELECT count(*) FROM public.profiles WHERE username LIKE 'loadtest.tenant.%' AND must_change_password = true;`);
  const tenantsTotal = Number(lt.locataires);
  const changedCount = (state.tenantPasswordChanged?.length || 0) + 1; // +1 : locataire (1,3) passé par le flux frontend P18
  add('must_change_password reset sur comptes testés', Number(mustChange) === tenantsTotal - changedCount, `reçu ${mustChange} (attendu ${tenantsTotal - changedCount}, ${changedCount} changés: phase 5 + frontend)`);

  // --- RLS : le client anon (clé publique) ne lit rien ---
  const anonClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data: anonRes, error: anonErr } = await anonClient.from('logements').select('id').limit(1);
  add('RLS : client anon ne lit pas de logements', anonErr !== null && (anonRes?.length ?? 0) === 0, `err=${anonErr?.message || 'aucune'} n=${anonRes?.length}`);

  // --- Sommes paiements vs loyers (cohérence financière) ---
  const sums = sql(`SELECT (SELECT sum(montant) FROM public.paiements WHERE user_id IN (${ownerSubq}))::bigint AS total, (SELECT sum(loyer_mensuel) FROM public.logements WHERE user_id IN (${ownerSubq}) AND statut='occupe')::bigint AS loyers, (SELECT count(*) FROM public.paiements WHERE user_id IN (${ownerSubq}) AND statut='paye') AS payes, (SELECT count(*) FROM public.paiements WHERE user_id IN (${ownerSubq}) AND statut='attente') AS attentes, (SELECT count(*) FROM public.paiements WHERE user_id IN (${ownerSubq}) AND statut='retard') AS retards;`);
  add('somme paiements = somme loyers occupés', true, sums);
  const [totalP, totalL, payes, attentes, retards] = sums.split(',');
  add('cohérence montants (paiements = loyers)', Number(totalP) === Number(totalL), `paiements=${totalP} loyers=${totalL}`);
  const tot = Number(payes) + Number(attentes) + Number(retards);
  const third = Math.floor(tot / 3);
  add('répartition statuts ~1/3 chacun', Number(payes) >= third - 5 && Number(attentes) >= third - 5 && Number(retards) >= third - 5, `paye=${payes} attente=${attentes} retard=${retards} (≈1/3 de ${tot})`);

  const out = { generatedAt: new Date().toISOString(), counts: { lt, orphans }, checks };
  fs.writeFileSync(path.join(__dirname, 'results-db.json'), JSON.stringify(out, null, 2));

  let fails = 0;
  console.log('──────────────────────────────────────────');
  for (const c of checks) {
    if (c.ok) console.log(`  ✅ ${c.name} — ${c.detail}`);
    else { console.log(`  ❌ ${c.name} — ${c.detail}`); fails++; }
  }
  console.log('──────────────────────────────────────────');
  console.log(`PHASE 20 — ${checks.length} vérifs, ${fails} échec(s) → results-db.json`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('[verify-db]', e); process.exit(1); });
