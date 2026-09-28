// Sauvegarde de la base (format custom pg_dump -Fc) :
//
//   node server/scripts/backup.mjs
//
// Écrit `backups/mim-<horodatage>.dump`. C'est le point de restauration
// que l'audit M7 constatait absent du dépôt (aucun pg_dump versionné, et
// depuis l'audit C1 aucune manière de revenir en arrière sur des tables
// comptables).
//
// Restauration (dans un conteneur, sur une base de contrôle d'abord) :
//
//   docker exec -i supabase_db_MIM pg_restore -U postgres -d postgres \
//     --clean --if-exists --no-owner < backups/mim-<horodatage>.dump
//
// En production, la même commande s'exécute depuis une image
// `postgres:17` (pg_dump et pg_restore doivent avoir la même version
// majeure que la base cible).
//
// Variables d'environnement : MIM_DB_CONTAINER, MIM_DB_USER, MIM_DB_NAME
// (voir scripts/dump-schema.mjs).

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(dirname, '..');
const repoDir = path.resolve(serverDir, '..');

const container = process.env.MIM_DB_CONTAINER || 'supabase_db_MIM';
const user = process.env.MIM_DB_USER || 'postgres';
const dbName = process.env.MIM_DB_NAME || 'postgres';

const outDir = path.join(repoDir, 'backups');
mkdirSync(outDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = path.join(outDir, `mim-${stamp}.dump`);

let payload;
try {
  payload = execFileSync(
    'docker',
    ['exec', container, 'pg_dump', '-U', user, '-d', dbName, '-Fc'],
    { maxBuffer: 1024 * 1024 * 1024, windowsHide: true },
  );
} catch (error) {
  console.error(`[backup] pg_dump a échoué dans ${container} :`);
  console.error(String(error.stdout || '') + String(error.stderr || error.message));
  process.exit(1);
}

writeFileSync(target, payload);

const sizeMb = (statSync(target).size / (1024 * 1024)).toFixed(2);
console.log(`[backup] ${path.relative(process.cwd(), target)} (${sizeMb} Mo).`);
console.log('[backup] restauration :');
console.log(
  `  docker exec -i ${container} pg_restore -U ${user} -d ${dbName} --clean --if-exists --no-owner < ${path.relative(process.cwd(), target).split(path.sep).join('/')}`,
);
