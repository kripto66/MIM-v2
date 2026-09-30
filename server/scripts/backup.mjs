// Sauvegarde de la base (format custom pg_dump -Fc) :
//
//   node server/scripts/backup.mjs [--force]
//
// Écrit `backups/mim-<horodatage>.dump`. C'est le point de restauration
// que l'audit M7 constatait absent du dépôt (aucun pg_dump versionné, et
// depuis l'audit C1 aucune manière de revenir en arrière sur des tables
// comptables).
//
// La logique (throttle, dump, stamp) vit dans utils/dbBackup.js : ce
// fichier n'est que la ligne de commande manuelle. Le cron checkLoyers
// appelle runDbBackup() sans --force, donc throttlé (H-16 : la
// sauvegarde git ne couvre pas les données Supabase).
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
// Variables d'environnement : MIM_DB_CONTAINER, MIM_DB_USER, MIM_DB_NAME,
// MIM_DB_BACKUP_DIR, MIM_DB_BACKUP_INTERVAL_MS.

import { runDbBackup, dbBackupRestoreHint } from '../utils/dbBackup.js';

const force = process.argv.includes('--force');

const result = await runDbBackup({ force });

if (result.success) {
  console.log('[backup] restauration :');
  console.log(`  ${dbBackupRestoreHint(result.file)}`);
  process.exit(0);
}

if (result.reason === 'throttled') {
  console.log(`[backup] dump récent déjà présent (${result.last}) : rien à faire. Utiliser --force pour forcer.`);
  process.exit(0);
}

console.error(`[backup] échec (${result.reason}).`);
process.exit(1);
