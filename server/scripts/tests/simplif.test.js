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

  await runner.section('Moyens de paiement : lien strictement facultatif', async () => {
    // 1. Wave SANS lien → création acceptée, lien null en base.
    const wave = await api('/moyens-paiement', {
      method: 'POST',
      jar,
      body: { type: 'wave', nom_titulaire: 'SIMPLIF Amadou Diop', numero: '77xxxxxxx', lien_paiement: '' },
    });
    if (expectSuccess(runner, wave, S, 'création Wave sans lien', [201])) {
      if (wave.data.data.lien_paiement === null) runner.pass(S, 'Wave sans lien : lien null en base');
      else runner.fail(S, 'Wave sans lien : lien null en base', String(wave.data.data.lien_paiement));
    }

    // 2. Orange Money SANS lien → création acceptée.
    const om = await api('/moyens-paiement', {
      method: 'POST',
      jar,
      body: { type: 'orange_money', nom_titulaire: 'SIMPLIF Amadou Diop', numero: '77xxxxxxx', lien_paiement: null },
    });
    if (expectSuccess(runner, om, S, 'création Orange Money sans lien', [201])) {
      if (om.data.data.lien_paiement === null) runner.pass(S, 'Orange Money sans lien : lien null');
      else runner.fail(S, 'Orange Money sans lien : lien null', String(om.data.data.lien_paiement));
    }

    // 3. Moyen AVEC lien → création + lien conservé.
    const avecLien = await api('/moyens-paiement', {
      method: 'POST',
      jar,
      body: { type: 'wave', nom_titulaire: 'SIMPLIF Titulaire Lien', numero: '771112223', lien_paiement: 'https://pay.wave.example/abc' },
    });
    if (expectSuccess(runner, avecLien, S, 'création avec lien', [201])) {
      if (avecLien.data.data.lien_paiement === 'https://pay.wave.example/abc') runner.pass(S, 'lien conservé après création');
      else runner.fail(S, 'lien conservé après création', String(avecLien.data.data.lien_paiement));
    }

    // 4. Édition : effacer le lien (valeur vide) → converti en null.
    const upd = await api(`/moyens-paiement/${avecLien.data.data.id}`, {
      method: 'PUT',
      jar,
      body: { lien_paiement: '' },
    });
    if (expectSuccess(runner, upd, S, 'édition : lien effacé')) {
      if (upd.data.data.lien_paiement === null) runner.pass(S, 'édition sans lien : lien null');
      else runner.fail(S, 'édition sans lien : lien null', String(upd.data.data.lien_paiement));
    }

    // 5. Vue locataire : nom et numéro copiables, aucun lien à ouvrir.
    const tjar = newJar();
    const tlogin = await api('/auth/login', {
      method: 'POST',
      jar: tjar,
      body: { identifier: `own${owner.i}loc1`, password: OWNER_PASSWORD },
    });
    if (!expectSuccess(runner, tlogin, S, 'connexion locataire (vue moyens)')) return;

    const moyens = await api('/locataire/moyens-paiement', { jar: tjar });
    const vus = (moyens.data.data || []).filter((m) => m.nom_titulaire === 'SIMPLIF Amadou Diop');
    const waveVu = vus.find((m) => m.type === 'wave');
    if (waveVu) {
      if (waveVu.nom_titulaire) runner.pass(S, 'locataire : nom copiable présent');
      else runner.fail(S, 'locataire : nom copiable présent', 'nom absent');
      if (waveVu.numero) runner.pass(S, 'locataire : numéro copiable présent');
      else runner.fail(S, 'locataire : numéro copiable présent', 'numéro absent');
      if (waveVu.lien_paiement == null) runner.pass(S, 'locataire : aucun lien → pas de bouton « Ouvrir »');
      else runner.fail(S, 'locataire : aucun lien → pas de bouton « Ouvrir »', String(waveVu.lien_paiement));
    } else {
      runner.fail(S, 'locataire : moyens du propriétaire visibles', 'Wave Amadou Diop introuvable');
    }

    // Nettoyage.
    await api(`/moyens-paiement/${wave.data.data.id}`, { method: 'DELETE', jar });
    await api(`/moyens-paiement/${om.data.data.id}`, { method: 'DELETE', jar });
    await api(`/moyens-paiement/${avecLien.data.data.id}`, { method: 'DELETE', jar });
  });

  await runner.section('Employé : résolution des incidents de SES biens', async () => {
    // Bien A (seed) avec incident ; bien B avec incident protégé.
    const incA = (
      await api('/incidents', {
        method: 'POST',
        jar,
        body: { logement_id: owner.logements[0].id, titre: 'SIMPLIF Incident Resolvable A', description: 'Fuite à réparer', statut: 'nouveau' },
      })
    ).data.data;

    const bienB = (
      await api('/biens', {
        method: 'POST',
        jar,
        body: { nom: 'SIMPLIF Résidence Reso B', type: 'villa', adresse: 'Rue Reso B', ville: 'Dakar', pays: 'Sénégal' },
      })
    ).data.data;
    const logB = (
      await api('/logements', {
        method: 'POST',
        jar,
        body: { bien_id: bienB.id, nom: 'SIMPLIF Log Reso B', type: 'appartement', loyer_mensuel: 70000, statut: 'libre' },
      })
    ).data.data;
    const incB = (
      await api('/incidents', {
        method: 'POST',
        jar,
        body: { logement_id: logB.id, titre: 'SIMPLIF Incident Protege B', statut: 'nouveau' },
      })
    ).data.data;

    // Employé affecté UNIQUEMENT au bien A.
    const created = await api('/employes', {
      method: 'POST',
      jar,
      body: { nom: 'SIMPLIF Employe Resolveur', poste: 'Agent', biens: [owner.bienId] },
    });
    if (!expectSuccess(runner, created, S, 'création employé résolveur (bien A)', [201])) return;
    const empId = created.data.data.id;

    const ejar = newJar();
    const login = await api('/auth/login', {
      method: 'POST',
      jar: ejar,
      body: { identifier: created.data.account.username, password: '1234' },
    });
    if (!expectSuccess(runner, login, S, 'connexion de l\'employé résolveur')) return;

    // Il VOIT l'incident de son bien, avec logement et description.
    const list = await api('/employe/incidents', { jar: ejar });
    const seenA = (list.data.data || []).find((x) => x.titre === 'SIMPLIF Incident Resolvable A');
    if (seenA) {
      runner.pass(S, 'employé affecté : voit l\'incident de son bien');
      if (seenA.logement && seenA.logement !== '—') runner.pass(S, 'carte incident : logement présent');
      else runner.fail(S, 'carte incident : logement présent', String(seenA.logement));
      if (seenA.description !== undefined) runner.pass(S, 'carte incident : description présente');
      else runner.fail(S, 'carte incident : description présente', 'description absente');
      if (seenA.created_at) runner.pass(S, 'carte incident : date présente');
      else runner.fail(S, 'carte incident : date présente', 'created_at absent');
    } else {
      runner.fail(S, 'employé affecté : voit l\'incident de son bien', 'incident A absent');
    }

    const seenB = (list.data.data || []).find((x) => x.titre === 'SIMPLIF Incident Protege B');
    if (seenB) runner.fail(S, 'employé : incident du bien B invisible', 'vu');
    else runner.pass(S, 'employé : incident du bien B invisible');

    // Résolution d'un incident HORS de ses biens → 403.
    const tryB = await api(`/employe/incidents/${incB.id}/resoudre`, { method: 'POST', jar: ejar, body: {} });
    if (tryB.status === 403) runner.pass(S, 'résolution d\'un incident hors biens affectés : 403');
    else runner.fail(S, 'résolution d\'un incident hors biens affectés : 403', `statut ${tryB.status}`);

    // Résolution valide : statut resolu + traces + horodatage serveur.
    const ok = await api(`/employe/incidents/${incA.id}/resoudre`, { method: 'POST', jar: ejar, body: {} });
    if (expectSuccess(runner, ok, S, 'résolution valide (200)')) {
      if (ok.data.data.statut === 'resolu') runner.pass(S, 'statut passé à resolu');
      else runner.fail(S, 'statut passé à resolu', ok.data.data.statut);
      if (String(ok.data.data.resolved_by) === String(empId)) runner.pass(S, 'resolved_by = fiche employé');
      else runner.fail(S, 'resolved_by = fiche employé', String(ok.data.data.resolved_by));
      if (ok.data.data.resolved_at) runner.pass(S, 'resolved_at = horodatage serveur présent');
      else runner.fail(S, 'resolved_at = horodatage serveur présent', 'absent');
    }

    // Résolution déjà effectuée → refus (400).
    const again = await api(`/employe/incidents/${incA.id}/resoudre`, { method: 'POST', jar: ejar, body: {} });
    if (again.status === 400) runner.pass(S, 'résolution déjà effectuée : refus (400)');
    else runner.fail(S, 'résolution déjà effectuée : refus (400)', `statut ${again.status}`);

    // Propriétaire notifié de la résolution.
    const { data: notifs, error: notifErr } = await service
      .from('notifications')
      .select('*')
      .eq('user_id', owner.id)
      .order('created_at', { ascending: false })
      .limit(20);
    const notifReso = (notifs || []).find((n) => n.message && n.message.includes('SIMPLIF Incident Resolvable A') && n.message.includes('résolu'));
    if (notifReso) runner.pass(S, 'propriétaire notifié de la résolution');
    else runner.fail(S, 'propriétaire notifié de la résolution', `err=${notifErr?.message || 'aucune'} total=${(notifs || []).length}`);

    // Employé NON affecté au bien de l'incident → refus (403).
    const created2 = await api('/employes', {
      method: 'POST',
      jar,
      body: { nom: 'SIMPLIF Employe Etranger', poste: 'Agent', biens: [bienB.id] },
    });
    const ejar2 = newJar();
    const login2 = await api('/auth/login', {
      method: 'POST',
      jar: ejar2,
      body: { identifier: created2.data.account.username, password: '1234' },
    });
    if (expectSuccess(runner, login2, S, 'connexion de l\'employé étranger')) {
      const tryA2 = await api(`/employe/incidents/${incA.id}/resoudre`, { method: 'POST', jar: ejar2, body: {} });
      if (tryA2.status === 403) runner.pass(S, 'employé non affecté au bien : 403');
      else runner.fail(S, 'employé non affecté au bien : 403', `statut ${tryA2.status}`);
    }

    // État final vérifié en base.
    const { data: finalInc } = await service.from('incidents').select('statut, resolved_by, resolved_at').eq('id', incA.id).single();
    if (finalInc && finalInc.statut === 'resolu' && finalInc.resolved_by && finalInc.resolved_at) {
      runner.pass(S, 'état résolu vérifié en base (statut + resolved_by + resolved_at)');
    } else {
      runner.fail(S, 'état résolu vérifié en base (statut + resolved_by + resolved_at)', JSON.stringify(finalInc));
    }

    // Nettoyage.
    await api(`/employes/${empId}`, { method: 'DELETE', jar });
    await api(`/employes/${created2.data.data.id}`, { method: 'DELETE', jar });
    await api(`/incidents/${incA.id}`, { method: 'DELETE', jar });
    await api(`/incidents/${incB.id}`, { method: 'DELETE', jar });
    await api(`/logements/${logB.id}`, { method: 'DELETE', jar });
    await api(`/biens/${bienB.id}`, { method: 'DELETE', jar });
  });

  await runner.section('Flux complet : incident signalé par le locataire → visible propriétaire + employé → résolu', async () => {
    const bien = (
      await api('/biens', {
        method: 'POST',
        jar,
        body: { nom: 'SIMPLIF Résidence Flux', type: 'immeuble', adresse: 'Rue Flux 1', ville: 'Dakar', pays: 'Sénégal' },
      })
    ).data.data;
    const log = (
      await api('/logements', {
        method: 'POST',
        jar,
        body: { bien_id: bien.id, nom: 'SIMPLIF Log Flux', type: 'appartement', loyer_mensuel: 90000, statut: 'occupe' },
      })
    ).data.data;
    const loc = await api('/locataires', {
      method: 'POST',
      jar,
      body: {
        logement_id: log.id,
        nom: 'SIMPLIF Locataire Flux',
        username: 'simplif.flux',
        password: OWNER_PASSWORD,
        statut: 'actif',
      },
    });
    if (!expectSuccess(runner, loc, S, 'création locataire avec compte (flux incident)', [201])) return;

    const tjar = newJar();
    const tlogin = await api('/auth/login', {
      method: 'POST',
      jar: tjar,
      body: { identifier: 'simplif.flux', password: OWNER_PASSWORD },
    });
    if (!expectSuccess(runner, tlogin, S, 'connexion du locataire (flux incident)')) return;

    // L'id de logement envoyé (logement d'un AUTRE propriétaire) est ignoré.
    const foreignLogId = ctx.seed.owners[1].logements[0].id;
    const report = await api('/locataire/incidents', {
      method: 'POST',
      jar: tjar,
      body: { logement_id: foreignLogId, titre: 'SIMPLIF Incident Flux', description: 'Dégât des eaux' },
    });
    if (!expectSuccess(runner, report, S, 'signalement par le locataire (201)', [201])) return;
    const incidentId = report.data.data.id;
    if (
      String(report.data.data.logement_id) === String(log.id) &&
      String(report.data.data.user_id) === String(owner.id)
    ) {
      runner.pass(S, 'incident rattaché au logement du locataire et au propriétaire');
    } else {
      runner.fail(S, 'incident rattaché au logement du locataire et au propriétaire', JSON.stringify(report.data.data));
    }

    // Le propriétaire le VOIT dans sa liste.
    const ownerList = await api('/incidents', { jar });
    const seenByOwner = (ownerList.data.data || []).find((x) => String(x.id) === String(incidentId));
    if (seenByOwner) runner.pass(S, 'propriétaire : incident signalé visible (GET /incidents)');
    else runner.fail(S, 'propriétaire : incident signalé visible (GET /incidents)', 'absent');

    // Un AUTRE propriétaire ne le voit pas.
    const o2List = await api('/incidents', { jar: ctx.seed.owners[1].jar });
    const seenByOther = (o2List.data.data || []).find((x) => String(x.id) === String(incidentId));
    if (seenByOther) runner.fail(S, 'autre propriétaire : incident invisible', 'vu');
    else runner.pass(S, 'autre propriétaire : incident invisible');

    // Employé affecté au bien : voit l'incident avec logement + locataire.
    const created = await api('/employes', {
      method: 'POST',
      jar,
      body: { nom: 'SIMPLIF Employe Flux', poste: 'Agent', biens: [bien.id] },
    });
    if (!expectSuccess(runner, created, S, 'création employé (bien du flux)', [201])) return;
    const ejar = newJar();
    const elogin = await api('/auth/login', {
      method: 'POST',
      jar: ejar,
      body: { identifier: created.data.account.username, password: '1234' },
    });
    if (!expectSuccess(runner, elogin, S, 'connexion de l\'employé (flux incident)')) return;

    const elist = await api('/employe/incidents', { jar: ejar });
    const seenByEmp = (elist.data.data || []).find((x) => String(x.id) === String(incidentId));
    if (seenByEmp) {
      runner.pass(S, 'employé affecté : voit l\'incident signalé');
      if (seenByEmp.logement === 'SIMPLIF Log Flux') runner.pass(S, 'employé : nom du logement présent');
      else runner.fail(S, 'employé : nom du logement présent', String(seenByEmp.logement));
      if (seenByEmp.tenant === 'SIMPLIF Locataire Flux') runner.pass(S, 'employé : locataire signalant présent');
      else runner.fail(S, 'employé : locataire signalant présent', String(seenByEmp.tenant));
    } else {
      runner.fail(S, 'employé affecté : voit l\'incident signalé', 'absent');
    }

    // L'employé résout l'incident ; le propriétaire est notifié.
    const resolve = await api(`/employe/incidents/${incidentId}/resoudre`, { method: 'POST', jar: ejar, body: {} });
    if (expectSuccess(runner, resolve, S, 'résolution par l\'employé (200)')) {
      if (resolve.data.data.statut === 'resolu') runner.pass(S, 'statut resolu après résolution');
      else runner.fail(S, 'statut resolu après résolution', resolve.data.data.statut);
    }

    const { data: notifs } = await service
      .from('notifications')
      .select('*')
      .eq('user_id', owner.id)
      .order('created_at', { ascending: false })
      .limit(20);
    const notifSignal = (notifs || []).find((n) => n.message && n.message.includes('SIMPLIF Incident Flux'));
    if (notifSignal && notifSignal.message.includes('résolu')) {
      runner.pass(S, 'propriétaire notifié du signalement ET de la résolution');
    } else {
      runner.fail(S, 'propriétaire notifié du signalement ET de la résolution', notifSignal ? notifSignal.message : 'aucune');
    }

    // Nettoyage.
    await api(`/employes/${created.data.data.id}`, { method: 'DELETE', jar });
    await api(`/incidents/${incidentId}`, { method: 'DELETE', jar });
    await api(`/locataires/${loc.data.data.id}`, { method: 'DELETE', jar });
    await api(`/logements/${log.id}`, { method: 'DELETE', jar });
    await api(`/biens/${bien.id}`, { method: 'DELETE', jar });
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