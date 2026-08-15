// ============================================================
// MIM - Suite isolation cross-tenant
// Un propriétaire (ou locataire) ne doit JAMAIS lire/écrire les
// données d'un autre propriétaire, ni référencer leurs entités.
// ============================================================

import { api, newJar, expectSuccess } from './lib.js';

const S = 'isolation';

export async function runIsolation(r, ctx) {
  const o1 = ctx.seed.owners[0];
  const o2 = ctx.seed.owners[1];
  const PW = 'Test1234!';

  // ----------------------------------------------------------
  await r.section('lecture : o2 ne voit pas les données de o1', async () => {
    const b = await api('/biens', { jar: o2.jar });
    if (!expectSuccess(r, b, S, r)) return;
    const leak = b.data.data.some((x) => String(x.id) === String(o1.bienId));
    if (leak) r.fail(S, 'o2 ne voit pas le bien de o1', 'bien de o1 visible dans la liste de o2');
    else r.pass(S, 'o2 ne voit pas le bien de o1');

    const l = await api('/logements', { jar: o2.jar });
    if (expectSuccess(r, l, S, r)) {
      const ids = new Set(o1.logements.map((x) => x.id));
      const leak = l.data.data.some((x) => ids.has(x.id));
      if (leak) r.fail(S, 'o2 ne voit pas les logements de o1', 'logement de o1 visible');
      else r.pass(S, 'o2 ne voit pas les logements de o1');
    }

    const loc = await api('/locataires', { jar: o2.jar });
    if (expectSuccess(r, loc, S, r)) {
      const ids = new Set(o1.locataires.map((x) => x.id));
      const leak = loc.data.data.some((x) => ids.has(x.id));
      if (leak) r.fail(S, 'o2 ne voit pas les locataires de o1', 'locataire de o1 visible');
      else r.pass(S, 'o2 ne voit pas les locataires de o1');
    }

    const pa = await api('/paiements', { jar: o2.jar });
    if (expectSuccess(r, pa, S, r)) {
      const ids = new Set(o1.locataires.map((x) => x.id));
      const leak = pa.data.data.some((x) => ids.has(x.locataire_id));
      if (leak) r.fail(S, 'o2 ne voit pas les paiements de o1', 'paiement lié à un locataire de o1');
      else r.pass(S, 'o2 ne voit pas les paiements de o1');
    }
  });

  // ----------------------------------------------------------
  await r.section('écriture : o2 ne peut ni modifier ni supprimer les données de o1', async () => {
    const upd = await api(`/biens/${o1.bienId}`, { method: 'PUT', jar: o2.jar, body: { nom: 'VOL' } });
    if (upd.status >= 400) r.pass(S, 'PUT sur bien de o1 bloqué');
    else r.fail(S, 'PUT sur bien de o1 bloqué', `statut ${upd.status} — VOL possible !`);

    const del = await api(`/biens/${o1.bienId}`, { method: 'DELETE', jar: o2.jar });
    if (del.status >= 400) r.pass(S, 'DELETE sur bien de o1 bloqué');
    else r.fail(S, 'DELETE sur bien de o1 bloqué', `statut ${del.status} — suppression possible !`);

    const updL = await api(`/logements/${o1.logements[0].id}`, { method: 'PUT', jar: o2.jar, body: { loyer_mensuel: 1 } });
    if (updL.status >= 400) r.pass(S, 'PUT sur logement de o1 bloqué');
    else r.fail(S, 'PUT sur logement de o1 bloqué', `statut ${updL.status} — modification possible !`);

    const delL = await api(`/logements/${o1.logements[0].id}`, { method: 'DELETE', jar: o2.jar });
    if (delL.status >= 400) r.pass(S, 'DELETE sur logement de o1 bloqué');
    else r.fail(S, 'DELETE sur logement de o1 bloqué', `statut ${delL.status} — suppression possible !`);

    const delLoc = await api(`/locataires/${o1.locataires[0].id}`, { method: 'DELETE', jar: o2.jar });
    if (delLoc.status >= 400) r.pass(S, 'DELETE sur locataire de o1 bloqué');
    else r.fail(S, 'DELETE sur locataire de o1 bloqué', `statut ${delLoc.status} — suppression possible !`);
  });

  // ----------------------------------------------------------
  await r.section('références croisées : o2 ne peut pas référencer les entités de o1', async () => {
    const foreignLoc = o1.locataires[0];
    const foreignLg = o1.logements[0];
    const ownLoc = o2.locataires[0];
    const ownLg = o2.logements[0];

    // Paiement rattaché au locataire de o1.
    const p1 = await api('/paiements', {
      method: 'POST',
      jar: o2.jar,
      body: { locataire_id: foreignLoc.id, logement_id: ownLg.id, montant: 1000, mois: ctx.seed.month, statut: 'attente' },
    });
    if (p1.status === 400) r.pass(S, 'paiement sur locataire de o1 rejeté');
    else r.fail(S, 'paiement sur locataire de o1 rejeté', `statut ${p1.status} — référence croisée acceptée !`);

    // Paiement dont le logement appartient à o1.
    const p2 = await api('/paiements', {
      method: 'POST',
      jar: o2.jar,
      body: { locataire_id: ownLoc.id, logement_id: foreignLg.id, montant: 1000, mois: ctx.seed.month, statut: 'attente' },
    });
    if (p2.status === 400) r.pass(S, 'paiement sur logement de o1 rejeté');
    else r.fail(S, 'paiement sur logement de o1 rejeté', `statut ${p2.status} — référence croisée acceptée !`);

    // Incident sur le logement de o1.
    const i1 = await api('/incidents', {
      method: 'POST',
      jar: o2.jar,
      body: { logement_id: foreignLg.id, titre: 'Espionnage', statut: 'nouveau' },
    });
    if (i1.status === 400) r.pass(S, 'incident sur logement de o1 rejeté');
    else r.fail(S, 'incident sur logement de o1 rejeté', `statut ${i1.status} — référence croisée acceptée !`);

    // Intervention référençant l'incident / prestataire / logement de o1.
    const iv1 = await api('/interventions', {
      method: 'POST',
      jar: o2.jar,
      body: { incident_id: o1.incidentId, prestataire_id: o2.prestataireId, logement_id: ownLg.id, titre: 'Intrusion', statut: 'planifie' },
    });
    if (iv1.status === 400) r.pass(S, 'intervention sur incident de o1 rejetée');
    else r.fail(S, 'intervention sur incident de o1 rejetée', `statut ${iv1.status} — référence croisée acceptée !`);

    const iv2 = await api('/interventions', {
      method: 'POST',
      jar: o2.jar,
      body: { incident_id: o2.incidentId, prestataire_id: o1.prestataireId, logement_id: ownLg.id, titre: 'Intrusion2', statut: 'planifie' },
    });
    if (iv2.status === 400) r.pass(S, 'intervention sur prestataire de o1 rejetée');
    else r.fail(S, 'intervention sur prestataire de o1 rejetée', `statut ${iv2.status} — référence croisée acceptée !`);

    // Locataire (sans compte) rattaché au logement de o1.
    const l1 = await api('/locataires', {
      method: 'POST',
      jar: o2.jar,
      body: { logement_id: foreignLg.id, nom: 'Locataire Espion', statut: 'actif' },
    });
    if (l1.status === 400) r.pass(S, 'locataire sur logement de o1 rejeté');
    else r.fail(S, 'locataire sur logement de o1 rejeté', `statut ${l1.status} — référence croisée acceptée !`);

    // PUT : changer le locataire_id d'un paiement de o2 vers un locataire de o1.
    const created = await api('/paiements', {
      method: 'POST',
      jar: o2.jar,
      body: { locataire_id: ownLoc.id, logement_id: ownLg.id, montant: 1000, mois: ctx.seed.month, statut: 'attente' },
    });
    if (expectSuccess(r, created, S, r, [201])) {
      const pid = created.data.data.id;
      const up = await api(`/paiements/${pid}`, { method: 'PUT', jar: o2.jar, body: { locataire_id: foreignLoc.id } });
      if (up.status === 400) r.pass(S, 'PUT paiement vers locataire de o1 rejeté');
      else r.fail(S, 'PUT paiement vers locataire de o1 rejeté', `statut ${up.status} — référence croisée acceptée !`);
      await api(`/paiements/${pid}`, { method: 'DELETE', jar: o2.jar });
    }
  });

  // ----------------------------------------------------------
  await r.section('base : aucune référence croisée résiduelle', async () => {
    const service = ctx.service;
    const o1LocIds = new Set(o1.locataires.map((x) => x.id));
    const o1LgIds = new Set(o1.logements.map((x) => x.id));

    const { data: pa } = await service.from('paiements').select('locataire_id, logement_id, user_id');
    const badPa = (pa || []).filter(
      (p) => p.user_id === o2.id && (o1LocIds.has(p.locataire_id) || o1LgIds.has(p.logement_id))
    );
    if (badPa.length) r.fail(S, 'aucun paiement croisé en base', `${badPa.length} paiement(s) croisé(s)`);
    else r.pass(S, 'aucun paiement croisé en base');

    const { data: inc } = await service.from('incidents').select('logement_id, user_id');
    const badInc = (inc || []).filter((x) => x.user_id === o2.id && o1LgIds.has(x.logement_id));
    if (badInc.length) r.fail(S, 'aucun incident croisé en base', `${badInc.length} incident(s) croisé(s)`);
    else r.pass(S, 'aucun incident croisé en base');
  });

  // ----------------------------------------------------------
  await r.section('locataires : isolation entre locataires', async () => {
    const t1 = o1.locataires[0];
    const t2 = o2.locataires[0];

    const jar1 = newJar();
    const login1 = await api('/auth/login', { method: 'POST', jar: jar1, body: { identifier: t1.username, password: PW } });
    if (login1.status !== 200) {
      r.blocked(S, `login ${t1.username}`, `statut ${login1.status}`);
      return;
    }

    const dash = await api('/locataire/dashboard', { jar: jar1 });
    if (expectSuccess(r, dash, S, r) && dash.data.linked === true) {
      r.pass(S, `dashboard locataire ${t1.username} (lié)`);
    } else {
      r.fail(S, `dashboard locataire ${t1.username} (lié)`, JSON.stringify(dash.data));
    }

    const ownLgId = o1.logements[0].id;
    if (dash.data?.logement?.id === ownLgId) r.pass(S, 'le locataire voit SON logement');
    else r.fail(S, 'le locataire voit SON logement', JSON.stringify(dash.data?.logement));

    // Les routes CRUD sont réservées aux propriétaires (403) : un locataire
    // ne peut même pas énumérer les logements de son propriétaire via la
    // route générale — protection plus stricte que le simple filtre par user_id.
    const lgs = await api('/logements', { jar: jar1 });
    if (lgs.status === 403) r.pass(S, 'locataire bloqué sur /api/logements (route propriétaire)');
    else r.fail(S, 'locataire bloqué sur /api/logements (route propriétaire)', `statut ${lgs.status} — attendu 403`);

    const pays = await api('/paiements', { jar: jar1 });
    if (pays.status === 403) r.pass(S, 'locataire bloqué sur /api/paiements (route propriétaire)');
    else r.fail(S, 'locataire bloqué sur /api/paiements (route propriétaire)', `statut ${pays.status} — attendu 403`);

    // Le locataire ne peut pas supprimer un logement (RLS + rôle).
    const delLg = await api(`/logements/${o2.logements[0].id}`, { method: 'DELETE', jar: jar1 });
    if (delLg.status >= 400) r.pass(S, 'locataire ne peut pas supprimer un logement');
    else r.fail(S, 'locataire ne peut pas supprimer un logement', `statut ${delLg.status}`);

    // Signalement d'incident : le logement est DÉDUIT de la fiche (pas de l'id envoyé).
    const intruder = await api('/locataire/incidents', {
      method: 'POST',
      jar: jar1,
      body: { logement_id: o2.logements[0].id, titre: 'Fausse cible' },
    });
    if (expectSuccess(r, intruder, S, r, [201])) {
      const { data: created } = await ctx.service.from('incidents').select('logement_id, user_id').eq('id', intruder.data.data.id).single();
      if (created && created.logement_id === ownLgId && created.user_id === o1.id) {
        r.pass(S, 'incident rattaché au VRAI logement du locataire (id envoyé ignoré)');
      } else {
        r.fail(S, 'incident rattaché au VRAI logement du locataire', JSON.stringify(created));
      }
    } else {
      r.fail(S, 'incident rattaché au VRAI logement du locataire', JSON.stringify(intruder.data));
    }

    const jar2 = newJar();
    const login2 = await api('/auth/login', { method: 'POST', jar: jar2, body: { identifier: t2.username, password: PW } });
    if (login2.status === 200) r.pass(S, `dashboard locataire ${t2.username} (login OK)`);
    else r.fail(S, `dashboard locataire ${t2.username} (login OK)`, `statut ${login2.status}`);
  });
}
