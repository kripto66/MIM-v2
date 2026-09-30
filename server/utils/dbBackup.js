// ============================================================
// Sauvegarde de la base (pg_dump custom, format -Fc) — H-16.
//
// La sauvegarde git ne couvre AUCUNE donnée Supabase : ce module est
// le volet « base » de la sauvegarde, séparé du volet « code »
// (utils/gitBackup.js) comme le demande l'audit. Il est throttlé :
// un dump complet ne doit pas être rejoué à chaque appel, seul le
// premier passage au-delà de MIM_DB_BACKUP_INTERVAL_MS produit un
// fichier. Le throttle est persisté sur disque (backups/.last-dump)
// pour survivre aux redémarrages du process.
//
//   node server/scripts/backup.mjs --force   (exécution manuelle)
//   runDbBackup()                            (cron, throttlé)
//
// Best-effort : ne lève JAMAIS, retourne { success, reason }.
// Voir le répertoire backups/ pour les commandes de restauration.
// ============================================================

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultDir = path.resolve(dirname, '..', '..', 'backups');

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 h
const DUMP_TIMEOUT_MS = Number(process.env.MIM_DB_BACKUP_TIMEOUT_MS) || 10 * 60 * 1000;

function backupDir() {
  return process.env.MIM_DB_BACKUP_DIR || defaultDir;
}

function stampFile() {
  return path.join(backupDir(), '.last-dump');
}

function dbSettings() {
  return {
    container: process.env.MIM_DB_CONTAINER || 'supabase_db_MIM',
    user: process.env.MIM_DB_USER || 'postgres',
    dbName: process.env.MIM_DB_NAME || 'postgres',
  };
}

function intervalMs() {
  const raw = Number(process.env.MIM_DB_BACKUP_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_INTERVAL_MS;
}

export function lastDbBackupAt() {
  try {
    const value = Date.parse(readFileSync(stampFile(), 'utf8').trim());
    return Number.isFinite(value) ? new Date(value) : null;
  } catch {
    return null;
  }
}

// Commande de restauration à exécuter sur une base de contrôle.
export function dbBackupRestoreHint(file) {
  const { container, user, dbName } = dbSettings();
  const relative = path.relative(process.cwd(), file).split(path.sep).join('/');
  return `docker exec -i ${container} pg_restore -U ${user} -d ${dbName} --clean --if-exists --no-owner < ${relative}`;
}

export async function runDbBackup({ force = false } = {}) {
  const dir = backupDir();
  mkdirSync(dir, { recursive: true });

  const last = lastDbBackupAt();
  if (!force && last && Date.now() - last.getTime() < intervalMs()) {
    return { success: false, reason: 'throttled', last: last.toISOString() };
  }

  const { container, user, dbName } = dbSettings();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `mim-${stamp}.dump`);

  let payload;
  try {
    ({ stdout: payload } = await exec(
      'docker',
      ['exec', container, 'pg_dump', '-U', user, '-d', dbName, '-Fc'],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024, timeout: DUMP_TIMEOUT_MS, windowsHide: true },
    ));
  } catch (error) {
    const detail = String(error.stderr || error.message || '').slice(0, 300);
    console.warn(`[backup] pg_dump a échoué dans ${container} : ${detail}`);
    // Pas de stamp : on retentera au prochain appel.
    return { success: false, reason: 'dump_failed' };
  }

  writeFileSync(target, payload);
  // Stamp APRÈS l'écriture : un dump raté ne bloque pas le suivant.
  writeFileSync(stampFile(), new Date().toISOString());

  const size = statSync(target).size;
  console.log(`[backup] base sauvegardée : ${path.relative(process.cwd(), target)} (${(size / (1024 * 1024)).toFixed(2)} Mo)`);
  return { success: true, file: target, size };
}
