// Régénère `server/supabase-schema.sql`, le schéma de référence.
//
//   node server/scripts/dump-schema.mjs          schéma de référence
//   node server/scripts/dump-schema.mjs --seed   catalogue des plans
//                                                (supabase/seed.sql)
//
// Le fichier est un artefact : il ne se modifie jamais à la main, on
// relance ce script après chaque migration (audit H2 « le schéma de
// référence est désynchronisé des migrations »).
//
// Procédure :
//   1. pg_dump --schema-only --schema=public sur la base locale ;
//   2. normalisation (voir plus bas) pour rester compatible avec
//      `run-schema.mjs`, qui pousse le fichier en entier via l'API
//      SQL Editor et a donc besoin d'un SQL idempotent ;
//   3. ajout de `server/schema-tail.sql` (déclencheurs sur auth.users
//      et catalogue de plans, absents d'un dump du schéma public).
//
// Variables d'environnement :
//   MIM_DB_CONTAINER  nom du conteneur Postgres (défaut supabase_db_MIM)
//   MIM_DB_USER       rôle (défaut postgres)
//   MIM_DB_NAME       base (défaut postgres)

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(dirname, '..');
const target = path.join(serverDir, 'supabase-schema.sql');
const tailFile = path.join(serverDir, 'schema-tail.sql');

const container = process.env.MIM_DB_CONTAINER || 'supabase_db_MIM';
const user = process.env.MIM_DB_USER || 'postgres';
const dbName = process.env.MIM_DB_NAME || 'postgres';

function dump() {
  try {
    return execFileSync(
      'docker',
      ['exec', container, 'pg_dump', '-U', user, '-d', dbName, '--schema-only', '--schema=public'],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    ).toString('utf8');
  } catch (error) {
    console.error(`[dump] impossible de lancer pg_dump dans ${container} :`);
    console.error(String(error.stdout || '') + String(error.stderr || error.message));
    process.exit(1);
  }
}

function normalize(sql) {
  let out = sql;

  // `\restrict`/`\unrestrict` : méta-commandes psql (pg_dump >= 17.5)
  // rejetées par le SQL Editor de Supabase.
  out = out.replace(/^\\restrict[^\n]*$/m, '');
  out = out.replace(/^\\unrestrict[^\n]*$/m, '');

  // Audit F8 : `SET row_security = off` en tête de fichier. Inutile pour
  // du DDL (postgres/service_role ont BYPASSRLS) et trompeur pour tout
  // contenu ajouté après.
  out = out.replace(
    /^SET row_security = off;\s*$/m,
    '-- (audit F8) « SET row_security = off » volontairement absent : le\n'
    + '-- reste du fichier est du DDL pur, exécuté par un rôle BYPASSRLS.',
  );

  // `transaction_timeout` n'existe qu'à partir de PostgreSQL 17 : le
  // retirer rend le dump exécutable sur les serveurs plus anciens (et 0
  // est déjà la valeur par défaut).
  out = out.replace(/^SET transaction_timeout = 0;\s*$/m, '');

  // Idempotence : run-schema.mjs rejoue le fichier via l'API SQL Editor.
  out = out.replace(/^CREATE FUNCTION /gm, 'CREATE OR REPLACE FUNCTION ');
  out = out.replace(/^CREATE TRIGGER /gm, 'CREATE OR REPLACE TRIGGER ');

  return out.replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trimEnd();
}

const header = `-- ===================================================================
-- MIM - Schéma de référence (dump schema-only du schéma public).
--
-- FICHIER GÉNÉRÉ : ne pas l'éditer à la main.
-- Régénération après toute migration :
--     node server/scripts/dump-schema.mjs
--
-- Source      : base locale (${container}, base ${dbName})
-- Étendue     : schéma public uniquement (+ server/schema-tail.sql)
-- Usage       : server/run-schema.mjs (poussée explicite, verrouillée)
-- Contrôles   : server/scripts/quality.mjs (mode lint)
-- ===================================================================
`;

const tail = readFileSync(tailFile, 'utf8');

function generateSchema() {
  const sql = header + '\n' + normalize(dump()) + '\n\n\n' + tail.trimEnd() + '\n';
  writeFileSync(target, sql, 'utf8');
  console.log(`[dump] ${path.relative(process.cwd(), target)} régénéré (${sql.split('\n').length} lignes).`);
}

// ---------------------------------------------------------------------
// Mode --seed : catalogue des plans, écrit dans supabase/seed.sql
// (exécuté par `[db.seed]` après les migrations, audit M7).
// Idempotent : les mêmes catalogues sont déjà insérés par les
// migrations, un `supabase db reset` ne doit donc pas échouer.
// ---------------------------------------------------------------------
const seedTarget = path.resolve(dirname, '..', '..', 'supabase', 'seed.sql');

function generateSeed() {
  let raw;
  try {
    raw = execFileSync(
      'docker',
      ['exec', container, 'pg_dump', '-U', user, '-d', dbName, '--data-only', '--schema=public', '--table=plans', '--column-inserts'],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    ).toString('utf8');
  } catch (error) {
    console.error(`[seed] pg_dump a échoué : ${String(error.stderr || error.message)}`);
    process.exit(1);
  }

  const inserts = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith('INSERT INTO public.plans '))
    .map((line) => line.replace(/;\s*$/, ' ON CONFLICT (code) DO NOTHING;'));

  if (!inserts.length) {
    console.error('[seed] aucune ligne de plans trouvée dans la base.');
    process.exit(1);
  }

  const seedHeader = [
    '-- MIM - Jeu de données de référence : catalogue des plans.',
    '--',
    '-- FICHIER GÉNÉRÉ : node server/scripts/dump-schema.mjs --seed',
    '-- Exécuté par supabase après les migrations ([db.seed] de',
    '-- supabase/config.toml, donc `supabase db reset`).',
    '--',
    '-- Idempotent : ces mêmes catalogues sont insérés par les',
    '-- migrations 20260921000000, 20260922000000, 20260926000000 et',
    '-- 20260927100000 ; ON CONFLICT (code) DO NOTHING garantit qu\'un',
    '-- reset ne casse pas. Aucune donnée utilisateur (audit M7).',
    '-- ===================================================================',
    '',
  ].join('\n');

  const seed = seedHeader + inserts.join('\n') + '\n';
  writeFileSync(seedTarget, seed, 'utf8');
  console.log(`[seed] ${path.relative(process.cwd(), seedTarget)} régénéré (${inserts.length} plans).`);
}

if (process.argv.includes('--seed')) generateSeed();
else generateSchema();
