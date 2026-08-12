import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const GIT = 'C:\\Users\\EsNova\\AppData\\Local\\Programs\\Git\\cmd\\git.exe';

export async function gitAutoBackup(message) {
  const repo = process.env.GIT_REPO_PATH;

  if (!repo) {
    console.warn('[git] GIT_REPO_PATH non défini, sauvegarde ignorée.');
    return { success: false, reason: 'no_path' };
  }

  const branch = process.env.GIT_BRANCH || 'master';

  try {
    await exec(GIT, ['-C', repo, 'add', '-A']);
    await exec(GIT, ['-C', repo, 'commit', '-m', message]);
    const { stdout } = await exec(GIT, ['-C', repo, 'push', 'origin', branch]);

    console.log(`[git] Sauvegarde automatique OK : ${message}`);
    return { success: true, output: stdout };
  } catch (err) {
    if (String(err.stderr || err).includes('nothing to commit')) {
      console.log('[git] Rien à sauvegarder.');
      return { success: true, reason: 'nothing_to_commit' };
    }

    console.error('[git] Erreur de sauvegarde :', String(err.stderr || err).slice(0, 300));
    return { success: false, reason: String(err.stderr || err) };
  }
}
