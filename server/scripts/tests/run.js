// ============================================================
// MIM - Lanceur de tests de bout en bout
//   node scripts/tests/run.js [--no-server] [--no-seed] [--suite auth]
// ============================================================

import 'dotenv/config';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { Runner, api, BASE } from './lib.js';
import { seed, wipeTestData } from './seed.js';
import { runAuth } from './auth.test.js';
import { runCrud } from './crud.test.js';
import { runIsolation } from './isolation.test.js';
import { runRelations } from './relations.test.js';
import { runStats } from './stats.test.js';
import { runSecurity } from './security.test.js';
import { runConcurrency } from './concurrency.test.js';
import { runFinal } from './final.test.js';
import { runAdmin } from './admin.test.js';
import { runAbonnement } from './abonnement.test.js';
import { runPaydunya, startPaydunyaMock, stopPaydunyaMock } from './paydunya.test.js';
import { runCinetpay, startCinetpayMock, stopCinetpayMock } from './cinetpay.test.js';
import { runDeclarations } from './declarations.test.js';
import { runImport } from './import.test.js';
import { runLocataires } from './locataires.test.js';
import { runSalaires } from './salaires.test.js';
import { runVierge } from './vierge.test.js';
import { runSimplif } from './simplif.test.js';
import { runComplet, runMatrice } from './complet.test.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, '..', '..');

const args = process.argv.slice(2);
const NO_SERVER = args.includes('--no-server');
const NO_SEED = args.includes('--no-seed');
const suiteArg = args.find((a) => a.startsWith('--suite='));
const ONLY = suiteArg ? suiteArg.split('=')[1] : null;

const SUITES = [
  ['auth', runAuth],
  ['crud', runCrud],
  ['isolation', runIsolation],
  ['relations', runRelations],
  ['stats', runStats],
  ['security', runSecurity],
  ['concurrency', runConcurrency],
  ['final', runFinal],
  ['admin', runAdmin],
  ['abonnement', runAbonnement],
  ['paydunya', runPaydunya],
  ['cinetpay', runCinetpay],
  ['declarations', runDeclarations],
  ['import', runImport],
  ['locataires', runLocataires],
  ['salaires', runSalaires],
  ['vierge', runVierge],
  ['simplif', runSimplif],
  ['complet', runComplet],
  ['matrice', runMatrice],
];

const runner = new Runner();

const service = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

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
  // Pendant les tests, les appels PayDunya sont redirigés vers un mock
  // local (aucun paiement réel, aucune clé exposée au frontend).
  // Idem pour CinetPay (Checkout v2 + Transfer v1).
  await startPaydunyaMock();
  await startCinetpayMock();

  const env = {
    ...process.env,
    PORT: '3100',
    RATE_LIMIT_OFF: 'true',
    GIT_REPO_PATH: '',
    GIT_BACKUP: 'false',
    NODE_ENV: '',
    TEST_BASE: BASE,
    PAYDUNYA_API_URL: 'http://127.0.0.1:64330/sandbox-api/v1',
    PAYDUNYA_DISBURSE_API_URL: 'http://127.0.0.1:64330/api/v2',
    CINETPAY_API_KEY: 'test-cp-key',
    CINETPAY_SITE_ID: 'test-cp-site',
    CINETPAY_WEBHOOK_SECRET: 'test-cp-webhook-secret',
    CINETPAY_TRANSFER_PASSWORD: 'test-cp-transfer-pwd',
    CINETPAY_CHECKOUT_API_URL: 'http://127.0.0.1:64331/v2',
    CINETPAY_TRANSFER_API_URL: 'http://127.0.0.1:64331/v1',
    CINETPAY_TEST_MODE: 'true',
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

  const ctx = { service, runner };

  if (!NO_SEED) {
    console.log('\nNettoyage des données de test précédentes...');
    const wiped = await wipeTestData(service);
    console.log(`${wiped} comptes de test supprimés.`);

    console.log('Seed : 10 propriétaires x 10 locataires...');
    ctx.seed = await seed(service);
    console.log(
      `Seed terminé : ${ctx.seed.countOwnerProfiles} profils, ${ctx.seed.countBiens} biens, ` +
        `${ctx.seed.countLogements} logements, ${ctx.seed.countLocataires} locataires, ${ctx.seed.countPaiements} paiements.`
    );
  }

  for (const [name, fn] of SUITES) {
    if (ONLY && name !== ONLY) continue;
    console.log(`\n══════════ SUITE ${name.toUpperCase()} ══════════`);
    try {
      await fn(runner, ctx);
    } catch (err) {
      runner.blocked(name, 'suite', `exception : ${err.message} — ${String(err.stack || '').split('\n').slice(1, 4).join(' | ')}`);
    }
  }

  const report = runner.summary();
  console.log(`\nStatut global : ${report.failed === 0 && report.blocked === 0 ? '🟢' : report.failed > 0 ? '🔴' : '🟠'}`);
  return report;
}

main()
  .then(() => {
    if (serverProc) serverProc.kill();
    stopPaydunyaMock();
    stopCinetpayMock();
    process.exit(0);
  })
  .catch((err) => {
    console.error('[run]', err);
    if (serverProc) serverProc.kill();
    stopPaydunyaMock();
    stopCinetpayMock();
    process.exit(1);
  });
