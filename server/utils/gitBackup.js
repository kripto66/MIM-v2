import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const GIT_CANDIDATES = [process.env.GIT_BIN, 'git'].filter(Boolean);
const ENABLED = Boolean(process.env.GIT_REPO_PATH) && process.env.GIT_BACKUP === 'true';
const SECRET_PATH = /(?:^|[\\/])(?:\.env(?:\..*)?|\.npmrc|\.pypirc|id_rsa(?:\..*)?|id_ecdsa(?:\..*)?|id_ed25519(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore))$/i;
const SECRET_CONTENT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{20,}\b/,
  /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /(?:^|\n)\s*(?:SUPABASE_SERVICE_ROLE_KEY|SUPABASE_ANON_KEY|BICTORYS_API_KEY|BICTORYS_WEBHOOK_SECRET|PAYDUNYA_MASTER_KEY|JWT_SECRET|SMTP_PASSWORD|ADMIN_PASSWORD|SUPABASE_PAT|GITHUB_TOKEN|NPM_TOKEN)\s*=\s*(?!remplacer|remplace|votre|your|change|<|\$\{|test_public|test_secret|bictorys_test_secret|Test\d|Admin\d|Vierge\d)[^\s#]{12,}/im,
];

let pipeline = Promise.resolve();
let cachedGit = null;

function normalizePath(file) {
  return String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function isSensitivePath(file) {
  const normalized = normalizePath(file);
  if (/(^|\/)\.env\.example$/i.test(normalized)) return false;
  return SECRET_PATH.test(normalized);
}

function containsSecret(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
  if (text.includes('\u0000')) return false;
  return SECRET_CONTENT.some((pattern) => pattern.test(text));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function splitPaths(value) {
  return String(value || '').split('\0').filter(Boolean);
}

async function runGit(gitExe, repo, args) {
  return exec(gitExe, ['-C', repo, ...args], {
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30000,
    windowsHide: true,
  });
}

async function findGit() {
  if (cachedGit) return cachedGit;
  for (const candidate of GIT_CANDIDATES) {
    try {
      await exec(candidate, ['--version'], { windowsHide: true });
      cachedGit = candidate;
      return cachedGit;
    } catch {
    }
  }
  return null;
}

async function changedPaths(gitExe, repo) {
  const worktree = await runGit(gitExe, repo, ['diff', '--name-only', '-z']);
  const staged = await runGit(gitExe, repo, ['diff', '--cached', '--name-only', '-z']);
  const untracked = await runGit(gitExe, repo, ['ls-files', '--others', '--exclude-standard', '-z']);
  return unique([...splitPaths(worktree.stdout), ...splitPaths(staged.stdout), ...splitPaths(untracked.stdout)]);
}

async function inspectWorktree(gitExe, repo) {
  const files = await changedPaths(gitExe, repo);
  for (const file of files) {
    if (isSensitivePath(file)) return { success: false, reason: 'secret_detected', file };
    try {
      const content = await readFile(path.resolve(repo, file));
      if (containsSecret(content)) return { success: false, reason: 'secret_detected', file };
    } catch (error) {
      if (error.code !== 'ENOENT') return { success: false, reason: 'secret_detected', file };
    }
  }
  return { success: true };
}

async function inspectIndex(gitExe, repo) {
  const result = await runGit(gitExe, repo, ['diff', '--cached', '--name-only', '-z']);
  const files = splitPaths(result.stdout);
  for (const file of files) {
    if (isSensitivePath(file)) return { success: false, reason: 'secret_detected', file };
    try {
      const content = await runGit(gitExe, repo, ['show', `:${file}`]);
      if (containsSecret(content.stdout)) return { success: false, reason: 'secret_detected', file };
    } catch {
      return { success: false, reason: 'secret_detected', file };
    }
  }
  return { success: true };
}

function redact(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s]+/gi, '[url-redacted]')
    .replace(/(token|secret|key|password|passwd|pwd)=[^\s&]+/gi, '$1=[redacted]')
    .slice(0, 200);
}

async function runBackup() {
  if (!ENABLED) return { success: false, reason: 'disabled' };

  const repo = process.env.GIT_REPO_PATH;
  const gitExe = await findGit();
  if (!gitExe) return { success: false, reason: 'git_introuvable' };

  const branch = process.env.GIT_BRANCH || 'master';
  const safeMessage = 'Sauvegarde code MIM';

  try {
    const worktreeCheck = await inspectWorktree(gitExe, repo);
    if (!worktreeCheck.success) return worktreeCheck;

    await runGit(gitExe, repo, ['add', '-A']);

    const indexCheck = await inspectIndex(gitExe, repo);
    if (!indexCheck.success) return indexCheck;

    const staged = await runGit(gitExe, repo, ['diff', '--cached', '--name-only', '-z']);
    const hasStagedChanges = splitPaths(staged.stdout).length > 0;
    if (hasStagedChanges) {
      await runGit(gitExe, repo, ['commit', '-m', safeMessage]);
    }
    await runGit(gitExe, repo, ['push', 'origin', branch]);

    console.log(`[git] Sauvegarde code OK : ${safeMessage}`);
    return { success: true };
  } catch (err) {
    const detail = `${err.stderr || ''}\n${err.stdout || ''}\n${err.message || ''}`;
    if (/nothing to commit/i.test(detail)) return { success: false, reason: 'nothing_to_commit' };
    if (/secret|private key|credential/i.test(detail)) return { success: false, reason: 'secret_detected' };
    console.warn('[git] Sauvegarde ignorée :', redact(detail));
    return { success: false, reason: redact(detail) };
  }
}

export function gitAutoBackup(message) {
  const task = pipeline.then(() => runBackup(message));
  pipeline = task.then(
    () => {},
    () => {}
  );
  return task;
}
