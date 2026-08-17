// ============================================================
// MIM - Suite « simplif » : parcours locataire simplifié,
// affectation des employés à des biens (isolation), photos de
// profil (avatar) et import par lots avec progression réelle.
// ============================================================

import { api, newJar, expectSuccess } from './lib.js';
import { OWNER_PASSWORD } from './seed.js';

const S = 'simplif';

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export async function runSimplif(runner, ctx) {
  const service = ctx.service;
  const owner = ctx.seed.owners[0];
  const jar = owner.jar;

  await runner.section('Locataire simplifié : adresse héritée du bien', async () => {
    const bien = (
      await api('/biens', {
        method: 'POST',
        jar,
        body: { nom: 'SIMPLIF Résidence Alpha', type: 'immeuble', adresse: 'Rue SIMPLIF 1', ville: 'Dakar', pays: 'Sénégal' },
      })
    ).data.data;

    // Le formulaire unique ne saisit PAS d'adresse : elle est reprise du bien.
    const created = await api('/locataires', {
      method: 'POST',
      jar,
      body: {
        nom: 'SIMPLIF Locataire Alpha',
        bien_id: bien.id,
        logement: { nom: 'SIMPLIF Appartement Alpha', type: 'appartement', loyer_mensuel: 120000 },
        jour_echeance: 5,
        autoAccount: true,
      },
    });

    if (!expectSuccess(runner, created, S, 'création locataire avec logement embarqué', [201])) return;

    if (created.data.logement && created.data.logement.id) {
      runner.pass(S, 'réponse : logement embarqué renvoyé');
      if (created.data.logement.adresse === 'Rue SIMPLIF 1, Dakar, Sénégal') {
        runner.pass(S, 'adresse héritée du bien (adresse + ville + pays)');
      } else {
        runner.fail(S, 'adresse héritée du bien (adresse + ville + pays)', `reçue : ${created.data.logement.adresse}`);
      }
      if (created.data.logement.statut === 'occupe') runner.pass(S, 'logement embarqué marqué occupé');
      else runner.fail(S, 'logement embarqué marqué occupé', created.data.logement.statut);
    } else {
      runner.fail(S, 'réponse : logement embarqué renvoyé', 'logement absent de la réponse');
    }

    if (created.data.account && created.data.account.username) runner.pass(S, 'compte auto + username généré');
    else runner.fail(S, 'compte auto + username généré', 'account absent');

    // Le logement est bien en base avec le loyer et le bien.
    const logs = await api('/logements', { jar });
    const found = (logs.data.data || []).find((l) => String(l.id) === String(created.data.logement.id));
    if (found) {
      if (Number(found.loyer_mensuel) === 120000) runner.pass(S, 'loyer enregistré sur le logement');
      else runner.fail(S, 'loyer enregistré sur le logement', found.loyer_mensuel);
      if (String(found.bien_id) === String(bien.id)) runner.pass(S, 'logement rattaché au bon bien');
      else runner.fail(S, 'logement rattaché au bon bien', found.bien_id);
    } else {
      runner.fail(S, 'logement présent en base', 'introuvable');
    }
  });

  await runner.section('Employés affectés à des biens (création, remplacement, refus)', async () => {
    const bienA = owner.bienId;
    const bienB = (
      await api('/biens', {
        method: 'POST',
        jar,
        body: { nom: 'SIMPLIF Résidence Beta', type: 'villa', adresse: 'Rue SIMPLIF 2', ville: 'Dakar', pays: 'Sénégal' },
      })
    ).data.data;

    const created = await api('/employes', {
      method: 'POST',
      jar,
      body: { nom: 'SIMPLIF Employé Gardien', poste: 'Gardien', salaire: 60000, biens: [bienA] },
    });
    if (!expectSuccess(runner, created, S, 'création employé avec bien affecté', [201])) return;

    const empId = created.data.data.id;

    const list = await api('/employes', { jar });
    const emp = (list.data.data || []).find((e) => String(e.id) === String(empId));
    if (emp && Array.isArray(emp.biens) && emp.biens.length === 1 && String(emp.biens[0].id) === String(bienA)) {
      runner.pass(S, 'GET /employes renvoie les biens affectés');
    } else {
      runner.fail(S, 'GET /employes renvoie les biens affectés', JSON.stringify(emp?.biens));
    }

    // Remplacement : gardien passe sur le bien B.
    const upd = await api(`/employes/${empId}`, {
      method: 'PUT',
      jar,
      body: { biens: [bienB] },
    });
    if (!expectSuccess(runner, upd, S, 'remplacement des biens (PUT)')) return;

    const list2 = await api('/employes', { jar });
    const emp2 = (list2.data.data || []).find((e) => String(e.id) === String(empId));
    if (emp2 && emp2.biens.length === 1 && String(emp2.biens[0].id) === String(bienB.id)) {
      runner.pass(S, 'PUT remplace bien les affectations');
    } else {
      runner.fail(S, 'PUT remplace bien les affectations', JSON.stringify(emp2?.biens));
    }

    // Un bien étranger (autre propriétaire) doit être refusé.
    const foreignBien = ctx.seed.owners[1].bienId;
    const bad = await api('/employes', {
      method: 'POST',
      jar,
      body: { nom: 'SIMPLIF Employé Interdit', biens: [foreignBien] },
    });
    if (bad.status === 400) runner.pass(S, 'bien étranger refusé (400)');
    else runner.fail(S, 'bien étranger refusé (400)', `statut ${bad.status}`);

    // Liste des biens de l'employé depuis la fiche (espace employé).
    const biensOf = await api(`/employes`, { jar });
    const empFinal = (biensOf.data.data || []).find((e) => String(e.id) === String(empId));
    if (empFinal && empFinal.biens.length === 1) {
      const bienObj = empFinal.biens[0];
      if (bienObj.nom && bienObj.id) runner.pass(S, 'biens renvoyés avec nom');
      else runner.fail(S, 'biens renvoyés avec nom', JSON.stringify(bienObj));
    } else {
      runner.fail(S, 'biens renvoyés avec nom', 'aucun bien');
    }

    // Nettoyage : employé supprimé (son compte aussi).
    await api(`/employes/${empId}`, { method: 'DELETE', jar });
  });

  await runner.section('Isolation employé : ne voit que les données de SES biens', async () => {
    // Bien B du propriétaire avec un logement occupé + un incident.
    const bienB = (
      await api('/biens', {
        method: 'POST',
        jar,
        body: { nom: 'SIMPLIF Résidence Gamma', type: 'immeuble', adresse: 'Rue SIMPLIF 3', ville: 'Dakar', pays: 'Sénégal' },
      })
    ).data.data;

    const logB = (
      await api('/logements', {
        method: 'POST',
        jar,
        body: { bien_id: bienB.id, nom: 'SIMPLIF Log Gamma', type: 'appartement', nombre_chambres: 2, loyer_mensuel: 80000, statut: 'libre' },
      })
    ).data.data;

    await api('/locataires', {
      method: 'POST',
      jar,
      body: {
        logement_id: logB.id,
        nom: 'SIMPLIF Locataire Gamma',
        username: 'simplifgamma',
        password: OWNER_PASSWORD,
        statut: 'actif',
      },
    });

    const incidentB = (
      await api('/incidents', {
        method: 'POST',
        jar,
        body: { logement_id: logB.id, titre: 'SIMPLIF Incident Gamma', statut: 'nouveau' },
      })
    ).data.data;

    // Employé affecté UNIQUEMENT au bien A (celui du seed, 10 logements).
    const created = await api('/employes', {
      method: 'POST',
      jar,
      body: { nom: 'SIMPLIF Employe Iso', poste: 'Agent', biens: [owner.bienId] },
    });
    if (!expectSuccess(runner, created, S, 'création employé isolé', [201])) return;
    const empId = created.data.data.id;
    const username = created.data.account.username;
    const password = created.data.account.password;

    const ejar = newJar();
    const login = await api('/auth/login', {
      method: 'POST',
      jar: ejar,
      body: { identifier: username, password },
    });
    if (!expectSuccess(runner, login, S, 'connexion de l\'employé')) return;

    const logements = await api('/employe/logements', { jar: ejar });
    const lgs = logements.data.data || [];
    const fromA = lgs.filter((l) => String(l.bien_id) === String(owner.bienId));
    const fromB = lgs.filter((l) => String(l.bien_id) === String(bienB.id));
    if (lgs.length > 0 && fromB.length === 0 && fromA.length === lgs.length) {
      runner.pass(S, 'logements limités à SES biens (A oui, B exclu)');
    } else {
      runner.fail(S, 'logements limités à SES biens (A oui, B exclu)', `A=${fromA.length} B=${fromB.length} total=${lgs.length}`);
    }

    const locataires = await api('/employe/locataires', { jar: ejar });
    const locs = locataires.data.data || [];
    const locB = locs.filter((x) => x.nom && x.nom.includes('SIMPLIF Locataire Gamma'));
    if (locB.length === 0) runner.pass(S, 'locataires limités à SES biens');
    else runner.fail(S, 'locataires limités à SES biens', `vu : ${locB.map((x) => x.nom).join(', ')}`);

    const incidents = await api('/employe/incidents', { jar: ejar });
    const incs = incidents.data.data || [];
    const incB = incs.filter((x) => x.titre && x.titre.includes('Incident Gamma'));
    if (incB.length === 0) runner.pass(S, 'incidents limités à SES biens');
    else runner.fail(S, 'incidents limités à SES biens', incB.map((x) => x.titre).join(', '));

    const dash = await api('/employe/dashboard', { jar: ejar });
    const dashData = dash.data.data || {};
    if (dashData.open_incidents_count != null || dashData.tasks_count != null) {
      runner.pass(S, 'dashboard employé accessible');
    } else {
      runner.fail(S, 'dashboard employé accessible', JSON.stringify(dashData).slice(0, 200));
    }

    // Élargissement : l'employé passe sur le bien B → il voit Gamma.
    await api(`/employes/${empId}`, { method: 'PUT', jar, body: { biens: [bienB.id] } });
    const logements2 = await api('/employe/logements', { jar: ejar });
    const lgs2 = logements2.data.data || [];
    const seesB = lgs2.some((l) => String(l.bien_id) === String(bienB.id));
    if (seesB && lgs2.length === 1) runner.pass(S, 'après réaffectation, il voit uniquement le bien B');
    else runner.fail(S, 'après réaffectation, il voit uniquement le bien B', `total=${lgs2.length} bienB=${seesB}`);

    await api(`/employes/${empId}`, { method: 'DELETE', jar });
  });

  await runner.section('Employé : changement de username à la première connexion', async () => {
    const created = await api('/employes', {
      method: 'POST',
      jar,
      body: { nom: 'SIMPLIF Employe Renomme', poste: 'Gardien', biens: [owner.bienId] },
    });
    if (!expectSuccess(runner, created, S, 'création employé (username auto)')) return;
    const username = created.data.account.username;

    const ejar = newJar();
    const login = await api('/auth/login', {
      method: 'POST',
      jar: ejar,
      body: { identifier: username, password: '1234' },
    });
    if (!expectSuccess(runner, login, S, 'première connexion (1234)')) return;
    if (login.data.mustChangePassword === true) runner.pass(S, 'mustChangePassword renvoyé au premier login');
    else runner.fail(S, 'mustChangePassword renvoyé au premier login', String(login.data.mustChangePassword));

    // Username modifié via /auth/update-username (employé accepté).
    const upd = await api('/auth/update-username', {
      method: 'PUT',
      jar: ejar,
      body: { username: 'simplif.renomme' },
    });
    if (expectSuccess(runner, upd, S, 'username employé modifié (première connexion)')) {
      const relog = await api('/auth/login', {
        method: 'POST',
        jar: newJar(),
        body: { identifier: 'simplif.renomme', password: '1234' },
      });
      if (relog.status === 200) runner.pass(S, 'connexion avec le nouveau username');
      else runner.fail(S, 'connexion avec le nouveau username', `statut ${relog.status}`);
    }

    // Un propriétaire ne peut pas modifier le username d'un employé (403).
    const forbidden = await api('/auth/update-username', {
      method: 'PUT',
      jar,
      body: { username: 'simplif.interdit' },
    });
    if (forbidden.status === 403) runner.pass(S, 'propriétaire refusé (403)');
    else runner.fail(S, 'propriétaire refusé (403)', `statut ${forbidden.status}`);

    const list = await api('/employes', { jar });
    const emp = (list.data.data || []).find((e) => e.username === 'simplif.renomme');
    if (emp) runner.pass(S, 'fiche employé mise à jour en base');
    else runner.fail(S, 'fiche employé mise à jour en base', 'username introuvable');

    await api(`/employes/${created.data.data.id}`, { method: 'DELETE', jar });
  });

  await runner.section('Photo de profil (avatar) : upload, lecture, suppression', async () => {
    const up = await api('/upload/avatar', {
      method: 'POST',
      jar,
      body: { dataUri: PNG_1PX },
    });
    if (expectSuccess(runner, up, S, 'upload avatar (PNG base64)')) {
      if (up.data.avatar_url && up.data.avatar_url.startsWith('http')) {
        runner.pass(S, 'URL publique d\'avatar renvoyée');
      } else {
        runner.fail(S, 'URL publique d\'avatar renvoyée', String(up.data.avatar_url));
      }
    }

    const me = await api('/auth/me', { jar });
    if (me.data.user && me.data.user.avatar_url) runner.pass(S, '/auth/me renvoie avatar_url');
    else runner.fail(S, '/auth/me renvoie avatar_url', String(me.data?.user?.avatar_url));

    const bad = await api('/upload/avatar', {
      method: 'POST',
      jar,
      body: { dataUri: 'data:image/png;base64,!!!!' },
    });
    if (bad.status === 400) runner.pass(S, 'avatar invalide refusé (400)');
    else runner.fail(S, 'avatar invalide refusé (400)', `statut ${bad.status}`);

    const del = await api('/upload/avatar', { method: 'DELETE', jar });
    if (expectSuccess(runner, del, S, 'suppression avatar')) {
      const me2 = await api('/auth/me', { jar });
      if (me2.data.user && me2.data.user.avatar_url === null) runner.pass(S, 'avatar_url remis à null après suppression');
      else runner.fail(S, 'avatar_url remis à null après suppression', String(me2.data?.user?.avatar_url));
    }

    // Remplacement d'extension : upload PNG puis JPG → le JPG survit
    // (l'ancienne photo est remplacée, jamais le fichier tout juste écrit).
    const upJpg = await api('/upload/avatar', {
      method: 'POST',
      jar,
      body: {
        dataUri:
          'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
      },
    });
    if (expectSuccess(runner, upJpg, S, 'upload avatar JPG (remplacement PNG→JPG)')) {
      const me3 = await api('/auth/me', { jar });
      const url = me3.data?.user?.avatar_url || '';
      if (url.includes('.jpg') && url !== upJpg.data.avatar_url) {
        runner.fail(S, 'avatar JPG conservé (URL à jour)', String(url));
      } else if (url === upJpg.data.avatar_url) {
        runner.pass(S, 'avatar JPG conservé (URL à jour)');
      } else {
        runner.fail(S, 'avatar JPG conservé (URL à jour)', String(url));
      }
    }
    await api('/upload/avatar', { method: 'DELETE', jar });
  });

  await runner.section('Import par lots : progression réelle + bien des employés', async () => {
    const csv = (cat) => {
      const files = {
        biens: [
          'nom;type;adresse;ville;pays',
          'SIMPLIF Bien Import 1;immeuble;Rue Import 1;Dakar;Sénégal',
          'SIMPLIF Bien Import 2;villa;Rue Import 2;Dakar;Sénégal',
        ].join('\n'),
        employes: [
          'nom;prenom;poste;bien;salaire',
          'SIMPLIF Alpha Import;1;Gérant;SIMPLIF Bien Import 1;70000',
          'SIMPLIF Beta Import;2;Agent;SIMPLIF Bien Import 2;45000',
        ].join('\n'),
      };
      return files[cat];
    };

    const files = { biens: { filename: 'biens.csv', content: csv('biens') }, employes: { filename: 'employes.csv', content: csv('employes') } };

    const exe = await api('/import/execute', {
      method: 'POST',
      jar,
      body: { categories: ['biens', 'employes'], files, duplicatePolicy: 'ignore' },
    });
    if (!expectSuccess(runner, exe, S, 'exécution import biens+employes', [201])) return;

    if (exe.data.report && exe.data.report.totals.created === 4) {
      runner.pass(S, '4 éléments créés (2 biens + 2 employés)');
    } else {
      runner.fail(S, '4 éléments créés (2 biens + 2 employés)', JSON.stringify(exe.data.report?.totals));
    }

    // Progression : le run existe et est terminé.
    if (exe.data.runId) {
      runner.pass(S, 'runId renvoyé par /import/execute');
      const prog = await api(`/import/progress/${exe.data.runId}`, { jar });
      if (prog.status === 200 && prog.data.status === 'done' && prog.data.done === prog.data.total && prog.data.total > 0) {
        runner.pass(S, 'progression terminée (done == total)');
      } else {
        runner.fail(S, 'progression terminée (done == total)', JSON.stringify(prog.data));
      }
    } else {
      runner.fail(S, 'runId renvoyé par /import/execute', 'runId absent');
    }

    const latest = await api('/import/progress/latest', { jar });
    if (latest.status === 200 && latest.data.percent === 100) runner.pass(S, 'GET /progress/latest renvoie le dernier run');
    else runner.fail(S, 'GET /progress/latest renvoie le dernier run', JSON.stringify(latest.data));

    // Les employés importés sont affectés à leur bien.
    const list = await api('/employes', { jar });
    const imported = (list.data.data || []).filter((e) => e.nom && e.nom.startsWith('SIMPLIF Alpha Import'));
    const imported2 = (list.data.data || []).filter((e) => e.nom && e.nom.startsWith('SIMPLIF Beta Import'));
    if (imported.length === 1 && imported[0].biens && imported[0].biens.length === 1 && imported[0].biens[0].nom === 'SIMPLIF Bien Import 1') {
      runner.pass(S, 'employé importé affecté à son bien (colonne « bien »)');
    } else {
      runner.fail(S, 'employé importé affecté à son bien (colonne « bien »)', JSON.stringify(imported[0]?.biens));
    }
    if (imported2.length === 1 && imported2[0].biens && imported2[0].biens[0].nom === 'SIMPLIF Bien Import 2') {
      runner.pass(S, 'second employé affecté au second bien');
    } else {
      runner.fail(S, 'second employé affecté au second bien', JSON.stringify(imported2[0]?.biens));
    }

    // Un bien inconnu dans le fichier employés est refusé à l'aperçu.
    const preview = await api('/import/preview', {
      method: 'POST',
      jar,
      body: {
        categories: ['employes'],
        files: { employes: { filename: 'e.csv', content: ['nom;bien', 'SIMPLIF Mauvais;Bien Inconnu XYZ'].join('\n') } },
        duplicatePolicy: 'ignore',
      },
    });
    if (preview.status === 200 && preview.data.totals.errors >= 1) {
      runner.pass(S, 'bien inconnu détecté à l\'aperçu employés');
    } else {
      runner.fail(S, 'bien inconnu détecté à l\'aperçu employés', JSON.stringify(preview.data?.totals));
    }
  });
}