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

    const postNotif = await api('/notifications', {
      method: 'POST',
      jar: ctx.seed.owners[0].jar,
      body: { type: 'info', message: 'intrusion', lu: false },
    });
    if (postNotif.status === 404) r.pass(S, 'création de notification via CRUD refusée (404)');
    else r.fail(S, 'création de notification via CRUD refusée (404)', `statut ${postNotif.status}`);
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

  // ----------------------------------------------------------
  // Attentes dynamiques : les suites précédentes créent des
  // comptes / modifient des statuts → on compare à la base réelle.
  // ----------------------------------------------------------
  const db = {
    proprietaires: (await service.from('profiles').select('id').in('account_type', ['proprietaire', 'agence', 'entreprise'])).data.length,
    locataires: (await service.from('locataires').select('id')).data.length,
    biens: (await service.from('biens').select('id')).data.length,
    logements: (await service.from('logements').select('id')).data.length,
    logementsOccupes: (await service.from('logements').select('id').eq('statut', 'occupe')).data.length,
    incidents: (await service.from('incidents').select('id')).data.length,
    incidentsActifs: (await service.from('incidents').select('id').neq('statut', 'resolu')).data.length,
    interventionsActives: (await service.from('interventions').select('id').neq('statut', 'termine')).data.length,
    paiements: (await service.from('paiements').select('id')).data.length,
    paiementsMois: (await service.from('paiements').select('montant, statut').eq('mois', month)).data,
  };

  db.paiementsEnAttente = db.paiementsMois.filter((p) => p.statut === 'attente').length;
  db.paiementsEnRetard = db.paiementsMois.filter((p) => p.statut === 'retard').length;
  db.revenusMois = db.paiementsMois.filter((p) => p.statut === 'paye').reduce((s, p) => s + Number(p.montant), 0);

  await r.section('admin : statistiques globales', async () => {
    const res = await api('/admin/stats', { jar: adminJar });
    if (!expectSuccess(r, res, S, 'statistiques admin')) return;

    const s = res.data.stats;
    const checks = [
      ['propriétaires', s.proprietaires, db.proprietaires],
      ['locataires', s.locataires, db.locataires],
      ['biens', s.biens, db.biens],
      ['logements', s.logements, db.logements],
      ['logements occupés', s.logementsOccupes, db.logementsOccupes],
      ['paiements en attente ce mois', s.paiementsEnAttente, db.paiementsEnAttente],
      ['paiements en retard ce mois', s.paiementsEnRetard, db.paiementsEnRetard],
      ['incidents actifs', s.incidentsActifs, db.incidentsActifs],
      ['interventions actives', s.interventionsActives, db.interventionsActives],
      ['revenus du mois', Number(s.revenusMois), db.revenusMois],
      ['12 mois de revenus', s.revenue12.length, 12],
    ];

    for (const [name, got, want] of checks) {
      if (got === want) r.pass(S, name);
      else r.fail(S, name, `reçu ${got} (attendu ${want})`);
    }

    const lastMonth = s.revenue12[s.revenue12.length - 1];
    if (Math.abs(Number(lastMonth.total) - db.revenusMois) < 0.01) {
      r.pass(S, 'dernier mois du graphique = revenus du mois');
    } else {
      r.fail(S, 'dernier mois du graphique = revenus du mois', `graph=${lastMonth?.total} base=${db.revenusMois}`);
    }

    const sum12 = s.revenue12.reduce((acc, m) => acc + m.total, 0);
    if (sum12 >= db.revenusMois) r.pass(S, 'revenus 12 mois cohérents');
    else r.fail(S, 'revenus 12 mois cohérents', `somme=${sum12} mois=${db.revenusMois}`);
  });

  await r.section('admin : listes globales', async () => {
    const prop = await api('/admin/proprietaires', { jar: adminJar });
    if (expectSuccess(r, prop, S, 'propriétaires')) {
      const data = prop.data.data;
      if (data.length === db.proprietaires) r.pass(S, `propriétaires (${data.length})`);
      else r.fail(S, 'propriétaires', `API=${data.length} base=${db.proprietaires}`);

      // Chaque propriétaire du seed est présent avec ses biens comptés.
      let seedOk = true;
      for (const owner of ctx.seed.owners) {
        const row = data.find((p) => p.id === owner.id);
        const wantBiens = (await service.from('biens').select('id').eq('user_id', owner.id)).data.length;
        if (!row || row.biens !== wantBiens) seedOk = false;
      }
      if (seedOk) r.pass(S, 'propriétaires du seed présents avec biens comptés');
      else r.fail(S, 'propriétaires du seed présents avec biens comptés');

      const seedOwners = data.filter((p) => ctx.seed.owners.some((o) => o.id === p.id));
      if (seedOwners.length === ctx.seed.owners.length && seedOwners.every((p) => p.statut === 'actif')) r.pass(S, 'tous les propriétaires du seed actifs');
      else r.fail(S, 'tous les propriétaires du seed actifs');
    }

    const locs = await api('/admin/locataires', { jar: adminJar });
    if (expectSuccess(r, locs, S, 'locataires')) {
      const data = locs.data.data;
      if (data.length === db.locataires) r.pass(S, `locataires (${data.length})`);
      else r.fail(S, 'locataires', `API=${data.length} base=${db.locataires}`);

      const linked = data.filter((l) => l.logement !== '—').length;
      if (linked >= 100) r.pass(S, `locataires du seed reliés à un logement (${linked})`);
      else r.fail(S, 'locataires du seed reliés à un logement', `reliés ${linked}`);
    }

    const biens = await api('/admin/biens', { jar: adminJar });
    if (expectSuccess(r, biens, S, 'biens')) {
      const data = biens.data.data;
      if (data.length === db.biens) r.pass(S, `biens (${data.length})`);
      else r.fail(S, 'biens', `API=${data.length} base=${db.biens}`);

      let seedOk = true;
      for (const owner of ctx.seed.owners) {
        const row = data.find((b) => b.id === owner.bienId);
        if (!row || row.logements !== 10) seedOk = false;
      }
      if (seedOk) r.pass(S, 'biens du seed avec 10 logements comptés');
      else r.fail(S, 'biens du seed avec 10 logements comptés');
    }

    const pays = await api('/admin/paiements', { jar: adminJar });
    if (expectSuccess(r, pays, S, 'paiements')) {
      if (pays.data.data.length >= ctx.seed.countPaiements) r.pass(S, `paiements visibles (${pays.data.data.length})`);
      else r.fail(S, 'paiements visibles', `API=${pays.data.data.length} seed=${ctx.seed.countPaiements}`);

      const avecLogement = pays.data.data.some((p) => p.logement && p.logement !== '—');
      if (avecLogement) r.pass(S, 'paiements : colonne logement renseignée');
      else r.fail(S, 'paiements : colonne logement renseignée');
    }

    const incs = await api('/admin/incidents', { jar: adminJar });
    if (expectSuccess(r, incs, S, 'incidents')) {
      if (incs.data.data.length >= db.incidents) r.pass(S, `incidents (${incs.data.data.length})`);
      else r.fail(S, 'incidents', `API=${incs.data.data.length} base=${db.incidents}`);
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
    if (banned.status === 403 && banned.data?.code === 'ACCOUNT_SUSPENDED') r.pass(S, 'compte suspendu → login refusé (403 ACCOUNT_SUSPENDED)');
    else r.fail(S, 'compte suspendu → login refusé (403 ACCOUNT_SUSPENDED)', `statut ${banned.status} ${JSON.stringify(banned.data)}`);

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
