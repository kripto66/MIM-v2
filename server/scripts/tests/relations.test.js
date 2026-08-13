// ============================================================
// MIM - Suite relations : FK, occupation, suppressions, cascade
// ============================================================

import { api, expectSuccess } from './lib.js';

const S = 'relations';
const PW = 'Test1234!';

export async function runRelations(r, ctx) {
  const o1 = ctx.seed.owners[0];
  const jar = o1.jar;
  const service = ctx.service;

  const logementStatut = async (id) => {
    const { data } = await service.from('logements').select('statut').eq('id', id).single();
    return data?.statut;
  };

  // ----------------------------------------------------------
  await r.section('logement occupé : suppression impossible', async () => {
    const occ = o1.logements[3];
    const del = await api(`/logements/${occ.id}`, { method: 'DELETE', jar });
    if (del.status === 400) r.pass(S, 'logement occupé → suppression refusée');
    else r.fail(S, 'logement occupé → suppression refusée', `statut ${del.status} ${JSON.stringify(del.data)}`);
  });

  // ----------------------------------------------------------
  await r.section('suppression locataire : logement libéré + compte désactivé + cascade paiements', async () => {
    // Créer un logement dédié pour ne pas toucher aux données du seed.
    const lg = await api('/logements', {
      method: 'POST',
      jar,
      body: { bien_id: o1.bienId, nom: 'Rel Log', type: 'chambre', adresse: 'A', loyer_mensuel: 50000, statut: 'libre' },
    });
    if (!expectSuccess(r, lg, S, r, [201])) return;
    const lgId = lg.data.data.id;

    const username = `relten${Date.now() % 100000}`;
    const loc = await api('/locataires', {
      method: 'POST',
      jar,
      body: { logement_id: lgId, nom: 'Rel Locataire', username, password: PW, jour_echeance: 5 },
    });
    if (!expectSuccess(r, loc, S, r, [201])) return;
    const locId = loc.data.data.id;

    const pay = await api('/paiements', {
      method: 'POST',
      jar,
      body: { locataire_id: locId, logement_id: lgId, montant: 50000, mois: ctx.seed.month, statut: 'paye' },
    });
    if (!expectSuccess(r, pay, S, r, [201])) return;

    if ((await logementStatut(lgId)) === 'occupe') r.pass(S, 'logement passé à occupe');
    else r.fail(S, 'logement passé à occupe', `statut ${await logementStatut(lgId)}`);

    const del = await api(`/locataires/${locId}`, { method: 'DELETE', jar });
    if (!expectSuccess(r, del, S, r)) return;

    if ((await logementStatut(lgId)) === 'libre') r.pass(S, 'logement libéré après suppression du locataire');
    else r.fail(S, 'logement libéré après suppression du locataire', `statut ${await logementStatut(lgId)}`);

    const login = await api('/auth/login', { method: 'POST', body: { identifier: username, password: PW } });
    if (login.status === 401) r.pass(S, 'compte locataire désactivé');
    else r.fail(S, 'compte locataire désactivé', `statut ${login.status}`);

    const { data: pa } = await service.from('paiements').select('id').eq('locataire_id', locId);
    if (!pa || pa.length === 0) r.pass(S, 'paiements supprimés en cascade');
    else r.fail(S, 'paiements supprimés en cascade', `${pa.length} paiement(s) restant(s)`);

    const delLg = await api(`/logements/${lgId}`, { method: 'DELETE', jar });
    if (expectSuccess(r, delLg, S, r)) r.pass(S, 'logement libre supprimé');
    else r.fail(S, 'logement libre supprimé', JSON.stringify(delLg.data));
  });

  // ----------------------------------------------------------
  await r.section('double occupation : un logement = un seul locataire actif', async () => {
    const lg = await api('/logements', {
      method: 'POST',
      jar,
      body: { bien_id: o1.bienId, nom: 'Double Log', type: 'chambre', adresse: 'A', loyer_mensuel: 45000, statut: 'libre' },
    });
    if (!expectSuccess(r, lg, S, r, [201])) return;
    const lgId = lg.data.data.id;

    const u1 = `dbltena${Date.now() % 100000}`;
    const t1 = await api('/locataires', {
      method: 'POST',
      jar,
      body: { logement_id: lgId, nom: 'Double A', username: u1, password: PW, jour_echeance: 5 },
    });
    if (!expectSuccess(r, t1, S, r, [201])) return;
    if ((await logementStatut(lgId)) === 'occupe') r.pass(S, '1er locataire → logement occupe');
    else r.fail(S, '1er locataire → logement occupe', `statut ${await logementStatut(lgId)}`);

    // 2e locataire sur le même logement → DOIT être refusé.
    const u2 = `dbltenb${Date.now() % 100000}`;
    const t2 = await api('/locataires', {
      method: 'POST',
      jar,
      body: { logement_id: lgId, nom: 'Double B', username: u2, password: PW, jour_echeance: 5 },
    });
    if (t2.status === 400) r.pass(S, '2e locataire sur logement occupé → refusé');
    else r.fail(S, '2e locataire sur logement occupé → refusé', `statut ${t2.status} — double occupation possible !`);

    // Même vérif via locataire sans compte.
    const t3 = await api('/locataires', {
      method: 'POST',
      jar,
      body: { logement_id: lgId, nom: 'Double C', statut: 'actif' },
    });
    if (t3.status === 400) r.pass(S, '2e locataire sans compte refusé aussi');
    else r.fail(S, '2e locataire sans compte refusé aussi', `statut ${t3.status}`);

    // Nettoyage.
    await api(`/locataires/${t1.data.data.id}`, { method: 'DELETE', jar });
    await api(`/logements/${lgId}`, { method: 'DELETE', jar });
  });

  // ----------------------------------------------------------
  await r.section('changement de logement : synchronisation des statuts', async () => {
    const lg1 = await api('/logements', {
      method: 'POST',
      jar,
      body: { bien_id: o1.bienId, nom: 'Move L1', type: 'chambre', adresse: 'A', loyer_mensuel: 40000, statut: 'libre' },
    });
    const lg2 = await api('/logements', {
      method: 'POST',
      jar,
      body: { bien_id: o1.bienId, nom: 'Move L2', type: 'chambre', adresse: 'B', loyer_mensuel: 40000, statut: 'libre' },
    });
    if (!expectSuccess(r, lg1, S, r, [201]) || !expectSuccess(r, lg2, S, r, [201])) return;
    const id1 = lg1.data.data.id;
    const id2 = lg2.data.data.id;

    const username = `moveten${Date.now() % 100000}`;
    const loc = await api('/locataires', {
      method: 'POST',
      jar,
      body: { logement_id: id1, nom: 'Move T', username, password: PW, jour_echeance: 5 },
    });
    if (!expectSuccess(r, loc, S, r, [201])) return;
    const locId = loc.data.data.id;

    const upd = await api(`/locataires/${locId}`, { method: 'PUT', jar, body: { logement_id: id2 } });
    if (!expectSuccess(r, upd, S, r)) return;

    const s1 = await logementStatut(id1);
    const s2 = await logementStatut(id2);
    if (s1 === 'libre' && s2 === 'occupe') r.pass(S, 'ancien logement libéré, nouveau occupé');
    else r.fail(S, 'ancien logement libéré, nouveau occupé', `L1=${s1} L2=${s2}`);

    await api(`/locataires/${locId}`, { method: 'DELETE', jar });
    await api(`/logements/${id1}`, { method: 'DELETE', jar });
    await api(`/logements/${id2}`, { method: 'DELETE', jar });
  });

  // ----------------------------------------------------------
  await r.section('suppression bien avec logements (FK SET NULL)', async () => {
    const bien = await api('/biens', { method: 'POST', jar, body: { nom: 'Rel Bien', type: 'villa' } });
    if (!expectSuccess(r, bien, S, r, [201])) return;
    const bienId = bien.data.data.id;

    const lg = await api('/logements', {
      method: 'POST',
      jar,
      body: { bien_id: bienId, nom: 'Rel Log2', type: 'chambre', adresse: 'A', loyer_mensuel: 30000, statut: 'libre' },
    });
    if (!expectSuccess(r, lg, S, r, [201])) return;
    const lgId = lg.data.data.id;

    const delBien = await api(`/biens/${bienId}`, { method: 'DELETE', jar });
    if (expectSuccess(r, delBien, S, r)) r.pass(S, 'bien supprimé (avec logement attaché)');

    const { data: after } = await service.from('logements').select('id, bien_id').eq('id', lgId).single();
    if (after && after.bien_id === null) r.pass(S, 'logement conservé avec bien_id NULL (FK SET NULL)');
    else r.fail(S, 'logement conservé avec bien_id NULL (FK SET NULL)', JSON.stringify(after));

    await api(`/logements/${lgId}`, { method: 'DELETE', jar });
  });
}
