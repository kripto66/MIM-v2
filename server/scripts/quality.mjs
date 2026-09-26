import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dirname, '..', '..');
const skippedDirectories = new Set(['.git', 'node_modules', '.aider.tags.cache.v4', '.temp']);

async function collectSourceFiles(directory) {
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
      if (!skippedDirectories.has(entry.name)) files.push(...await collectSourceFiles(fullPath));
      continue;
    }
    if (entry.isFile() && ['.js', '.mjs', '.cjs'].includes(path.extname(entry.name))) files.push(fullPath);
  }
  return files;
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

const mode = process.argv[2] || 'syntax';
const files = await collectSourceFiles(root);
const errors = [];
for (const file of files) {
  const error = checkSyntax(file);
  if (error) errors.push(error);
}
if (mode === 'lint') errors.push(...await checkConflicts(files));
if (mode === 'typecheck' || mode === 'lint') errors.push(...await checkManifests());

if (errors.length) {
  console.error(errors.join('\n\n'));
  process.exit(1);
}

console.log(`${mode}: ${files.length} fichiers JavaScript vérifiés`);
