// ============================================================
// MIM - Suite COMPLET : endpoints restants (tâches, espace employé
// étendu, update-profile, meta, mois-courant, test-mode, git,
// santé, pages publiques, confirmation loyer locataire)
// + Suite MATRICE : combinaisons rôles × endpoints (7 contextes)
// ============================================================

import { api, newJar, expectSuccess, loginForBusiness, createConfirmedSession } from './lib.js';

const S = 'complet';
const M = 'matrice';
const WEB = (process.env.TEST_BASE || 'http://127.0.0.1:3100/api').replace(/\/api$/, '');
const OWNER_PASSWORD = 'Test1234!';

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export async function runComplet(r, ctx) {
  const owner = ctx.seed.owners[4];
  const owner2 = ctx.seed.owners[3];
  const jar = owner.jar;

  await r.section('santé et pages publiques', async () => {
    try {
      const health = await fetch(`${WEB}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (health.status === 200) r.pass(S, 'GET /api/health ? 200');
      else r.fail(S, 'GET /api/health ? 200', `statut ${health.status}`);
    } catch (e) {
      r.fail(S, 'GET /api/health ? 200', e.message);
    }
  });

  await r.section('PUT /auth/update-profile', async () => {
    const noName = await api('/auth/update-profile', { method: 'PUT', jar, body: {} });
    if (noName.status === 400) r.pass(S, 'sans nom ? 400');
    else r.fail(S, 'sans nom ? 400', `statut ${noName.status}`);

    const newName = `Propriétaire Complet ${owner.i}`;
    const upd = await api('/auth/update-profile', {
      method: 'PUT',
      jar,
      body: { name: newName, phone: '+221770000099' },
    });
    if (!expectSuccess(r, upd, S, 'mise à jour nom + téléphone')) return;

    const me = await api('/auth/me', { jar });
    if (me.data?.user?.name === newName) r.pass(S, '/auth/me reflète le nouveau nom');
    else r.fail(S, '/auth/me reflète le nouveau nom', String(me.data?.user?.name));
  });

  await r.section('routes utilitaires authentifiées', async () => {
    const backup = await api('/git/backup', { method: 'POST', jar });
    if (backup.status === 200) r.pass(S, 'POST /git/backup ? 200');
    else r.fail(S, 'POST /git/backup ? 200', `statut ${backup.status}`);

    const mc = await api('/employes/mois-courant', { jar });
    if (
      expectSuccess(r, mc, S, 'GET /employes/mois-courant') &&
      mc.data.mois === currentMonth()
    ) {
      r.pass(S, 'mois-courant renvoie le mois courant');
    } else if (mc.data?.mois !== currentMonth()) {
      r.fail(S, 'mois-courant renvoie le mois courant', String(mc.data?.mois));
    }

    for (const base of ['import', 'onboarding']) {
      const meta = await api(`/${base}/meta`, { jar });
      const cats = Array.isArray(meta.data?.categories) ? meta.data.categories : [];
      const okCats = ['biens', 'logements', 'locataires', 'employes'].every((c) => cats.includes(c));
      const okPw = meta.data && !Object.prototype.hasOwnProperty.call(meta.data, 'initialPassword');
      if (
        expectSuccess(r, meta, S, `GET /${base}/meta`) &&
        okCats &&
        okPw
      ) {
        r.pass(S, `${base}/meta : catégories complètes, aucun secret global`);
      } else if (!okCats || !okPw) {
        r.fail(S, `${base}/meta : catégories complètes + mot de passe initial aléatoire`, cats.join(','));
      }
    }
  });

  await r.section('sauvegardes code/base (H-16)', async () => {
    const { execFileSync } = await import('node:child_process');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const pathMod = await import('node:path');

    const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
    const tmp = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'mim-h16-'));
    const savedEnv = {
      GIT_REPO_PATH: process.env.GIT_REPO_PATH,
      GIT_BACKUP: process.env.GIT_BACKUP,
      GIT_BRANCH: process.env.GIT_BRANCH,
      MIM_DB_BACKUP_DIR: process.env.MIM_DB_BACKUP_DIR,
      MIM_DB_CONTAINER: process.env.MIM_DB_CONTAINER,
      MIM_DB_BACKUP_INTERVAL_MS: process.env.MIM_DB_BACKUP_INTERVAL_MS,
    };

    try {
      // ---- Volet git : un commit retenu localement doit partir des que
      // le remote redevient disponible, meme sans nouveau changement.
      const remote = pathMod.join(tmp, 'remote.git');
      const work = pathMod.join(tmp, 'work');
      fs.mkdirSync(remote);
      fs.mkdirSync(work);
      git(['init', '--bare', remote]);
      git(['symbolic-ref', 'HEAD', 'refs/heads/master'], remote);
      git(['init'], work);
      git(['config', 'user.email', 'h16@mim.test'], work);
      git(['config', 'user.name', 'H16'], work);
      fs.writeFileSync(pathMod.join(work, 'a.txt'), 'v1');
      git(['add', '-A'], work);
      git(['commit', '-m', 'init'], work);
      git(['remote', 'add', 'origin', remote], work);
      git(['push', '-u', 'origin', 'master'], work);

      process.env.GIT_REPO_PATH = work;
      process.env.GIT_BACKUP = 'true';
      process.env.GIT_BRANCH = 'master';

      // Instance fraîche : ENABLED est figé au chargement du module.
      const gitBackup = await import(`../../utils/gitBackup.js?h16=${Date.now()}`);

      // Remote injoignable : le commit est retenu, l'echec est signale.
      fs.renameSync(remote, `${remote}.off`);
      fs.writeFileSync(pathMod.join(work, 'a.txt'), 'v2');
      const blocked = await gitBackup.gitAutoBackup('test H-16');
      if (blocked.success === false && blocked.reason === 'push_failed') {
        r.pass(S, 'remote injoignable ? push_failed (et non succès trompeur)');
      } else {
        r.fail(S, 'remote injoignable ? push_failed', JSON.stringify(blocked));
      }
      const localHead = git(['log', '-1', '--format=%s'], work);
      if (localHead === 'Sauvegarde code Okarne GM') r.pass(S, 'commit local conservé malgré le push refusé');
      else r.fail(S, 'commit local conservé malgré le push refusé', localHead);

      // Remote restauré, AUCUN changement nouveau : le retard doit partir.
      fs.renameSync(`${remote}.off`, remote);
      const retried = await gitBackup.gitAutoBackup('test H-16');
      if (retried.success === true) r.pass(S, 'remote rétabli ? poussée réussie sans nouveau commit');
      else r.fail(S, 'remote rétabli ? poussée réussie sans nouveau commit', JSON.stringify(retried));
      const remoteHead = git(['log', '-1', '--format=%s', 'master'], remote);
      if (remoteHead === 'Sauvegarde code Okarne GM') r.pass(S, 'commit en retard présent sur le remote');
      else r.fail(S, 'commit en retard présent sur le remote', remoteHead);

      // ---- Volet base : throttle + echec best-effort (jamais d'exception).
      process.env.MIM_DB_BACKUP_DIR = pathMod.join(tmp, 'dumps');
      process.env.MIM_DB_CONTAINER = 'mim-inexistant-h16';
      process.env.MIM_DB_BACKUP_INTERVAL_MS = '3600000';
      const dbBackup = await import('../../utils/dbBackup.js');

      const failed = await dbBackup.runDbBackup();
      if (failed.success === false && failed.reason === 'dump_failed') r.pass(S, 'pg_dump impossible ? échec retourné, pas d\'exception');
      else r.fail(S, 'pg_dump impossible ? échec retourné, pas d\'exception', JSON.stringify(failed));

      fs.writeFileSync(pathMod.join(tmp, 'dumps', '.last-dump'), new Date().toISOString());
      const throttled = await dbBackup.runDbBackup();
      if (throttled.reason === 'throttled') r.pass(S, 'dump récent ? throttle (pas de rejeu)');
      else r.fail(S, 'dump récent ? throttle (pas de rejeu)', JSON.stringify(throttled));

      const forced = await dbBackup.runDbBackup({ force: true });
      if (forced.success === false && forced.reason === 'dump_failed') r.pass(S, '--force ignore le throttle');
      else r.fail(S, '--force ignore le throttle', JSON.stringify(forced));
    } catch (error) {
      r.fail(S, 'sauvegardes H-16', error.message);
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await r.section('locataire confirme un paiement a_confirmer', async () => {
    const tenant = owner.locataires[0];
    const session = await loginForBusiness(owner.locataires[0].username, OWNER_PASSWORD);
    const ljar = session.jar;
    if (session.login.status !== 200 || (session.change && session.change.status !== 200)) {
      r.fail(S, 'connexion locataire own1loc1', `statut ${session.login.status}`);
      return;
    }

    const list = await api('/paiements', { jar });
    const paiement = (list.data?.data || []).find((p) => p.locataire_id === tenant.id);
    if (!paiement) {
      r.fail(S, 'paiement du locataire trouvé chez le propriétaire', 'aucun');
      return;
    }

    const mark = await api(`/paiements/${paiement.id}`, {
      method: 'PUT',
      jar,
      body: { statut: 'a_confirmer' },
    });
    if (!expectSuccess(r, mark, S, 'propriétaire marque le loyer a_confirmer')) return;

    const conf = await api(`/locataire/paiements/${paiement.id}/confirmer`, { method: 'POST', jar: ljar });
    expectSuccess(r, conf, S, 'locataire confirme le paiement');

    const after = await api('/paiements', { jar });
    const refreshed = (after.data?.data || []).find((p) => p.id === paiement.id);
    if (refreshed?.statut === 'en_validation') r.pass(S, 'statut passé à en_validation');
    else r.fail(S, 'statut passé à en_validation', String(refreshed?.statut));

    const validate = await api(`/paiements-validation/${paiement.id}/valider`, { method: 'POST', jar });
    expectSuccess(r, validate, S, 'propriétaire valide le paiement confirmé');

    const after2 = await api('/paiements', { jar });
    const final = (after2.data?.data || []).find((p) => p.id === paiement.id);
    if (final?.statut === 'paye') r.pass(S, 'chaîne complète : statut final paye');
    else r.fail(S, 'chaîne complète : statut final paye', String(final?.statut));

    const again = await api(`/locataire/paiements/${paiement.id}/confirmer`, { method: 'POST', jar: ljar });
    if (again.status === 400) r.pass(S, 're-confirmation refusée (400)');
    else r.fail(S, 're-confirmation refusée (400)', `statut ${again.status}`);
  });

  await r.section('espace employé : profil, mot de passe, tâches, interventions, paiements, notifications', async () => {
    const created = await api('/employes', {
      method: 'POST',
      jar,
      body: { nom: 'Complet Employe', poste: 'Agent de sécurité', biens: [owner.bienId] },
    });
    if (!expectSuccess(r, created, S, 'création employé auto')) return;
    const username = created.data.account.username;
    const password = created.data.account.password;
    const empId = created.data.data.id;

    const ejar = newJar();
    const login = await api('/auth/login', {
      method: 'POST',
      jar: ejar,
      body: { identifier: username, password },
    });
    if (!expectSuccess(r, login, S, 'première connexion employé (mdp initial)')) return;
    if (login.data.mustChangePassword === true) r.pass(S, 'mustChangePassword au premier login');
    else r.fail(S, 'mustChangePassword au premier login', String(login.data.mustChangePassword));

    // Tant que must_change_password est vrai, l'employé est bloqué sur
    // toutes les routes métier (requirePasswordChanged) sauf sur celle
    // qui change le mot de passe : on vérifie d'abord cette sortie de
    // secours, sinon le compte serait enfermé.
    const badPw = await api('/employe/password', {
      method: 'PUT',
      jar: ejar,
      body: { new_password: 'court' },
    });
    if (badPw.status === 400) r.pass(S, 'mot de passe faible refusé (400)');
    else r.fail(S, 'mot de passe faible refusé (400)', `statut ${badPw.status}`);

    const chpw = await api('/employe/password', {
      method: 'PUT',
      jar: ejar,
      body: { new_password: 'Emploi1234!' },
    });
    expectSuccess(r, chpw, S, 'changement de mot de passe forcé (sans ancien)');

    const ej = newJar();
    const relog = await api('/auth/login', {
      method: 'POST',
      jar: ej,
      body: { identifier: username, password: 'Emploi1234!' },
    });
    if (relog.status === 200 && relog.data.mustChangePassword === false) {
      r.pass(S, 'relogin : mustChangePassword repassé à false');
    } else {
      r.fail(S, 'relogin : mustChangePassword repassé à false', `statut ${relog.status} mcp=${relog.data.mustChangePassword}`);
    }
    const workingJar = relog.status === 200 ? ej : ejar;

    const me = await api('/employe/me', { jar: workingJar });
    if (
      expectSuccess(r, me, S, 'GET /employe/me') &&
      me.data.data.role === 'employe' &&
      me.data.data.poste === 'Agent de sécurité'
    ) {
      r.pass(S, 'profil employé complet (rôle + poste)');
    } else if (me.data?.data?.role !== 'employe') {
      r.fail(S, 'profil employé complet (rôle + poste)', JSON.stringify(me.data).slice(0, 150));
    }

    const updName = await api('/employe/profile', {
      method: 'PUT',
      jar: workingJar,
      body: { name: 'Complet Employe Modifié' },
    });
    expectSuccess(r, updName, S, 'PUT /employe/profile (nom)');

    const badUsername = await api('/employe/profile', {
      method: 'PUT',
      jar: workingJar,
      body: { username: 'X invalide !' },
    });
    if (badUsername.status === 400) r.pass(S, 'username invalide refusé (400)');
    else r.fail(S, 'username invalide refusé (400)', `statut ${badUsername.status}`);

    const list = await api('/employes', { jar });
    const fiche = (list.data?.data || []).find((e) => e.id === empId);
    const accountUid = fiche?.account_uid;

    let task = null;
    if (accountUid) {
      task = await api('/tasks', {
        method: 'POST',
        jar,
        body: { titre: 'Tache EMPLOYE Complet', employe_uid: accountUid },
      });
      expectSuccess(r, task, S, "création tâche assignée à l'employé");
    } else {
      r.fail(S, "création tâche assignée à l'employé", 'account_uid introuvable dans la liste');
    }

    const etasks = await api('/employe/tasks', { jar: workingJar });
    const seen = (etasks.data?.data || []).some((t) => t.titre === 'Tache EMPLOYE Complet');
    if (expectSuccess(r, etasks, S, 'GET /employe/tasks') && seen) {
      r.pass(S, "l'employé voit sa tâche assignée");
    } else if (!seen && task?.data?.data?.id) {
      r.fail(S, "l'employé voit sa tâche assignée", 'tâche absente');
    }

    const inters = await api('/employe/interventions', { jar: workingJar });
    const interList = inters.data?.data;
    if (expectSuccess(r, inters, S, 'GET /employe/interventions') && Array.isArray(interList)) {
      if (interList.length > 0) r.pass(S, 'interventions du bien affecté visibles');
      else r.pass(S, 'interventions : liste vide valide');
    }

    const epaiements = await api('/employe/paiements', { jar: workingJar });
    if (
      expectSuccess(r, epaiements, S, 'GET /employe/paiements') &&
      Array.isArray(epaiements.data.data)
    ) {
      r.pass(S, 'liste des salaires');
    }

    const readAll = await api('/employe/notifications/read-all', { method: 'POST', jar: workingJar });
    const notifs = await api('/notifications', { jar: workingJar });
    const allRead = (notifs.data?.data || []).every((n) => n.lu === true);
    if (expectSuccess(r, readAll, S, 'POST /employe/notifications/read-all') && allRead) {
      r.pass(S, 'toutes les notifications marquées lues');
    } else if (!allRead) {
      r.fail(S, 'toutes les notifications marquées lues', 'au moins une notification non lue');
    }

    if (task?.data?.data?.id) {
      await api(`/tasks/${task.data.data.id}`, { method: 'DELETE', jar });
    }
    await api(`/employes/${empId}`, { method: 'DELETE', jar });
    const gone = await api('/auth/login', {
      method: 'POST',
      jar: newJar(),
      body: { identifier: username, password: 'Emploi1234!' },
    });
    if (gone.status === 401) r.pass(S, 'compte employé désactivé après suppression');
    else r.fail(S, 'compte employé désactivé après suppression', `statut ${gone.status}`);
  });

  await r.section('tasks CRUD propriétaire : validations et isolation', async () => {
    const noTitre = await api('/tasks', { method: 'POST', jar, body: { titre: '' } });
    if (noTitre.status === 400) r.pass(S, 'titre vide ? 400');
    else r.fail(S, 'titre vide ? 400', `statut ${noTitre.status}`);

    const longTitre = await api('/tasks', { method: 'POST', jar, body: { titre: 'x'.repeat(201) } });
    if (longTitre.status === 400) r.pass(S, 'titre > 200 caractères ? 400');
    else r.fail(S, 'titre > 200 caractères ? 400', `statut ${longTitre.status}`);

    const badStatut = await api('/tasks', { method: 'POST', jar, body: { titre: 'T', statut: 'nope' } });
    if (badStatut.status === 400) r.pass(S, 'statut invalide ? 400');
    else r.fail(S, 'statut invalide ? 400', `statut ${badStatut.status}`);

    const badDate = await api('/tasks', { method: 'POST', jar, body: { titre: 'T', echeance: 'pasunedate' } });
    if (badDate.status === 400) r.pass(S, 'échéance invalide ? 400');
    else r.fail(S, 'échéance invalide ? 400', `statut ${badDate.status}`);

    const badEmp = await api('/tasks', {
      method: 'POST',
      jar,
      body: { titre: 'T', employe_uid: '00000000-0000-0000-0000-000000000000' },
    });
    if (badEmp.status === 400) r.pass(S, 'employé inconnu ? 400');
    else r.fail(S, 'employé inconnu ? 400', `statut ${badEmp.status}`);

    const created = await api('/tasks', {
      method: 'POST',
      jar,
      body: { titre: 'Complet Tache CRUD', description: 'desc', echeance: '2026-12-31' },
    });
    if (!expectSuccess(r, created, S, 'création tâche valide')) return;
    const taskId = created.data.data.id;

    const list = await api('/tasks', { jar });
    if ((list.data?.data || []).some((t) => t.id === taskId)) r.pass(S, 'tâche présente dans GET /tasks');
    else r.fail(S, 'tâche présente dans GET /tasks', 'absente');

    const upd = await api(`/tasks/${taskId}`, { method: 'PUT', jar, body: { statut: 'en_cours' } });
    expectSuccess(r, upd, S, 'PUT statut en_cours');

    const emptyTitre = await api(`/tasks/${taskId}`, { method: 'PUT', jar, body: { titre: '  ' } });
    if (emptyTitre.status === 400) r.pass(S, 'PUT titre vide ? 400');
    else r.fail(S, 'PUT titre vide ? 400', `statut ${emptyTitre.status}`);

    const badUpd = await api(`/tasks/${taskId}`, { method: 'PUT', jar, body: { statut: 'nope' } });
    if (badUpd.status === 400) r.pass(S, 'PUT statut invalide ? 400');
    else r.fail(S, 'PUT statut invalide ? 400', `statut ${badUpd.status}`);

    const ghostId = '11111111-1111-1111-1111-111111111111';
    const ghost = await api(`/tasks/${ghostId}`, { method: 'PUT', jar, body: { statut: 'termine' } });
    if (ghost.status === 404) r.pass(S, 'PUT tâche inexistante ? 404');
    else r.fail(S, 'PUT tâche inexistante ? 404', `statut ${ghost.status}`);

    const foreign = await api(`/tasks/${taskId}`, { method: 'PUT', jar: owner2.jar, body: { statut: 'termine' } });
    if (foreign.status === 404) r.pass(S, "tâche d'un autre propriétaire invisible (404)");
    else r.fail(S, "tâche d'un autre propriétaire invisible (404)", `statut ${foreign.status}`);

    const del = await api(`/tasks/${taskId}`, { method: 'DELETE', jar });
    expectSuccess(r, del, S, 'suppression tâche');
    const after = await api('/tasks', { jar });
    if (!(after.data?.data || []).some((t) => t.id === taskId)) r.pass(S, 'tâche supprimée de la liste');
    else r.fail(S, 'tâche supprimée de la liste', 'encore présente');
  });
}

// ============================================================
// MATRICE : 7 contextes × N endpoints
// ============================================================

const ALL_AUTH = ['proprietaire', 'agence', 'entreprise', 'locataire', 'employe', 'admin'];
const OWNERS = ['proprietaire', 'agence', 'entreprise'];

function expectedFor(spec) {
  const exp = { anonyme: spec.anon ?? 401 };
  for (const c of OWNERS) exp[c] = spec.owner ?? 403;
  exp.locataire = spec.locataire ?? 403;
  exp.employe = spec.employe ?? 403;
  exp.admin = spec.admin ?? 403;
  return exp;
}

export async function runMatrice(r, ctx) {
  const service = ctx.service;
  const owner = ctx.seed.owners[2];
  const stamp = Date.now();

  const jars = { anonyme: undefined };

  let agenceSession;
  try {
    agenceSession = await createConfirmedSession(service, {
      account_type: 'agence',
      name: `Agence Matrice ${stamp}`,
      email: `agence.matrix.${stamp}@mimtest.com`,
      phone: '+221771112233',
      password: OWNER_PASSWORD,
    });
    jars.agence = agenceSession.jar;
  } catch (error) {
    r.fail(M, 'inscription agence', error.message);
    return;
  }

  let entrepriseSession;
  try {
    entrepriseSession = await createConfirmedSession(service, {
      account_type: 'entreprise',
      name: `Entreprise Matrice ${stamp}`,
      email: `entreprise.matrix.${stamp}@mimtest.com`,
      phone: '+221771112244',
      password: OWNER_PASSWORD,
    });
    jars.entreprise = entrepriseSession.jar;
  } catch (error) {
    r.fail(M, 'inscription entreprise', error.message);
    return;
  }

  jars.proprietaire = owner.jar;

  const tenantSession = await loginForBusiness(owner.locataires[4].username, OWNER_PASSWORD);
  jars.locataire = tenantSession.jar;
  if (tenantSession.login.status !== 200 || (tenantSession.change && tenantSession.change.status !== 200)) {
    r.fail(M, 'connexion locataire', `statut ${tenantSession.login.status}`);
    return;
  }

  const emp = await api('/employes', {
    method: 'POST',
    jar: owner.jar,
    body: { nom: `Matrice Employe ${stamp}`, poste: 'Testeur', biens: [owner.bienId] },
  });
  if (!expectSuccess(r, emp, M, 'création employé matrice')) return;
  jars.employe = newJar();
  const logE = await api('/auth/login', {
    method: 'POST',
    jar: jars.employe,
    body: { identifier: emp.data.account.username, password: emp.data.account.password },
  });
  if (logE.status !== 200) {
    r.fail(M, 'connexion employé', `statut ${logE.status}`);
    return;
  }
  if (logE.data.mustChangePassword) {
    const rotated = await api('/auth/change-password', {
      method: 'PUT',
      jar: jars.employe,
      body: { password: 'MatriceRotated1234!', password_confirm: 'MatriceRotated1234!' },
    });
    if (rotated.status !== 200) {
      r.fail(M, 'rotation du mot de passe employé', JSON.stringify(rotated.data));
      return;
    }
  }

  const adminEmail = `admin.matrix.${stamp}@mim.local`;
  const { data: adminData, error: adminErr } = await service.auth.admin.createUser({
    email: adminEmail,
    password: 'Admin1234!',
    email_confirm: true,
    user_metadata: { name: 'Admin Matrice' },
    app_metadata: { mim_account_type: 'admin' },
  });
  if (adminErr) {
    r.fail(M, 'création admin matrice', adminErr.message);
    return;
  }
  await service.from('profiles').update({ account_type: 'admin', role: 'admin' }).eq('id', adminData.user.id);
  jars.admin = newJar();
  const logA = await api('/auth/login', {
    method: 'POST',
    jar: jars.admin,
    body: { identifier: adminEmail, password: 'Admin1234!' },
  });
  if (logA.status !== 200) {
    r.fail(M, 'connexion admin', `statut ${logA.status}`);
    return;
  }

  const CASES = [
    {
      name: 'GET /biens (zone propriétaire)',
      path: '/biens',
      exp: expectedFor({ anon: 401, owner: 200 }),
    },
    {
      name: 'POST /tasks (zone propriétaire)',
      method: 'POST',
      path: '/tasks',
      body: { titre: 'MATRICE Tache' },
      cleanupTask: true,
      exp: expectedFor({ anon: 401, owner: 201 }),
    },
    {
      name: 'GET /stats/dashboard (zone propriétaire)',
      path: '/stats/dashboard',
      exp: expectedFor({ anon: 401, owner: 200 }),
    },
    {
      name: 'GET /import/status (zone propriétaire)',
      path: '/import/status',
      exp: expectedFor({ anon: 401, owner: 200 }),
    },
    {
      name: 'GET /paiements-validation/en-attente (zone propriétaire)',
      path: '/paiements-validation/en-attente',
      exp: expectedFor({ anon: 401, owner: 200 }),
    },
    {
      name: 'GET /subscription/me (zone propriétaire)',
      path: '/subscription/me',
      exp: expectedFor({ anon: 401, owner: 200 }),
    },
    {
      name: 'GET /moyens-paiement (zone propriétaire)',
      path: '/moyens-paiement',
      exp: expectedFor({ anon: 401, owner: 200 }),
    },
    {
      name: 'POST /git/backup (propriétaires + admin)',
      method: 'POST',
      path: '/git/backup',
      exp: expectedFor({ anon: 401, owner: 200, admin: 200 }),
    },
    {
      name: 'GET /employe/me (zone employé)',
      path: '/employe/me',
      exp: expectedFor({ anon: 401, employe: 200 }),
    },
    {
      name: 'GET /employe/tasks (zone employé)',
      path: '/employe/tasks',
      exp: expectedFor({ anon: 401, employe: 200 }),
    },
    {
      name: 'GET /locataire/dashboard (zone locataire)',
      path: '/locataire/dashboard',
      exp: expectedFor({ anon: 401, locataire: 200 }),
    },
    {
      name: 'GET /admin/stats (zone admin)',
      path: '/admin/stats',
      exp: expectedFor({ anon: 401, admin: 200 }),
    },
    {
      name: 'GET /notifications (tous rôles authentifiés)',
      path: '/notifications',
      exp: expectedFor({ anon: 401, owner: 200, locataire: 200, employe: 200, admin: 200 }),
    },
  ];

  const CONTEXTS = ['anonyme', ...ALL_AUTH];

  for (const c of CASES) {
    await r.section(c.name, async () => {
      const taskIds = [];
      const failures = [];
      for (const who of CONTEXTS) {
        const res = await api(c.path, {
          method: c.method || 'GET',
          body: c.body,
          jar: jars[who],
        });
        const expected = c.exp[who];
        if (res.status === expected) {
          if (c.cleanupTask && res.status === 201 && res.data?.data?.id) {
            taskIds.push([who, res.data.data.id]);
          }
        } else {
          failures.push(`${who}: ${res.status}?${expected}`);
        }
      }
      for (const [who, id] of taskIds) {
        await api(`/tasks/${id}`, { method: 'DELETE', jar: jars[who] });
      }
      if (failures.length === 0) {
        r.pass(M, `${c.name} — ${CONTEXTS.length} combinaisons OK`);
      } else {
        r.fail(M, `${c.name} — ${CONTEXTS.length} combinaisons OK`, failures.join(' | ').slice(0, 300));
      }
    });
  }

  const list = await api('/employes', { jar: owner.jar });
  const fiche = (list.data?.data || []).find((e) => e.nom === `Matrice Employe ${stamp}`);
  if (fiche) await api(`/employes/${fiche.id}`, { method: 'DELETE', jar: owner.jar });
}
