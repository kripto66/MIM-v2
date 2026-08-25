// ============================================================
// MIM - Suite CRUD : chaque ressource, validation, erreurs
// ============================================================

import { api, expectSuccess } from './lib.js';

const S = 'crud';

export async function runCrud(r, ctx) {
  const { service, seed } = ctx;
  const owner = ctx.seed.owners[0];
  const jar = owner.jar;

  // ----------------------------------------------------------
  await r.section('biens', async () => {
    const invalid = await api('/biens', { method: 'POST', jar, body: { adresse: 'sans nom' } });
    if (invalid.status === 400) r.pass(S, 'bien sans nom → 400');
    else r.fail(S, 'bien sans nom → 400', `statut ${invalid.status}`);

    const created = await api('/biens', { method: 'POST', jar, body: { nom: 'CRUD Bien', type: 'villa', ville: 'Dakar' } });
    if (expectSuccess(r, created, S, r, [201]) && created.data.data.id) {
      r.pass(S, `bien créé (id ${created.data.data.id})`);
    } else return;

    const id = created.data.data.id;

    const list = await api('/biens', { jar });
    if (expectSuccess(r, list, S, r) && list.data.data.some((b) => b.id === id)) r.pass(S, 'bien présent dans la liste');
    else r.fail(S, 'bien présent dans la liste', JSON.stringify(list.data));

    const upd = await api(`/biens/${id}`, { method: 'PUT', jar, body: { nom: 'CRUD Bien Modifié' } });
    if (expectSuccess(r, upd, S, r) && upd.data.data.nom === 'CRUD Bien Modifié') r.pass(S, 'bien modifié (PUT)');
    else r.fail(S, 'bien modifié (PUT)', JSON.stringify(upd.data));

    const del = await api(`/biens/${id}`, { method: 'DELETE', jar });
    if (expectSuccess(r, del, S, r)) r.pass(S, 'bien supprimé (DELETE)');
    else r.fail(S, 'bien supprimé (DELETE)', JSON.stringify(del.data));
  });

  // ----------------------------------------------------------
  await r.section('logements', async () => {
    const badLoyer = await api('/logements', { method: 'POST', jar, body: { nom: 'X', type: 'appartement', adresse: 'A', loyer_mensuel: 0 } });
    if (badLoyer.status === 400) r.pass(S, 'loyer <= 0 → 400');
    else r.fail(S, 'loyer <= 0 → 400', `statut ${badLoyer.status}`);

    const badType = await api('/logements', { method: 'POST', jar, body: { nom: 'X', type: 'studio', adresse: 'A', loyer_mensuel: 5000 } });
    if (badType.status === 400) r.pass(S, 'type invalide → 400');
    else r.fail(S, 'type invalide → 400', `statut ${badType.status}`);

    const foreignBien = await api('/logements', {
      method: 'POST',
      jar,
      body: { bien_id: ctx.seed.owners[1].bienId, nom: 'X', type: 'chambre', adresse: 'A', loyer_mensuel: 5000 },
    });
    if (foreignBien.status === 400) r.pass(S, 'bien d’un autre propriétaire → 400');
    else r.fail(S, 'bien d’un autre propriétaire → 400', `statut ${foreignBien.status}`);

    const created = await api('/logements', {
      method: 'POST',
      jar,
      body: { bien_id: owner.bienId, nom: 'CRUD Log', type: 'chambre', adresse: 'Adresse', loyer_mensuel: 75000, statut: 'libre' },
    });
    if (!expectSuccess(r, created, S, r, [201]) || !created.data.data.id) return;
    const id = created.data.data.id;

    const upd = await api(`/logements/${id}`, { method: 'PUT', jar, body: { loyer_mensuel: 90000, statut: 'maintenance' } });
    if (expectSuccess(r, upd, S, r) && Number(upd.data.data.loyer_mensuel) === 90000) r.pass(S, 'logement modifié (loyer + statut)');
    else r.fail(S, 'logement modifié (loyer + statut)', JSON.stringify(upd.data));

    const del = await api(`/logements/${id}`, { method: 'DELETE', jar });
    if (expectSuccess(r, del, S, r)) r.pass(S, 'logement libre supprimé');
    else r.fail(S, 'logement libre supprimé', JSON.stringify(del.data));
  });

  // ----------------------------------------------------------
  await r.section('loyer modifié → échéances ouvertes synchronisées', async () => {
    const lg = await api('/logements', {
      method: 'POST',
      jar,
      body: { bien_id: owner.bienId, nom: 'CRUD Sync Log', type: 'chambre', adresse: 'A', loyer_mensuel: 40000, statut: 'libre' },
    });
    if (!expectSuccess(r, lg, S, r, [201]) || !lg.data.data?.id) return;
    const lgId = lg.data.data.id;

    // Locataire avec compte automatique : crée l'échéance initiale du mois
    // courant au montant du logement (statut « attente »).
    const loc = await api('/locataires', {
      method: 'POST',
      jar,
      body: { logement_id: lgId, nom: 'CRUD Sync Locataire', statut: 'actif', autoAccount: true },
    });
    if (!expectSuccess(r, loc, S, r, [201]) || !loc.data.data?.id) return;
    const locId = loc.data.data.id;
    if (loc.data.accountCreated === true && loc.data.echeance?.mois)
      r.pass(S, `compte auto + échéance initiale (${loc.data.echeance.mois})`);
    else r.fail(S, 'compte auto + échéance initiale', JSON.stringify(loc.data).slice(0, 200));

    const rowsOf = async () =>
      (await service.from('paiements').select('id, user_id, montant, statut').eq('logement_id', lgId)).data || [];

    const attente0 = (await rowsOf()).find((p) => p.statut === 'attente');
    if (!attente0) {
      r.fail(S, 'échéance initiale « attente » créée au loyer du logement');
      await api(`/locataires/${locId}`, { method: 'DELETE', jar });
      await api(`/logements/${lgId}`, { method: 'DELETE', jar });
      return;
    }
    if (Number(attente0.montant) === 40000) r.pass(S, 'échéance initiale « attente » au loyer du logement (40000)');
    else r.fail(S, 'échéance initiale « attente » au loyer du logement (40000)', `montant ${attente0.montant}`);

    // Échéance déjà réglée : ne doit JAMAIS être modifiée par un changement de loyer.
    await service.from('paiements').insert({
      user_id: attente0.user_id,
      locataire_id: locId,
      logement_id: lgId,
      montant: 40000,
      mois: seed.prev,
      statut: 'paye',
      date_paiement: '2026-07-05',
    });

    const cleanup = async () => {
      await service.from('paiements').delete().eq('logement_id', lgId);
      await api(`/locataires/${locId}`, { method: 'DELETE', jar });
      await api(`/logements/${lgId}`, { method: 'DELETE', jar });
    };

    try {
      // 1) Chemin PUT /logements/:id
      const upd = await api(`/logements/${lgId}`, { method: 'PUT', jar, body: { loyer_mensuel: 55000 } });
      if (!expectSuccess(r, upd, S, 'PUT /logements/:id accepté')) return;
      let after = await rowsOf();
      if (Number(after.find((p) => p.statut === 'attente')?.montant) === 55000)
        r.pass(S, 'PUT /logements : échéance « attente » passée au nouveau loyer (55000)');
      else r.fail(S, 'PUT /logements : échéance « attente » passée au nouveau loyer (55000)', JSON.stringify(after));
      if (Number(after.find((p) => p.statut === 'paye')?.montant) === 40000)
        r.pass(S, 'échéance « paye » inchangée (historique)');
      else r.fail(S, 'échéance « paye » inchangée (historique)', JSON.stringify(after));

      // 2) Chemin embarqué logement_update depuis la fiche locataire
      //    (comme l'envoie le formulaire réel : accompagné d'autres champs).
      const upd2 = await api(`/locataires/${locId}`, {
        method: 'PUT',
        jar,
        body: {
          nom: 'CRUD Sync Locataire',
          statut: 'actif',
          logement_update: { id: lgId, bien_id: owner.bienId, loyer_mensuel: 60000 },
        },
      });
      if (!expectSuccess(r, upd2, S, 'PUT /locataires + logement_update accepté')) return;
      after = await rowsOf();
      if (Number(after.find((p) => p.statut === 'attente')?.montant) === 60000)
        r.pass(S, 'logement_update : échéance « attente » passée au nouveau loyer (60000)');
      else r.fail(S, 'logement_update : échéance « attente » passée au nouveau loyer (60000)', JSON.stringify(after));
    } finally {
      await cleanup();
    }
  });

  // ----------------------------------------------------------
  await r.section('locataires (avec compte)', async () => {
    // Logement dédié (ne pas occuper ceux du seed).
    const lg = await api('/logements', {
      method: 'POST',
      jar,
      body: { bien_id: owner.bienId, nom: 'CRUD Loc Log', type: 'chambre', adresse: 'A', loyer_mensuel: 40000, statut: 'libre' },
    });
    if (!expectSuccess(r, lg, S, r, [201])) return;
    const lgId = lg.data.data.id;

    const username = `crudten${Date.now() % 100000}`;
    const created = await api('/locataires', {
      method: 'POST',
      jar,
      body: {
        logement_id: lgId,
        nom: 'CRUD Locataire',
        username,
        password: 'Test1234!',
        jour_echeance: 10,
        statut: 'actif',
      },
    });
    if (!expectSuccess(r, created, S, r, [201]) || !created.data.data.id) return;
    const id = created.data.data.id;
    if (created.data.accountCreated === true) r.pass(S, 'locataire créé avec compte');
    else r.fail(S, 'locataire créé avec compte', JSON.stringify(created.data));

    const upd = await api(`/locataires/${id}`, { method: 'PUT', jar, body: { nom: 'CRUD Locataire Modifié', phone: '+221700000077' } });
    if (expectSuccess(r, upd, S, r) && upd.data.data.nom === 'CRUD Locataire Modifié') r.pass(S, 'locataire modifié');
    else r.fail(S, 'locataire modifié', JSON.stringify(upd.data));

    const login = await api('/auth/login', { method: 'POST', body: { identifier: username, password: 'Test1234!' } });
    if (login.status === 200) r.pass(S, 'compte locataire fonctionne');
    else r.fail(S, 'compte locataire fonctionne', `statut ${login.status}`);

    const del = await api(`/locataires/${id}`, { method: 'DELETE', jar });
    if (expectSuccess(r, del, S, r)) r.pass(S, 'locataire supprimé');
    else r.fail(S, 'locataire supprimé', JSON.stringify(del.data));

    const loginAfter = await api('/auth/login', { method: 'POST', body: { identifier: username, password: 'Test1234!' } });
    if (loginAfter.status === 401) r.pass(S, 'compte désactivé après suppression');
    else r.fail(S, 'compte désactivé après suppression', `statut ${loginAfter.status}`);

    await api(`/logements/${lgId}`, { method: 'DELETE', jar });
  });

  // ----------------------------------------------------------
  await r.section('paiements', async () => {
    const loc = owner.locataires[2];
    const lg = owner.logements[2];
    const loyer = lg.loyer_mensuel;

    const badMontant = await api('/paiements', { method: 'POST', jar, body: { locataire_id: loc.id, logement_id: lg.id, montant: -5, mois: ctx.seed.month } });
    if (badMontant.status === 400) r.pass(S, 'montant <= 0 → 400');
    else r.fail(S, 'montant <= 0 → 400', `statut ${badMontant.status}`);

    const paye = await api('/paiements', { method: 'POST', jar, body: { locataire_id: loc.id, logement_id: lg.id, montant: loyer, mois: ctx.seed.month, statut: 'paye' } });
    if (expectSuccess(r, paye, S, r, [201]) && paye.data.data.date_paiement) r.pass(S, 'paiement payé → date_paiement auto');
    else r.fail(S, 'paiement payé → date_paiement auto', JSON.stringify(paye.data));
    const pid = paye.data.data.id;

    const upd = await api(`/paiements/${pid}`, { method: 'PUT', jar, body: { statut: 'retard' } });
    if (expectSuccess(r, upd, S, r) && upd.data.data.statut === 'retard') r.pass(S, 'paiement modifié → retard');
    else r.fail(S, 'paiement modifié → retard', JSON.stringify(upd.data));

    const del = await api(`/paiements/${pid}`, { method: 'DELETE', jar });
    if (expectSuccess(r, del, S, r)) r.pass(S, 'paiement supprimé');
    else r.fail(S, 'paiement supprimé', JSON.stringify(del.data));
  });

  // ----------------------------------------------------------
  await r.section('incidents', async () => {
    const badPhoto = await api('/incidents', {
      method: 'POST',
      jar,
      body: { logement_id: owner.logements[0].id, titre: 'X', photo: 'http://evil/x.png' },
    });
    if (badPhoto.status === 400) r.pass(S, 'photo non data-uri → 400');
    else r.fail(S, 'photo non data-uri → 400', `statut ${badPhoto.status}`);

    const created = await api('/incidents', { method: 'POST', jar, body: { logement_id: owner.logements[0].id, titre: 'CRUD Incident', statut: 'nouveau' } });
    if (!expectSuccess(r, created, S, r, [201]) || !created.data.data.id) return;
    const id = created.data.data.id;

    const upd = await api(`/incidents/${id}`, { method: 'PUT', jar, body: { statut: 'en_cours' } });
    if (expectSuccess(r, upd, S, r) && upd.data.data.statut === 'en_cours') r.pass(S, 'incident modifié');
    else r.fail(S, 'incident modifié', JSON.stringify(upd.data));

    const del = await api(`/incidents/${id}`, { method: 'DELETE', jar });
    if (expectSuccess(r, del, S, r)) r.pass(S, 'incident supprimé');
    else r.fail(S, 'incident supprimé', JSON.stringify(del.data));
  });

  // ----------------------------------------------------------
  await r.section('prestataires / interventions', async () => {
    const created = await api('/prestataires', { method: 'POST', jar, body: { nom: 'CRUD Prestataire', specialite: 'Électricité' } });
    if (!expectSuccess(r, created, S, r, [201])) return;
    const pid = created.data.data.id;

    const inter = await api('/interventions', {
      method: 'POST',
      jar,
      body: { incident_id: owner.incidentId, prestataire_id: pid, logement_id: owner.logements[0].id, titre: 'CRUD Intervention', statut: 'planifie' },
    });
    if (!expectSuccess(r, inter, S, r, [201])) return;
    const iid = inter.data.data.id;

    const list = await api('/interventions', { jar });
    if (expectSuccess(r, list, S, r) && list.data.data.some((x) => x.id === iid)) r.pass(S, 'intervention listée');
    else r.fail(S, 'intervention listée', JSON.stringify(list.data));

    const delI = await api(`/interventions/${iid}`, { method: 'DELETE', jar });
    if (expectSuccess(r, delI, S, r)) r.pass(S, 'intervention supprimée');
    else r.fail(S, 'intervention supprimée', JSON.stringify(delI.data));

    const delP = await api(`/prestataires/${pid}`, { method: 'DELETE', jar });
    if (expectSuccess(r, delP, S, r)) r.pass(S, 'prestataire supprimé');
    else r.fail(S, 'prestataire supprimé', JSON.stringify(delP.data));
  });

  // ----------------------------------------------------------
  await r.section('notifications', async () => {
    const list = await api('/notifications', { jar });
    if (!expectSuccess(r, list, S, r) || !Array.isArray(list.data.data)) return;
    r.pass(S, `notifications listées (${list.data.data.length})`);

    const unread = list.data.data.find((n) => !n.lu);
    if (unread) {
      const mark = await api(`/notifications/${unread.id}`, { method: 'PUT', jar, body: { lu: true } });
      if (expectSuccess(r, mark, S, r) && mark.data.data.lu === true) r.pass(S, 'notification marquée lue');
      else r.fail(S, 'notification marquée lue', JSON.stringify(mark.data));
    } else {
      r.pass(S, 'aucune notification non lue à marquer (OK)');
    }

    const bad = await api(`/notifications/${list.data.data[0]?.id || 1}`, { method: 'PUT', jar, body: { lu: 'oui' } });
    if (bad.status === 400) r.pass(S, 'valeur lu invalide → 400');
    else r.fail(S, 'valeur lu invalide → 400', `statut ${bad.status}`);
  });
}
