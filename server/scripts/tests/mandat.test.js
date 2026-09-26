// ============================================================
// MIM - Suite « mandat » : espace propriétaire délégué
//   * le propriétaire avec mandat actif est redirigé vers son espace
//   * GET /mandat/dashboard reflète le parc et les versements
//   * confirmation d'un versement par le propriétaire
//   * messagerie propriétaire <-> agence
//   * un propriétaire SANS mandat ne peut pas utiliser ces routes
//   * isolation : un propriétaire ne voit jamais le mandat d'un autre
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
