// ============================================================
// MIM - Suite « mandat » : espace propriétaire délégué
//   * le propriétaire avec mandat actif est redirigé vers son espace
//   * GET /mandat/dashboard reflète le parc et les versements
//   * confirmation d'un versement par le propriétaire
//   * messagerie propriétaire <-> agence
//   * un propriétaire SANS mandat ne peut pas utiliser ces routes
//   * isolation : un propriétaire ne voit jamais le mandat d'un autre
//   * H-18 : révocation / suspension du mandat (routes scoped → 403,
//     traçage motif + horodatage + acteur, réactivation réservée au
//     compte qui a prononcé la suspension)
// ============================================================

import { api, newJar, createConfirmedSession } from './lib.js';

const S = 'mandat';
const PW = 'Test1234!';

export async function runMandat(r, ctx) {
  const { service } = ctx;
  const stamp = Date.now();

  // --- 1. Propriétaire SANS mandat : accès refusé (fail-closed) ---
  const sansMandat = ctx.seed.owners[7];
  const noMandat = await api('/mandat/dashboard', { jar: sansMandat.jar });
  if (noMandat.status === 404 && noMandat.data?.code === 'MANDAT_NOT_FOUND') {
    r.pass(S, 'propriétaire sans mandat → 404 MANDAT_NOT_FOUND');
  } else {
    r.fail(S, 'propriétaire sans mandat → 404 MANDAT_NOT_FOUND', `statut ${noMandat.status}`);
  }

  // --- 2. Création agence + propriétaire géré + mandat ---
  let agence;
  let gere;
  try {
    agence = await createConfirmedSession(service, {
      account_type: 'agence',
      name: `Agence Mandat ${stamp}`,
      email: `agence.mandat.${stamp}@mimtest.com`,
      phone: '+221771119900',
      password: PW,
    });
    gere = await createConfirmedSession(service, {
      account_type: 'proprietaire',
      name: `is_test Proprietaire Mandat ${stamp}`,
      email: `proprio.mandat.${stamp}@mimtest.com`,
      phone: '+221771118877',
      password: PW,
    });
  } catch (err) {
    r.blocked(S, 'création des comptes mandat', err.message);
    return;
  }

  const bienId = `9${stamp}`.slice(0, 12);
  const { error: bienErr } = await service.from('biens').insert({
    id: Number(bienId),
    user_id: gere.user.id,
    nom: `Bien mandat ${stamp}`,
    type: 'appartement',
    adresse: 'Rue mandat',
    ville: 'Dakar',
  });
  if (bienErr) {
    r.blocked(S, 'création du bien du mandat', bienErr.message);
    return;
  }
  const { data: lgRow, error: lgErr } = await service.from('logements').insert({
    user_id: gere.user.id,
    bien_id: Number(bienId),
    nom: 'is_test Logement mandat',
    type: 'appartement',
    adresse: 'Rue mandat',
    loyer_mensuel: 120000,
    statut: 'libre',
  }).select('id').single();
  if (lgErr || !lgRow?.id) {
    r.blocked(S, 'création du logement du mandat', lgErr?.message || 'id non retourné');
    return;
  }
  const logementId = lgRow.id;

  const { error: lienErr } = await service.from('agences_proprietaires').insert({
    user_id: agence.user.id,
    agence_id: agence.user.id,
    proprietaire_id: gere.user.id,
    statut: 'actif',
  });
  if (lienErr) {
    r.blocked(S, 'création du mandat', lienErr.message);
    return;
  }
  const { error: bienLienErr } = await service.from('agences_biens').insert({
    user_id: agence.user.id,
    agence_id: agence.user.id,
    proprietaire_id: gere.user.id,
    bien_id: Number(bienId),
    statut: 'actif',
  });
  if (bienLienErr) {
    r.blocked(S, 'création du mandat bien', bienLienErr.message);
    return;
  }

  const { data: vRow, error: vErr } = await service
    .from('versements')
    .insert({
      user_id: agence.user.id,
      agence_id: agence.user.id,
      proprietaire_id: gere.user.id,
      bien_id: Number(bienId),
      montant: 95000,
      periode: '2026-08',
      statut: 'attente',
      methode_paiement: 'virement',
    })
    .select('id')
    .single();
  if (vErr || !vRow?.id) {
    r.blocked(S, 'création du versement', vErr?.message || 'id non retourné');
    return;
  }
  const versementId = vRow.id;

  // --- 3. Le propriétaire SAISIT une session APRÈS le mandat : redirection shadow ---
  const jarShadow = newJar();
  const login = await api('/auth/login', {
    method: 'POST',
    jar: jarShadow,
    body: { email: gere.user.email, password: PW },
  });
  if (login.status === 200 && login.data?.redirect === 'PartProprietairesShadow/dashboard.html') {
    r.pass(S, 'connexion avec mandat → redirection espace délégué');
  } else {
    r.fail(S, 'connexion avec mandat → redirection espace délégué', `redir=${login.data?.redirect}`);
  }

  // --- 4. Dashboard du mandat ---
  const dash = await api('/mandat/dashboard', { jar: jarShadow });
  if (dash.status === 200 && dash.data?.success) {
    r.pass(S, 'GET /mandat/dashboard → 200');
  } else {
    r.fail(S, 'GET /mandat/dashboard → 200', `statut ${dash.status}`);
    return;
  }

  if (dash.data.biens.length === 1 && dash.data.totaux.biens === 1) {
    r.pass(S, 'dashboard mandat : 1 bien sous mandat');
  } else {
    r.fail(S, 'dashboard mandat : 1 bien sous mandat', JSON.stringify(dash.data.biens?.map((b) => b.id)));
  }

  if (dash.data.totaux.loyerTotal === 120000 && dash.data.totaux.occupes === 0 && dash.data.totaux.logements === 1) {
    r.pass(S, 'dashboard mandat : loyer et occupation reflétés');
  } else {
    r.fail(S, 'dashboard mandat : loyer et occupation reflétés', JSON.stringify(dash.data.totaux));
  }

  if (dash.data.totaux.verseAttente === 95000 && dash.data.totaux.verse === 0) {
    r.pass(S, 'dashboard mandat : versement en attente comptabilisé');
  } else {
    r.fail(S, 'dashboard mandat : versement en attente comptabilisé', JSON.stringify(dash.data.totaux));
  }

  // --- 4b. Drill-down lecture seule : logements + locataires ---
  // Les assertions dashboard ci-dessus ont été relevées AVANT l'occupation
  // du logement : on peuple ensuite locataire + échéance du mois courant
  // pour valider les deux routes de drill-down.
  const dNow = new Date();
  const moisCourant = `${dNow.getFullYear()}-${String(dNow.getMonth() + 1).padStart(2, '0')}`;

  const { data: locRow, error: locErr } = await service
    .from('locataires')
    .insert({
      user_id: gere.user.id,
      logement_id: logementId,
      nom: 'is_test Locataire Mandat',
      phone: '+221770000009',
      date_entree: '2026-03-15',
      statut: 'actif',
    })
    .select('id')
    .single();
  if (locErr || !locRow?.id) {
    r.blocked(S, 'drill-down : locataire de test', locErr?.message || 'id non retourné');
  } else {
    const { error: paiErr } = await service.from('paiements').insert({
      user_id: gere.user.id,
      locataire_id: locRow.id,
      logement_id: logementId,
      montant: 120000,
      mois: moisCourant,
      statut: 'retard',
    });
    if (paiErr) r.blocked(S, 'drill-down : échéance de test', paiErr.message);

    const { error: occErr } = await service.from('logements').update({ statut: 'occupe' }).eq('id', logementId);
    if (occErr) r.blocked(S, 'drill-down : occupation du logement', occErr.message);
  }

  const lgRes = await api('/mandat/logements', { jar: jarShadow });
  const lg = lgRes.data?.logements?.[0];
  if (lgRes.status === 200 && (lgRes.data?.logements || []).length === 1) {
    r.pass(S, 'GET /mandat/logements → 200 (1 logement)');
  } else {
    r.fail(S, 'GET /mandat/logements → 200 (1 logement)', `statut ${lgRes.status}`);
  }

  if (lg && lg.locataire?.nom === 'is_test Locataire Mandat' && lg.bien_nom === `Bien mandat ${stamp}`) {
    r.pass(S, 'drill-down : logement rattaché au bien et au locataire');
  } else {
    r.fail(S, 'drill-down : logement rattaché au bien et au locataire', JSON.stringify(lg));
  }

  if (lg && lg.paiementMois?.statut === 'retard' && lg.paiementMois?.montant === 120000) {
    r.pass(S, 'drill-down : échéance du mois courant branchée sur le logement');
  } else {
    r.fail(S, 'drill-down : échéance du mois courant branchée sur le logement', JSON.stringify(lg?.paiementMois));
  }

  if (lgRes.data?.totaux?.occupes === 1 && lgRes.data?.totaux?.retards === 1 && lgRes.data?.totaux?.loyerTotal === 120000) {
    r.pass(S, 'drill-down : totaux (occupation, retard, loyer)');
  } else {
    r.fail(S, 'drill-down : totaux (occupation, retard, loyer)', JSON.stringify(lgRes.data?.totaux));
  }

  const locRes = await api('/mandat/locataires', { jar: jarShadow });
  const t0 = locRes.data?.locataires?.[0];
  if (
    locRes.status === 200 &&
    (locRes.data?.locataires || []).length === 1 &&
    t0?.logement_nom === 'is_test Logement mandat' &&
    t0?.bien_nom === `Bien mandat ${stamp}` &&
    t0?.paiementMois?.statut === 'retard'
  ) {
    r.pass(S, 'GET /mandat/locataires → drill-down logement/bien/échéance');
  } else {
    r.fail(S, 'GET /mandat/locataires → drill-down logement/bien/échéance', `statut ${locRes.status} ${JSON.stringify(locRes.data?.locataires)}`);
  }

  const lgSans = await api('/mandat/logements', { jar: sansMandat.jar });
  const locSans = await api('/mandat/locataires', { jar: sansMandat.jar });
  if (lgSans.status === 404 && locSans.status === 404) {
    r.pass(S, 'drill-down sans mandat → 404 (fail-closed)');
  } else {
    r.fail(S, 'drill-down sans mandat → 404 (fail-closed)', `logements=${lgSans.status} locataires=${locSans.status}`);
  }

  // --- 4c. Bloc revenus : finances du parc (série 6 mois) ---
  const finRes = await api('/mandat/finances', { jar: jarShadow });
  const fin = finRes.data;
  if (finRes.status === 200 && fin?.success) {
    r.pass(S, 'GET /mandat/finances → 200');
  } else {
    r.fail(S, 'GET /mandat/finances → 200', `statut ${finRes.status}`);
  }

  if (fin && fin.courant?.attendu === 120000 && fin.courant?.encaisse === 0 && fin.courant?.impaye === 120000) {
    r.pass(S, 'finances : attendu / encaissé / impayé du mois courant');
  } else {
    r.fail(S, 'finances : attendu / encaissé / impayé du mois courant', JSON.stringify(fin?.courant));
  }

  const dernier = Array.isArray(fin?.series) ? fin.series[5] : null;
  if (
    fin?.series?.length === 6 &&
    dernier?.mois === moisCourant &&
    dernier?.attendu === 120000 &&
    dernier?.paye === 0 &&
    dernier?.retarde === 120000
  ) {
    r.pass(S, 'finances : série de 6 mois, attendu porté sur le mois courant');
  } else {
    r.fail(S, 'finances : série de 6 mois, attendu porté sur le mois courant', JSON.stringify(fin?.series));
  }

  const finSans = await api('/mandat/finances', { jar: sansMandat.jar });
  if (finSans.status === 404) {
    r.pass(S, 'finances sans mandat → 404 (fail-closed)');
  } else {
    r.fail(S, 'finances sans mandat → 404 (fail-closed)', `statut ${finSans.status}`);
  }

  // --- 4d. Entretien : incidents et interventions en détail ---
  const { data: preRow, error: preErr } = await service
    .from('prestataires')
    .insert({ user_id: gere.user.id, nom: 'Plombier Mandat', specialite: 'plomberie', phone: '+221770000010' })
    .select('id')
    .single();
  const { data: incRow, error: incErr } = await service
    .from('incidents')
    .insert({
      user_id: gere.user.id,
      logement_id: logementId,
      titre: 'is_test Fuite d eau',
      description: 'Fuite sous l evier',
      statut: 'nouveau',
    })
    .select('id')
    .single();
  if (preErr || incErr || !preRow?.id || !incRow?.id) {
    r.blocked(S, 'entretien : fixtures incident/prestataire', preErr?.message || incErr?.message || 'id manquant');
  } else {
    const { error: intErr } = await service.from('interventions').insert({
      user_id: gere.user.id,
      incident_id: incRow.id,
      prestataire_id: preRow.id,
      logement_id: logementId,
      titre: 'is_test Intervention plomberie',
      statut: 'planifie',
      date_prevue: '2026-10-15',
    });
    if (intErr) r.blocked(S, 'entretien : intervention de test', intErr.message);
  }

  const entRes = await api('/mandat/entretien', { jar: jarShadow });
  const ent = entRes.data;
  if (entRes.status === 200 && ent?.success) {
    r.pass(S, 'GET /mandat/entretien → 200');
  } else {
    r.fail(S, 'GET /mandat/entretien → 200', `statut ${entRes.status}`);
  }

  const inc0 = ent?.incidents?.[0];
  if (
    ent?.incidents?.length === 1 &&
    inc0?.titre === 'is_test Fuite d eau' &&
    inc0?.logement_nom === 'is_test Logement mandat' &&
    inc0?.bien_nom === `Bien mandat ${stamp}` &&
    inc0?.statut === 'nouveau'
  ) {
    r.pass(S, 'entretien : incident détaillé (logement, bien, statut)');
  } else {
    r.fail(S, 'entretien : incident détaillé (logement, bien, statut)', JSON.stringify(ent?.incidents));
  }

  const int0 = ent?.interventions?.[0];
  if (
    ent?.interventions?.length === 1 &&
    int0?.titre === 'is_test Intervention plomberie' &&
    int0?.statut === 'planifie' &&
    int0?.date_prevue === '2026-10-15' &&
    int0?.prestataire?.nom === 'Plombier Mandat' &&
    int0?.incident?.titre === 'is_test Fuite d eau' &&
    inc0?.interventions?.length === 1
  ) {
    r.pass(S, 'entretien : intervention avec prestataire et rattachée à l\'incident');
  } else {
    r.fail(S, 'entretien : intervention avec prestataire et rattachée à l\'incident', JSON.stringify(ent?.interventions));
  }

  if (ent?.totaux?.incidents === 1 && ent?.totaux?.incidentsOuverts === 1 && ent?.totaux?.interventionsPlanifiees === 1) {
    r.pass(S, 'entretien : totaux (incidents ouverts, interventions planifiées)');
  } else {
    r.fail(S, 'entretien : totaux (incidents ouverts, interventions planifiées)', JSON.stringify(ent?.totaux));
  }

  const entSans = await api('/mandat/entretien', { jar: sansMandat.jar });
  if (entSans.status === 404) {
    r.pass(S, 'entretien sans mandat → 404 (fail-closed)');
  } else {
    r.fail(S, 'entretien sans mandat → 404 (fail-closed)', `statut ${entSans.status}`);
  }

  // --- 4e. Dépenses : lecture sous mandat, écriture refusée ---
  const { error: depErr } = await service.from('depenses').insert({
    user_id: gere.user.id,
    bien_id: Number(bienId),
    libelle: 'is_test Peinture salon',
    montant: 45000,
    categorie: 'travaux',
    date_depense: `${moisCourant}-05`,
  });
  if (depErr) r.blocked(S, 'depenses : fixture de test', depErr.message);

  const depRes = await api('/mandat/depenses', { jar: jarShadow });
  const dep = depRes.data;
  const d0 = dep?.depenses?.[0];
  if (depRes.status === 200 && dep?.success && dep?.depenses?.length === 1) {
    r.pass(S, 'GET /mandat/depenses → 200 (1 dépense)');
  } else {
    r.fail(S, 'GET /mandat/depenses → 200 (1 dépense)', `statut ${depRes.status}`);
  }

  if (d0?.libelle === 'is_test Peinture salon' && d0?.bien_nom === `Bien mandat ${stamp}` && d0?.montant === 45000 && d0?.categorie === 'travaux') {
    r.pass(S, 'depenses : ligne détaillée (libellé, bien, montant, catégorie)');
  } else {
    r.fail(S, 'depenses : ligne détaillée (libellé, bien, montant, catégorie)', JSON.stringify(d0));
  }

  if (dep?.totaux?.moisCourant === 45000 && dep?.totaux?.sixMois === 45000 && dep?.parMois?.length === 6 && dep?.parMois?.[5]?.total === 45000) {
    r.pass(S, 'depenses : cumuls (mois courant, 6 mois, ventilation mensuelle)');
  } else {
    r.fail(S, 'depenses : cumuls (mois courant, 6 mois, ventilation mensuelle)', JSON.stringify({ totaux: dep?.totaux, parMois: dep?.parMois }));
  }

  // Sous mandat actif, le propriétaire ne peut PAS écrire (mandatGuard).
  const depWrite = await api('/depenses', {
    method: 'POST',
    jar: jarShadow,
    body: { bien_id: Number(bienId), libelle: 'Interdit', montant: 1000, categorie: 'autre' },
  });
  if (depWrite.status === 403) {
    r.pass(S, 'espace délégué : création de dépense refusée (403)');
  } else {
    r.fail(S, 'espace délégué : création de dépense refusée (403)', `statut ${depWrite.status}`);
  }

  const depSans = await api('/mandat/depenses', { jar: sansMandat.jar });
  if (depSans.status === 404) {
    r.pass(S, 'depenses sans mandat → 404 (fail-closed)');
  } else {
    r.fail(S, 'depenses sans mandat → 404 (fail-closed)', `statut ${depSans.status}`);
  }

  // CRUD propriétaire HORS mandat : création, validation, suppression.
  const depCreate = await api('/depenses', {
    method: 'POST',
    jar: sansMandat.jar,
    body: { bien_id: sansMandat.bienId, libelle: 'Assurance habitation', montant: 25000, categorie: 'assurance', date_depense: '2026-10-01' },
  });
  if (depCreate.status === 201 && depCreate.data?.data?.id && depCreate.data?.data?.user_id === sansMandat.id) {
    r.pass(S, 'CRUD hors mandat : création d\'une dépense (201, user_id imposé)');
  } else {
    r.fail(S, 'CRUD hors mandat : création d\'une dépense (201, user_id imposé)', `statut ${depCreate.status} ${JSON.stringify(depCreate.data)}`);
  }

  const depNoLibelle = await api('/depenses', {
    method: 'POST',
    jar: sansMandat.jar,
    body: { bien_id: sansMandat.bienId, montant: 1000 },
  });
  if (depNoLibelle.status === 400 && depNoLibelle.data?.errors?.libelle) {
    r.pass(S, 'CRUD : libellé manquant → 400');
  } else {
    r.fail(S, 'CRUD : libellé manquant → 400', `statut ${depNoLibelle.status}`);
  }

  const depBadCategorie = await api('/depenses', {
    method: 'POST',
    jar: sansMandat.jar,
    body: { bien_id: sansMandat.bienId, libelle: 'X', montant: 1000, categorie: 'crypto' },
  });
  if (depBadCategorie.status === 400 && depBadCategorie.data?.errors?.categorie) {
    r.pass(S, 'CRUD : catégorie inconnue → 400');
  } else {
    r.fail(S, 'CRUD : catégorie inconnue → 400', `statut ${depBadCategorie.status}`);
  }

  const depMine = await api('/depenses', { jar: sansMandat.jar });
  const depMineRow = (depMine.data?.data || []).find((x) => x.id === depCreate.data?.data?.id);
  if (depMine.status === 200 && depMineRow && depMineRow.bien_id === sansMandat.bienId) {
    r.pass(S, 'CRUD : liste des dépenses du propriétaire');
  } else {
    r.fail(S, 'CRUD : liste des dépenses du propriétaire', `statut ${depMine.status} ${JSON.stringify(depMine.data?.data?.length)}`);
  }

  if (depCreate.status === 201) {
    const depDel = await api(`/depenses/${depCreate.data.data.id}`, { method: 'DELETE', jar: sansMandat.jar });
    if (depDel.status === 200) {
      r.pass(S, 'CRUD : suppression d\'une dépense');
    } else {
      r.fail(S, 'CRUD : suppression d\'une dépense', `statut ${depDel.status}`);
    }
  }

  // --- 5. Le shadow ne peut PAS créer de locataire/employé ---
  const createLoc = await api('/locataires', {
    method: 'POST',
    jar: jarShadow,
    body: { nom: 'Interdit', autoAccount: true },
  });
  if (createLoc.status === 403) {
    r.pass(S, 'espace délégué : création locataire refusée (403)');
  } else {
    r.fail(S, 'espace délégué : création locataire refusée (403)', `statut ${createLoc.status}`);
  }

  // --- 6. Confirmation du versement par le propriétaire ---
  const confirm = await api(`/mandat/versements/${versementId}/confirmer`, {
    method: 'POST',
    jar: jarShadow,
    body: { reference: 'VIR-MANDAT-1' },
  });
  if (confirm.status === 200 && confirm.data?.success) {
    r.pass(S, 'confirmation du versement par le propriétaire');
  } else {
    r.fail(S, 'confirmation du versement par le propriétaire', `statut ${confirm.status}`);
  }

  const { data: apres } = await service
    .from('versements')
    .select('statut, reference, effectue_par')
    .eq('id', versementId)
    .maybeSingle();
  if (apres?.statut === 'effectue' && apres.effectue_par === gere.user.id) {
    r.pass(S, 'versement marqué effectué par le bon propriétaire');
  } else {
    r.fail(S, 'versement marqué effectué par le bon propriétaire', JSON.stringify(apres));
  }

  const rejouer = await api(`/mandat/versements/${versementId}/confirmer`, {
    method: 'POST',
    jar: jarShadow,
    body: {},
  });
  if (rejouer.status === 409) {
    r.pass(S, 'double confirmation → 409');
  } else {
    r.fail(S, 'double confirmation → 409', `statut ${rejouer.status}`);
  }

  // --- 7. Messagerie ---
  const envoi = await api('/mandat/messages', {
    method: 'POST',
    jar: jarShadow,
    body: { objet: 'Question', corps: 'Bonjour, pouvez-vous m\'adresser le relevé ?' },
  });
  if (envoi.status === 201 && envoi.data?.success) {
    r.pass(S, 'envoi d\'un message à l\'agence');
  } else {
    r.fail(S, 'envoi d\'un message à l\'agence', `statut ${envoi.status}`);
  }

  const thread = await api('/mandat/messages', { jar: jarShadow });
  if (thread.status === 200 && (thread.data.messages || []).length === 1) {
    r.pass(S, 'liste des messages du mandat');
  } else {
    r.fail(S, 'liste des messages du mandat', JSON.stringify(thread.data?.messages?.length));
  }

  const vide = await api('/mandat/messages', {
    method: 'POST',
    jar: jarShadow,
    body: { corps: '   ' },
  });
  if (vide.status === 400) {
    r.pass(S, 'message vide → 400');
  } else {
    r.fail(S, 'message vide → 400', `statut ${vide.status}`);
  }

  // --- 8. Isolation : un AUTRE propriétaire ne voit pas ce mandat ---
  const autre = ctx.seed.owners[6];
  const intrusion = await api(`/mandat/versements/${versementId}/confirmer`, {
    method: 'POST',
    jar: autre.jar,
    body: {},
  });
  if (intrusion.status === 404) {
    r.pass(S, 'un autre propriétaire ne peut pas confirmer le versement (404)');
  } else {
    r.fail(S, 'un autre propriétaire ne peut pas confirmer le versement (404)', `statut ${intrusion.status}`);
  }

  // --- 9. Le propriétaire SANS mandat ne voit pas les versements d'autrui ---
  const listeSansMandat = await api('/mandat/versements', { jar: sansMandat.jar });
  if (listeSansMandat.status === 404) {
    r.pass(S, 'liste versements sans mandat → 404');
  } else {
    r.fail(S, 'liste versements sans mandat → 404', `statut ${listeSansMandat.status}`);
  }

  // --- 11. Côté agence : l'agence adresse un versement, le propriétaire confirme.
  const agenceJar = agence.jar;
  const createV = await api('/agence/versements', {
    method: 'POST',
    jar: agenceJar,
    body: { proprietaire_id: gere.user.id, montant: 120000, periode: '2026-09', methode_paiement: 'virement', reference: 'VIR-AG-1' },
  });
  if (createV.status === 201 && createV.data?.data?.montant === 120000) {
    r.pass(S, 'agence : versement adressé au propriétaire (120 000 XOF)');
  } else {
    r.fail(S, 'agence : versement adressé au propriétaire', `statut ${createV.status}`);
  }

  const agenceVersements = await api('/agence/versements', { jar: agenceJar });
  if (agenceVersements.status === 200 && (agenceVersements.data.versements || []).length >= 1) {
    r.pass(S, 'agence : liste de ses versements');
  } else {
    r.fail(S, 'agence : liste de ses versements', JSON.stringify(agenceVersements.data?.versements?.length));
  }

  // L'agence ne peut pas verser à un propriétaire hors portefeuille
  const horsPortefeuille = await api('/agence/versements', {
    method: 'POST',
    jar: agenceJar,
    body: { proprietaire_id: sansMandat.id, montant: 50000 },
  });
  if (horsPortefeuille.status === 403) {
    r.pass(S, 'agence : versement vers un propriétaire hors portefeuille refusé (403)');
  } else {
    r.fail(S, 'agence : versement vers un propriétaire hors portefeuille refusé (403)', `statut ${horsPortefeuille.status}`);
  }

  // Montant invalide
  const mauvaisMontant = await api('/agence/versements', {
    method: 'POST',
    jar: agenceJar,
    body: { proprietaire_id: gere.user.id, montant: -10 },
  });
  if (mauvaisMontant.status === 400) {
    r.pass(S, 'agence : montant négatif refusé (400)');
  } else {
    r.fail(S, 'agence : montant négatif refusé (400)', `statut ${mauvaisMontant.status}`);
  }

  // Messagerie agence -> propriétaire
  const msgA = await api('/agence/messages', {
    method: 'POST',
    jar: agenceJar,
    body: { proprietaire_id: gere.user.id, objet: 'Relevé', corps: 'Voici votre relevé de versements.' },
  });
  if (msgA.status === 201) {
    r.pass(S, 'agence : message envoyé au propriétaire');
  } else {
    r.fail(S, 'agence : message envoyé au propriétaire', `statut ${msgA.status}`);
  }

  const threadProprio = await api('/mandat/messages', { jar: jarShadow });
  if (threadProprio.status === 200 && (threadProprio.data.messages || []).length === 2) {
    r.pass(S, 'propriétaire voit les 2 messages (envoyés + reçus)');
  } else {
    r.fail(S, 'propriétaire voit les 2 messages (envoyés + reçus)', JSON.stringify(threadProprio.data?.messages?.length));
  }

  // --- 12. H-18 : révocation du mandat côté propriétaire ---
  const sansMotif = await api('/mandat/statut', {
    method: 'PATCH',
    jar: jarShadow,
    body: { statut: 'inactif' },
  });
  if (sansMotif.status === 400 && sansMotif.data?.errors?.motif) {
    r.pass(S, 'H-18 : révocation sans motif → 400');
  } else {
    r.fail(S, 'H-18 : révocation sans motif → 400', `statut ${sansMotif.status}`);
  }

  const statutInvalide = await api('/mandat/statut', {
    method: 'PATCH',
    jar: jarShadow,
    body: { statut: 'suspendu', motif: 'Test H-18' },
  });
  if (statutInvalide.status === 400) {
    r.pass(S, 'H-18 : statut invalide → 400');
  } else {
    r.fail(S, 'H-18 : statut invalide → 400', `statut ${statutInvalide.status}`);
  }

  const revoc = await api('/mandat/statut', {
    method: 'PATCH',
    jar: jarShadow,
    body: { statut: 'inactif', motif: 'Fin du mandat (test H-18)' },
  });
  if (revoc.status === 200 && revoc.data?.changed && revoc.data?.statut === 'inactif') {
    r.pass(S, 'H-18 : révocation par le propriétaire → 200');
  } else {
    r.fail(S, 'H-18 : révocation par le propriétaire → 200', `statut ${revoc.status} ${JSON.stringify(revoc.data)}`);
  }

  // Traçabilité : motif, horodatage et acteur sur la ligne de liaison.
  const { data: trace } = await service
    .from('agences_proprietaires')
    .select('statut, motif, revoque_par, updated_at')
    .eq('proprietaire_id', gere.user.id)
    .maybeSingle();
  if (trace?.statut === 'inactif' && trace?.motif && trace?.revoque_par === gere.user.id && trace?.updated_at) {
    r.pass(S, 'H-18 : liaison tracée (motif, horodatage, acteur)');
  } else {
    r.fail(S, 'H-18 : liaison tracée (motif, horodatage, acteur)', JSON.stringify(trace));
  }

  // Test recommandé du finding : toutes les routes scoped tombent en 403.
  const ctxRevoque = await api(`/agence/bien/${bienId}/contexte`, { jar: agenceJar });
  if (ctxRevoque.status === 403) {
    r.pass(S, 'H-18 : route scoped agence après révocation → 403');
  } else {
    r.fail(S, 'H-18 : route scoped agence après révocation → 403', `statut ${ctxRevoque.status}`);
  }

  const dashRevoque = await api('/mandat/dashboard', { jar: jarShadow });
  if (dashRevoque.status === 404 && dashRevoque.data?.code === 'MANDAT_NOT_FOUND') {
    r.pass(S, 'H-18 : espace délégué fermé après révocation (404)');
  } else {
    r.fail(S, 'H-18 : espace délégué fermé après révocation (404)', `statut ${dashRevoque.status}`);
  }

  const pfRevoque = await api('/agence/portefeuille', { jar: agenceJar });
  if (pfRevoque.status === 200 && (pfRevoque.data.data || []).length === 0) {
    r.pass(S, 'H-18 : portefeuille vide après révocation');
  } else {
    r.fail(S, 'H-18 : portefeuille vide après révocation', JSON.stringify(pfRevoque.data?.data?.length));
  }

  const statsRevoque = await api('/agence/stats', { jar: agenceJar });
  if (statsRevoque.status === 200 && statsRevoque.data?.stats?.totalBiens === 0) {
    r.pass(S, 'H-18 : statistiques sans les biens révoqués');
  } else {
    r.fail(S, 'H-18 : statistiques sans les biens révoqués', JSON.stringify(statsRevoque.data?.stats));
  }

  const vRevoque = await api('/agence/versements', {
    method: 'POST',
    jar: agenceJar,
    body: { proprietaire_id: gere.user.id, montant: 10000 },
  });
  if (vRevoque.status === 403) {
    r.pass(S, 'H-18 : écriture agence vers propriétaire révoqué → 403');
  } else {
    r.fail(S, 'H-18 : écriture agence vers propriétaire révoqué → 403', `statut ${vRevoque.status}`);
  }

  // Gouvernance : l'agence ne peut pas dérévoquer la décision du propriétaire.
  const reactAgence = await api(`/agence/proprietaires/${gere.user.id}/statut`, {
    method: 'PATCH',
    jar: agenceJar,
    body: { statut: 'actif', motif: 'Test H-18' },
  });
  if (reactAgence.status === 403 && reactAgence.data?.code === 'MANDAT_REVOKED_BY_OTHER') {
    r.pass(S, 'H-18 : l\'agence ne peut pas réactiver la révocation du propriétaire (403)');
  } else {
    r.fail(S, 'H-18 : l\'agence ne peut pas réactiver la révocation du propriétaire (403)', `statut ${reactAgence.status}`);
  }

  const reactProprio = await api('/mandat/statut', {
    method: 'PATCH',
    jar: jarShadow,
    body: { statut: 'actif', motif: 'Rétablissement (test H-18)' },
  });
  if (reactProprio.status === 200 && reactProprio.data?.statut === 'actif') {
    r.pass(S, 'H-18 : réactivation par le propriétaire → 200');
  } else {
    r.fail(S, 'H-18 : réactivation par le propriétaire → 200', `statut ${reactProprio.status}`);
  }

  const ctxRetabli = await api(`/agence/bien/${bienId}/contexte`, { jar: agenceJar });
  if (ctxRetabli.status === 200) {
    r.pass(S, 'H-18 : accès agence restaurés après réactivation');
  } else {
    r.fail(S, 'H-18 : accès agence restaurés après réactivation', `statut ${ctxRetabli.status}`);
  }

  // --- 13. H-18 : suspension côté agence (aller-retour) ---
  const susp = await api(`/agence/proprietaires/${gere.user.id}/statut`, {
    method: 'PATCH',
    jar: agenceJar,
    body: { statut: 'inactif', motif: 'Clôture provisoire (test H-18)' },
  });
  if (susp.status === 200 && susp.data?.changed && susp.data?.statut === 'inactif') {
    r.pass(S, 'H-18 : suspension par l\'agence → 200');
  } else {
    r.fail(S, 'H-18 : suspension par l\'agence → 200', `statut ${susp.status} ${JSON.stringify(susp.data)}`);
  }

  const ctxSuspendu = await api(`/agence/bien/${bienId}/contexte`, { jar: agenceJar });
  if (ctxSuspendu.status === 403) {
    r.pass(S, 'H-18 : route scoped après suspension → 403');
  } else {
    r.fail(S, 'H-18 : route scoped après suspension → 403', `statut ${ctxSuspendu.status}`);
  }

  // Gouvernance symétrique : le propriétaire ne peut pas réactiver
  // la suspension décidée par l'agence.
  const reactOwnerSurSusp = await api('/mandat/statut', {
    method: 'PATCH',
    jar: jarShadow,
    body: { statut: 'actif', motif: 'Test H-18' },
  });
  if (reactOwnerSurSusp.status === 403 && reactOwnerSurSusp.data?.code === 'MANDAT_REVOKED_BY_OTHER') {
    r.pass(S, 'H-18 : le propriétaire ne peut pas réactiver la suspension de l\'agence (403)');
  } else {
    r.fail(S, 'H-18 : le propriétaire ne peut pas réactiver la suspension de l\'agence (403)', `statut ${reactOwnerSurSusp.status}`);
  }

  const reprise = await api(`/agence/proprietaires/${gere.user.id}/statut`, {
    method: 'PATCH',
    jar: agenceJar,
    body: { statut: 'actif', motif: 'Reprise (test H-18)' },
  });
  if (reprise.status === 200 && reprise.data?.statut === 'actif') {
    r.pass(S, 'H-18 : l\'agence réactive sa propre suspension → 200');
  } else {
    r.fail(S, 'H-18 : l\'agence réactive sa propre suspension → 200', `statut ${reprise.status} ${JSON.stringify(reprise.data)}`);
  }

  const ctxRepris = await api(`/agence/bien/${bienId}/contexte`, { jar: agenceJar });
  if (ctxRepris.status === 200) {
    r.pass(S, 'H-18 : accès restaurés après reprise par l\'agence');
  } else {
    r.fail(S, 'H-18 : accès restaurés après reprise par l\'agence', `statut ${ctxRepris.status}`);
  }

  // Nettoyage
  await service.from('versements').delete().eq('id', versementId);
  await service.from('versements').delete().eq('agence_id', agence.user.id);
  await service.from('messages').delete().eq('proprietaire_id', gere.user.id);
  await service.from('paiements').delete().eq('user_id', gere.user.id);
  await service.from('locataires').delete().eq('user_id', gere.user.id);
  await service.from('interventions').delete().eq('user_id', gere.user.id);
  await service.from('incidents').delete().eq('user_id', gere.user.id);
  await service.from('prestataires').delete().eq('user_id', gere.user.id);
  await service.from('depenses').delete().eq('user_id', gere.user.id);
  await service.from('depenses').delete().eq('user_id', sansMandat.id);
  await service.from('agences_biens').delete().eq('proprietaire_id', gere.user.id);
  await service.from('agences_proprietaires').delete().eq('proprietaire_id', gere.user.id);
  await service.from('logements').delete().eq('user_id', gere.user.id);
  await service.from('biens').delete().eq('id', Number(bienId));
  await service.auth.admin.deleteUser(gere.user.id).catch(() => {});
  await service.auth.admin.deleteUser(agence.user.id).catch(() => {});
}
