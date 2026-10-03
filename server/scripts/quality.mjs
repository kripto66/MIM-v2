import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const selfFile = path.join(dirname, 'quality.mjs');
const root = path.resolve(dirname, '..', '..');
const skippedDirectories = new Set(['.git', 'node_modules', '.aider.tags.cache.v4', '.temp']);

const JS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const FRONT_EXTENSIONS = new Set(['.js', '.html']);
const SQL_EXTENSIONS = new Set(['.sql']);

async function collectFiles(directory, extensions) {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) files.push(...await collectFiles(fullPath, extensions));
      continue;
    }
    if (entry.isFile() && extensions.has(path.extname(entry.name))) files.push(fullPath);
  }
  return files;
}

async function collectSourceFiles(directory) {
  return collectFiles(directory, JS_EXTENSIONS);
}

async function collectPartFiles(extensions) {
  const files = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('Part')) {
      files.push(...await collectFiles(path.join(root, entry.name), extensions));
    }
  }
  return files;
}

async function collectFrontFiles() {
  return collectPartFiles(FRONT_EXTENSIONS);
}

async function collectPages() {
  return (await collectPartFiles(new Set(['.html']))).filter((file) => file.endsWith('.html'));
}

async function collectFrontAssets() {
  return collectPartFiles(new Set(['.html', '.js', '.css']));
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function lineOf(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

function checkSyntax(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
  if (result.status === 0) return null;
  return `${file}\n${result.stderr || result.stdout || 'syntax error'}`;
}

async function checkManifests() {
  const files = [
    path.join(root, 'package.json'),
    path.join(root, 'package-lock.json'),
    path.join(root, 'server', 'package.json'),
    path.join(root, 'server', 'package-lock.json'),
    path.join(root, 'video-marketing', 'package.json'),
    path.join(root, 'video-marketing', 'package-lock.json'),
  ];
  const errors = [];
  for (const file of files) {
    try {
      JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push(`${file}\n${error.message}`);
    }
  }
  for (const file of [path.join(root, 'package.json'), path.join(root, 'server', 'package.json'), path.join(root, 'video-marketing', 'package.json')]) {
    try {
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      if (manifest.engines?.node !== '>=22') errors.push(`${file}: engines.node doit être >=22`);
    } catch (error) {
      if (error.code !== 'ENOENT') errors.push(`${file}\n${error.message}`);
    }
  }
  return errors;
}

async function checkConflicts(files) {
  const errors = [];
  for (const file of files) {
    try {
      const content = await readFile(file, 'utf8');
      if (content.split(/\r?\n/).some((line) => /^(?:<<<<<<<|>>>>>>>)(?: .*)?$/.test(line) || line === '=======')) errors.push(`${file}: marqueur de conflit`);
    } catch {
    }
  }
  return errors;
}

// ---------------------------------------------------------------------
// Contrôles de garde (mode lint) : ils bloquent les régressions des
// correctifs d'audit. Chaque contrôle renvoie une liste d'erreurs.
// ---------------------------------------------------------------------

// Audit C1 : jamais de DROP/TRUNCATE dans les migrations. Les tables
// retirées sont déplacées dans le schéma `archive` (voir migrations
// 20260903 / 20260904) pour conserver les données comptables.
const MIGRATION_BANNED = /^\s*(?:DROP\s+TABLE|DROP\s+SCHEMA|TRUNCATE\s+\w)/im;

async function checkMigrationSafety() {
  const directory = path.join(root, 'supabase', 'migrations');
  const errors = [];
  const files = await collectFiles(directory, SQL_EXTENSIONS);
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    const match = content.match(MIGRATION_BANNED);
    if (!match) continue;
    errors.push(
      `${relative(file)}:${lineOf(content, match.index)}: « ${match[0].trim()} » interdit dans une migration — `
      + 'déplacez la table dans le schéma `archive` (audit C1) au lieu de la supprimer.',
    );
  }
  return errors;
}

// Audit XSS : une seule définition globale de escapeHtml/escapeAttr,
// dans PartPublic/mim-errors.js (les versions locales en double
// n'étaient pas systématiquement appelées).
const ESCAPE_HELPER_DEF = /(?:function\s+|(?:const|let|var)\s+|window\.)(escapeHtml|escapeAttr)\s*(?==|\()/g;
const ESCAPE_HELPER_HOME = 'PartPublic/mim-errors.js';

async function checkEscapeHelpers() {
  const errors = [];
  const files = await collectFrontFiles();
  const definitions = new Map();
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    for (const match of content.matchAll(ESCAPE_HELPER_DEF)) {
      const name = match[1];
      if (!definitions.has(name)) definitions.set(name, []);
      definitions.get(name).push(`${relative(file)}:${lineOf(content, match.index)}`);
    }
  }
  for (const name of ['escapeHtml', 'escapeAttr']) {
    const found = definitions.get(name) || [];
    if (found.length === 0) {
      errors.push(`${ESCAPE_HELPER_HOME}: définition de ${name} introuvable (chacune doit exister exactement une fois).`);
      continue;
    }
    if (found.length > 1) {
      errors.push(`${name} défini ${found.length} fois (une seule autorisée, dans ${ESCAPE_HELPER_HOME}) : ${found.join(', ')}`);
      continue;
    }
    const where = found[0].split(':')[0];
    if (where !== ESCAPE_HELPER_HOME) {
      errors.push(`${name} défini dans ${where} au lieu de ${ESCAPE_HELPER_HOME}.`);
    }
  }
  return errors;
}

// Interdiction des fonctions d'exécution dynamique dans le code source
// (évaluation de chaînes = porte ouverte à l'injection de code).
const DANGEROUS_CALLS = [
  ['eval(', /\beval\s*\(/],
  ['new Function(', /\bnew\s+Function\s*\(/],
  ['document.write(', /document\.write\s*\(/],
];

async function checkDynamicEvaluation(files) {
  const errors = [];
  for (const file of files) {
    if (path.resolve(file) === selfFile) continue;
    const content = await readFile(file, 'utf8');
    for (const [label, pattern] of DANGEROUS_CALLS) {
      const match = content.match(pattern);
      if (match) errors.push(`${relative(file)}:${lineOf(content, match.index)}: ${label} interdit (exécution dynamique).`);
    }
  }
  return errors;
}

// Ordre d'import critique au démarrage : loadEnv.js d'abord (sinon
// server/.env n'est pas lu et supabaseUrl est requis), puis
// asyncGuard.js avant toute route (patch des Router/Route prototypes).
const BOOT_ORDER = [
  ['server/app.js', ['./loadEnv.js', './middleware/asyncGuard.js']],
  ['server/server.js', ['./loadEnv.js']],
];
const IMPORT_RE = /^import\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"];?\s*$/gm;

async function checkBootOrder() {
  const errors = [];
  for (const [rel, expected] of BOOT_ORDER) {
    const file = path.join(root, rel);
    let content;
    try {
      content = await readFile(file, 'utf8');
    } catch {
      errors.push(`${rel}: fichier absent.`);
      continue;
    }
    const relativeImports = [...content.matchAll(IMPORT_RE)]
      .map((match) => match[1])
      .filter((specifier) => specifier.startsWith('.'));
    expected.forEach((specifier, index) => {
      if (relativeImports[index] !== specifier) {
        errors.push(
          `${rel}: le ${index + 1}er import relatif doit être « ${specifier} » `
          + `(trouvé « ${relativeImports[index] ?? 'aucun'} ») — ordre critique chargement de la configuration.`,
        );
      }
    });
  }
  return errors;
}

// Les garde-fous fail-closed (NODE_ENV, TRUST_PROXY) dépendent de
// variables explicitement déclarées : elles doivent rester documentées.
async function checkEnvTemplate() {
  const file = path.join(root, 'server', '.env.example');
  const errors = [];
  // .env.example peut commencer par un BOM UTF-8 : sans son retrait, la
  // première clé n'est jamais reconnue par une ancre `^`.
  let content;
  try {
    content = (await readFile(file, 'utf8')).replace(/^﻿/, '');
  } catch {
    return [`${relative(file)}: absent — le modèle de configuration doit exister.`];
  }
  for (const key of ['NODE_ENV', 'TRUST_PROXY', 'JWT_SECRET', 'SESSION_ENCRYPTION_KEY']) {
    if (!new RegExp(`^${key}=`, 'm').test(content)) errors.push(`${relative(file)}: ${key} manquant.`);
  }
  return errors;
}

// ---------------------------------------------------------------------
// Audit B5 : interpolation non échappée dans innerHTML. Une valeur
// issue de données (objet.propriete / objet[i]) injectée dans du HTML
// est une XSS tant qu'elle n'est pas passée par escapeHtml/escapeAttr
// ou par un helper de rendu qui les appelle déjà.
//
// Volontairement ciblé pour rester fiable (aucun faux positif) :
//  - seules les affectations `x.innerHTML = \`...\`` sont examinées
//    (une valeur passée à new Option(...), textContent, etc. n'est
//    jamais interprétée comme du HTML) ;
//  - seuls les champs porteurs de texte libre sont signalés : les
//    compteurs, identifiants et montants restent bruts ;
//  - un helper de rendu connu (escapeHtml, badge, statCard, fmt*,
//    ...) ou une table de libellés en MAJUSCULES neutralise l'alerte.
// ---------------------------------------------------------------------
const INNER_HTML_ASSIGN = [/\.(?:innerHTML|outerHTML)\s*=/g, /insertAdjacentHTML\s*\(\s*[^,)]*,/g];
const SAFE_EXPR_CALL =
  /\b(?:escapeHtml|escapeAttr|escape\w*|sanitize\w*|esc|linkify|label|badge|badgeStatut|statCard|activity|revenueChart|svg|money|format\w+|fmt\w+|encodeURI\w*|JSON\.stringify|Object\.keys|Array\.isArray|isNaN|isFinite)\s*\(/;
const FREE_TEXT_FIELD =
  /\b(?:nom|nom_complet|name|prenom|email|mail|adresse|ville|rue|quartier|titre|title|label|libelle|detail|message|commentaire|motif|raison|contenu|description|username|identifiant|societe|entreprise|raison_sociale|banque|iban|rib|note|obs|observation|objet|subject|texte|content|slug|fichier|filename|image|avatar|url|chemin|path|telephone|tel)\b/;
const STATIC_TABLE_ROOT = /^\s*[A-Z][A-Z0-9_]{2,}\s*[.[]/;

function skipQuoted(text, i, quote) {
  i += 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === quote) return i + 1;
    i += 1;
  }
  return i;
}

// Parcourt un modèle littéral (i = index du ` d'ouverture) et collecte
// chaque expression d'interpolation, y compris dans les modèles nichés.
function walkTemplate(text, i, out) {
  i += 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return i + 1;
    if (c === '$' && text[i + 1] === '{') {
      const start = i + 2;
      const end = walkInterpolation(text, i + 1, out);
      out.push({ expr: text.slice(start, Math.max(start, end - 1)), index: start });
      i = end;
      continue;
    }
    i += 1;
  }
  return i;
}

function walkInterpolation(text, i, out) {
  let depth = 1;
  i += 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"') { i = skipQuoted(text, i, c); continue; }
    if (c === '`') { i = walkTemplate(text, i, out); continue; }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return i;
}

async function checkInnerHTMLEscaping(scanned) {
  const errors = [];
  for (const file of scanned) {
    if (path.resolve(file) === selfFile) continue;
    const content = await readFile(file, 'utf8');
    for (const assign of INNER_HTML_ASSIGN) {
      assign.lastIndex = 0;
      let match;
      while ((match = assign.exec(content)) !== null) {
        const after = match.index + match[0].length;
        // La valeur de droite doit être un modèle littéral : sinon le
        // backtick suivant appartient à une autre expression.
        let start = after;
        while (start < content.length && /\s/.test(content[start])) start += 1;
        if (content[start] !== '`') continue;
        const interpolations = [];
        walkTemplate(content, start, interpolations);
        for (const { expr, index } of interpolations) {
          const oneLine = expr.replace(/\s+/g, ' ').trim();
          if (oneLine.length === 0) continue;
          if (!FREE_TEXT_FIELD.test(oneLine)) continue;
          if (SAFE_EXPR_CALL.test(oneLine)) continue;
          if (STATIC_TABLE_ROOT.test(oneLine)) continue;
          errors.push(
            `${relative(file)}:${lineOf(content, index)}: texte de données non échappé dans innerHTML : `
            + `« ${oneLine.slice(0, 120) } » — enveloppez-le dans escapeHtml(...) `
            + `(audit B5, helpers dans PartPublic/mim-errors.js).`,
          );
        }
        assign.lastIndex = after;
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------
// Contrôle du schéma de référence (audits H2 / F8 / M7) : le dump doit
// exister, rester régénérable (jamais édité à la main), rester plus
// récent que les migrations, et contenir les correctifs d'audit.
// ---------------------------------------------------------------------
const DUMP_RELATIVE = 'server/supabase-schema.sql';
const DUMP_REQUIRED = [
  ['ON "auth"."users"', 'déclencheurs de création de compte (schema-tail.sql)'],
  ['prix_plan', 'prix figé au paiement (S1-3)'],
  ['closed_deny_all', 'politiques de fermeture explicite (F6)'],
  ['profiles_email_uidx', 'index partiel unique sur profiles.email (F7)'],
  ['ON DELETE RESTRICT', 'paiements détachés du plan (F9)'],
  ['CREATE OR REPLACE FUNCTION', 'fonctions idempotentes (poussée run-schema.mjs)'],
  ['ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon,authenticated',
    'révocations de privilèges par défaut (M9) : pg_dump ne les émet pas, sans elles toute table créée après une restauration est ouverte à anon'],
  ['import_run_rows_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.import_runs(id) ON DELETE CASCADE',
    'lignes d\'import en cascade (M6) : en RESTRICT elles bloquaient la suppression du compte dès le premier import'],
];
const DUMP_FORBIDDEN = [
  ['\\restrict', 'meta-commande rejetée par le SQL Editor (H2)'],
  ['DROP TABLE', 'jamais de suppression dans le schéma de référence (C1)'],
  ['profiles_email_key', 'index unique dupliqué supprimé (F7)'],
  ['owner_all_sessions', 'politique morte supprimée (F3)'],
  ['owner_can_pay', 'ancien bonus propriétaire retiré (corrections d\'audit)'],
];
const DUMP_ROW_SECURITY_STATEMENT = /^\s*SET\s+row_security\s*=/im;

async function checkSchemaDump() {
  const errors = [];
  const dumpFile = path.join(root, DUMP_RELATIVE);
  let content;
  try {
    content = await readFile(dumpFile, 'utf8');
  } catch {
    return [`${DUMP_RELATIVE}: absent — régénérez-le avec « node server/scripts/dump-schema.mjs ».`];
  }
  if (content.includes('\uFEFF')) errors.push(`${DUMP_RELATIVE}: BOM UTF-8 présent — le script de régénération doit l'écrire sans BOM.`);
  for (const [needle, why] of DUMP_REQUIRED) {
    if (!content.includes(needle)) {
      errors.push(`${DUMP_RELATIVE}: marqueur absent « ${needle} » (${why}) — le dump est désynchronisé, relancez « npm run schema:dump ».`);
    }
  }
  for (const [needle, why] of DUMP_FORBIDDEN) {
    if (content.toLowerCase().includes(needle.toLowerCase())) {
      errors.push(`${DUMP_RELATIVE}: marqueur interdit « ${needle} » (${why}) — relancez « npm run schema:dump ».`);
    }
  }
  if (DUMP_ROW_SECURITY_STATEMENT.test(content)) {
    errors.push(`${DUMP_RELATIVE}: « SET row_security = … » actif (audit F8 : commentaire explicatif uniquement).`);
  }

  // Un dump plus ancien qu'une migration = schéma de référence périmé.
  const migrationsDir = path.join(root, 'supabase', 'migrations');
  const migrations = await collectFiles(migrationsDir, SQL_EXTENSIONS);
  if (migrations.length) {
    const dumpMtime = (await stat(dumpFile)).mtimeMs;
    let newest = null;
    for (const file of migrations) {
      const mtime = (await stat(file)).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { file, mtime };
    }
    // Tolérance de 60 s : un fresh clone écrit tous les fichiers presque
    // simultanément, l'ordre n'a alors aucun sens.
    if (newest && dumpMtime + 60_000 < newest.mtime) {
      errors.push(
        `${DUMP_RELATIVE}: plus ancien que ${relative(newest.file)} — schéma de référence désynchronisé `
        + '(audit H2) ; relancez « npm run schema:dump ».',
      );
    }
  }

  // Le catalogue des plans doit suivre le schéma (audit M7).
  const seedFile = path.join(root, 'supabase', 'seed.sql');
  try {
    const seed = await readFile(seedFile, 'utf8');
    if (!/ON\s+CONFLICT\s*\(\s*code\s*\)\s*DO\s+NOTHING/i.test(seed)) {
      errors.push('supabase/seed.sql: insertions non idempotentes (« ON CONFLICT (code) DO NOTHING » attendu, audit M7).');
    }
    if (!/INSERT\s+INTO\s+public\.plans/i.test(seed)) {
      errors.push('supabase/seed.sql: catalogue des plans absent (audit M7).');
    }
  } catch {
    errors.push('supabase/seed.sql: absent — « npm run schema:seed » le régénère.');
  }
  return errors;
}

// ---------------------------------------------------------------------
// Dette D6 : définition vs chargement des helpers partagés.
// Une page qui appelle un helper défini dans un script partagé de
// PartPublic doit charger ce fichier : sinon la page s'ouvre puis lève
// une ReferenceError au premier appel (bug critique du 27/09 et bug B1
// du 29/09 relevés par l'audit frontend).
// Les appels protégés par `typeof x === 'function'` (sidebar.js et son
// mimApiBase) sont ignorés : la dépendance y est explicite et sans risque.
// ---------------------------------------------------------------------
const SHARED_HELPER_FILES = [
  'PartPublic/mim-ui.js',
  'PartPublic/mim-errors.js',
  'PartPublic/form-utils.js',
  'PartPublic/sidebar.js',
  'PartPublic/dash-fx.js',
  'PartPublic/password-strength.js',
  'PartPublic/mim-poll.js',
  'PartPublic/mim-realtime.js',
  'PartPublic/footer.js',
  // Dette D4 : api.js / crud.js / notifications.js n'ont plus qu'un
  // exemplaire (PartPublic) — le contrôle veille à ce qu'une page qui
  // appelle apiRequest/CrudPage charge bien le fichier qui les définit.
  'PartPublic/api.js',
  'PartPublic/crud.js',
  'PartPublic/notifications.js',
];
// Toute déclaration `function` (mim-ui.js est enveloppé dans une IIFE et
// indenté), mais `const`/`let`/`var` seulement en colonne 0 : un
// `var res = await fetch(...)` imbriqué n'est pas un helper global.
const ANY_FUNCTION_DECL = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
const TOP_LEVEL_BINDING = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm;
const TOP_LEVEL_MEMBER = /^(?:window|globalThis|self|MIM|MIMUI|CrudPage|Onboarding)\.([A-Za-z_$][\w$]*)\s*=/gm;
const SCRIPT_SRC = /<script[^>]+src="([^"]+)"/g;
const SCRIPT_INLINE = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
const DEFINED_FUNCTIONS = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
// Méthode abrégée (`async load() {`) : sans elle, la définition elle-même
// est comptée comme un appel et le contrôle accuse à tort une page qui
// charge crud.js.
const DEFINED_METHODS = /(?:^|[\s;{}])(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
const DEFINED_CONST = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
const DEFINED_MEMBERS = /(?:window|globalThis|self|MIM|MIMUI|CrudPage|Onboarding)\.([A-Za-z_$][\w$]*)\s*=/g;
const CALLED = /(?<![.\w$'"`])([A-Za-z_$][\w$]*)\s*\(/g;
// « async load( », « function load( », « get load( » : déclaration, pas appel.
const DEFINITION_BEFORE = /(?:^|[^\w$.])(?:async\s+|function\s+|get\s+|set\s+)$/;

function resolveFrontRef(specifier, directory) {
  if (specifier.startsWith('../')) return path.join(root, specifier.slice(3));
  if (specifier.startsWith('/')) {
    // PartPublic est monté à la racine de l'express.static (app.js) : les
    // pages demandent /mim-errors.js autant que /PartPublic/mim-ui.js.
    const direct = path.join(root, specifier.slice(1));
    if (existsSync(direct)) return direct;
    return path.join(root, 'PartPublic', specifier.slice(1));
  }
  return path.join(directory, specifier);
}

async function readIfPresent(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function checkHelperLoading() {
  const errors = [];
  const shared = new Map();
  for (const rel of SHARED_HELPER_FILES) {
    const content = await readIfPresent(path.join(root, rel));
    if (!content) {
      errors.push(`${rel}: absent — les helpers partagés doivent rester chargés par toutes les pages.`);
      continue;
    }
    const names = new Set();
    for (const pattern of [ANY_FUNCTION_DECL, TOP_LEVEL_BINDING, TOP_LEVEL_MEMBER]) {
      for (const match of content.matchAll(pattern)) names.add(match[1]);
    }
    shared.set(path.basename(rel), { home: rel, names });
  }
  for (const page of await collectPages()) {
    const html = await readIfPresent(page);
    if (!html) continue;
    const directory = path.dirname(page);
    const loaded = [];
    const inline = [];
    for (const match of html.matchAll(SCRIPT_SRC)) loaded.push(match[1]);
    for (const match of html.matchAll(SCRIPT_INLINE)) inline.push(match[1]);
    const loadedNames = new Set(loaded.map((specifier) => path.basename(specifier)));

    const sources = [];
    for (const text of inline) sources.push(text);
    for (const specifier of loaded) {
      const file = resolveFrontRef(specifier, directory);
      const content = file.endsWith('.js') ? await readIfPresent(file) : null;
      if (content) sources.push(content);
    }
    const source = sources.join('\n');

    const defined = new Set();
    for (const pattern of [DEFINED_FUNCTIONS, DEFINED_METHODS, DEFINED_CONST, DEFINED_MEMBERS]) {
      for (const match of source.matchAll(pattern)) defined.add(match[1]);
    }

    const called = new Set();
    CALLED.lastIndex = 0;
    let match;
    while ((match = CALLED.exec(source)) !== null) {
      const name = match[1];
      const before = source.slice(Math.max(0, match.index - 120), match.index);
      if (new RegExp(`typeof\\s+${name}\\s*===`).test(before)) continue; // garde typeof explicite
      if (DEFINITION_BEFORE.test(before)) continue; // déclaration, pas appel
      called.add(name);
    }

    for (const [scriptName, { home, names }] of shared) {
      if (loadedNames.has(scriptName)) continue;
      const missing = [...called].filter((name) => names.has(name) && !defined.has(name));
      if (missing.length) {
        errors.push(
          `${relative(page)}: appelle ${missing.join(', ')} (defini dans ${home}) sans charger `
          + `<script src="/${home}"> — ReferenceError au premier appel (audit frontend D6).`,
        );
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------
// Dette D2 : un id déclaré deux fois dans une page est invalide et devient
// un piège dès que les deux occurrences coexistent. Deux comptes :
//   * le HTML statique (cas classique) ;
//   * le meme <script> : deux emissions d'un meme id dans le meme code
//     (branches de ternaires, gabarits rendus au clic) signifient qu'un
//     chemin d'execution peut doubler l'id dans le DOM — le listener
//     rattache alors le mauvais element. Un seul exemplaire par script
//     force un id distinct par branche (audit frontend D2).
// Les ids contenant " ou $ (gabarits dynamiques) sont hors perimetre.
// ---------------------------------------------------------------------
const STATIC_HTML = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const STATIC_STYLE = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
const HTML_ID = /\sid="([^"$]+)"/g;
const SCRIPT_TAG = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

async function checkDuplicateIds() {
  const errors = [];
  for (const page of await collectPages()) {
    const html = await readIfPresent(page);
    if (!html) continue;
    const staticHtml = html.replace(STATIC_HTML, '').replace(STATIC_STYLE, '');
    const ids = new Map();
    for (const match of staticHtml.matchAll(HTML_ID)) {
      const id = match[1];
      if (!ids.has(id)) ids.set(id, { count: 0, index: match.index });
      ids.get(id).count += 1;
    }
    for (const [id, info] of ids) {
      if (info.count > 1) {
        errors.push(
          `${relative(page)}:${lineOf(staticHtml, info.index)}: id="${id}" déclaré ${info.count} fois `
          + 'dans le HTML statique — un seul élément porteur de cet id peut exister dans le DOM.',
        );
      }
    }
    SCRIPT_TAG.lastIndex = 0;
    let script;
    while ((script = SCRIPT_TAG.exec(html)) !== null) {
      // Offset réel du contenu dans le fichier (en-tête inclus).
      const contentStart = script.index + script[0].length - script[1].length - '</script>'.length;
      const seen = new Map();
      for (const match of script[1].matchAll(HTML_ID)) {
        const id = match[1];
        if (!seen.has(id)) seen.set(id, { count: 0, index: match.index });
        seen.get(id).count += 1;
      }
      for (const [id, info] of seen) {
        if (info.count > 1) {
          errors.push(
            `${relative(page)}:${lineOf(html, contentStart + info.index)}: id="${id}" émis ${info.count} fois `
            + 'dans le même script — deux chemins d’exécution peuvent doubler l’id dans le DOM '
            + '(id distinct par branche, audit frontend D2).',
          );
        }
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------
// Dette D6 : chaque page doit déclarer meta viewport (rendu mobile) et
// l'encodage ne doit jamais régresser vers du CP1252 réinterprété
// (bugs B2/B6 de l'audit : « Mes employÃ©s », « DÃ©connexion », U+FFFD).
// ---------------------------------------------------------------------
const VIEWPORT_META = /<meta[^>]+name="viewport"/i;
const MOJIBAKE = /Ã[\u0080-\u00BF]|â€|Â[¡¿«»]|âŒ|âœ|ðŸ|[\u01F0-\u01FF]/g;
const REPLACEMENT_CHAR = /\uFFFD/g;

async function checkViewport() {
  const errors = [];
  for (const page of await collectPages()) {
    const html = await readIfPresent(page);
    if (html && !VIEWPORT_META.test(html)) {
      errors.push(`${relative(page)}: <meta name="viewport"> absente — rendu dézoomé sur mobile.`);
    }
  }
  return errors;
}

async function checkEncoding() {
  const errors = [];
  for (const file of await collectFrontAssets()) {
    const content = await readIfPresent(file);
    if (!content) continue;
    const bad = new Set();
    for (const match of content.matchAll(MOJIBAKE)) bad.add(match[0]);
    const replacement = content.match(REPLACEMENT_CHAR);
    if (replacement) bad.add(`\uFFFD (x${replacement.length})`);
    if (bad.size) {
      const first = content.search(/Ã[\u0080-\u00BF]|â€|Â[¡¿«»]|âŒ|âœ|ðŸ|[\u01F0-\u01FF]|\uFFFD/);
      errors.push(
        `${relative(file)}:${lineOf(content, first)}: séquence d'encodage corrompue `
        + `${[...bad].join(', ')} — texte CP1252 réinterprété (audit B2/B6).`,
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------
// Dette D8 : un catch entièrement silencieux (corps réduit à des
// commentaires) masque les pannes. Chaque échec doit au minimum tracer
// en console (console.warn pour un échec réel, console.debug pour une
// condition d'environnement attendue : stockage absent, réseau coupé…),
// et signaler l'erreur à l'utilisateur quand l'action lui appartient.
// ---------------------------------------------------------------------
const CATCH_OPEN = /catch\s*(?:\([^)]*\))?\s*\{/g;

function silentCatchLines(content) {
  const lines = [];
  CATCH_OPEN.lastIndex = 0;
  let match;
  while ((match = CATCH_OPEN.exec(content))) {
    let i = match.index + match[0].length;
    let depth = 1;
    while (i < content.length && depth > 0) {
      const c = content[i];
      if (c === "'" || c === '"') {
        i++;
        while (i < content.length && content[i] !== c) {
          if (content[i] === '\\') i++;
          i++;
        }
      } else if (c === '`') {
        i++;
        while (i < content.length && content[i] !== '`') {
          if (content[i] === '\\') i++;
          i++;
        }
      } else if (c === '/' && content[i + 1] === '/') {
        while (i < content.length && content[i] !== '\n') i++;
      } else if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    const body = content.slice(match.index + match[0].length, i - 1);
    const stripped = body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      .trim();
    if (!stripped) lines.push(lineOf(content, match.index));
  }
  return lines;
}

// ---------------------------------------------------------------------
// Dette D4 : duplication des espaces. Deux fichiers Part* strictement
// identiques signifient qu'une correction devra être réappliquée N fois
// (cause racine des bugs du 27/09). Un seul exemplaire doit exister,
// dans PartPublic quand le fichier est partagé.
// ---------------------------------------------------------------------
const DUP_MIN_SIZE = 128; // sous ce seuil, un fichier identique n'est qu'un gabarit vide

async function checkDuplicateFrontFiles() {
  const errors = [];
  const byContent = new Map();
  for (const file of await collectFrontAssets()) {
    const content = await readIfPresent(file);
    if (content === null || content.length < DUP_MIN_SIZE) continue;
    const key = content.replace(/\r\n/g, '\n');
    if (!byContent.has(key)) byContent.set(key, []);
    byContent.get(key).push(relative(file));
  }
  for (const files of byContent.values()) {
    if (files.length > 1) {
      errors.push(
        `${files.join(' | ')} : fichiers strictement identiques — `
        + 'un seul exemplaire doit subsister (dette D4, duplication des espaces).',
      );
    }
  }
  return errors;
}

async function checkSilentCatches() {
  const errors = [];
  for (const file of await collectFrontFiles()) {
    const content = await readIfPresent(file);
    if (!content) continue;
    const lines = silentCatchLines(content);
    if (lines.length) {
      errors.push(
        `${relative(file)} (l.${lines.join(', l.')}) : catch silencieux — `
        + 'trace console obligatoire (console.warn / console.debug), message utilisateur si l\'action appartient à l\'utilisateur (dette D8).',
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------
// Dette D3 : la CSP ne contient plus 'unsafe-inline' en script-src —
// tout handler on*= ou URL javascript: écrit dans le HTML (ou dans un
// gabarit JS injecté) serait donc bloqué au clic, silencieusement.
// Ce contrôle verrouille l'état atteint par D5/D3 : ces vecteurs ne
// doivent pas réapparaître. La conversion attendue est la délégation
// d'événements (data-action + addEventListener), déjà en place.
// ---------------------------------------------------------------------
const INLINE_HANDLER = /\son[a-z]+\s*=\s*["']/i;
const JS_URL = /(?:href|src|action)\s*=\s*["']\s*javascript:/i;

async function checkInlineScriptVectors() {
  const errors = [];
  for (const file of await collectFrontAssets()) {
    const content = await readIfPresent(file);
    if (!content) continue;
    for (const pattern of [INLINE_HANDLER, JS_URL]) {
      const match = pattern.exec(content);
      if (match) {
        errors.push(
          `${relative(file)}:${lineOf(content, match.index)}: « ${match[0].trim()} » — `
          + 'vecteur d\'exécution inline bloqué par la CSP script-src (dette D3) : utiliser data-action + délégation.',
        );
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------
// Cohérence de la navigation statique : tout href/src d'une page (hors
// scripts, déjà couverts par la suite e2e frontend) doit pointer vers
// un fichier existant — lien de sidebar oublié, page renommée sans
// mise à jour des entrées, ressource manquante. Compense l'impossibilité
// d'une revue visuelle systématique.
// ---------------------------------------------------------------------
const PAGE_REF = /(?:href|src)\s*=\s*"([^"]+)"/gi;
const EXTERNAL_REF = /^(?:https?:)?\/\/|^(?:mailto|tel|data|javascript):/i;

async function checkInternalLinks() {
  const errors = [];
  for (const page of await collectPages()) {
    const html = await readIfPresent(page);
    if (!html) continue;
    const staticHtml = html.replace(STATIC_HTML, '').replace(STATIC_STYLE, '');
    PAGE_REF.lastIndex = 0;
    let match;
    while ((match = PAGE_REF.exec(staticHtml)) !== null) {
      const url = match[1];
      if (!url || url.startsWith('#') || EXTERNAL_REF.test(url) || url.startsWith('/api/')) continue;
      const clean = url.split('#')[0].split('?')[0];
      if (!clean) continue;
      const target = clean.startsWith('/')
        ? (/^\/Part[A-Za-z0-9_]+\//.test(clean) || clean.startsWith('/images/')
          ? path.join(root, clean)
          : path.join(root, 'PartPublic', clean))
        : path.resolve(path.dirname(page), clean);
      if (!existsSync(target)) {
        errors.push(
          `${relative(page)}:${lineOf(staticHtml, match.index)}: « ${url} » — `
          + 'cible introuvable (lien ou ressource cassé).',
        );
      }
    }
  }
  return errors;
}

async function runGuards(files) {
  const htmlFiles = await collectFrontFiles();
  const scanned = [...new Set([...files, ...htmlFiles])];
  const errors = [];
  errors.push(...await checkMigrationSafety());
  errors.push(...await checkEscapeHelpers());
  errors.push(...await checkDynamicEvaluation(scanned));
  errors.push(...await checkInnerHTMLEscaping(scanned));
  errors.push(...await checkSchemaDump());
  errors.push(...await checkBootOrder());
  errors.push(...await checkEnvTemplate());
  errors.push(...await checkHelperLoading());
  errors.push(...await checkDuplicateIds());
  errors.push(...await checkViewport());
  errors.push(...await checkEncoding());
  errors.push(...await checkDuplicateFrontFiles());
  errors.push(...await checkSilentCatches());
  errors.push(...await checkInlineScriptVectors());
  errors.push(...await checkInternalLinks());
  return errors;
}

const mode = process.argv[2] || 'syntax';
const files = await collectSourceFiles(root);
const errors = [];
for (const file of files) {
  const error = checkSyntax(file);
  if (error) errors.push(error);
}
if (mode === 'lint') errors.push(...await checkConflicts(files));
if (mode === 'typecheck' || mode === 'lint') errors.push(...await checkManifests());
if (mode === 'lint') errors.push(...await runGuards(files));

if (errors.length) {
  console.error(errors.join('\n\n'));
  process.exit(1);
}

console.log(`${mode}: ${files.length} fichiers JavaScript vérifiés${mode === 'lint' ? ' + contrôles de garde (migrations, XSS, innerHTML, schéma de référence, démarrage, configuration, helpers chargés, doublons d\'id, viewport, encodage, duplication, catch silencieux)' : ''}`);
