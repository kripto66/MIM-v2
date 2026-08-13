// ============================================================
// MIM - Suite admin : rôle administrateur, données globales,
// protection d'accès et suspension de comptes
// ============================================================

import { api, newJar, expectSuccess } from './lib.js';

const S = 'admin';
const ADMIN_PASSWORD = 'Admin1234!';

export async function runAdmin(r, ctx) {
  const service = ctx.service;
  const adminEmail = `admin.test.${Date.now()}@mim.local`;

  // Crée le compte admin de test via le service role (le déclencheur
  // handle_new_user crée le profil avec account_type='admin').
  const { data: created, error } = await service.auth.admin.createUser({
    email: adminEmail,
    password: ADMIN_PASSWORD,
    email_confirm: true,
    user_metadata: { account_type: 'admin', name: 'Admin Test', role: 'admin' },
  });

  if (error) {
    r.fail(S, 'création compte admin', error.message);
    return;
  }
  r.pass(S, 'création compte admin (service role)');

  const adminId = created.user.id;
  const adminJar = newJar();

  await r.section('admin : protection des routes', async () => {
    const anon = await api('/admin/stats');
    if (anon.status === 401) r.pass(S, 'non authentifié → 401');
    else r.fail(S, 'non authentifié → 401', `statut ${anon.status}`);

    const owner = await api('/admin/stats', { jar: ctx.seed.owners[0].jar });
    if (owner.status === 403) r.pass(S, 'propriétaire → 403 (rôle refusé)');
    else r.fail(S, 'propriétaire → 403 (rôle refusé)', `statut ${owner.status}`);
  });

  await r.section('admin : connexion et redirection', async () => {
    const login = await api('/auth/login', {
      method: 'POST',
      jar: adminJar,
      body: { identifier: adminEmail, password: ADMIN_PASSWORD },
    });
    if (login.status !== 200 || !login.data?.success) {
      r.fail(S, 'connexion admin', `statut ${login.status} ${JSON.stringify(login.data)}`);
      return;
    }
    r.pass(S, 'connexion admin');

    if (login.data.redirect === 'PartAdmin/admin.html') {
      r.pass(S, 'redirection vers PartAdmin/admin.html');
    } else {
      r.fail(S, 'redirection vers PartAdmin/admin.html', `reçu ${login.data.redirect}`);
    }

    const me = await api('/auth/me', { jar: adminJar });
    if (me.data?.user?.account_type === 'admin') r.pass(S, '/auth/me renvoie account_type=admin');
    else r.fail(S, '/auth/me renvoie account_type=admin', JSON.stringify(me.data));
  });

  const month = ctx.seed.month;

  await r.section('admin : statistiques globales', async () => {
    const res = await api('/admin/stats', { jar: adminJar });
    if (!expectSuccess(r, res, S, 'statistiques admin')) return;

    const s = res.data.stats;
    const checks = [
      ['propriétaires = 10', s.proprietaires, 10],
      ['locataires = 100', s.locataires, 100],
      ['biens = 10', s.biens, 10],
      ['logements = 100', s.logements, 100],
      ['logements occupés = 0 (seed libre)', s.logementsOccupes, 0],
      ['paiements en attente = 50', s.paiementsEnAttente, 50],
      ['paiements en retard ce mois = 0', s.paiementsEnRetard, 0],
      ['incidents actifs = 10', s.incidentsActifs, 10],
      ['interventions actives = 10', s.interventionsActives, 10],
      ['12 mois de revenus', s.revenue12.length, 12],
    ];

    for (const [name, got, want] of checks) {
      if (got === want) r.pass(S, name);
      else r.fail(S, name, `reçu ${got} (attendu ${want})`);
    }

    const sum12 = s.revenue12.reduce((acc, m) => acc + m.total, 0);
    if (Math.abs(sum12 - s.revenusMois) < 0.01) {
      r.pass(S, `revenus 12 mois cohérents (= ${s.revenusMois})`);
    } else {
      r.fail(S, 'revenus 12 mois cohérents', `somme=${sum12} mois=${s.revenusMois}`);
    }

    // Revenus attendus = loyers des logements occupés... mais le seed laisse
    // les logements libres → revenus payés = paiements 'paye' du mois.
    if (s.revenusMois > 0) r.pass(S, `revenus du mois > 0 (${s.revenusMois})`);
    else r.fail(S, 'revenus du mois > 0', `reçu ${s.revenusMois}`);
  });

  await r.section('admin : listes globales', async () => {
    const prop = await api('/admin/proprietaires', { jar: adminJar });
    if (expectSuccess(r, prop, S, 'propriétaires')) {
      if (prop.data.data.length === 10) r.pass(S, '10 propriétaires');
      else r.fail(S, '10 propriétaires', `reçu ${prop.data.data.length}`);
      const allOneBien = prop.data.data.every((p) => p.biens === 1);
      if (allOneBien) r.pass(S, 'chaque propriétaire a 1 bien');
      else r.fail(S, 'chaque propriétaire a 1 bien', JSON.stringify(prop.data.data.slice(0, 2)));
      if (prop.data.data.every((p) => p.statut === 'actif')) r.pass(S, 'tous les propriétaires actifs');
      else r.fail(S, 'tous les propriétaires actifs');
    }

    const locs = await api('/admin/locataires', { jar: adminJar });
    if (expectSuccess(r, locs, S, 'locataires')) {
      if (locs.data.data.length === 100) r.pass(S, '100 locataires');
      else r.fail(S, '100 locataires', `reçu ${locs.data.data.length}`);
      const linked = locs.data.data.every((l) => l.logement !== '—');
      if (linked) r.pass(S, 'locataires reliés à un logement');
      else r.fail(S, 'locataires reliés à un logement');
    }

    const biens = await api('/admin/biens', { jar: adminJar });
    if (expectSuccess(r, biens, S, 'biens')) {
      if (biens.data.data.length === 10) r.pass(S, '10 biens');
      else r.fail(S, '10 biens', `reçu ${biens.data.data.length}`);
      if (biens.data.data.every((b) => b.logements === 10)) r.pass(S, 'chaque bien a 10 logements');
      else r.fail(S, 'chaque bien a 10 logements');
    }

    const pays = await api('/admin/paiements', { jar: adminJar });
    if (expectSuccess(r, pays, S, 'paiements')) {
      if (pays.data.data.length >= 100) r.pass(S, `paiements visibles (${pays.data.data.length})`);
      else r.fail(S, 'paiements visibles', `reçu ${pays.data.data.length}`);
    }

    const incs = await api('/admin/incidents', { jar: adminJar });
    if (expectSuccess(r, incs, S, 'incidents')) {
      if (incs.data.data.length === 20) r.pass(S, '20 incidents');
      else r.fail(S, '20 incidents', `reçu ${incs.data.data.length}`);
    }

    const act = await api('/admin/activite', { jar: adminJar });
    if (expectSuccess(r, act, S, 'activité')) {
      if (act.data.data.length >= 10) r.pass(S, `journal d'activité rempli (${act.data.data.length})`);
      else r.fail(S, "journal d'activité rempli", `reçu ${act.data.data.length}`);
    }
  });

  await r.section('admin : suspension / réactivation', async () => {
    const target = ctx.seed.owners[0];
    const badJar = newJar();

    const suspend = await api(`/admin/proprietaires/${target.id}`, {
      method: 'PATCH',
      jar: adminJar,
      body: { statut: 'suspendu' },
    });
    if (expectSuccess(r, suspend, S, 'suspension compte')) {
      r.pass(S, 'suspension compte');
    }

    const banned = await api('/auth/login', {
      method: 'POST',
      jar: badJar,
      body: { identifier: target.email, password: target.password },
    });
    if (banned.status === 401) r.pass(S, 'compte suspendu → login refusé (401)');
    else r.fail(S, 'compte suspendu → login refusé (401)', `statut ${banned.status}`);

    const activate = await api(`/admin/proprietaires/${target.id}`, {
      method: 'PATCH',
      jar: adminJar,
      body: { statut: 'actif' },
    });
    if (expectSuccess(r, activate, S, 'réactivation compte')) {
      r.pass(S, 'réactivation compte');
    }

    const ok = await api('/auth/login', {
      method: 'POST',
      jar: newJar(),
      body: { identifier: target.email, password: target.password },
    });
    if (ok.status === 200) r.pass(S, 'compte réactivé → login OK');
    else r.fail(S, 'compte réactivé → login OK', `statut ${ok.status}`);

    const prop = await api('/admin/proprietaires', { jar: adminJar });
    const me = prop.data?.data?.find((p) => p.id === target.id);
    if (me?.statut === 'actif') r.pass(S, 'statut reflété actif');
    else r.fail(S, 'statut reflété actif', JSON.stringify(me));
  });

  // Le profil admin de test garde l'ID pour vérification éventuelle.
  return { adminId, adminEmail };
}
