// ============================================================
// MIM - Suite « Salaires & moyens de paiement des employés »
//
// Flux : le propriétaire déclare un versement (statut « attente »),
// l'employé confirme la réception (« paye ») ou signale ne pas
// l'avoir reçue (« non_recu »). L'employé gère ses propres moyens
// de réception ; le propriétaire peut aussi en créer pour lui.
// ============================================================

import { api, expectSuccess, newJar } from './lib.js';

const S = 'salaires';
const EMP_PASSWORD = 'Test1234!';

function currentMoisUTC() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function loginEmployee(username) {
  const jar = newJar();
  const login = await api('/auth/login', {
    method: 'POST',
    jar,
    body: { identifier: username, password: EMP_PASSWORD },
  });
  if (login.status !== 200) return { jar: null, login };
  return { jar, login };
}

export async function runSalaires(r, ctx) {
  const service = ctx.service;
  const owner1 = ctx.seed.owners[0];
  const owner2 = ctx.seed.owners[1];
  const jar = owner1.jar;
  const jar2 = owner2.jar;
  const moisCourant = currentMoisUTC();

  const emp = { A: null, B: null, C: null };
  const moyens = { A: [], B: [], ownerB: null };
  const paie = { A1: null, B2: null, B3: null };

  // ----------------------------------------------------------
  await r.section('création d\'employés (avec compte)', async () => {
    const create = async (ownerJar, username, nom, poste, salaire) => {
      const res = await api('/employes', {
        method: 'POST',
        jar: ownerJar,
        body: {
          username,
          password: EMP_PASSWORD,
          nom,
          poste,
          salaire,
          email: `${username}@exemple.com`,
          statut: 'actif',
        },
      });
      if (!expectSuccess(r, res, S, r, [201])) {
        r.fail(S, `employé ${nom} créé`, JSON.stringify(res.data));
        return null;
      }
      return res.data.data;
    };

    emp.A = await create(jar, 'salaire.alpha', 'Alpha Sow', 'Gardien', 250000);
    emp.B = await create(jar, 'salaire.beta', 'Beta Ndiaye', 'Nettoyeur', 180000);
    emp.C = await create(jar2, 'salaire.gamma', 'Gamma Diop', 'Cuisinier', 150000);
    if (!emp.A || !emp.B || !emp.C) return;

    if (emp.A.account_uid && emp.B.account_uid && emp.C.account_uid) {
      r.pass(S, 'comptes employés créés (account_uid)');
    } else {
      r.fail(S, 'comptes employés créés', 'account_uid manquant');
    }

    const { data: row } = await service
      .from('employes')
      .select('user_id, account_uid, username, nom, salaire')
      .eq('id', emp.A.id)
      .maybeSingle();
    if (row && row.user_id === owner1.id && Number(row.salaire) === 250000 && row.username === 'salaire.alpha') {
      r.pass(S, 'fiche employé en base (propriétaire 1, salaire 250 000)');
    } else {
      r.fail(S, 'fiche employé en base', JSON.stringify(row));
    }

    // Connexion de l'employé : username + mot de passe initial.
    const loginA = await loginEmployee('salaire.alpha');
    if (loginA.jar && loginA.login.data.mustChangePassword === true) {
      r.pass(S, 'connexion employé (username + mdp) → changement forcé');
    } else {
      r.fail(S, 'connexion employé (username + mdp)', `statut ${loginA.login.status} ${JSON.stringify(loginA.login.data).slice(0, 200)}`);
    }

    // L'employé appartient au bon propriétaire (A et B chez 1, C chez 2).
    const { data: rowC } = await service.from('employes').select('user_id').eq('id', emp.C.id).maybeSingle();
    if (rowC && rowC.user_id === owner2.id) r.pass(S, 'employé C rattaché au propriétaire 2');
    else r.fail(S, 'employé C rattaché au propriétaire 2', JSON.stringify(rowC));
  });

  // ----------------------------------------------------------
  await r.section('moyens de réception gérés par l\'employé', async () => {
    const { jar: jarA } = await loginEmployee('salaire.alpha');
    const { jar: jarB } = await loginEmployee('salaire.beta');
    if (!jarA || !jarB) return;

    // Ajout de DEUX moyens par A (Wave + virement).
    const w1 = await api('/employe/moyens-paiement', {
      method: 'POST',
      jar: jarA,
      body: { type: 'wave', nom_titulaire: 'Alpha Sow', numero: '+221770000111', actif: true },
    });
    const v1 = await api('/employe/moyens-paiement', {
      method: 'POST',
      jar: jarA,
      body: { type: 'virement', banque: 'BCEAO', nom_titulaire: 'Alpha Sow', num_compte: 'SN0000001', iban: 'SN88BCEA0000001', bic: 'BCEASNDA', actif: true },
    });
    if (expectSuccess(r, w1, S, r, [201]) && expectSuccess(r, v1, S, r, [201])) {
      r.pass(S, 'A ajoute 2 moyens (Wave + virement)');
      moyens.A.push(w1.data.data, v1.data.data);
    } else {
      r.fail(S, 'A ajoute 2 moyens', JSON.stringify({ w: w1.data, v: v1.data }));
    }

    const o1 = await api('/employe/moyens-paiement', {
      method: 'POST',
      jar: jarB,
      body: { type: 'orange_money', nom_titulaire: 'Beta Ndiaye', numero: '+221770000222', actif: true },
    });
    if (expectSuccess(r, o1, S, r, [201])) {
      r.pass(S, 'B ajoute 1 moyen (Orange Money)');
      moyens.B.push(o1.data.data);
    } else {
      r.fail(S, 'B ajoute 1 moyen', JSON.stringify(o1.data));
    }

    // Liste : A ne voit QUE ses propres moyens (jamais ceux de B).
    const listA = await api('/employe/moyens-paiement', { jar: jarA });
    if (
      expectSuccess(r, listA, S, r) &&
      (listA.data.data || []).length === 2 &&
      (listA.data.data || []).every((m) => [moyens.A[0].id, moyens.A[1].id].includes(m.id))
    ) {
      r.pass(S, 'liste de A : 2 moyens, aucun de B');
    } else {
      r.fail(S, 'liste de A : 2 moyens, aucun de B', JSON.stringify(listA.data).slice(0, 300));
    }

    // Édition : A désactive son virement.
    const upd = await api(`/employe/moyens-paiement/${moyens.A[1].id}`, {
      method: 'PUT',
      jar: jarA,
      body: { actif: false },
    });
    if (expectSuccess(r, upd, S, r) && upd.data.data.actif === false) {
      r.pass(S, 'A désactive son virement (actif=false)');
    } else {
      r.fail(S, 'A désactive son virement', JSON.stringify(upd.data));
    }

    // Suppression d'un moyen par B, puis recréation.
    const del = await api(`/employe/moyens-paiement/${moyens.B[0].id}`, { method: 'DELETE', jar: jarB });
    if (expectSuccess(r, del, S, r)) {
      r.pass(S, 'B supprime son moyen');
    } else {
      r.fail(S, 'B supprime son moyen', JSON.stringify(del.data));
    }
    const o2 = await api('/employe/moyens-paiement', {
      method: 'POST',
      jar: jarB,
      body: { type: 'orange_money', nom_titulaire: 'Beta Ndiaye', numero: '+221770000223', actif: true },
    });
    if (expectSuccess(r, o2, S, r, [201])) {
      moyens.B = [o2.data.data];
      r.pass(S, 'B recrée son moyen');
    } else {
      r.fail(S, 'B recrée son moyen', JSON.stringify(o2.data));
    }
  });

  // ----------------------------------------------------------
  await r.section('vue propriétaire des moyens + création pour l\'employé', async () => {
    // Le propriétaire ne voit que les moyens ACTIFS de A (le virement est désactivé).
    const viewA = await api(`/employes/${emp.A.id}/moyens-paiement`, { jar });
    if (
      expectSuccess(r, viewA, S, r) &&
      (viewA.data.data || []).length === 1 &&
      viewA.data.data[0].id === moyens.A[0].id
    ) {
      r.pass(S, 'propriétaire voit les moyens actifs de A (1 seul)');
    } else {
      r.fail(S, 'propriétaire voit les moyens actifs de A', JSON.stringify(viewA.data).slice(0, 300));
    }

    // Le propriétaire crée un moyen pour B.
    const mk = await api(`/employes/${emp.B.id}/moyens-paiement`, {
      method: 'POST',
      jar,
      body: { type: 'wave', nom_titulaire: 'Beta Ndiaye', numero: '+221770000333', actif: true },
    });
    if (expectSuccess(r, mk, S, r, [201])) {
      moyens.ownerB = mk.data.data;
      r.pass(S, 'propriétaire crée un moyen pour B');
    } else {
      r.fail(S, 'propriétaire crée un moyen pour B', JSON.stringify(mk.data));
    }
  });

  // ----------------------------------------------------------
  await r.section('déclaration de salaire (attente de confirmation)', async () => {
    const res = await api(`/employes/${emp.A.id}/paiements`, {
      method: 'POST',
      jar,
      body: {
        montant: 250000,
        mois: moisCourant,
        moyen_employe_id: moyens.A[0].id,
        reference: 'WAVE-SAL-A1',
      },
    });
    if (expectSuccess(r, res, S, r, [201]) && res.data.data.statut === 'attente' && res.data.data.methode_paiement === 'wave') {
      paie.A1 = res.data.data;
      r.pass(S, `déclaration → attente (wave, ${moisCourant})`);
    } else {
      r.fail(S, 'déclaration → attente', JSON.stringify(res.data));
    }

    // Un moyen d'un AUTRE employé est refusé (404).
    const bad = await api(`/employes/${emp.A.id}/paiements`, {
      method: 'POST',
      jar,
      body: { montant: 100000, mois: moisCourant, moyen_employe_id: moyens.ownerB?.id },
    });
    if (bad.status === 404) r.pass(S, 'moyen d\'un autre employé → refusé (404)');
    else r.fail(S, 'moyen d\'un autre employé → refusé', `statut ${bad.status}`);

    // La liste des employés expose l'attente de confirmation.
    const list = await api('/employes', { jar });
    const empAInList = expectSuccess(r, list, S, r) && (list.data.data || []).find((e) => e.id === emp.A.id);
    if (empAInList && empAInList.en_attente_confirmation === 1 && empAInList.dernier_paiement?.statut === 'attente') {
      r.pass(S, 'GET /employes : en_attente_confirmation=1, dernier paiement attente');
    } else {
      r.fail(S, 'GET /employes : en_attente_confirmation=1', JSON.stringify(empAInList || list.data).slice(0, 300));
    }

    // L'employé est notifié.
    const { jar: jarA } = await loginEmployee('salaire.alpha');
    if (jarA) {
      const notifs = await api('/employe/notifications', { jar: jarA });
      const okNotif =
        expectSuccess(r, notifs, S, r) &&
        (notifs.data.data || []).some((n) => n.title === 'salaire' && String(n.message || '').includes('confirmez la réception'));
      if (okNotif) r.pass(S, 'employé notifié de la déclaration (salaire + confirmez)');
      else r.fail(S, 'employé notifié de la déclaration', JSON.stringify(notifs.data).slice(0, 300));
    }
  });

  // ----------------------------------------------------------
  await r.section('confirmation par l\'employé', async () => {
    const { jar: jarA } = await loginEmployee('salaire.alpha');
    if (!jarA || !paie.A1) return;

    const conf = await api(`/employe/paiements/${paie.A1.id}/confirmer`, {
      method: 'POST',
      jar: jarA,
      body: {},
    });
    if (expectSuccess(r, conf, S, r) && conf.data.data.statut === 'paye' && conf.data.data.confirmed_at) {
      r.pass(S, 'confirmation → paye (confirmed_at renseigné)');
    } else {
      r.fail(S, 'confirmation → paye', JSON.stringify(conf.data));
    }

    // Double confirmation refusée.
    const again = await api(`/employe/paiements/${paie.A1.id}/confirmer`, { method: 'POST', jar: jarA, body: {} });
    if (again.status === 400) r.pass(S, 'double confirmation → 400 (déjà confirmé)');
    else r.fail(S, 'double confirmation → 400', `statut ${again.status}`);

    // En base : confirmed_by = compte de l'employé.
    const { data: row } = await service
      .from('paiements_employes')
      .select('statut, confirmed_at, confirmed_by, moyen_employe_id')
      .eq('id', paie.A1.id)
      .maybeSingle();
    if (row && row.statut === 'paye' && row.confirmed_by && row.confirmed_at && row.moyen_employe_id === moyens.A[0].id) {
      r.pass(S, 'base : paye + confirmed_by employé + moyen lié');
    } else {
      r.fail(S, 'base : paye + confirmed_by employé', JSON.stringify(row));
    }

    // Le propriétaire est notifié de la confirmation.
    const notifs = await api('/notifications', { jar });
    const okNotif =
      expectSuccess(r, notifs, S, r) &&
      (notifs.data.data || []).some((n) => n.type === 'salaire' && String(n.message || '').includes('confirmé'));
    if (okNotif) r.pass(S, 'propriétaire notifié de la confirmation');
    else r.fail(S, 'propriétaire notifié de la confirmation', JSON.stringify(notifs.data).slice(0, 300));

    // Historique propriétaire : paiement payé avec l'objet moyen.
    const hist = await api(`/employes/${emp.A.id}/paiements`, { jar });
    const p1 = expectSuccess(r, hist, S, r) && (hist.data.data || []).find((p) => p.id === paie.A1.id);
    if (
      p1 &&
      p1.statut === 'paye' &&
      Number(p1.montant) === 250000 &&
      p1.moyen?.type === 'wave' &&
      p1.moyen?.label === 'Wave' &&
      p1.moyen?.nom_titulaire === 'Alpha Sow'
    ) {
      r.pass(S, 'historique propriétaire : paye + moyen complet (Wave/Alpha Sow)');
    } else {
      r.fail(S, 'historique propriétaire : paye + moyen', JSON.stringify(p1 || hist.data).slice(0, 300));
    }

    // La liste des employés n'affiche plus d'attente et totalise 250 000.
    const list = await api('/employes', { jar });
    const empAInList = expectSuccess(r, list, S, r) && (list.data.data || []).find((e) => e.id === emp.A.id);
    if (empAInList && empAInList.en_attente_confirmation === 0 && empAInList.total_paye === 250000) {
      r.pass(S, 'GET /employes : attente=0, total payé 250 000');
    } else {
      r.fail(S, 'GET /employes : attente=0, total payé', JSON.stringify(empAInList || list.data).slice(0, 300));
    }
  });

  // ----------------------------------------------------------
  await r.section('paiement direct « paye » (compat UnitechPay)', async () => {
    const res = await api(`/employes/${emp.B.id}/paiements`, {
      method: 'POST',
      jar,
      body: {
        montant: 180000,
        mois: moisCourant,
        statut: 'paye',
        date_paiement: '2026-08-02',
        reference: 'UNITECH-1',
      },
    });
    if (expectSuccess(r, res, S, r, [201]) && res.data.data.statut === 'paye') {
      paie.B2 = res.data.data;
      r.pass(S, 'paiement direct paye accepté (compat UnitechPay)');
    } else {
      r.fail(S, 'paiement direct paye accepté', JSON.stringify(res.data));
    }

    // Statut invalide refusé.
    const bad = await api(`/employes/${emp.B.id}/paiements`, {
      method: 'POST',
      jar,
      body: { montant: 100000, mois: moisCourant, statut: 'inconnu' },
    });
    if (bad.status === 400) r.pass(S, 'statut invalide → 400');
    else r.fail(S, 'statut invalide → 400', `statut ${bad.status}`);
  });

  // ----------------------------------------------------------
  await r.section('« je n\'ai pas reçu » (refus par l\'employé)', async () => {
    const res = await api(`/employes/${emp.B.id}/paiements`, {
      method: 'POST',
      jar,
      body: {
        montant: 180000,
        mois: moisCourant,
        moyen_employe_id: moyens.ownerB?.id,
        reference: 'WAVE-SAL-B3',
      },
    });
    if (!expectSuccess(r, res, S, r, [201]) || res.data.data.statut !== 'attente') {
      r.fail(S, 'déclaration B (attente)', JSON.stringify(res.data));
      return;
    }
    paie.B3 = res.data.data;

    // Motif vide refusé.
    const { jar: jarB } = await loginEmployee('salaire.beta');
    if (!jarB) return;
    const noMotif = await api(`/employe/paiements/${paie.B3.id}/non-recus`, { method: 'POST', jar: jarB, body: { motif: '' } });
    if (noMotif.status === 400) r.pass(S, 'refus sans motif → 400');
    else r.fail(S, 'refus sans motif → 400', `statut ${noMotif.status}`);

    const refus = await api(`/employe/paiements/${paie.B3.id}/non-recus`, {
      method: 'POST',
      jar: jarB,
      body: { motif: 'Montant incorrect' },
    });
    if (expectSuccess(r, refus, S, r) && refus.data.data.statut === 'non_recu' && refus.data.data.rejected_at) {
      r.pass(S, 'refus → non_recu (motif conservé)');
    } else {
      r.fail(S, 'refus → non_recu', JSON.stringify(refus.data));
    }

    const { data: row } = await service
      .from('paiements_employes')
      .select('statut, rejected_at, rejection_reason')
      .eq('id', paie.B3.id)
      .maybeSingle();
    if (row && row.statut === 'non_recu' && row.rejection_reason === 'Montant incorrect' && row.rejected_at) {
      r.pass(S, 'base : non_recu + rejection_reason');
    } else {
      r.fail(S, 'base : non_recu + rejection_reason', JSON.stringify(row));
    }

    // Le propriétaire est notifié du non-reçu.
    const notifs = await api('/notifications', { jar });
    const okNotif =
      expectSuccess(r, notifs, S, r) &&
      (notifs.data.data || []).some((n) => n.type === 'salaire' && String(n.message || '').includes('non reçu'));
    if (okNotif) r.pass(S, 'propriétaire notifié du non-reçu');
    else r.fail(S, 'propriétaire notifié du non-reçu', JSON.stringify(notifs.data).slice(0, 300));

    // Historique : le paiement refusé reste visible avec le motif.
    const hist = await api(`/employes/${emp.B.id}/paiements`, { jar });
    const p3 = expectSuccess(r, hist, S, r) && (hist.data.data || []).find((p) => p.id === paie.B3.id);
    if (p3 && p3.statut === 'non_recu' && p3.rejection_reason === 'Montant incorrect' && p3.moyen?.type === 'wave') {
      r.pass(S, 'historique : non_recu + motif + moyen');
    } else {
      r.fail(S, 'historique : non_recu + motif + moyen', JSON.stringify(p3 || hist.data).slice(0, 300));
    }
  });

  // ----------------------------------------------------------
  await r.section('isolation entre propriétaires et employés', async () => {
    // B ne peut pas accéder aux employés de A.
    const steal1 = await api(`/employes/${emp.A.id}/moyens-paiement`, { jar: jar2 });
    const steal2 = await api(`/employes/${emp.A.id}/paiements`, { jar: jar2 });
    const steal3 = await api(`/employes/${emp.A.id}/paiements`, {
      method: 'POST',
      jar: jar2,
      body: { montant: 50000, mois: moisCourant },
    });
    if (steal1.status === 404 && steal2.status === 404 && steal3.status === 404) {
      r.pass(S, 'propriétaire 2 : aucun accès aux employés de 1 (404 x3)');
    } else {
      r.fail(S, 'propriétaire 2 : aucun accès aux employés de 1', `statuts ${steal1.status}/${steal2.status}/${steal3.status}`);
    }

    // A ne voit aucun employé de B dans sa liste.
    const list1 = await api('/employes', { jar });
    if (expectSuccess(r, list1, S, r) && !(list1.data.data || []).some((e) => e.id === emp.C.id)) {
      r.pass(S, 'liste de 1 : aucun employé de 2');
    } else {
      r.fail(S, 'liste de 1 : aucun employé de 2', JSON.stringify(list1.data).slice(0, 300));
    }

    // Un employé ne peut pas confirmer le paiement d'un autre employé.
    const { jar: jarA } = await loginEmployee('salaire.alpha');
    const { jar: jarB } = await loginEmployee('salaire.beta');
    if (jarA && jarB && paie.B3) {
      const cross = await api(`/employe/paiements/${paie.B3.id}/confirmer`, { method: 'POST', jar: jarA, body: {} });
      if (cross.status === 404) r.pass(S, 'A ne peut pas confirmer le paiement de B (404)');
      else r.fail(S, 'A ne peut pas confirmer le paiement de B', `statut ${cross.status}`);

      // A ne peut pas modifier/supprimer les moyens de B.
      const delCross = await api(`/employe/moyens-paiement/${moyens.B[0].id}`, { method: 'DELETE', jar: jarA });
      if (delCross.status === 404) r.pass(S, 'A ne peut pas supprimer les moyens de B (404)');
      else r.fail(S, 'A ne peut pas supprimer les moyens de B', `statut ${delCross.status}`);

      // Les moyens de B restent intacts.
      const listB = await api('/employe/moyens-paiement', { jar: jarB });
      if (expectSuccess(r, listB, S, r) && (listB.data.data || []).some((m) => m.id === moyens.B[0].id)) {
        r.pass(S, 'moyens de B intacts après tentative de A');
      } else {
        r.fail(S, 'moyens de B intacts après tentative de A', JSON.stringify(listB.data).slice(0, 300));
      }
    }

    // Le propriétaire 2 ne peut pas créer de moyen pour l'employé de 1.
    const mkCross = await api(`/employes/${emp.A.id}/moyens-paiement`, {
      method: 'POST',
      jar: jar2,
      body: { type: 'wave', nom_titulaire: 'X', numero: '0000', actif: true },
    });
    if (mkCross.status === 404) r.pass(S, 'propriétaire 2 : création de moyen pour employé de 1 → 404');
    else r.fail(S, 'propriétaire 2 : création de moyen pour employé de 1', `statut ${mkCross.status}`);
  });

  // ----------------------------------------------------------
  await r.section('statistiques du dashboard (employés + salaires)', async () => {
    const res = await api('/stats/dashboard', { jar });
    const st = expectSuccess(r, res, S, r) ? res.data.stats : null;
    if (!st) return;

    // Le compte doit refléter TOUS les employés du propriétaire 1
    // (les autres suites, ex. import, peuvent en avoir créé) : on
    // compare au nombre réel en base plutôt qu'à une valeur fixe.
    const { count: dbCount } = await service
      .from('employes')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', owner1.id);

    if (st.totalEmployees === dbCount) r.pass(S, `totalEmployees = ${dbCount} (cohérent avec la base)`);
    else r.fail(S, 'totalEmployees cohérent avec la base', `API=${st.totalEmployees} base=${dbCount}`);

    // A : 0 en attente (confirmé) ; B : 0 en attente (le refusé est passé non_recu).
    if (st.salairesAttente === 0) r.pass(S, 'salairesAttente = 0 (confirmé + refusé)');
    else r.fail(S, 'salairesAttente = 0 (confirmé + refusé)', JSON.stringify(st));

    if (typeof st.paiementsEnValidation === 'number') r.pass(S, 'paiementsEnValidation présent');
    else r.fail(S, 'paiementsEnValidation présent', JSON.stringify(st));
  });
}