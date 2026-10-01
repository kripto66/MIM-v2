// ============================================================
// MIM - Lanceur de tests de bout en bout
//   node scripts/tests/run.js [--no-server] [--no-seed] [--suite auth]
// ============================================================

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, '..', '..');
dotenv.config({ path: path.join(SERVER_DIR, '.env') });
const { Runner, BASE, assertSeedAllowed, assertTestDatabaseAllowed } = await import('./lib.js');
const { seed, wipeTestData, TEST_MARKER } = await import('./seed.js');

const args = process.argv.slice(2);
const NO_SERVER = args.includes('--no-server');
const NO_SEED = args.includes('--no-seed');
const suiteArg = args.find((a) => a.startsWith('--suite='));
const ONLY = suiteArg ? suiteArg.split('=')[1] : null;

const SUITE_DEFINITIONS = [
  ['auth', () => import('./auth.test.js').then(({ runAuth }) => runAuth)],
  ['crud', () => import('./crud.test.js').then(({ runCrud }) => runCrud)],
  ['isolation', () => import('./isolation.test.js').then(({ runIsolation }) => runIsolation)],
  ['relations', () => import('./relations.test.js').then(({ runRelations }) => runRelations)],
  ['stats', () => import('./stats.test.js').then(({ runStats }) => runStats)],
  ['security', () => import('./security.test.js').then(({ runSecurity }) => runSecurity)],
  ['concurrency', () => import('./concurrency.test.js').then(({ runConcurrency }) => runConcurrency)],
  ['final', () => import('./final.test.js').then(({ runFinal }) => runFinal)],
  ['admin', () => import('./admin.test.js').then(({ runAdmin }) => runAdmin)],
  ['abonnement', () => import('./abonnement.test.js').then(({ runAbonnement }) => runAbonnement)],
  ['bictorys', () => import('./bictorys.test.js').then(({ runBictorys }) => runBictorys)],
  ['declarations', () => import('./declarations.test.js').then(({ runDeclarations }) => runDeclarations)],
  ['import', () => import('./import.test.js').then(({ runImport }) => runImport)],
  ['locataires', () => import('./locataires.test.js').then(({ runLocataires }) => runLocataires)],
  ['salaires', () => import('./salaires.test.js').then(({ runSalaires }) => runSalaires)],
  ['vierge', () => import('./vierge.test.js').then(({ runVierge }) => runVierge)],
  ['simplif', () => import('./simplif.test.js').then(({ runSimplif }) => runSimplif)],
  ['complet', () => import('./complet.test.js').then(({ runComplet }) => runComplet)],
  ['matrice', () => import('./complet.test.js').then(({ runMatrice }) => runMatrice)],
  ['csrf-validation', () => import('./csrf-validation.test.js').then(({ runCsrfValidation }) => runCsrfValidation)],
  ['resetpwd', () => import('./resetpwd.test.js').then(({ runResetPwd }) => runResetPwd)],
  ['mandat', () => import('./mandat.test.js').then(({ runMandat }) => runMandat)],
  ['agence', () => import('./agence.test.js').then(({ runAgence }) => runAgence)],
  ['frontend', () => import('./frontend.test.js').then(({ runFrontend }) => runFrontend)],
];

const runner = new Runner();

async function waitForHealth(port, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      /* pas encore prêt */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

let serverProc = null;

async function startServer() {
  // Paiement 100% manuel : aucun fournisseur en ligne (MIM n'encaisse rien),
  // donc aucun mock de provider à démarrer.

  const env = {
    ...process.env,
    PORT: '3100',
    RATE_LIMIT_OFF: 'true',
    GIT_REPO_PATH: '',
    GIT_BACKUP: 'false',
    NODE_ENV: 'test',
    TEST_BASE: BASE,
    BICTORYS_AUTOCONFIRM: '0',
     BICTORYS_WEBHOOK_SECRET: process.env.BICTORYS_WEBHOOK_SECRET || 'bictorys_test_secret',
     SMTP_SIMULATE: '1',
  };
  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: SERVER_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', (d) => process.stdout.write(`[srv] ${d}`));
  serverProc.stderr.on('data', (d) => process.stdout.write(`[srv!] ${d}`));
}

async function main() {
  assertTestDatabaseAllowed();
  if (!NO_SEED) assertSeedAllowed();
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY est requis pour lancer les tests E2E.');

  const service = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  console.log(`Harness MIM — base ${BASE}`);

  if (!NO_SERVER) {
    await startServer();
    const up = await waitForHealth(3100);
    if (!up) {
      console.error('Serveur de test injoignable sur :3100');
      process.exit(1);
    }
    console.log('Serveur de test prêt.');
  }

  const ctx = { service, runner, marker: TEST_MARKER };

  if (!NO_SEED) {
    console.log('\nNettoyage des données de test précédentes...');
    const wiped = await wipeTestData(service);
    console.log(`${wiped} comptes de test supprimés.`);

    // M-06 : les compteurs de rate limit sont persistés en base — on
    // repart de quotas neufs à chaque run (les clés de tests unitaires
    // sont fixes, une fenêtre résiduelle ferait échouer les seuils).
    await service.from('rate_limit_buckets').delete().neq('key', '');

    console.log('Seed : 10 propriétaires x 10 locataires...');
    ctx.seed = await seed(service);
    console.log(
      `Seed terminé : ${ctx.seed.countOwnerProfiles} profils, ${ctx.seed.countBiens} biens, ` +
        `${ctx.seed.countLogements} logements, ${ctx.seed.countLocataires} locataires, ${ctx.seed.countPaiements} paiements.`
    );
  }

  const suites = [];
  for (const [name, load] of SUITE_DEFINITIONS) {
    if (ONLY && name !== ONLY) continue;
    suites.push([name, await load()]);
  }

  for (const [name, fn] of suites) {
    if (ONLY && name !== ONLY) continue;
    console.log(`\n══════════ SUITE ${name.toUpperCase()} ══════════`);
    try {
      await fn(runner, ctx);
    } catch (err) {
      runner.blocked(name, 'suite', `exception : ${err.message} — ${String(err.stack || '').split('\n').slice(1, 4).join(' | ')}`);
    }
  }

  const report = runner.summary();
  console.log(`\nStatut global : ${report.total === 0 || report.passed !== report.total ? (report.failed > 0 ? '🔴' : '🟠') : '🟢'}`);
  return report;
}

main()
  .then((report) => {
    if (serverProc) serverProc.kill();
    process.exit(report.total === 0 || report.passed !== report.total ? 1 : 0);
  })
  .catch((err) => {
    console.error('[run]', err);
    if (serverProc) serverProc.kill();
    process.exit(1);
  });
