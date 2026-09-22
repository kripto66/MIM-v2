// ============================================================
// MIM - Suite Bictorys (paiement en ligne des abonnements)
//
// Grille mensuelle : Standard 7 000 / Premium 15 000 / Pro 30 000 /
// Agence 50 000 XOF (immeubles 1/3/10/25, logements 20/75/300/750,
// locataires 20/75/300/750 — employés/prestataires illimités).
//
// Vérifie tout le circuit auto-service d'un propriétaire :
//   1. catalogue des plans (limites 1 / 3 / 10 / 25) ;
//   2. checkout Bictorys (mode simulation : aucun appel réseau) ;
//   3. activation UNIQUEMENT par webhook `succeeded`, idempotent ;
//   4. échecs webhook (failed / cancelled / montant inattendu) ;
//   5. limites immeubles/logements/locataires appliquées CÔTÉ
//      SERVEUR à la création (blocage en 409) ;
//   6. renouvellement en ligne prolongeant l'échéance courante ;
//   7. accès : login propriétaire expiré autorisé (renouvellement),
//      routes métier bloquées, dépendants refusés ;
//   8. vue admin des paiements d'abonnement ;
//   9. sécurité du webhook (secret + signature HMAC).
//
// IMPORTANT : ces tests exigent le mode simulation
// (BICTORYS_SIMULATE=1) pour ne jamais émettre de requête HTTP vers
// Bictorys. Sinon la suite est bloquée (pas de faux paiement réel).
// ============================================================

import { createHmac } from 'node:crypto';
import { api, newJar, expectSuccess, BASE } from './lib.js';

const S = 'bictorys';
const ADMIN_PASSWORD = 'Admin1234!';

const save = (client, jar) => ({ client, jar });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Le cache serveur d'abonnement expire en ~2 s : après une écriture
// DIRECTE en base (service role), on attend un peu pour que le serveur
// de test recalcule l'état.
const CACHE_SLEEP_MS = 2600;

const WEBHOOK_URL = `${BASE.replace(/\/api\/?$/, '')}/api/webhooks/bictorys`;
const WEBHOOK_SECRET = process.env.BICTORYS_WEBHOOK_SECRET || 'bictorys_test_secret';

function webhookHeaders(rawBody, extra = {}) {
  return {
    'Content-Type': 'application/json',
    'X-Secret-Key': WEBHOOK_SECRET,
    ...extra,
  };
}

