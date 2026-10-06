// ============================================================
// MIM - Suite abonnement propriétaire
//
// L'abonnement Okarne GM est SÉPARÉ des paiements de loyer (table
// public.paiements) : les tests vérifient qu'aucun chevauchement
// n'existe, que l'état est toujours calculé côté serveur à partir
// de date_expiration, et que l'expiration bloque le propriétaire
// puis ses locataires/employés.
// ============================================================

import { api, newJar, expectSuccess, loginForBusiness } from './lib.js';

const S = 'abonnement';
const ADMIN_PASSWORD = 'Admin1234!';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Le cache serveur d'abonnement expire en ~2 s : après une écriture
// DIRECTE en base (service role), on attend un peu pour que le serveur
// de test recalcule l'état.
const CACHE_SLEEP_MS = 2600;

export async function runAbonnement(r, ctx) {
  const service = ctx.service;

  // Compte admin de test (comme la suite admin).
  const adminEmail = `admin.abonnement.${Date.now()}@mim.local`;
  const { data: created, error: adminError } = await service.auth.admin.createUser({
    email: adminEmail,
    password: ADMIN_PASSWORD,
    email_confirm: true,
    user_metadata: { name: 'Admin Abonnement' },
    app_metadata: { mim_account_type: 'admin' },
  });
  if (adminError) {
    r.fail(S, 'création compte admin', adminError.message);
    return;
  }
  await service.from('profiles').update({ account_type: 'admin', role: 'admin' }).eq('id', created.user.id);
  const adminJar = newJar();
  const adminLogin = await api('/auth/login', {
    method: 'POST',
    jar: adminJar,
    body: { identifier: adminEmail, password: ADMIN_PASSWORD },
  });
  if (adminLogin.status !== 200 || !adminLogin.data?.success) {
    r.fail(S, 'connexion admin', `statut ${adminLogin.status} ${JSON.stringify(adminLogin.data)}`);
    return;
  }
  r.pass(S, 'compte admin de test prêt');

  const owner = ctx.seed.owners[0];
  const other = ctx.seed.owners[1];
  const ownerJar = owner.jar;
  const otherJar = other.jar;
  const dbPaiementsBefore = (await service.from('paiements').select('id')).data.length;

  // ----------------------------------------------------------
  // 1. Héritage : un propriétaire sans abonnement payant garde l'accès.
  //    Depuis la migration 20261006100000_essai_30j_trial.sql, chaque
  //    inscription reçoit automatiquement 30 jours de plan « essai ».
  // ----------------------------------------------------------
  await r.section('abonnement : héritage (essai automatique)', async () => {
    const me = await api('/auth/me', { jar: otherJar });
    if (me.status === 200 && me.data?.success) r.pass(S, 'propriétaire sans abonnement → accès conservé');
    else r.fail(S, 'propriétaire sans abonnement → accès conservé', `statut ${me.status}`);

    const sub = await api('/subscription/me', { jar: otherJar });
    const jours = sub.data?.subscription?.joursRestants;
    if (
      expectSuccess(r, sub, S, '/subscription/me sans abonnement payant') &&
      sub.data.subscription?.planCode === 'essai' &&
      sub.data.subscription?.statut === 'actif' &&
      jours >= 29 &&
      jours <= 31
    ) {
      r.pass(S, 'sans abonnement payant → essai automatique actif (30 j)');
    } else {
      r.fail(S, 'sans abonnement payant → essai automatique actif (30 j)', JSON.stringify(sub.data));
    }
  });

  // ----------------------------------------------------------
  // 2. L'admin enregistre un paiement manuel reçu : l'abonnement est
  //    activé immédiatement (MIM n'encaisse rien).
  // ----------------------------------------------------------
  await r.section('abonnement : paiement manuel + activation immédiate', async () => {
    const res = await api('/admin/subscriptions/register', {
      method: 'POST',
      jar: adminJar,
      body: {
        userId: owner.id,
        plan: 'standard',
        montant: 100000,
        dureeMois: 12,
        methode_paiement: 'wave',
        reference: 'SUB-MANUAL-001',
      },
    });
    if (!expectSuccess(r, res, S, 'enregistrement du paiement manuel (register)')) return;

    const d = res.data.data;
    if (d.abonnementPaiementId && d.subscription?.statut === 'actif') {
      r.pass(S, 'paiement manuel enregistré → abonnement activé (statut actif)');
    } else {
      r.fail(S, 'paiement manuel enregistré → abonnement activé (statut actif)', JSON.stringify(d));
    }

    const me = await api('/subscription/me', { jar: ownerJar });
    if (me.data?.subscription?.statut === 'actif' && Number(me.data.subscription.montant) === 100000) {
      r.pass(S, 'le propriétaire voit son abonnement actif sans IPN');
    } else {
      r.fail(S, 'le propriétaire voit son abonnement actif sans IPN', JSON.stringify(me.data));
    }

    const hist = await service.from('abonnement_paiements').select('*').eq('user_id', owner.id);
    const row = (hist.data || []).find((h) => h.reference === 'SUB-MANUAL-001');
    if (row?.date_paiement && row?.methode_paiement === 'wave') {
      r.pass(S, 'paiement manuel horodaté + méthode wave + référence');
    } else {
      r.fail(S, 'paiement manuel horodaté + méthode wave + référence', JSON.stringify(row));
    }
  });

  // ----------------------------------------------------------
  // 3. Liste admin des abonnements.
  // ----------------------------------------------------------
  await r.section('abonnement : liste admin', async () => {
    const res = await api('/admin/subscriptions', { jar: adminJar });
    if (!expectSuccess(r, res, S, 'liste des abonnements')) return;
    const row = res.data.data.find((x) => x.user_id === owner.id);
    if (row && row.statut === 'actif' && row.proprietaire) r.pass(S, 'abonnement visible avec propriétaire');
    else r.fail(S, 'abonnement visible avec propriétaire', JSON.stringify(row));
  });

  // ----------------------------------------------------------
  // 4. L'abonnement apparaît sur la fiche propriétaire.
  // ----------------------------------------------------------
  await r.section('abonnement : fiche propriétaire (admin)', async () => {
    const res = await api('/admin/proprietaires', { jar: adminJar });
    if (!expectSuccess(r, res, S, 'liste des propriétaires')) return;
    const row = res.data.data.find((p) => p.id === owner.id);
    if (row?.subscription?.statut === 'actif') r.pass(S, 'subscription renseignée dans /admin/proprietaires');
    else r.fail(S, 'subscription renseignée dans /admin/proprietaires', JSON.stringify(row));
  });

  // ----------------------------------------------------------
  // 5. Renouvellement : prolonge à partir de l'échéance courante.
  // ----------------------------------------------------------
  await r.section('abonnement : renouvellement', async () => {
    const before = await api('/subscription/me', { jar: ownerJar });
    const exp1 = new Date(before.data?.subscription?.date_expiration).getTime();

    const res = await api('/admin/subscriptions/register', {
      method: 'POST',
      jar: adminJar,
      body: { userId: owner.id, montant: 10000, dureeMois: 1, methode_paiement: 'especes' },
    });
    if (!expectSuccess(r, res, S, 'renouvellement d\'un mois')) return;

    // Nouvelle échéance calculée côté serveur dès l'enregistrement.
    const pendingExp = new Date(res.data.data?.subscription?.date_expiration).getTime();
    const pendingDelta = (pendingExp - exp1) / 86400000;
    if (pendingDelta >= 27 && pendingDelta <= 32) r.pass(S, 'échéance calculée côté serveur dès l\'enregistrement (~1 mois)');
    else r.fail(S, 'échéance calculée côté serveur dès l\'enregistrement (~1 mois)', `delta ${pendingDelta.toFixed(1)} j`);

    const after = await api('/subscription/me', { jar: ownerJar });
    const exp2 = new Date(after.data?.subscription?.date_expiration).getTime();
    const delta = (exp2 - exp1) / 86400000;
    if (delta >= 27 && delta <= 32) r.pass(S, `échéance prolongée de ~1 mois (${delta.toFixed(1)} j)`);
    else r.fail(S, 'échéance prolongée de ~1 mois', `delta ${delta.toFixed(1)} j`);
  });

  // ----------------------------------------------------------
  // 6 + 7. Expiration → le login RENOUVELABLE est autorisé (l'abonné
  //         se reconnecte pour payer en ligne), les routes métier
  //         restent bloquées (les locataires d'un autre propriétaire,
  //         eux, restent refusés au login).
  // ----------------------------------------------------------
  await r.section('abonnement : expiration du propriétaire', async () => {
    const { error } = await service
      .from('subscriptions')
      .update({ date_expiration: new Date(Date.now() - 86400000).toISOString() })
      .eq('user_id', owner.id);
    if (error) {
      r.fail(S, 'forçage expiration en base', error.message);
      return;
    }
    await sleep(CACHE_SLEEP_MS);

    // Le propriétaire expiré PEUT se reconnecter pour renouveler en ligne.
    const login = await api('/auth/login', {
      method: 'POST',
      jar: newJar(),
      body: { identifier: owner.email, password: owner.password },
    });
    if (login.status === 200) {
      r.pass(S, 'login propriétaire expiré → autorisé (renouvellement en ligne)');
    } else {
      r.fail(S, 'login propriétaire expiré → autorisé (renouvellement en ligne)', `statut ${login.status} ${JSON.stringify(login.data)}`);
    }

    // L'auto-service /subscription est disponible pendant l'expiration :
    // statut calculé côté serveur = 'expire', aucune autre route ne l'est.
    const sub = await api('/subscription/me', { jar: ownerJar });
    if (sub.status === 200 && sub.data?.subscription?.statut === 'expire') {
      r.pass(S, '/subscription/me disponible pendant l\'expiration → statut \'expire\'');
    } else {
      r.fail(S, '/subscription/me disponible pendant l\'expiration → statut \'expire\'', `statut ${sub.status} ${JSON.stringify(sub.data)}`);
    }

    const biens = await api('/biens', { jar: ownerJar });
    if (biens.status === 401 && ['ACCOUNT_SUSPENDED', 'SUBSCRIPTION_EXPIRED'].includes(biens.data?.code)) {
      r.pass(S, 'session existante → route métier 401');
    } else {
      r.fail(S, 'session existante → route métier 401', `statut ${biens.status} ${JSON.stringify(biens.data)}`);
    }
  });

  // ----------------------------------------------------------
  // 8. Dépendant locataire : login bloqué quand le propriétaire expire.
  // ----------------------------------------------------------
  await r.section('abonnement : dépendant locataire', async () => {
    const { data: activeTenants = [] } = await service
      .from('locataires')
      .select('username')
      .eq('user_id', owner.id)
      .eq('statut', 'actif')
      .not('account_uid', 'is', null)
      .is('superseded_at', null)
      .limit(1);
    const tenant = activeTenants[0] || owner.locataires[0];
    const tenantIdentifier = tenant?.username || ctx.seed.owners[0].locataires[0].username;

    const tenantSession = await loginForBusiness(tenantIdentifier, 'Test1234!');
    const login = tenantSession.login;
    // Le compte locataire est suspendu avec le propriétaire → login refusé (401 générique).
    if (login.status === 401 && login.data?.code === 'INVALID_CREDENTIALS') {
      r.pass(S, 'login locataire (propriétaire expiré) → refusé (401, anti-énumération)');
    } else {
      r.fail(S, 'login locataire (propriétaire expiré) → refusé (401, anti-énumération)', `statut ${login.status} ${JSON.stringify(login.data)}`);
    }
  });

  // ----------------------------------------------------------
  // 9. Réactivation : l'admin réenregistre → accès de nouveau OK.
  // ----------------------------------------------------------
  await r.section('abonnement : réactivation', async () => {
    const res = await api('/admin/subscriptions/register', {
      method: 'POST',
      jar: adminJar,
      body: { userId: owner.id, montant: 150000, dureeMois: 12, methode_paiement: 'virement' },
    });
    if (!expectSuccess(r, res, S, 'réenregistrement (réactivation)')) return;

    const login = await api('/auth/login', {
      method: 'POST',
      jar: newJar(),
      body: { identifier: owner.email, password: owner.password },
    });
    if (login.status === 200) r.pass(S, 'propriétaire réactivé → login OK');
    else r.fail(S, 'propriétaire réactivé → login OK', `statut ${login.status}`);

    const biens = await api('/biens', { jar: ownerJar });
    if (biens.status === 200) r.pass(S, 'réactivation → route métier de nouveau OK');
    else r.fail(S, 'réactivation → route métier de nouveau OK', `statut ${biens.status}`);
  });

  // ----------------------------------------------------------
  // 10. Isolation : un autre propriétaire reste actif.
  // ----------------------------------------------------------
  await r.section('abonnement : isolation entre propriétaires', async () => {
    await service
      .from('subscriptions')
      .update({ date_expiration: new Date(Date.now() - 86400000).toISOString() })
      .eq('user_id', owner.id);
    await sleep(CACHE_SLEEP_MS);

    const me = await api('/auth/me', { jar: otherJar });
    if (me.status === 200) r.pass(S, 'l\'autre propriétaire reste connecté');
    else r.fail(S, 'l\'autre propriétaire reste connecté', `statut ${me.status}`);

    const biens = await api('/biens', { jar: otherJar });
    if (biens.status === 200) r.pass(S, 'l\'autre propriétaire accède à ses données');
    else r.fail(S, 'l\'autre propriétaire accède à ses données', `statut ${biens.status}`);

    const blocked = await api('/biens', { jar: ownerJar });
    if (blocked.status === 401) r.pass(S, 'le propriétaire expiré reste bloqué');
    else r.fail(S, 'le propriétaire expiré reste bloqué', `statut ${blocked.status}`);
  });

  // ----------------------------------------------------------
  // 11. Séparation stricte : les paiements de loyers sont intacts.
  // ----------------------------------------------------------
  await r.section('abonnement : séparation d\'avec les loyers', async () => {
    const dbPaiementsAfter = (await service.from('paiements').select('id')).data.length;
    if (dbPaiementsAfter === dbPaiementsBefore) r.pass(S, 'aucun paiement de loyer créé/supprimé par l\'abonnement');
    else r.fail(S, 'aucun paiement de loyer créé/supprimé par l\'abonnement', `${dbPaiementsBefore} → ${dbPaiementsAfter}`);

    const adminPays = await api('/admin/paiements', { jar: adminJar });
    if (adminPays.data?.data?.length === dbPaiementsBefore) r.pass(S, 'liste admin des paiements = loyers inchangés');
    else r.fail(S, 'liste admin des paiements = loyers inchangés', `API=${adminPays.data?.data?.length} base=${dbPaiementsBefore}`);

    const me = await api('/subscription/me', { jar: ownerJar });
    const keys = Object.keys(me.data?.subscription || {});
     const noLoyer = !keys.some((k) => /loyer|paiements/i.test(k));
    if (noLoyer) r.pass(S, '/subscription/me ne contient aucune donnée de loyer');
    else r.fail(S, '/subscription/me ne contient aucune donnée de loyer', keys.join(','));
  });

  // ----------------------------------------------------------
  // 12. Sécurité : aucune écriture client, rôles restreints.
  // ----------------------------------------------------------
  await r.section('abonnement : sécurité (aucune écriture client)', async () => {
    const ownerPost = await api('/subscription/register', {
      method: 'POST',
      jar: ownerJar,
      body: { userId: owner.id, montant: 1, dureeMois: 1 },
    });
    // Aucun enregistrement public : la route n'existe pas (404) ou exige une
// authentification (401) — dans les deux cas, le client ne peut pas s'inscrire.
    if (ownerPost.status === 404 || ownerPost.status === 401) r.pass(S, 'aucun enregistrement public de subscription (404/401)');
    else r.fail(S, 'aucun enregistrement public de subscription (404/401)', `statut ${ownerPost.status}`);

    // `other` (propriétaire actif, sans abonnement) doit être refusé par
    // le rôle admin (403), et non bloqué pour cause d'abonnement (401).
    const ownerList = await api('/admin/subscriptions', { jar: otherJar });
    if (ownerList.status === 403) r.pass(S, 'un propriétaire ne peut pas lister les abonnements (403)');
    else r.fail(S, 'un propriétaire ne peut pas lister les abonnements (403)', `statut ${ownerList.status}`);

    const ownerCrud = await api('/subscriptions', { jar: otherJar });
    if (ownerCrud.status === 404) r.pass(S, 'pas de CRUD public sur /subscriptions (404)');
    else r.fail(S, 'pas de CRUD public sur /subscriptions (404)', `statut ${ownerCrud.status}`);

    // Un locataire d'un autre propriétaire (actif) ne peut pas lire
    // l'abonnement : route réservée aux propriétaires (403).
    const { data: activeOtherTenants = [] } = await service
      .from('locataires')
      .select('username')
      .eq('user_id', other.id)
      .eq('statut', 'actif')
      .not('account_uid', 'is', null)
      .is('superseded_at', null)
      .limit(1);
    const tenant = activeOtherTenants[0];
    const tenantSession = await loginForBusiness(tenant?.username || other.locataires[0].username, 'Test1234!');
    const tenantJar = tenantSession.jar;
    const tenantLogin = tenantSession.login;
    if (tenantLogin.status === 200) {
      const sub = await api('/subscription/me', { jar: tenantJar });
      if (sub.status === 403) r.pass(S, 'un locataire ne peut pas lire l\'abonnement (403)');
      else r.fail(S, 'un locataire ne peut pas lire l\'abonnement (403)', `statut ${sub.status}`);
    } else {
      r.fail(S, 'connexion locataire pour la vérification de rôle', `statut ${tenantLogin.status} ${JSON.stringify(tenantLogin.data)}`);
    }
  });

  // ----------------------------------------------------------
  // 13. Nettoyage de fin : on réactive owner (la section 10 l'a laissé
  //     expiré). Les suites suivantes de la campagne complète l'utilisent.
  // ----------------------------------------------------------
  await r.section('abonnement : réactivation de fin (nettoyage)', async () => {
    const res = await api('/admin/subscriptions/register', {
      method: 'POST',
      jar: adminJar,
      body: { userId: owner.id, montant: 150000, dureeMois: 12, methode_paiement: 'wave' },
    });
    if (!expectSuccess(r, res, S, 'réactivation de fin')) return;

    const login = await api('/auth/login', {
      method: 'POST',
      jar: newJar(),
      body: { identifier: owner.email, password: owner.password },
    });
    if (login.status === 200) r.pass(S, 'owner réactivé pour les suites suivantes');
    else r.fail(S, 'owner réactivé pour les suites suivantes', `statut ${login.status}`);
  });

  // ----------------------------------------------------------
  // 14. Essai gratuit 30 jours (mode promo).
  //     Le flag vit dans system_config 'plan_trial_mode' (repli env
  //     PLAN_TRIAL_MODE du serveur de test = '0') : il est activé
  //     ici puis retiré en fin de section pour ne pas perturber les
  //     suites suivantes (cache serveur ~2 s → sleeps dédiés).
  // ----------------------------------------------------------
  await r.section('abonnement : essai gratuit 30 jours', async () => {
    const setFlag = async (value) => {
      if (value === null) {
        await service.from('system_config').delete().eq('key', 'plan_trial_mode');
      } else {
        await service
          .from('system_config')
          .upsert({ key: 'plan_trial_mode', value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
      }
      await sleep(CACHE_SLEEP_MS);
    };

    try {
      await setFlag('1');

      // Compte dédié : l'inscription déclenche l'essai automatique
      // (30 j + trial_used posé par le trigger).
      const trialEmail = `trial.30j.${Date.now()}@mim.local`;
      const { data: created, error: createError } = await service.auth.admin.createUser({
        email: trialEmail,
        password: 'Test1234!',
        email_confirm: true,
        user_metadata: { name: 'Trial 30j' },
        app_metadata: { mim_account_type: 'proprietaire' },
      });
      if (createError) {
        r.fail(S, 'essai : création du compte de test', createError.message);
        return;
      }
      await service.from('profiles').update({ account_type: 'proprietaire' }).eq('id', created.user.id);
      const trialJar = newJar();
      const trialLogin = await api('/auth/login', {
        method: 'POST',
        jar: trialJar,
        body: { identifier: trialEmail, password: 'Test1234!' },
      });
      if (trialLogin.status !== 200) {
        r.fail(S, 'essai : connexion du compte de test', `statut ${trialLogin.status}`);
        return;
      }

      // a) Inscription → fenêtre d'essai active, /plans signale le mode.
      const me1 = await api('/subscription/me', { jar: trialJar });
      const jours = me1.data?.subscription?.joursRestants;
      if (me1.data?.subscription?.planCode === 'essai' && jours >= 29 && jours <= 31) {
        r.pass(S, `essai : inscription → 30 jours (${jours} j)`);
      } else {
        r.fail(S, 'essai : inscription → 30 jours', JSON.stringify(me1.data));
      }

      const plans1 = await api('/subscription/plans', { jar: trialJar });
      const t1 = plans1.data?.trial;
      if (t1?.enabled && t1?.windowActive && t1?.eligible) {
        r.pass(S, 'essai : /plans signale enabled + windowActive');
      } else {
        r.fail(S, 'essai : /plans signale enabled + windowActive', JSON.stringify(t1));
      }

      // b) Changement de plan au sein de la fenêtre : échéance INTACTE.
      const expBefore = new Date(me1.data?.subscription?.date_expiration).getTime();
      const sw = await api('/subscription/trial', {
        method: 'POST',
        jar: trialJar,
        body: { plan: 'premium' },
      });
      const expAfter = sw.status === 201 ? new Date(sw.data?.date_expiration).getTime() : NaN;
      if (sw.status === 201 && sw.data?.switched === true && Math.abs(expAfter - expBefore) <= 1000) {
        r.pass(S, 'essai : changement de plan → échéance inchangée');
      } else {
        r.fail(S, 'essai : changement de plan → échéance inchangée', `statut ${sw.status} ${JSON.stringify(sw.data)}`);
      }
      const me2 = await api('/subscription/me', { jar: trialJar });
      if (me2.data?.subscription?.planCode === 'premium' && me2.data?.subscription?.trial?.windowActive) {
        r.pass(S, 'essai : plan premium actif + trial.windowActive côté /me');
      } else {
        r.fail(S, 'essai : plan premium actif + trial.windowActive côté /me', JSON.stringify(me2.data?.subscription));
      }

      // c) Le paiement est en pause pour un compte en essai.
      const co = await api('/subscription/checkout', {
        method: 'POST',
        jar: trialJar,
        body: { plan: 'standard' },
      });
      if (co.status === 409 && co.data?.code === 'TRIAL_MODE_ACTIVE') {
        r.pass(S, 'essai : checkout refusé (409 TRIAL_MODE_ACTIVE)');
      } else {
        r.fail(S, 'essai : checkout refusé (409 TRIAL_MODE_ACTIVE)', `statut ${co.status} ${JSON.stringify(co.data)}`);
      }

      // d) Un abonnement payant actif ne bascule jamais en essai.
      const paidTrial = await api('/subscription/trial', {
        method: 'POST',
        jar: ownerJar,
        body: { plan: 'standard' },
      });
      if (paidTrial.status === 409 && paidTrial.data?.code === 'SUBSCRIPTION_ACTIVE') {
        r.pass(S, 'essai : abonnement payant actif → refusé (409 SUBSCRIPTION_ACTIVE)');
      } else {
        r.fail(S, 'essai : abonnement payant actif → refusé (409 SUBSCRIPTION_ACTIVE)', `statut ${paidTrial.status} ${JSON.stringify(paidTrial.data)}`);
      }

      // e) Fenêtre expirée → plus d'essai, le paiement se réactive.
      await service
        .from('subscriptions')
        .update({ date_expiration: new Date(Date.now() - 86400000).toISOString() })
        .eq('user_id', created.user.id);
      await sleep(CACHE_SLEEP_MS);
      const again = await api('/subscription/trial', {
        method: 'POST',
        jar: trialJar,
        body: { plan: 'standard' },
      });
      if (again.status === 409 && again.data?.code === 'TRIAL_USED') {
        r.pass(S, 'essai : fenêtre expirée → plus aucun essai (409 TRIAL_USED)');
      } else {
        r.fail(S, 'essai : fenêtre expirée → plus aucun essai (409 TRIAL_USED)', `statut ${again.status} ${JSON.stringify(again.data)}`);
      }

      const co2 = await api('/subscription/checkout', {
        method: 'POST',
        jar: trialJar,
        body: { plan: 'standard' },
      });
      if (co2.status !== 409 && co2.data?.code !== 'TRIAL_MODE_ACTIVE') {
        r.pass(S, 'essai : après 30 j, checkout de nouveau ouvert (paiement réactivé)');
      } else {
        r.fail(S, 'essai : après 30 j, checkout de nouveau ouvert (paiement réactivé)', `statut ${co2.status} ${JSON.stringify(co2.data)}`);
      }
      // On neutralise l'éventuel paiement pending créé ci-dessus.
      await service
        .from('abonnement_paiements')
        .update({ statut: 'failed', updated_at: new Date().toISOString() })
        .eq('user_id', created.user.id)
        .eq('statut', 'pending');

      // f) Compte « legacy » (jamais de fenêtre, pas de paiement) :
      //    il peut démarrer une fenêtre de 30 jours neuve.
      const legacyEmail = `trial.legacy.${Date.now()}@mim.local`;
      const { data: legacyCreated, error: legacyError } = await service.auth.admin.createUser({
        email: legacyEmail,
        password: 'Test1234!',
        email_confirm: true,
        user_metadata: { name: 'Trial Legacy' },
        app_metadata: { mim_account_type: 'proprietaire' },
      });
      if (legacyError) {
        r.fail(S, 'essai : création du compte legacy', legacyError.message);
        return;
      }
      await service.from('profiles').update({ account_type: 'proprietaire', trial_used: false }).eq('id', legacyCreated.user.id);
      await service.from('subscriptions').delete().eq('user_id', legacyCreated.user.id);
      await sleep(CACHE_SLEEP_MS);
      const legacyJar = newJar();
      await api('/auth/login', {
        method: 'POST',
        jar: legacyJar,
        body: { identifier: legacyEmail, password: 'Test1234!' },
      });
      const fresh = await api('/subscription/trial', {
        method: 'POST',
        jar: legacyJar,
        body: { plan: 'standard' },
      });
      const freshExp = fresh.status === 201 ? (new Date(fresh.data?.date_expiration).getTime() - Date.now()) / 86400000 : NaN;
      if (fresh.status === 201 && fresh.data?.switched === false && freshExp >= 29 && freshExp <= 31) {
        r.pass(S, 'essai : compte legacy → fenêtre neuve de 30 jours');
      } else {
        r.fail(S, 'essai : compte legacy → fenêtre neuve de 30 jours', `statut ${fresh.status} ${JSON.stringify(fresh.data)}`);
      }
      const { data: legacyProfile } = await service.from('profiles').select('trial_used').eq('id', legacyCreated.user.id).maybeSingle();
      if (legacyProfile?.trial_used === true) r.pass(S, 'essai : trial_used posé au démarrage de la fenêtre');
      else r.fail(S, 'essai : trial_used posé au démarrage de la fenêtre', JSON.stringify(legacyProfile));

      // g) Mode promo OFF : /trial refusé, vitrine payante retrouvée.
      await setFlag('0');
      const off = await api('/subscription/trial', {
        method: 'POST',
        jar: trialJar,
        body: { plan: 'premium' },
      });
      if (off.status === 403 && off.data?.code === 'TRIAL_DISABLED') {
        r.pass(S, 'essai : flag OFF → /trial refusé (403 TRIAL_DISABLED)');
      } else {
        r.fail(S, 'essai : flag OFF → /trial refusé (403 TRIAL_DISABLED)', `statut ${off.status} ${JSON.stringify(off.data)}`);
      }
      const plansOff = await api('/subscription/plans', { jar: trialJar });
      if (plansOff.data?.trial?.enabled === false) {
        r.pass(S, 'essai : flag OFF → /plans trial.enabled = false');
      } else {
        r.fail(S, 'essai : flag OFF → /plans trial.enabled = false', JSON.stringify(plansOff.data?.trial));
      }
    } finally {
      // Nettoyage obligatoire : les suites suivantes (bictorys…)
      // s'attendent au paiement normal (env PLAN_TRIAL_MODE='0').
      await setFlag(null);
    }
  });

  // ----------------------------------------------------------
  // 15. Quotas PENDANT un essai : mêmes plafonds que le payant,
  //     pour un propriétaire ET pour une agence. Le système de
  //     quotas (RPC reserve_quota) lit uniquement plan_id et
  //     date_expiration — methode_paiement='essai' / montant=0
  //     ne doivent ouvrir aucune porte.
  // ----------------------------------------------------------
  await r.section("abonnement : quotas pendant l'essai", async () => {
    const setFlag = async (value) => {
      if (value === null) {
        await service.from('system_config').delete().eq('key', 'plan_trial_mode');
      } else {
        await service
          .from('system_config')
          .upsert({ key: 'plan_trial_mode', value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
      }
      await sleep(CACHE_SLEEP_MS);
    };

    const createAccount = async (prefix, accountType) => {
      const email = `${prefix}.${Date.now()}@mim.local`;
      const { data: created, error } = await service.auth.admin.createUser({
        email,
        password: 'Test1234!',
        email_confirm: true,
        user_metadata: { name: prefix },
        app_metadata: { mim_account_type: accountType },
      });
      if (error) return { error: error.message };
      await service.from('profiles').update({ account_type: accountType }).eq('id', created.user.id);
      const jar = newJar();
      const login = await api('/auth/login', {
        method: 'POST',
        jar,
        body: { identifier: email, password: 'Test1234!' },
      });
      if (login.status !== 200) return { error: `login ${login.status}` };
      return { jar, userId: created.user.id };
    };

    const createBien = (jar, nom) =>
      api('/biens', { method: 'POST', jar, body: { nom, type: 'maison', ville: 'Dakar' } });

    try {
      await setFlag('1');

      // --- Propriétaire : essai standard = 1 immeuble (comme un payant).
      const owner = await createAccount('quota.trial', 'proprietaire');
      if (owner.error) {
        r.fail(S, 'essai quotas : création du compte propriétaire', owner.error);
        return;
      }
      const start = await api('/subscription/trial', {
        method: 'POST',
        jar: owner.jar,
        body: { plan: 'standard' },
      });
      if (start.status === 201) r.pass(S, 'essai quotas : essai démarré sur standard');
      else {
        r.fail(S, 'essai quotas : essai démarré sur standard', `statut ${start.status} ${JSON.stringify(start.data)}`);
        return;
      }

      const me1 = await api('/subscription/me', { jar: owner.jar });
      const sub1 = me1.data?.subscription;
      if (sub1?.planCode === 'standard' && sub1?.max_immeubles === 1 && sub1?.trial?.windowActive) {
        r.pass(S, 'essai quotas : /me expose plafond standard (1) + fenêtre active');
      } else {
        r.fail(S, 'essai quotas : /me expose plafond standard (1) + fenêtre active', JSON.stringify(sub1));
      }

      const b1 = await createBien(owner.jar, 'Quota-Essai-1');
      const b2 = await createBien(owner.jar, 'Quota-Essai-2');
      if (b1.status === 201 && b2.status === 409 && b2.data?.code === 'IMMEUBLES_LIMIT_REACHED') {
        r.pass(S, 'essai quotas : standard → 1er bien OK, 2e bloqué (409 IMMEUBLES_LIMIT_REACHED)');
      } else {
        r.fail(
          S,
          'essai quotas : standard → 1er bien OK, 2e bloqué (409 IMMEUBLES_LIMIT_REACHED)',
          `b1=${b1.status} b2=${b2.status} ${JSON.stringify(b2.data)}`,
        );
      }
      await sleep(CACHE_SLEEP_MS);
      const me2 = await api('/subscription/me', { jar: owner.jar });
      const imp = me2.data?.subscription?.immeubles;
      // allowed = count <= max (l'état est « conforme au plafond ») : ici
      // on est exactement à la limite, le refus de création est prouvé
      // par le 409 ci-dessus.
      if (imp?.count === 1 && imp?.max === 1 && imp?.allowed === true) {
        r.pass(S, 'essai quotas : /me compte=1 max=1 (au plafond)');
      } else {
        r.fail(S, 'essai quotas : /me compte=1 max=1 (au plafond)', JSON.stringify(imp));
      }

      // --- Changement de plan dans la fenêtre : le plafond SUIT le plan.
      const sw = await api('/subscription/trial', {
        method: 'POST',
        jar: owner.jar,
        body: { plan: 'premium' },
      });
      const me3 = await api('/subscription/me', { jar: owner.jar });
      const max3 = me3.data?.subscription?.max_immeubles;
      if (sw.status === 201 && Number.isInteger(max3) && max3 > 1 && me3.data?.subscription?.planCode === 'premium') {
        r.pass(S, `essai quotas : passage en premium → plafond ${max3} (suivi du plan)`);
      } else {
        r.fail(S, 'essai quotas : passage en premium → plafond suivi du plan', `sw=${sw.status} max=${max3}`);
        return;
      }
      let createdCount = 0;
      let full = null;
      for (let i = createdCount; i < max3 - 1; i++) {
        const b = await createBien(owner.jar, `Quota-Essai-P${i + 2}`);
        if (b.status === 201) createdCount++;
        else { full = b; break; }
      }
      const extra = full || (await createBien(owner.jar, 'Quota-Essai-Overflow'));
      if (createdCount === max3 - 1 && extra.status === 409 && extra.data?.code === 'IMMEUBLES_LIMIT_REACHED') {
        r.pass(S, `essai quotas : premium → ${max3} biens puis 409 (plafond exact)`);
      } else {
        r.fail(S, 'essai quotas : premium → plafond exact puis 409', `created=${createdCount}/${max3 - 1} extra=${extra.status} ${JSON.stringify(extra.data)}`);
      }

      // --- Audience : un propriétaire ne touche jamais à un palier agence.
      const wrongAudience = await api('/subscription/trial', {
        method: 'POST',
        jar: owner.jar,
        body: { plan: 'agence_starter' },
      });
      if (wrongAudience.status === 400 && wrongAudience.data?.code === 'PLAN_INVALID') {
        r.pass(S, 'essai quotas : propriétaire → plan agence refusé (400 PLAN_INVALID)');
      } else {
        r.fail(S, 'essai quotas : propriétaire → plan agence refusé (400 PLAN_INVALID)', `statut ${wrongAudience.status} ${JSON.stringify(wrongAudience.data)}`);
      }

      // --- Agence : essai agence_starter = 10 biens, bloqué au 11e.
      const agence = await createAccount('quota.agence', 'agence');
      if (agence.error) {
        r.fail(S, 'essai quotas : création du compte agence', agence.error);
        return;
      }
      const startA = await api('/subscription/trial', {
        method: 'POST',
        jar: agence.jar,
        body: { plan: 'agence_starter' },
      });
      const meA = await api('/subscription/me', { jar: agence.jar });
      const subA = meA.data?.subscription;
      if (startA.status === 201 && subA?.planCode === 'agence_starter' && subA?.max_immeubles === 10) {
        r.pass(S, 'essai quotas : agence → essai agence_starter (plafond 10)');
      } else {
        r.fail(S, 'essai quotas : agence → essai agence_starter (plafond 10)', `start=${startA.status} sub=${JSON.stringify(subA)}`);
        return;
      }
      let aCreated = 0;
      let aFull = null;
      for (let i = 0; i < 10; i++) {
        const b = await createBien(agence.jar, `Quota-Agence-${i + 1}`);
        if (b.status === 201) aCreated++;
        else { aFull = b; break; }
      }
      const aExtra = aFull || (await createBien(agence.jar, 'Quota-Agence-Overflow'));
      if (aCreated === 10 && aExtra.status === 409 && aExtra.data?.code === 'IMMEUBLES_LIMIT_REACHED') {
        r.pass(S, 'essai quotas : agence → 10 biens puis 409 (plafond exact)');
      } else {
        r.fail(S, 'essai quotas : agence → 10 biens puis 409 (plafond exact)', `created=${aCreated} extra=${aExtra.status} ${JSON.stringify(aExtra.data)}`);
      }

      // --- Audience inversée : une agence ne touche jamais à un palier propriétaire.
      const wrongA = await api('/subscription/trial', {
        method: 'POST',
        jar: agence.jar,
        body: { plan: 'standard' },
      });
      if (wrongA.status === 400 && wrongA.data?.code === 'PLAN_INVALID') {
        r.pass(S, 'essai quotas : agence → plan propriétaire refusé (400 PLAN_INVALID)');
      } else {
        r.fail(S, 'essai quotas : agence → plan propriétaire refusé (400 PLAN_INVALID)', `statut ${wrongA.status} ${JSON.stringify(wrongA.data)}`);
      }
    } finally {
      await setFlag(null);
    }
  });
}
