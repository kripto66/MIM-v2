// ============================================================
// MIM - Suite abonnement propriétaire
//
// L'abonnement MIM est SÉPARÉ des paiements de loyer (table
// public.paiements) : les tests vérifient qu'aucun chevauchement
// n'existe, que l'état est toujours calculé côté serveur à partir
// de date_expiration, et que l'expiration bloque le propriétaire
// puis ses locataires/employés.
// ============================================================

import { api, newJar, expectSuccess } from './lib.js';

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
    user_metadata: { account_type: 'admin', name: 'Admin Abonnement', role: 'admin' },
  });
  if (adminError) {
    r.fail(S, 'création compte admin', adminError.message);
    return;
  }
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
  // 1. Héritage : un propriétaire sans abonnement garde l'accès.
  // ----------------------------------------------------------
  await r.section('abonnement : héritage (aucun abonnement)', async () => {
    const me = await api('/auth/me', { jar: otherJar });
    if (me.status === 200 && me.data?.success) r.pass(S, 'propriétaire sans abonnement → accès conservé');
    else r.fail(S, 'propriétaire sans abonnement → accès conservé', `statut ${me.status}`);

    const sub = await api('/subscription/me', { jar: otherJar });
    if (expectSuccess(r, sub, S, '/subscription/me sans abonnement') && sub.data.subscription === null) {
      r.pass(S, 'sans abonnement → subscription null');
    } else {
      r.fail(S, 'sans abonnement → subscription null', JSON.stringify(sub.data));
    }
  });

  // ----------------------------------------------------------
  // 2. L'admin enregistre un paiement d'abonnement.
  // ----------------------------------------------------------
  await r.section('abonnement : enregistrement par l\'admin', async () => {
    const res = await api('/admin/subscriptions/register', {
      method: 'POST',
      jar: adminJar,
      body: {
        userId: owner.id,
        plan: 'standard',
        montant: 100000,
        dureeMois: 12,
        methodePaiement: 'especes',
        reference: 'TEST-ABO-001',
      },
    });
    if (!expectSuccess(r, res, S, 'enregistrement paiement abonnement')) return;

    const sub = res.data.subscription;
    if (sub.statut === 'actif' && sub.joursRestants > 300) r.pass(S, 'échéance future calculée côté serveur');
    else r.fail(S, 'échéance future calculée côté serveur', JSON.stringify(sub));

    const me = await api('/subscription/me', { jar: ownerJar });
    if (me.data?.subscription?.statut === 'actif' && Number(me.data.subscription.montant) === 100000) {
      r.pass(S, 'le propriétaire voit son abonnement actif');
    } else {
      r.fail(S, 'le propriétaire voit son abonnement actif', JSON.stringify(me.data));
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
      body: { userId: owner.id, montant: 10000, dureeMois: 1 },
    });
    if (!expectSuccess(r, res, S, 'renouvellement d\'un mois')) return;

    const after = await api('/subscription/me', { jar: ownerJar });
    const exp2 = new Date(after.data?.subscription?.date_expiration).getTime();
    const delta = (exp2 - exp1) / 86400000;
    if (delta >= 27 && delta <= 32) r.pass(S, `échéance prolongée de ~1 mois (${delta.toFixed(1)} j)`);
    else r.fail(S, 'échéance prolongée de ~1 mois', `delta ${delta.toFixed(1)} j`);
  });

  // ----------------------------------------------------------
  // 6 + 7. Expiration → login bloqué + routes métier bloquées.
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

    const login = await api('/auth/login', {
      method: 'POST',
      jar: newJar(),
      body: { identifier: owner.email, password: owner.password },
    });
    if (login.status === 403 && login.data?.code === 'ACCOUNT_SUSPENDED') {
      r.pass(S, 'login propriétaire expiré → 403 ACCOUNT_SUSPENDED');
    } else {
      r.fail(S, 'login propriétaire expiré → 403 ACCOUNT_SUSPENDED', `statut ${login.status} ${JSON.stringify(login.data)}`);
    }

    const biens = await api('/biens', { jar: ownerJar });
    if (biens.status === 401 && biens.data?.code === 'ACCOUNT_SUSPENDED') {
      r.pass(S, 'session existante → route métier 401 ACCOUNT_SUSPENDED');
    } else {
      r.fail(S, 'session existante → route métier 401 ACCOUNT_SUSPENDED', `statut ${biens.status}`);
    }

    const sub = await api('/subscription/me', { jar: ownerJar });
    if (sub.data?.subscription?.statut === 'expire' && sub.data.subscription.joursRestants === 0) {
      r.pass(S, '/subscription/me reste accessible et affiche "expire"');
    } else {
      r.fail(S, '/subscription/me reste accessible et affiche "expire"', JSON.stringify(sub.data));
    }
  });

  // ----------------------------------------------------------
  // 8. Dépendant locataire : login bloqué quand le propriétaire expire.
  // ----------------------------------------------------------
  await r.section('abonnement : dépendant locataire', async () => {
    const tenant = owner.locataires[0];
    const tenantIdentifier = tenant?.username || 'own1loc1';

    const login = await api('/auth/login', {
      method: 'POST',
      jar: newJar(),
      body: { identifier: tenantIdentifier, password: 'Test1234!' },
    });
    if (login.status === 403 && login.data?.code === 'ACCOUNT_SUSPENDED') {
      r.pass(S, 'login locataire (propriétaire expiré) → 403 ACCOUNT_SUSPENDED');
    } else {
      r.fail(S, 'login locataire (propriétaire expiré) → 403 ACCOUNT_SUSPENDED', `statut ${login.status} ${JSON.stringify(login.data)}`);
    }
  });

  // ----------------------------------------------------------
  // 9. Réactivation : l'admin réenregistre → accès de nouveau OK.
  // ----------------------------------------------------------
  await r.section('abonnement : réactivation', async () => {
    const res = await api('/admin/subscriptions/register', {
      method: 'POST',
      jar: adminJar,
      body: { userId: owner.id, montant: 150000, dureeMois: 12 },
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
    const noLoyer = !keys.some((k) => /locataire|logement|loyer|paiement/i.test(k));
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
    if (ownerPost.status === 404) r.pass(S, 'aucun endpoint public d\'enregistrement (404)');
    else r.fail(S, 'aucun endpoint public d\'enregistrement (404)', `statut ${ownerPost.status}`);

    const ownerList = await api('/admin/subscriptions', { jar: ownerJar });
    if (ownerList.status === 403) r.pass(S, 'un propriétaire ne peut pas lister les abonnements (403)');
    else r.fail(S, 'un propriétaire ne peut pas lister les abonnements (403)', `statut ${ownerList.status}`);

    const ownerCrud = await api('/subscriptions', { jar: ownerJar });
    if (ownerCrud.status === 404) r.pass(S, 'pas de CRUD public sur /subscriptions (404)');
    else r.fail(S, 'pas de CRUD public sur /subscriptions (404)', `statut ${ownerCrud.status}`);

    // Un locataire d'un autre propriétaire (actif) ne peut pas lire
    // l'abonnement : route réservée aux propriétaires (403).
    const tenant = other.locataires[0];
    const tenantLogin = await api('/auth/login', {
      method: 'POST',
      jar: newJar(),
      body: { identifier: tenant?.username || 'own2loc1', password: 'Test1234!' },
    });
    if (tenantLogin.status === 200) {
      const tenantJar = tenantLogin.jar;
      const sub = await api('/subscription/me', { jar: tenantJar });
      if (sub.status === 403) r.pass(S, 'un locataire ne peut pas lire l\'abonnement (403)');
      else r.fail(S, 'un locataire ne peut pas lire l\'abonnement (403)', `statut ${sub.status}`);
    } else {
      r.fail(S, 'connexion locataire pour la vérification de rôle', `statut ${tenantLogin.status}`);
    }
  });
}