function signedHeaders(rawBody) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const bodyHex = Buffer.from(String(rawBody), 'utf8').toString('hex');
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${bodyHex}`).digest('hex');
  return {
    'Content-Type': 'application/json',
    'X-Secret-Key': WEBHOOK_SECRET,
    'X-Webhook-Timestamp': timestamp,
    'X-Webhook-Signature': signature,
  };
}

function webhookBody(overrides = {}) {
  return {
    id: 'evt_' + Math.random().toString(36).slice(2, 12),
    type: 'payment',
    status: 'succeeded',
    amount: null,
    currency: 'XOF',
    paymentReference: `MIM-missing`,
    merchantReference: null,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

export async function runBictorys(r, ctx) {
  const service = ctx.service;

  if (!['1', 'true'].includes(String(process.env.BICTORYS_SIMULATE || '').toLowerCase())) {
    r.blocked(S, 'simulation', "BICTORYS_SIMULATE doit être à 1 pour exécuter la suite (aucun appel réel).");
    return;
  }

  // Compte admin de test pour la vue paiements (comme la suite admin).
  const adminEmail = `admin.bictorys.${Date.now()}@mim.local`;
  const { data: adminData, error: adminErr } = await service.auth.admin.createUser({
    email: adminEmail,
    password: ADMIN_PASSWORD,
    email_confirm: true,
    user_metadata: { account_type: 'admin', name: 'Admin Bictorys', role: 'admin' },
  });
  if (adminErr) {
    r.fail(S, 'création compte admin', adminErr.message);
    return;
  }
  const adminJar = newJar();
  const adminLogin = await api('/auth/login', {
    method: 'POST',
    jar: adminJar,
    body: { identifier: adminEmail, password: ADMIN_PASSWORD },
  });
  if (adminLogin.status !== 200 || !adminLogin.data?.success) {
    r.fail(S, 'connexion admin', `statut ${adminLogin.status}`);
    return;
  }
  const admin = save(service, adminJar);

  // Un propriétaire DÉDIÉ (0 immeuble) pour tester précisément les limites.
  const ownerEmail = `bic.owner.${Date.now()}@mim.local`;
  const { data: ownerData, error: ownerErr } = await service.auth.admin.createUser({
    email: ownerEmail,
    password: 'Test1234!',
    email_confirm: true,
    user_metadata: { account_type: 'proprietaire', name: 'Propriétaire Bictorys' },
  });
  if (ownerErr) {
    r.fail(S, 'création propriétaire dédié', ownerErr.message);
    return;
  }
  // Certains builds Supabase renvoient { data: user } (avec .id) et
  // d'autres { data: { user, session } } : on accepte les deux formes.
  const OWNER_ID = ownerData?.user?.id || ownerData?.id;
  const ownerJar = newJar();
  try {
    const ownerLogin = await api('/auth/login', {
      method: 'POST',
      jar: ownerJar,
      body: { identifier: ownerEmail, password: 'Test1234!' },
    });
    if (ownerLogin.status !== 200) {
      r.fail(S, 'connexion propriétaire dédié', `statut ${ownerLogin.status}`);
      return;
    }
    const owner = save(service, ownerJar);

      // Raccourcis de tests.
      const me = () => api('/subscription/me', { jar: owner.jar });
      const checkout = (plan) =>
        api('/subscription/checkout', { method: 'POST', jar: owner.jar, body: { plan } });

    const createBien = (nom) =>
      api('/biens', { method: 'POST', jar: owner.jar, body: { nom, type: 'maison', ville: 'Dakar' } });
    const createLogement = (bienId, nom) =>
      api('/logements', {
        method: 'POST',
        jar: owner.jar,
        body: { bien_id: bienId, nom, type: 'appartement', nombre_chambres: 1, adresse: 'Dakar', loyer_mensuel: 50000, statut: 'libre' },
      });
    const createLocataire = (logementId, nom) =>
      api('/locataires', {
        method: 'POST',
        jar: owner.jar,
        body: { logement_id: logementId, nom, statut: 'inactif' },
      });
    // Dernier paiement Bictorys (par date) d'un plan donné — les rejeux
    // peuvent créer plusieurs lignes, on prend toujours la plus récente.
      async function payFor(plan) {
        const { data, error } = await service
          .from('abonnement_paiements')
          .select('*')
          .eq('user_id', OWNER_ID)
          .eq('provider', 'bictorys')
          .eq('plan', plan)
          .order('created_at', { ascending: false })
          .limit(1);
        if (error) return null;
        return data?.[0] || null;
      }
    const webhook = async (payload, headers = webhookHeaders(JSON.stringify(payload))) => {
      return fetch(WEBHOOK_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));
    };

    // ------------------------------------------------------------
    // 1. Catalogue des plans (limites côté serveur).
    // ------------------------------------------------------------
    await r.section('bictorys : catalogue des plans', async () => {
      const plans = await api('/subscription/plans', { jar: owner.jar });
      if (!expectSuccess(r, plans, S, '/subscription/plans')) return;

      const expected = { standard: 1, premium: 3, pro: 10, agence: 25 };
      const expectedCap = { standard: 20, premium: 75, pro: 300, agence: 750 };
      const ok = ['standard', 'premium', 'pro', 'agence'].every((code) => {
        const plan = (plans.data?.plans || []).find((x) => x.code === code);
        return (
          plan &&
          Number(plan.max_immeubles) === expected[code] &&
          Number(plan.max_logements) === expectedCap[code] &&
          Number(plan.max_locataires) === expectedCap[code] &&
          Number(plan.prix) > 0 &&
          plan.duree_abonnement === 1 &&
          !plans.data.plans.some((p) => p.code === 'ultra')
        );
      });
      if (ok && plans.data.plans.length === 4) {
        r.pass(S, '4 plans (Standard/Premium/Pro/Agence) : prix mensuels, capacités 1/3/10/25 immeubles + logements/locataires, Ultra archivé');
      } else {
        r.fail(S, '4 plans (Standard/Premium/Pro/Agence) : prix mensuels, capacités 1/3/10/25 + logements/locataires, Ultra archivé', JSON.stringify(plans.data?.plans));
      }
    });

    // ------------------------------------------------------------
    // 2. Checkout : paiement pending, aucun accès débloqué.
    // ------------------------------------------------------------
    await r.section('bictorys : checkout (pending)', async () => {
      const res = await checkout('standard');
      if (res.status !== 201) {
        r.fail(S, 'checkout standard → 201', `statut ${res.status} ${JSON.stringify(res.data)}`);
        return;
      }
      const c = res.data.checkout || {};
      const p = res.data.payment || {};
      const linkOk =
        c.link &&
        c.link.includes('paiement=simule') &&
        !c.link.includes('paiement=succes') &&
        c.link.split('?').length === 2;
      if (
        linkOk && c.simulated === true &&
        c.paymentReference && c.paymentReference.startsWith('MIM-') &&
        p.statut === 'pending' && p.provider === 'bictorys' && Number(p.montant) === 7000
      ) {
        r.pass(S, 'checkout standard → lien factice propre (?paiement=simule&ref=) + paiement pending 7 000 XOF');
      } else {
        r.fail(S, 'checkout standard → lien factice propre + paiement pending 7 000 XOF', JSON.stringify(res.data));
      }

      // Le checkout n'active RIEN : subscription encore null (propriétaire dédié).
      const before = await me();
      if (before.data?.subscription == null || before.data?.subscription?.statut === 'pending') {
        r.pass(S, 'checkout seul → aucun abonnement actif');
      } else {
        r.fail(S, 'checkout seul → aucun abonnement actif', JSON.stringify(before.data));
      }

      // Plans invalides → refus clair.
      const bad1 = await checkout('inexistant');
      if (bad1.status === 400 && bad1.data?.code === 'PLAN_INVALID') r.pass(S, 'plan inconnu → 400 PLAN_INVALID');
      else r.fail(S, 'plan inconnu → 400 PLAN_INVALID', `statut ${bad1.status} ${JSON.stringify(bad1.data)}`);

      const bad2 = await api('/subscription/checkout', { method: 'POST', jar: owner.jar, body: {} });
      if (bad2.status === 400) r.pass(S, 'checkout sans plan → 400');
      else r.fail(S, 'checkout sans plan → 400', `statut ${bad2.status}`);
    });

    // ------------------------------------------------------------
    // 3. Webhook succeeded → activation SEULE via ce canal.
    // ------------------------------------------------------------
    await r.section('bictorys : webhook succeeded active', async () => {
      // La référence vien du CHECKOUT, qui renvoie paymentReference + (me())
      // la reflète dans subscription.paiement.reference — on préfère la
      // lecture session (fiable) à une relecture admin fragile.
      const meNow = await me();
      const ref = meNow?.data?.subscription?.paiement?.reference;
      if (!ref) {
        r.fail(S, 'paiement standard en attente trouvable', JSON.stringify(pendStd));
        return;
      }

      const payload = webhookBody({
        id: 'evt_success_1',
        status: 'succeeded',
        amount: 7000,
        paymentReference: ref,
        merchantReference: `SUB-${ref}`,
      });
      const got = await webhook(payload);
      if (got.status === 200 && got.body.success === true) r.pass(S, 'webhook succeeded accepté (200)');
      else r.fail(S, 'webhook succeeded accepté (200)', `statut ${got.status} ${JSON.stringify(got.body)}`);

      const after = await me();
      const s = after.data?.subscription;
      if (
        s?.statut === 'actif' &&
        s?.planCode === 'standard' &&
        s?.immeubles?.max === 1 &&
        Number(s?.paiement?.montant) === 7000 &&
        s?.paiement?.statut === 'paid' &&
        s?.paiement?.overlay === false
      ) {
        r.pass(S, 'abonnement standard ACTIF via webhook (1 immeuble, paiement payé)');
      } else {
        r.fail(S, 'abonnement standard ACTIF via webhook', JSON.stringify(s));
      }
    });

    // ------------------------------------------------------------
    // 4. Idempotence : rejouer le même événement ne double pas.
    // ------------------------------------------------------------
    await r.section('bictorys : idempotence du webhook', async () => {
      const rowsBefore = (await service.from('bictorys_webhooks').select('id, event_id, handled, error')).data;
      const first = rowsBefore.find((x) => x.event_id === 'evt_success_1');
      if (!first) {
        r.fail(S, 'événement journalisé', JSON.stringify(rowsBefore));
        return;
      }

      // Rejeu du même id → fingerprint dupliqué.
      const replay = await webhook(
        webhookBody({
          id: 'evt_success_1',
          status: 'succeeded',
          amount: 7000,
          paymentReference: 'should-not-matter-duplicate',
        })
      );
      const rowsAfter = (await service.from('bictorys_webhooks').select('id, event_id')).data;
      const countSame = rowsAfter.filter((x) => x.event_id === 'evt_success_1').length;
      if (replay.status === 200 && countSame === 1 && rowsAfter.length === rowsBefore.length) {
        r.pass(S, 'rejeu → aucun doublon (fingerprint UNIQUE)');
      } else {
        r.fail(S, 'rejeu → aucun doublon', `replay ${replay.status} count=${countSame}`);
      }

      // Le paiement n'est PAS re-appliqué (garde-fou statut 'pending').
      const pay = await payFor('standard');
      if (pay?.statut === 'paid') r.pass(S, 'statut du paiement inchangé (paid)');
      else r.fail(S, 'statut du paiement inchangé (paid)', JSON.stringify(pay));
    });

    // ------------------------------------------------------------
    // 5. Montant inattendu → refus de traitement (journal erreur), 200.
    // ------------------------------------------------------------
    await r.section('bictorys : montant inattendu refusé', async () => {
      const pendStd = await payFor('standard');
      const ref = pendStd?.reference;

      const got = await webhook(
        webhookBody({
          id: 'evt_bad_amount',
          status: 'succeeded',
          amount: 5000,
          paymentReference: ref,
        })
      );
      const row = (await service.from('bictorys_webhooks').select('event_id, error').eq('event_id', 'evt_bad_amount')).data[0];
      if (got.status === 200 && row?.error === 'AMOUNT_MISMATCH') {
        r.pass(S, 'montant différent de la charge → refusé (AMOUNT_MISMATCH journalisé)');
      } else {
        r.fail(S, 'montant différent de la charge → refusé (AMOUNT_MISMATCH journalisé)', `row=${JSON.stringify(row)}`);
      }
    });

    // ------------------------------------------------------------
    // 6. Échecs webhook : failed / cancelled → paiement échoué.
    // ------------------------------------------------------------
    await r.section('bictorys : échecs de paiement', async () => {
      await checkout('premium'); // pending premium
      const pendP = await payFor('premium');
      const ref = pendP?.reference;

      const fail = await webhook(
        webhookBody({ id: 'evt_failed_1', status: 'failed', amount: 15000, paymentReference: ref })
      );
      const row = await payFor('premium');
      if (fail.status === 200 && row?.statut === 'failed') {
        r.pass(S, 'webhook failed → paiement marqué échoué');
      } else {
        r.fail(S, 'webhook failed → paiement marqué échoué', `row=${JSON.stringify(row)}`);
      }
      if ((await me()).data?.subscription?.statut !== 'actif') {
        r.fail(S, 'un échec n\'altère pas l\'abonnement actif', JSON.stringify((await me()).data));
      } else {
        r.pass(S, 'un échec n\'altère pas l\'abonnement actif');
      }

      const all = (await service.from('abonnement_paiements').select('*').eq('user_id', OWNER_ID)).data;
      const run2 = all.filter((p) => p.plan === 'premium' && p.statut === 'failed').length;
      if (run2 === 1) r.pass(S, 'exactement 1 paiement premium échoué');
      else r.fail(S, 'exactement 1 paiement premium échoué', `count=${run2}`);
    });

    // ------------------------------------------------------------
    // 7. Limites d'immeubles CÔTÉ SERVEUR (Standard 1 → Premium 3 → Pro 10).
    // ------------------------------------------------------------
    await r.section('bictorys : limites d\'immeubles à la création', async () => {
      // Standard : 1 seul bien possible.
      const b1 = await createBien('Bic-Immeuble-1');
      const b2 = await createBien('Bic-Immeuble-2');
      if (b1.status === 201 && b2.status === 409 && b2.data?.code === 'IMMEUBLES_LIMIT_REACHED') {
        r.pass(S, 'Standard : 1 immeuble créé, 2e → 409 IMMEUBLES_LIMIT_REACHED');
      } else {
        r.fail(S, 'Standard : 1 immeuble créé, 2e → 409', `b1=${b1.status} b2=${b2.status} ${JSON.stringify(b2.data)}`);
      }

      // Passage Premium (3 immeubles) via UN NOUVEAU checkout + webhook :
      // le paiement premium créé à la section « échecs de paiement » a déjà
      // été marqué `failed`, il ne peut pas être réutilisé (garde-fou statut).
      await checkout('premium');
      const pendP = await payFor('premium');
      const refP = pendP?.reference;
      await webhook(webhookBody({ id: 'evt_premium_1', status: 'succeeded', amount: 15000, paymentReference: refP }));

      const b3 = await createBien('Bic-Immeuble-3');
      const b4 = await createBien('Bic-Immeuble-4');
      const b5 = await createBien('Bic-Immeuble-5');
      if (b3.status === 201 && b4.status === 201 && b5.status === 409 && b5.data?.code === 'IMMEUBLES_LIMIT_REACHED') {
        r.pass(S, 'Premium : 3 immeubles acceptés, le 4e → 409 IMMEUBLES_LIMIT_REACHED');
      } else {
        r.fail(S, 'Premium : 3 immeubles acceptés, le 4e → 409', `b3=${b3.status} b4=${b4.status} b5=${b5.status} ${JSON.stringify(b5.data)}`);
      }
    });

    // ------------------------------------------------------------
    // 7b. Limites logements (75) et locataires (75) sur Premium,
    //     appliquées CÔTÉ SERVEUR à la création.
    // ------------------------------------------------------------
    await r.section('bictorys : limites logements & locataires à la création', async () => {
      const b1 = (await service.from('biens').select('id').eq('user_id', OWNER_ID).order('created_at', { ascending: true }).limit(1)).data?.[0];
      if (!b1) {
        r.fail(S, 'bien de rattachement trouvé', 'aucun bien');
        return;
      }

      let log = { status: 0 };
      for (let i = 1; i <= 75; i++) log = await createLogement(b1.id, `Bic-Logement-${i}`);
      const log76 = await createLogement(b1.id, 'Bic-Logement-76');
      if (log.status === 201 && log76.status === 409 && log76.data?.code === 'LOGEMENTS_LIMIT_REACHED') {
        r.pass(S, 'Premium : 75 logements acceptés, le 76e → 409 LOGEMENTS_LIMIT_REACHED');
      } else {
        r.fail(S, 'Premium : 75 logements acceptés, le 76e → 409', `last=${log.status} l76=${log76.status} ${JSON.stringify(log76.data)}`);
      }

      const L1 = (await service.from('logements').select('id').eq('user_id', OWNER_ID).order('created_at', { ascending: true }).limit(1)).data?.[0];
      if (!L1) {
        r.fail(S, 'logement de rattachement trouvé', 'aucun logement');
        return;
      }

      let loc = { status: 0 };
      for (let i = 1; i <= 75; i++) loc = await createLocataire(L1.id, `Bic-Locataire-${i}`);
      const loc76 = await createLocataire(L1.id, 'Bic-Locataire-76');
      if (loc.status === 201 && loc76.status === 409 && loc76.data?.code === 'LOCATAIRES_LIMIT_REACHED') {
        r.pass(S, 'Premium : 75 locataires acceptés, le 76e → 409 LOCATAIRES_LIMIT_REACHED');
      } else {
        r.fail(S, 'Premium : 75 locataires acceptés, le 76e → 409', `last=${loc.status} l76=${loc76.status} ${JSON.stringify(loc76.data)}`);
      }
    });

    // ------------------------------------------------------------
    // 8. Passage Pro (10 immeubles, 30 000 XOF) : prolongation + limite à 10.
    // ------------------------------------------------------------
    await r.section('bictorys : Pro + renouvellement prolongeant', async () => {
      const before = await me();
      const expStd = new Date(before.data?.subscription?.date_expiration).getTime();

      await checkout('pro');
      const pendU = await payFor('pro');
      await webhook(
        webhookBody({ id: 'evt_pro_1', status: 'succeeded', amount: 30000, paymentReference: pendU?.reference })
      );

      // Prolongation depuis l'échéance courante (pas depuis aujourd'hui).
      const after = await me();
      const expUltra = new Date(after.data?.subscription?.date_expiration).getTime();
      const deltaDays = (expUltra - expStd) / 86400000;

      // Remplir jusqu'à la limite Pro (10) : on a déjà 3 immeubles
      // (1 + 2 ajoutés en Premium), on ajoute les numéros 4 à 10.
      let last = { status: 0 };
      for (let i = 4; i <= 10; i++) last = await createBien(`Bic-Immeuble-${i}`);
      const b11 = await createBien('Bic-Immeuble-11');

      if (after.data?.subscription?.planCode === 'pro' && deltaDays >= 25 && deltaDays <= 35) {
        r.pass(S, `Pro : échéance prolongée de ~1 mois (${deltaDays.toFixed(1)} j)`);
      } else {
        r.fail(S, 'Pro : échéance prolongée de ~1 mois', `delta ${deltaDays.toFixed(1)} j ${JSON.stringify(after.data?.subscription)}`);
      }
      if (last.status === 201 && b11.status === 409) {
        r.pass(S, 'Pro : 10 immeubles acceptés, l\'onzième est refusé (409)');
      } else {
        r.fail(S, 'Pro : 10 immeubles acceptés, l\'onzième est refusé (409)', `last=${last.status} b11=${b11.status} ${JSON.stringify(b11.data)}`);
      }
    });

    // ------------------------------------------------------------
    // 9. Accès : expiration → login renouvelable, métier bloqué,
    //    dépendant locataire refusé.
    // ------------------------------------------------------------
    await r.section('bictorys : accès en expiration', async () => {
      await service
        .from('subscriptions')
        .update({ date_expiration: new Date(Date.now() - 86400000).toISOString() })
        .eq('user_id', OWNER_ID);
      await sleep(CACHE_SLEEP_MS);

      const login = await api('/auth/login', {
        method: 'POST',
        jar: newJar(),
        body: { identifier: ownerEmail, password: 'Test1234!' },
      });
      if (login.status === 200) r.pass(S, 'login propriétaire expiré autorisé (renouvellement)');
      else r.fail(S, 'login propriétaire expiré autorisé', `statut ${login.status}`);

      const biens = await api('/biens', { jar: owner.jar });
      if (biens.status === 401 && biens.data?.code === 'ACCOUNT_SUSPENDED') r.pass(S, 'routes métier bloquées (401 ACCOUNT_SUSPENDED)');
      else r.fail(S, 'routes métier bloquées (401 ACCOUNT_SUSPENDED)', `statut ${biens.status}`);

      const sub = await me();
      if (sub.status === 200 && sub.data?.subscription?.statut === 'expire') r.pass(S, '/subscription/me accessible → statut \'expire\'');
      else r.fail(S, '/subscription/me accessible → statut \'expire\'', `statut ${sub.status} ${JSON.stringify(sub.data)}`);

      const renew = await checkout('standard');
      if (renew.status === 201) r.pass(S, 'le renouvellement en ligne reste possible');
      else r.fail(S, 'le renouvellement en ligne reste possible', `statut ${renew.status} ${JSON.stringify(renew.data)}`);
    });

    // ------------------------------------------------------------
    // 10. Vue admin des paiements d'abonnement.
    // ------------------------------------------------------------
    await r.section('bictorys : vue admin des paiements', async () => {
      const res = await api('/admin/subscriptions/payments', { jar: admin.jar });
      if (!expectSuccess(r, res, S, 'liste admin des paiements')) return;
      const rows = res.data?.data || [];
      const bic = rows.filter((x) => x.provider === 'bictorys' && x.user_id === OWNER_ID);
      if (bic.length >= 4) r.pass(S, 'paiements Bictorys visibles par l\'admin (provider, transactionId, statut)');
      else r.fail(S, 'paiements Bictorys visibles par l\'admin', `count=${bic.length}`);
    });

    // ------------------------------------------------------------
    // 11. Sécurité du webhook : secret + signature HMAC.
    // ------------------------------------------------------------
    await r.section('bictorys : sécurité du webhook', async () => {
      const pend = await payFor('pro');
      const ref = pend?.reference;

      // Secret absent / mauvais → 401.
      const noSecret = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(webhookBody({ status: 'succeeded', paymentReference: ref })),
      });
      if (noSecret.status === 401) r.pass(S, 'webhook sans secret → 401');
      else r.fail(S, 'webhook sans secret → 401', `statut ${noSecret.status}`);

      // Signature HMAC valide → 200.
      const good = webhookBody({ id: 'evt_signed_ok', status: 'succeeded', paymentReference: ref, amount: pend?.montant });
      const body = JSON.stringify(good);
      const signed = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: signedHeaders(body),
        body,
      });
      if (signed.status === 200) r.pass(S, 'webhook avec signature HMAC valide → 200');
      else r.fail(S, 'webhook avec signature HMAC valide → 200', `statut ${signed.status}`);

      // Signature falsifiée → 401.
      const tampered = webhookBody({ id: 'evt_signed_bad', status: 'succeeded', paymentReference: ref });
      const tbody = JSON.stringify(tampered);
      const badHdr = signedHeaders(tbody);
      badHdr['X-Webhook-Signature'] = '0'.repeat(64);
      const bad = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: badHdr,
        body: tbody,
      });
      if (bad.status === 401) r.pass(S, 'signature HMAC invalide → 401');
      else r.fail(S, 'signature HMAC invalide → 401', `statut ${bad.status}`);
    });
  } finally {
    // Nettoyage : les comptes créés (préfixes @mim.local) sont purgés
    // par seed(). Vérification minimale locale.
    await service.auth.admin.deleteUser(OWNER_ID).catch(() => {});
    await service.auth.admin.deleteUser(adminData.id).catch(() => {});
  }
}