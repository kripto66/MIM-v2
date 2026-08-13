// ============================================================
// MIM — LOADTEST : orchestration complète
//   node scripts/loadtest/run-all.mjs [--no-seed] [--no-phases] [--no-frontend]
//   Spawn serveur :3200 (RATE_LIMIT_OFF, git backup OFF) puis :
//     seed.mjs → run-phases.mjs → frontend.mjs → verify-db.mjs → report.mjs
//   ⚠ NE NETTOIE PAS : exécutez cleanup.mjs (dry-run) puis --confirm.
// ============================================================
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnServer, stopServer, waitHealth, PORT, BASE, __dirname } from './common.mjs';

const args = process.argv.slice(2);
const NO_SEED = args.includes('--no-seed');
const NO_PHASES = args.includes('--no-phases');
const NO_FRONTEND = args.includes('--no-frontend');
const NO_VERIFY = args.includes('--no-verify');

const node = process.execPath;
const script = (f) => path.join(__dirname, f);

function runChild(name, file) {
  return new Promise((resolve) => {
    console.log(`\n━━━━━━ ${name} ━━━━━━━`);
    const p = spawn(node, [script(file)], { cwd: __dirname, stdio: 'inherit' });
    p.on('exit', (code) => resolve(code === 0));
  });
}

async function main() {
  if (!NO_SEED) {
    console.log(`Démarrage du serveur loadtest sur :${PORT} (${BASE})`);
    spawnServer();
    const ok = await waitHealth(`http://127.0.0.1:${PORT}`);
    if (!ok) { console.error('Serveur :3200 injoignable'); process.exit(1); }
    console.log('Serveur prêt.');
  }

  let seedOk = true;
  if (!NO_SEED) seedOk = await runChild('PHASES 2-4 — Création', 'seed.mjs');

  let phasesOk = true;
  if (!NO_PHASES && (seedOk || NO_SEED)) phasesOk = await runChild('PHASES 5-19 — Tests', 'run-phases.mjs');

  let feOk = true;
  if (!NO_FRONTEND && (seedOk || NO_SEED)) feOk = await runChild('PHASE 18 — Frontend navigateur', 'frontend.mjs');

  let verifyOk = true;
  if (!NO_VERIFY) verifyOk = await runChild('PHASE 20 — Vérification DB', 'verify-db.mjs');

  stopServer();

  await runChild('Rapport final', 'report.mjs');

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`seed     : ${seedOk ? 'OK' : 'ÉCHEC'}`);
  console.log(`phases   : ${phasesOk ? 'OK' : 'ÉCHEC'}`);
  console.log(`frontend : ${feOk ? 'OK' : 'ÉCHEC'}`);
  console.log(`verify   : ${verifyOk ? 'OK' : 'ÉCHEC'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('ÉTAPE SUIVANTE : node scripts/loadtest/cleanup.mjs  (dry-run) puis --confirm.');
  process.exit(seedOk && phasesOk && feOk && verifyOk ? 0 : 1);
}

main().catch((e) => { stopServer(); console.error('[run-all]', e); process.exit(1); });
