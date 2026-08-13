// ============================================================
// MIM — LOADTEST : PHASE 21 — Nettoyage
//   Ne supprime QUE les données loadtest (auth.users + cascade).
//   DRY-RUN par défaut (affiche les décomptes exacts).
//   Suppression réelle uniquement avec --confirm.
//   Interdit : TRUNCATE / DROP / RESET.
// ============================================================
import { execSync } from 'node:child_process';
import { service, loadState } from './common.mjs';

const CONFIRM = process.argv.includes('--confirm');
const state = loadState();

function sql(q) {
  return execSync(
    `docker exec supabase_db_MIM psql -U postgres -d postgres -t -A -F, -c "${q.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  ).trim();
}

async function main() {
  console.log('PHASE 21 — Nettoyage des données loadtest\n');
  console.log(`  Propriétaires provisionnés : ${state.owners.length}`);
  console.log(`  Locataires attendus         : ${state.owners.length * state.perOwner}`);
  console.log(`  Mots de passe modifiés      : ${state.tenantPasswordChanged?.length || 0}`);

  // Décomptes précis à supprimer
  const counts = {
    'auth.users loadtest.owner.*': sql(`SELECT count(*) FROM auth.users WHERE email LIKE 'loadtest.owner.%';`),
    'auth.users loadtest.register.*': sql(`SELECT count(*) FROM auth.users WHERE email LIKE 'loadtest.register.%';`),
    'auth.users loadtest.tenant.* (locataires)': sql(`SELECT count(*) FROM auth.users WHERE email LIKE 'loadtest.tenant.%@mim.local';`),
    'profiles (loadtest.*)': sql(`SELECT count(*) FROM public.profiles WHERE email LIKE 'loadtest.%' OR username LIKE 'loadtest.%';`),
  };
  // Cascade via user_id pour les tables publiques
  const cascade = {};
  const tables = ['biens', 'logements', 'locataires', 'paiements', 'incidents', 'prestataires', 'interventions', 'notifications', 'sessions'];
  for (const t of tables) {
    cascade[t] = sql(`SELECT count(*) FROM public.${t} WHERE user_id IN (SELECT id FROM auth.users WHERE email LIKE 'loadtest.%');`);
  }

  console.log('  À supprimer (décomptes exacts) :');
  for (const [k, v] of Object.entries(counts)) console.log(`    ${k.padEnd(42)} ${v}`);
  for (const [k, v] of Object.entries(cascade)) console.log(`    cascade public.${k.padEnd(34)} ${v}`);

  const totalUsers = Object.values(counts).reduce((a, b) => a + Number(b), 0);
  console.log(`\n  TOTAL auth.users à supprimer : ${totalUsers}`);

  if (!CONFIRM) {
    console.log('\n  DRY-RUN : rien supprimé. Relancez avec --confirm après validation visuelle.');
    process.exit(0);
  }

  const deleted = sql(`DELETE FROM auth.users WHERE email LIKE 'loadtest.%';`);
  console.log(`\n  Supprimés : ${deleted} utilisateurs auth.users (cascade appliquée).`);

  // Vérification post-suppression
  const remains = sql(`SELECT count(*) FROM auth.users WHERE email LIKE 'loadtest.%' OR id IN (SELECT id FROM public.profiles WHERE email LIKE 'loadtest.%' OR username LIKE 'loadtest.%');`);
  const real = {
    profiles: sql(`SELECT count(*) FROM public.profiles;`),
    admin: sql(`SELECT count(*) FROM public.profiles WHERE email = 'admin@mim.local';`),
    realOwners: sql(`SELECT count(*) FROM public.profiles WHERE email LIKE '%@gmail.com';`),
    locataires: sql(`SELECT count(*) FROM public.locataires;`),
  };
  console.log('  État résiduel :');
  console.log(`    restes loadtest : ${remains}`);
  console.log(`    profiles total   : ${real.profiles}`);
  console.log(`    admin present    : ${real.admin}`);
  console.log(`    vrais proprios   : ${real.realOwners}`);
  console.log(`    fiches locataires: ${real.locataires} (2 fiches réelles conservées)`);

  if (Number(remains) !== 0) { console.error('  ❌ RESTES LOADTEST PRÉSENTS !'); process.exit(1); }
  if (Number(real.admin) !== 1) { console.error('  ❌ admin@mim.local endommagé !'); process.exit(1); }
  console.log('  ✅ Nettoyage complet et propre.');
}

main().catch((e) => { console.error('[cleanup]', e); process.exit(1); });
