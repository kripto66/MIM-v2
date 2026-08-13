// ============================================================
// MIM - Sauvegarde git automatique
//
// Précédemment : chemin git en dur + un commit/push synchrone à
// chaque login/logout/écriture, ce qui pouvait échouer (conflit
// d'index.lock entre opérations parallèles) et inonder les logs.
//
// Désormais :
//   * non bloquant : l'appelant n'attend pas la fin du backup ;
//   * sérialisé : une seule opération git à la fois (pas de
//     collision index.lock / refs) ;
//   * désactivé en production (Vercel) sauf GIT_BACKUP=true ;
//   * binaire git localisé via GIT_BIN, puis PATH, puis chemin
//     Windows historique (résultat mis en cache) ;
//   * erreurs discrètes (warn court), jamais de crash.
// ============================================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const GIT_CANDIDATES = [
  process.env.GIT_BIN,
  'git',
  'C:\\Users\\EsNova\\AppData\\Local\\Programs\\Git\\cmd\\git.exe',
].filter(Boolean);

const IS_PROD = process.env.NODE_ENV === 'production';
const ENABLED =
  Boolean(process.env.GIT_REPO_PATH) &&
  (process.env.GIT_BACKUP === 'true' || !IS_PROD);

// File d'attente : empêche deux backups de tourner en même temps.
let pipeline = Promise.resolve();
let cachedGit = null;

async function findGit() {
  if (cachedGit) return cachedGit;
  for (const candidate of GIT_CANDIDATES) {
    try {
      await exec(candidate, ['--version']);
      cachedGit = candidate;
      return cachedGit;
    } catch {
      // essaye le candidat suivant
    }
  }
  return null;
}

async function runBackup(message) {
  if (!ENABLED) {
    return { success: false, reason: 'disabled' };
  }

  const repo = process.env.GIT_REPO_PATH;
  const gitExe = await findGit();

  if (!gitExe) {
    return { success: false, reason: 'git_introuvable' };
  }

  const branch = process.env.GIT_BRANCH || 'master';

  try {
    await exec(gitExe, ['-C', repo, 'add', '-A']);
    await exec(gitExe, ['-C', repo, 'commit', '-m', message]);
    await exec(gitExe, ['-C', repo, 'push', 'origin', branch]);
    console.log(`[git] Sauvegarde OK : ${message}`);
    return { success: true };
  } catch (err) {
    // git écrit « nothing to commit » sur stdout (stderr vide) : il faut
    // examiner les deux flux, sinon chaque backup « à vide » serait loggé
    // comme une erreur.
    const detail = String(err.stderr || err.stdout || err);
    if (detail.includes('nothing to commit')) {
      return { success: true, reason: 'nothing_to_commit' };
    }
    // Les erreurs attendues ne doivent pas polluer les logs.
    console.warn('[git] Sauvegarde ignorée :', detail.slice(0, 160));
    return { success: false, reason: detail.slice(0, 200) };
  }
}

// Sauvegarde non bloquante et sérialisée. L'appelant reçoit une promesse
// (utile pour l'endpoint manuel) mais le flux de requête n'attend pas la
// fin du commit/push.
export function gitAutoBackup(message) {
  const task = pipeline.then(() => runBackup(message));
  pipeline = task.then(
    () => {},
    () => {}
  );
  return task;
}
