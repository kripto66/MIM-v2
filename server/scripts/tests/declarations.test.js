// ============================================================
// MIM - Suite « Declarations » : loyer payé DIRECTEMENT au
// propriétaire (hors MIM) puis déclaré par le locataire et
// validé / refusé par le propriétaire.
//
// La suite est autonome : elle crée ses propres paiements via
// l'API (les suites précédentes mutent les paiements du seed).
//
// Machine d'état vérifiée :
//   attente|retard --déclarer--> en_validation --valider--> paye
//                                             \--refuser--> refuse
//   refuse --déclarer--> en_validation (re-déclaration possible)
//
// Sécurité :
//   - un locataire ne déclare que SES paiements, avec un moyen
//     du propriétaire (actif) ;
//   - le propriétaire ne voit/valide que SES paiements ;
//   - doubles clics / requêtes simultanées : une seule écriture
//     gagne (mise à jour conditionnelle) ;
//   - la nouvelle échéance est créée UNIQUEMENT après validation,
//     avec le montant relu en base (loyer_mensuel du logement).
// ============================================================

import { api, newJar, okStatus, expectSuccess } from './lib.js';

const S = 'declarations';
const PW = 'Test1234!';

export async function runDeclarations(r, ctx) {
  const { service, seed } = ctx;

  const nextMois = (ym) => {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1, 1));
    d.setUTCMonth(d.getUTCMonth() + 1);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  const nextMonth = nextMois(seed.month);

  const owner1 = seed.owners[0];
  const owner2 = seed.owners[1];
  const loc1 = owner1.locataires[0]; // own1loc1
  const loc2 = owner1.locataires[1]; // own1loc2
  const loc21 = owner2.locataires[0]; // own2loc1
  const log1 = owner1.logements[0];

  const loginOwner = async (owner) => {
    const jar = newJar();
    const res = await api('/auth/login', { method: 'POST', jar, body: { email: owner.email, password: PW } });
    if (res.status !== 200) throw new Error(`login ${owner.email} : ${res.status}`);
    return jar;
  };
  const loginTenant = async (username) => {
    const jar = newJar();
    const res = await api('/auth/login', { method: 'POST', jar, body: { identifier: username, password: PW } });
    if (res.status !== 200) throw new Error(`login ${username} : ${res.status}`);
    return jar;
  };

  const payOf = async (locataireId, mois) => {
    const { data } = await service.from('paiements').select('*').eq('locataire_id', locataireId).eq('mois', mois).maybeSingle();
    return data;
  };

  const createPay = async (jar, { locataireId, logementId, montant, mois, statut }) => {
    const res = await api('/paiements', {
      method: 'POST', jar,
      body: { locataire_id: locataireId, logement_id: logementId, montant, mois, statut, ...(statut === 'paye' ? { date_paiement: '2026-08-02' } : {}) },
    });
    return res;
  };

  // ----------------------------------------------------------
  // Préparation des paiements de test : l'anti-doublon interdit plusieurs
  // paiements par (locataire, mois) — on réutilise donc les paiements du
  // seed (attente/retard/paye) et on créé un seul paiement API sur un mois
  // libre (mois précédent-précédent) pour disposer d'un « payé » côté loc1.
  await r.section('préparation des paiements (seed + 1 création API)', async () => {
    const jar = await loginOwner(owner1);
    const jar2 = await loginOwner(owner2);

    const salPay = async (locataireId, mois) => {
      const one = await service.from('paiements').select('*').eq('locataire_id', locataireId).eq('mois', mois).maybeSingle();
      return one.data;
    };

    // Mois précédent-précédent : jamais d'échéance en base pour loc1.
    const [py, pm] = seed.prev.split('-').map(Number);
    const dd = new Date(Date.UTC(py, pm - 2, 1));
    const prevPrev = `${dd.getUTCFullYear()}-${String(dd.getUTCMonth() + 1).padStart(2, '0')}`;

    const p1 = await salPay(loc1.id, seed.month);       // attente (seed)
    const p2 = await salPay(loc1.id, seed.prev);        // retard (seed)
    const p5 = await salPay(loc2.id, seed.month);        // paye (seed)
    const p3 = await salPay(loc21.id, seed.month);       // attente (seed owner2)
    const p6 = await salPay(loc21.id, seed.prev);        // retard (seed owner2)

    const p4 = await createPay(jar, { locataireId: loc1.id, logementId: log1.id, montant: 100000, mois: prevPrev, statut: 'paye' });

    const all = [p1, p2, p3, p5, p6, p4.data?.data];
    if (all.every((p) => p?.id) && p4.status === 201) {
      ctx.P = {
        p1, p2, p3, p4: p4.data.data, p5, p6,
      };
      r.pass(S, '6 paiements de test identifiés (seed + 1 création API anti-doublon)');
    } else {
      r.fail(S, '6 paiements de test identifiés', `seed=${all.slice(0, 5).map((p) => p?.id ?? 'null').join(',')} api=${p4.status}`);
    }
  });

  // ----------------------------------------------------------
  await r.section('CRUD moyens de paiement (propriétaire)', async () => {
    const jar = await loginOwner(owner1);

    const wave = await api('/moyens-paiement', {
      method: 'POST', jar,
      body: { type: 'wave', nom_titulaire: 'Ali Ndiaye', numero: '+221771234567', instructions: 'Envoyez puis déclarez.' },
    });
    if (!expectSuccess(r, wave, S, 'création moyen wave (propriétaire)')) return;
    if (wave.data.data.type !== 'wave' || wave.data.data.user_id !== owner1.id) r.fail(S, 'moyen wave créé pour owner1', JSON.stringify(wave.data.data).slice(0, 200));
    else r.pass(S, 'moyen wave créé pour owner1');

    const om = await api('/moyens-paiement', { method: 'POST', jar, body: { type: 'orange_money', nom_titulaire: 'Ali Ndiaye', numero: '+22170111222' } });
    const virement = await api('/moyens-paiement', { method: 'POST', jar, body: { type: 'virement', banque: 'CBAO', nom_titulaire: 'Ali Ndiaye', num_compte: 'SN00123' } });
    const especes = await api('/moyens-paiement', { method: 'POST', jar, body: { type: 'especes', instructions: 'Au rendez-vous mensuel.' } });
    if (expectSuccess(r, om, S, 'création moyen orange_money')
      && expectSuccess(r, virement, S, 'création moyen virement')
      && expectSuccess(r, especes, S, 'création moyen especes')) r.pass(S, '4 types de moyens créés');
    else r.fail(S, '4 types de moyens créés');

    const badType = await api('/moyens-paiement', { method: 'POST', jar, body: { type: 'bitcoin' } });
    if (badType.status === 400) r.pass(S, 'type invalide rejeté (400)');
    else r.fail(S, 'type invalide rejeté (400)', `statut ${badType.status}`);

    const noType = await api('/moyens-paiement', { method: 'POST', jar, body: {} });
    if (noType.status === 400) r.pass(S, 'type manquant rejeté (400)');
    else r.fail(S, 'type manquant rejeté (400)', `statut ${noType.status}`);

    const list = await api('/moyens-paiement', { jar });
    if (okStatus(r, list, S, 'liste des moyens (propriétaire)') && list.data.data.length === 4) r.pass(S, 'liste des moyens (4)');
    else r.fail(S, 'liste des moyens (4)', `len=${list.data?.data?.length}`);

    const upd = await api(`/moyens-paiement/${wave.data.data.id}`, { method: 'PUT', jar, body: { numero: '+22177000000' } });
    if (expectSuccess(r, upd, S, 'mise à jour d\'un moyen') && upd.data.data.numero === '+22177000000') r.pass(S, 'numéro mis à jour');
    else r.fail(S, 'numéro mis à jour', JSON.stringify(upd.data).slice(0, 200));

    const tenantJar = await loginTenant(loc1.username);
    const asTenant = await api('/moyens-paiement', { method: 'POST', jar: tenantJar, body: { type: 'wave' } });
    if (asTenant.status === 403) r.pass(S, 'locataire interdit d\'écrire (403)');
    else r.fail(S, 'locataire interdit d\'écrire (403)', `statut ${asTenant.status}`);
  });

  // ----------------------------------------------------------
  await r.section('visibilité des moyens par le locataire', async () => {
    const jar = await loginOwner(owner1);
    const t1 = await loginTenant(loc1.username);
    const t2 = await loginTenant(loc21.username);

    const vis = await api('/locataire/moyens-paiement', { jar: t1 });
    if (expectSuccess(r, vis, S, 'moyens visibles (locataire own1loc1)') && vis.data.data.length === 4) r.pass(S, 'own1loc1 voit 4 moyens de son propriétaire');
    else r.fail(S, 'own1loc1 voit 4 moyens', `len=${vis.data?.data?.length}`);

    const vis2 = await api('/locataire/moyens-paiement', { jar: t2 });
    if (expectSuccess(r, vis2, S, 'moyens visibles (locataire own2loc1)') && vis2.data.data.length === 0) r.pass(S, 'own2loc1 ne voit aucun moyen d\'owner1');
    else r.fail(S, 'own2loc1 ne voit aucun moyen d\'owner1', `len=${vis2.data?.data?.length}`);

    // Désactivation : le locataire ne voit plus le moyen inactif.
    const first = vis.data.data[0];
    await api(`/moyens-paiement/${first.id}`, { method: 'PUT', jar, body: { actif: false } });
    const visOff = await api('/locataire/moyens-paiement', { jar: t1 });
    const offLen = visOff.data?.data?.length;
    if (offLen === 3 && !visOff.data.data.some((m) => m.id === first.id)) r.pass(S, 'moyen désactivé invisible pour le locataire');
    else r.fail(S, 'moyen désactivé invisible', `len=${offLen}`);

    await api(`/moyens-paiement/${first.id}`, { method: 'PUT', jar, body: { actif: true } });
    const visOn = await api('/locataire/moyens-paiement', { jar: t1 });
    if (visOn.data?.data?.length === 4) r.pass(S, 'moyen réactivé visible');
    else r.fail(S, 'moyen réactivé visible', `len=${visOn.data?.data?.length}`);

    const myMoyens = await api('/moyens-paiement', { jar: t1 });
    if (myMoyens.status === 403) r.pass(S, 'locataire bloqué sur /moyens-paiement (403)');
    else r.fail(S, 'locataire bloqué sur /moyens-paiement', `statut ${myMoyens.status}`);
  });

  // ----------------------------------------------------------
  await r.section('déclaration du locataire', async () => {
    const P = ctx.P;
    const t1 = await loginTenant(loc1.username);
    const otherJar = await loginOwner(owner2);

    const { data: moyens } = await service.from('moyens_paiement').select('id, type').eq('user_id', owner1.id).eq('actif', true);
    const waveMoyen = moyens.find((m) => m.type === 'wave');

    const noMoyen = await api(`/locataire/paiements/${P.p2.id}/declarer`, { method: 'POST', jar: t1, body: {} });
    if (noMoyen.status === 400) r.pass(S, 'déclaration sans moyen rejetée (400)');
    else r.fail(S, 'déclaration sans moyen rejetée (400)', `statut ${noMoyen.status}`);

    const crossLoc = await api(`/locataire/paiements/${P.p5.id}/declarer`, { method: 'POST', jar: t1, body: { moyen_paiement_id: waveMoyen.id } });
    if (crossLoc.status === 404) r.pass(S, 'déclaration d\'un paiement d\'autrui rejetée (404)');
    else r.fail(S, 'déclaration d\'un paiement d\'autrui rejetée (404)', `statut ${crossLoc.status}`);

    const ghost = await api('/locataire/paiements/999999999/declarer', { method: 'POST', jar: t1, body: { moyen_paiement_id: waveMoyen.id } });
    if (ghost.status === 404) r.pass(S, 'déclaration d\'un paiement inexistant rejetée (404)');
    else r.fail(S, 'déclaration d\'un paiement inexistant rejetée (404)', `statut ${ghost.status}`);

    const foreignMoyen = await api('/moyens-paiement', { method: 'POST', jar: otherJar, body: { type: 'wave', numero: '+22199000000' } });
    const crossMoyen = await api(`/locataire/paiements/${P.p2.id}/declarer`, { method: 'POST', jar: t1, body: { moyen_paiement_id: foreignMoyen.data.data.id } });
    if (crossMoyen.status === 404) r.pass(S, 'moyen d\'un autre propriétaire rejeté (404)');
    else r.fail(S, 'moyen d\'un autre propriétaire rejeté (404)', `statut ${crossMoyen.status}`);

    const dec = await api(`/locataire/paiements/${P.p2.id}/declarer`, {
      method: 'POST', jar: t1,
      body: { moyen_paiement_id: waveMoyen.id, reference: 'WAVE-REF-77' },
    });
    if (!expectSuccess(r, dec, S, 'déclaration valide')) return;
    if (dec.data.data.statut !== 'en_validation') r.fail(S, 'statut en_validation après déclaration', dec.data.data.statut);
    else r.pass(S, 'statut en_validation après déclaration');
    if (!dec.data.data.validation_requested_at) r.fail(S, 'validation_requested_at horodaté serveur');
    else r.pass(S, 'validation_requested_at horodaté serveur');
    if (dec.data.data.methode_paiement !== 'wave' || dec.data.data.reference !== 'WAVE-REF-77') r.fail(S, 'méthode + référence enregistrées', JSON.stringify(dec.data.data));
    else r.pass(S, 'méthode + référence enregistrées');

    const twice = await api(`/locataire/paiements/${P.p2.id}/declarer`, { method: 'POST', jar: t1, body: { moyen_paiement_id: waveMoyen.id } });
    if (twice.status === 409 || twice.status === 400) r.pass(S, 'double déclaration rejetée');
    else r.fail(S, 'double déclaration rejetée', `statut ${twice.status}`);

    const onPaye = await api(`/locataire/paiements/${P.p4.id}/declarer`, { method: 'POST', jar: t1, body: { moyen_paiement_id: waveMoyen.id } });
    if (onPaye.status === 400) r.pass(S, 'déclaration d\'un paiement payé rejetée (400)');
    else r.fail(S, 'déclaration d\'un paiement payé rejetée (400)', `statut ${onPaye.status}`);

    // Déclaration du mois courant (pour le flux « validation -> nouvelle échéance »).
    const decCourant = await api(`/locataire/paiements/${P.p1.id}/declarer`, { method: 'POST', jar: t1, body: { moyen_paiement_id: waveMoyen.id } });
    if (expectSuccess(r, decCourant, S, 'déclaration du mois courant') && decCourant.data.data.statut === 'en_validation') r.pass(S, 'mois courant déclaré -> en_validation');
    else r.fail(S, 'mois courant déclaré -> en_validation', JSON.stringify(decCourant.data).slice(0, 200));
  });

  // ----------------------------------------------------------
  await r.section('paiements en attente (propriétaire)', async () => {
    const P = ctx.P;
    const jar = await loginOwner(owner1);
    const t1 = await loginTenant(loc1.username);

    const pending = await api('/paiements-validation/en-attente', { jar });
    if (!okStatus(r, pending, S, 'liste des paiements à valider')) return;
    const items = pending.data.data;
    // D'autres suites peuvent laisser des paiements en_validation chez
    // owner1 : on vérifie la présence des DEUX nôtres, pas un total exact.
    const ids = items.map((i) => String(i.id));
    const mine = ids.includes(String(P.p1.id)) && ids.includes(String(P.p2.id));
    const allMineAreLoc1 = [P.p1, P.p2].every((p) => items.some((i) => String(i.id) === String(p.id) && String(i.locataire_id) === String(loc1.id)));
    if (mine && allMineAreLoc1) r.pass(S, 'les 2 déclarations (own1loc1) sont visibles par le propriétaire');
    else r.fail(S, 'les 2 déclarations (own1loc1) sont visibles', `len=${items.length} ids=${ids.join(',')}`);

    const asTenant = await api('/paiements-validation/en-attente', { jar: t1 });
    if (asTenant.status === 403) r.pass(S, 'locataire bloqué (403)');
    else r.fail(S, 'locataire bloqué (403)', `statut ${asTenant.status}`);

    const anon = await api('/paiements-validation/en-attente', { jar: newJar() });
    if (anon.status === 401) r.pass(S, 'non authentifié bloqué (401)');
    else r.fail(S, 'non authentifié bloqué (401)', `statut ${anon.status}`);
  });

  // ----------------------------------------------------------
  await r.section('validation du propriétaire', async () => {
    const P = ctx.P;
    const jar = await loginOwner(owner1);
    const otherJar = await loginOwner(owner2);

    const cross = await api(`/paiements-validation/${P.p1.id}/valider`, { method: 'POST', jar: otherJar });
    if (cross.status === 404) r.pass(S, 'propriétaire étranger bloqué (404)');
    else r.fail(S, 'propriétaire étranger bloqué (404)', `statut ${cross.status}`);

    const notPending = await api(`/paiements-validation/${P.p4.id}/valider`, { method: 'POST', jar });
    if (notPending.status === 400) r.pass(S, 'validation d\'un paiement payé rejetée (400)');
    else r.fail(S, 'validation d\'un paiement payé rejetée (400)', `statut ${notPending.status}`);

    // Le mois courant possède déjà des paiements : la validation du mois
    // précédent ne doit PAS créer d'échéance supplémentaire (anti-doublon,
    // robuste même si plusieurs paiements existent pour ce mois).
    const countCourant = async () => {
      const { data } = await service.from('paiements').select('id').eq('locataire_id', loc1.id).eq('mois', seed.month);
      return data.length;
    };
    const before = await countCourant();
    const val = await api(`/paiements-validation/${P.p2.id}/valider`, { method: 'POST', jar });
    if (!expectSuccess(r, val, S, 'validation valide')) return;
    if (val.data.data.statut !== 'paye') r.fail(S, 'statut paye après validation', val.data.data.statut);
    else r.pass(S, 'statut paye après validation');
    if (!val.data.data.validated_at) r.fail(S, 'validated_at horodaté serveur');
    else r.pass(S, 'validated_at horodaté serveur');
    if (val.data.data.validated_by !== owner1.id) r.fail(S, 'validated_by = owner1', String(val.data.data.validated_by));
    else r.pass(S, 'validated_by = owner1');
    const after = await countCourant();
    if (after === before) r.pass(S, 'validation mois précédent : aucune échéance dupliquée');
    else r.fail(S, 'validation mois précédent : aucune échéance dupliquée', `${before} -> ${after}`);

    const again = await api(`/paiements-validation/${P.p2.id}/valider`, { method: 'POST', jar });
    if (again.status === 400 || again.status === 409) r.pass(S, 'double validation rejetée');
    else r.fail(S, 'double validation rejetée', `statut ${again.status}`);

    // Validation du mois courant : le mois suivant est STRICTEMENT futur,
    // aucune échéance prématurée n'est donc créée (le locataire reste
    // « à jour » ; l'échéance sera assurée à l'ouverture de son dashboard).
    const valCourant = await api(`/paiements-validation/${P.p1.id}/valider`, { method: 'POST', jar });
    if (!expectSuccess(r, valCourant, S, 'validation du mois courant')) return;
    if (valCourant.data.echeance?.mois === nextMonth) r.fail(S, 'nouvelle échéance non annoncée (mois futur)', JSON.stringify(valCourant.data.echeance));
    else r.pass(S, 'échéance du mois suivant non annoncée (mois futur)');

    const echeance = await payOf(loc1.id, nextMonth);
    if (echeance) r.fail(S, `aucune échéance prématurée en base (${nextMonth})`, JSON.stringify(echeance).slice(0, 200));
    else r.pass(S, `aucune échéance prématurée en base (${nextMonth})`);

    const { data: echs } = await service.from('paiements').select('id').eq('locataire_id', loc1.id).eq('mois', nextMonth);
    if (echs.length === 0) r.pass(S, 'échéance future absente (anti-doublon)');
    else r.fail(S, 'échéance future absente (anti-doublon)', `len=${echs.length}`);

    // Un paiement désormais paye n'est plus déclarable par le locataire.
    const t1 = await loginTenant(loc1.username);
    const { data: moyens } = await service.from('moyens_paiement').select('id').eq('user_id', owner1.id).eq('actif', true);
    const redeclPaye = await api(`/locataire/paiements/${P.p1.id}/declarer`, { method: 'POST', jar: t1, body: { moyen_paiement_id: moyens[0].id } });
    if (redeclPaye.status === 400) r.pass(S, 'déclaration d\'un paiement payé rejetée (400)');
    else r.fail(S, 'déclaration d\'un paiement payé rejetée (400)', `statut ${redeclPaye.status}`);
  });

  // ----------------------------------------------------------
  await r.section('refus + re-déclaration', async () => {
    const P = ctx.P;
    const jar = await loginOwner(owner2);
    const t21 = await loginTenant(loc21.username);
    const otherJar = await loginOwner(owner1);

    const { data: moyens } = await service.from('moyens_paiement').select('id, type').eq('user_id', owner2.id).eq('actif', true);
    const waveMoyen = moyens.find((m) => m.type === 'wave');

    const dec = await api(`/locataire/paiements/${P.p3.id}/declarer`, { method: 'POST', jar: t21, body: { moyen_paiement_id: waveMoyen.id } });
    if (!expectSuccess(r, dec, S, 'déclaration own2loc1')) return;

    const wrongOwner = await api(`/paiements-validation/${P.p3.id}/refuser`, { method: 'POST', jar: otherJar, body: { motif: 'Paiement non reçu' } });
    if (wrongOwner.status === 404) r.pass(S, 'refus par un autre propriétaire bloqué (404)');
    else r.fail(S, 'refus par un autre propriétaire bloqué (404)', `statut ${wrongOwner.status}`);

    const noMotif = await api(`/paiements-validation/${P.p3.id}/refuser`, { method: 'POST', jar, body: {} });
    if (noMotif.status === 400) r.pass(S, 'refus sans motif rejeté (400)');
    else r.fail(S, 'refus sans motif rejeté (400)', `statut ${noMotif.status}`);

    const longMotif = await api(`/paiements-validation/${P.p3.id}/refuser`, { method: 'POST', jar, body: { motif: 'x'.repeat(201) } });
    if (longMotif.status === 400) r.pass(S, 'refus motif trop long rejeté (400)');
    else r.fail(S, 'refus motif trop long rejeté (400)', `statut ${longMotif.status}`);

    const rej = await api(`/paiements-validation/${P.p3.id}/refuser`, { method: 'POST', jar, body: { motif: 'Paiement non reçu' } });
    if (!expectSuccess(r, rej, S, 'refus valide')) return;
    if (rej.data.data.statut !== 'refuse' || rej.data.data.rejection_reason !== 'Paiement non reçu') r.fail(S, 'statut refuse + motif', JSON.stringify(rej.data.data));
    else r.pass(S, 'statut refuse + motif enregistrés');
    if (rej.data.data.validated_at) r.fail(S, 'pas de validated_at après refus');
    else r.pass(S, 'pas de validated_at après refus');

    // Le refus n'avance PAS l'échéance : aucune création au mois suivant.
    const { data: echsNext } = await service.from('paiements').select('id').eq('locataire_id', loc21.id).eq('mois', nextMonth);
    if (echsNext.length === 0) r.pass(S, 'refus sans avance d\'échéance');
    else r.fail(S, 'refus sans avance d\'échéance', `len=${echsNext.length}`);

    const redecl = await api(`/locataire/paiements/${P.p3.id}/declarer`, { method: 'POST', jar: t21, body: { moyen_paiement_id: waveMoyen.id, reference: 'TRY-2' } });
    if (expectSuccess(r, redecl, S, 're-déclaration après refus') && redecl.data.data.statut === 'en_validation') r.pass(S, 're-déclaration après refus -> en_validation');
    else r.fail(S, 're-déclaration après refus -> en_validation', JSON.stringify(redecl.data).slice(0, 200));
  });

  // ----------------------------------------------------------
  await r.section('concurrence : doubles requêtes simultanées', async () => {
    const P = ctx.P;
    const t21 = await loginTenant(loc21.username);
    const jar = await loginOwner(owner2);

    const { data: moyens } = await service.from('moyens_paiement').select('id').eq('user_id', owner2.id).eq('actif', true);
    const moyenId = moyens[0].id;

    const [a, b] = await Promise.all([
      api(`/locataire/paiements/${P.p6.id}/declarer`, { method: 'POST', jar: t21, body: { moyen_paiement_id: moyenId } }),
      api(`/locataire/paiements/${P.p6.id}/declarer`, { method: 'POST', jar: t21, body: { moyen_paiement_id: moyenId } }),
    ]);
    const winners = [a, b].filter((x) => x.status === 200).length;
    const losers = [a, b].filter((x) => x.status === 409 || x.status === 400).length;
    if (winners === 1 && losers === 1) r.pass(S, '2 déclarations simultanées : 1 gagne, 1 rejetée');
    else r.fail(S, '2 déclarations simultanées', `winners=${winners} losers=${losers} (${a.status}, ${b.status})`);

    const [v1, v2] = await Promise.all([
      api(`/paiements-validation/${P.p6.id}/valider`, { method: 'POST', jar }),
      api(`/paiements-validation/${P.p6.id}/valider`, { method: 'POST', jar }),
    ]);
    const vWinners = [v1, v2].filter((x) => x.status === 200).length;
    const vLosers = [v1, v2].filter((x) => x.status === 400 || x.status === 409).length;
    if (vWinners === 1 && vLosers === 1) r.pass(S, '2 validations simultanées : 1 gagne, 1 rejetée');
    else r.fail(S, '2 validations simultanées', `winners=${vWinners} losers=${vLosers} (${v1.status}, ${v2.status})`);

    const { data: echs } = await service.from('paiements').select('id').eq('locataire_id', loc21.id).eq('mois', nextMonth);
    if (echs.length === 0) r.pass(S, 'aucune échéance prématurée après double validation');
    else r.fail(S, 'aucune échéance prématurée après double validation', `len=${echs.length}`);
  });

  // ----------------------------------------------------------
  await r.section('notifications (déclaration + validation + refus)', async () => {
    const { data: notifOwner } = await service
      .from('notifications')
      .select('type, message, created_at')
      .eq('user_id', owner1.id)
      .order('created_at', { ascending: false })
      .limit(2);
    const last = notifOwner?.[0];
    if (last && /validation/i.test(last.message)) r.pass(S, 'propriétaire notifié de la demande de validation');
    else r.fail(S, 'propriétaire notifié de la demande de validation', last ? last.message : 'aucune notification');

    const { data: notifTenant } = await service
      .from('notifications')
      .select('type, message, created_at')
      .eq('user_id', loc1.account_uid)
      .order('created_at', { ascending: false })
      .limit(5);
    const msgs = (notifTenant || []).map((n) => n.message).join(' | ');
    if (/Paiement validé/.test(msgs)) r.pass(S, 'locataire notifié de la validation');
    else r.fail(S, 'locataire notifié de la validation', msgs || 'aucune');

    const { data: notifTenant21 } = await service
      .from('notifications')
      .select('message')
      .eq('user_id', loc21.account_uid)
      .order('created_at', { ascending: false })
      .limit(3);
    const msgs21 = (notifTenant21 || []).map((n) => n.message).join(' | ');
    if (/non validé/.test(msgs21) || /n'a pas été confirmée/.test(msgs21)) r.pass(S, 'locataire own2loc1 notifié du refus');
    else r.fail(S, 'locataire own2loc1 notifié du refus', msgs21 || 'aucune');
  });
}