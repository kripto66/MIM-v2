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
  const { error: lgErr } = await service.from('logements').insert({
    user_id: gere.user.id,
    bien_id: Number(bienId),
    nom: 'is_test Logement mandat',
    type: 'appartement',
    adresse: 'Rue mandat',
    loyer_mensuel: 120000,
    statut: 'libre',
  });
  if (lgErr) {
    r.blocked(S, 'création du logement du mandat', lgErr.message);
    return;
  }

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
  await service.from('agences_biens').delete().eq('proprietaire_id', gere.user.id);
  await service.from('agences_proprietaires').delete().eq('proprietaire_id', gere.user.id);
  await service.from('logements').delete().eq('user_id', gere.user.id);
  await service.from('biens').delete().eq('id', Number(bienId));
  await service.auth.admin.deleteUser(gere.user.id).catch(() => {});
  await service.auth.admin.deleteUser(agence.user.id).catch(() => {});
}
