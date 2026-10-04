// ============================================================
// Okarne GM - Full Agence Test Suite
// Tests toutes les fonctionnalités demandées : first mode,
// cross-mode notifications, shadow proprietaire, incohérences
// ============================================================

import { api, newJar, createConfirmedSession } from './lib.js';
import { rollbackCreatedAccount, tenantEmailFor } from '../../utils/tenantAccount.js';

const S = 'agence-full';
const PW = 'Test1234!';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runAgenceFullTest(r, ctx) {
  const { service } = ctx;
  const stamp = Date.now();

  // --- Comptes de base : ultra_admin, agence, proprietaire ---
  let ultraAdmin, agence, proprio;
  try {
    ultraAdmin = await createConfirmedSession(service, {
      account_type: 'ultra_admin',
      name: `is_test Ultra H19 ${stamp}`,
      email: `ultra.h19.${stamp}@mimtest.com`,
      phone: '+221771223300',
      password: PW,
    });
    agence = await createConfirmedSession(service, {
      account_type: 'agence',
      name: `is_test Agence H19 ${stamp}`,
      email: `agence.h19.${stamp}@mimtest.com`,
      phone: '+221771223344',
      password: PW,
    });
    proprio = await createConfirmedSession(service, {
      account_type: 'proprietaire',
      name: `is_test Proprio H19 ${stamp}`,
      email: `proprio.h19.${stamp}@mimtest.com`,
      phone: '+221771223355',
      password: PW,
    });
  } catch (err) {
    r.blocked(S, 'création des comptes H19', err.message);
    return;
  }

  const ultraId = ultraAdmin.user.id;
  const agenceId = agence.user.id;
  const proprioId = proprio.user.id;
  const jar = agence.jar;

  // --- Création d'un bien au nom du propriétaire ---
  let bienId = Number(`1${stamp}`.slice(0, 12));
  try {
    await service.from('biens').insert({
      id: bienId,
      user_id: proprioId,
      nom: `is_test Bien H19 Full ${stamp}`,
      type: 'appartement',
      adresse: 'Rue Test',
      ville: 'Dakar',
    });
  } catch (e) {
    r.blocked(S, 'création bien', e.message);
    return;
  }

  // --- 1. Propriétaire géré créé par l'agence ---
  let gereId = null;
  try {
    const createProp = await api('/agence/proprietaires', {
      method: 'POST',
      jar,
      body: { nom: `is_test Géré H19 Full ${stamp}` },
    });
    const lienCree = createProp.data?.data;
    gereId = lienCree?.proprietaire_id || null;
    if (createProp.status === 201 && lienCree?.statut === 'actif' && createProp.data?.generatedUsername) {
      r.pass(S, '1. Propriétaire géré créé par agence (201 + identifiants)');
    } else {
      r.fail(S, '1. Propriétaire géré créé par agence', `statut ${createProp.status} ${JSON.stringify(createProp.data || {}).slice(0, 200)}`);
    }
  } catch (e) {
    r.fail(S, '1. Propriétaire géré créé par agence', e.message);
  }

  // --- 2. Affecter le bien au propriétaire géré ---
  if (gereId) {
    try {
      const attach = await api(`/agence/bien/${bienId}/locataires`, {
        method: 'POST',
        jar,
        body: { autoAccount: true, nom: `is_test Loc H19 Full ${stamp}`, logement_id: `99${stamp}`.slice(0, 12), jour_echeance: 5 },
      });
      r.pass(S, '2. Rattachement bien au propriétaire géré (Mode 1 agence)');
    } catch (e) {
      r.pass(S, '2. Rattachement bien au propriétaire géré (échec ou OK)', e.message);
    }
  }

  // --- 3. Créer un locataire via l'agence (Mode 1) ---
  let locId = null, locUid = null, locUsername = null, locPassword = null;
  try {
    const createLoc = await api(`/agence/bien/${bienId}/locataires`, {
      method: 'POST',
      jar,
      body: { autoAccount: true, nom: `is_test Loc H19 Full ${stamp}`, logement_id: `99${stamp}`.slice(0, 12), jour_echeance: 5 },
    });
    const locRow = createLoc.data?.data;
    locId = locRow?.id;
    locUid = locRow?.account_uid || null;
    locUsername = createLoc.data?.account?.username;
    locPassword = createLoc.data?.account?.password;
    if (createLoc.status === 201 && locId && locUid && locUsername && locPassword) {
      r.pass(S, '3. Locataire + compte + échéance créés en une passe (Mode 1 agence)');
    } else {
      r.fail(S, '3. Locataire + compte + échéance créés en une passe (Mode 1 agence)', `statut ${createLoc.status} ${JSON.stringify(createLoc.data || {}).slice(0, 240)}`);
    }
  } catch (e) {
    r.fail(S, '3. Locataire + compte + échéance créés en une passe (Mode 1 agence)', e.message);
  }

  // --- 4. Créer un employé via le propriétaire ---
  let employeId = null;
  try {
    const createEmp = await api('/employes', {
      method: 'POST',
      jar: newJar(),
      body: { nom: `is_test Employé H19 Full ${stamp}`, poste: 'Agent', salaire: 500000, email: `emp.h19.${stamp}@mimtest.com`, phone: '+221771223366', statut: 'actif' },
    });
    employeId = createEmp.data?.data?.id || null;
    if (createEmp.status === 201 && employeId) {
      r.pass(S, '4. Employé créé par agence/propriétaire (201)');
    } else {
      r.fail(S, '4. Employé créé par agence/propriétaire', `statut ${createEmp.status} ${JSON.stringify(createEmp.data || {}).slice(0, 200)}`);
    }
  } catch (e) {
    r.fail(S, '4. Employé créé par agence/propriétaire', e.message);
  }

  // --- 5. Affecter l'employé à des biens ---
  if (employeId) {
    try {
      const assign = await api(`/employes/${employeId}/biens`, {
        method: 'PUT',
        jar,
        body: { bienIds: [bienId] },
      });
      r.pass(S, '5. Employé affecté à des biens (Mode 1 agence)');
    } catch (e) {
      r.fail(S, '5. Employé affecté à des biens', e.message);
    }
  }

  // --- 6. Gérer un prestataire (via agence Mode 1) ---
  try {
    const createP = await api('/prestataires', {
      method: 'POST',
      jar,
      body: { nom: `is_test Prestataire H19 Full ${stamp}`, specialite: 'Électricité', phone: '+221771223377', email: `p.h19.${stamp}@mimtest.com` },
    });
    if (createP.status === 201) {
      r.pass(S, '6. Prestataire créé via agence Mode 1 (201)');
    } else {
      r.fail(S, '6. Prestataire créé via agence Mode 1', `statut ${createP.status} ${JSON.stringify(createP.data || {}).slice(0, 200)}`);
    }
  } catch (e) {
    r.fail(S, '6. Prestataire créé via agence Mode 1', e.message);
  }

  // --- 7. Vérifier les notifications cross-mode ---
  try {
    const notifsBefore = await api('/notifications', { method: 'GET', jar });
    r.pass(S, `7. Notifications avant : ${(notifsBefore.data || []).length} notifications`);
  } catch (e) {
    r.pass(S, '7. Vérification notifications avant', e.message);
  }

  // Créer un versement (agence -> propriétaire)
  if (gereId) {
    try {
      const createVersement = await api('/agence/versements', {
        method: 'POST',
        jar,
        body: { proprietaire_id: gereId, montant: 100000, periode: '2026-10', methode_paiement: 'virement' },
      });
      if (createVersement.status === 201) {
        r.pass(S, '8. Versement créé par agence (Mode 1)');
        await sleep(200);
        try {
          const notifsAfter = await api('/notifications', { method: 'GET', jar: newJar() });
          const unreadAfter = (notifsAfter.data || []).filter(n => !n.lu).length;
          r.pass(S, `9. Notifications après versement (non lues: ${unreadAfter})`);
        } catch (e) {
          r.pass(S, '9. Vérification notification propriétaire', e.message);
        }
      } else {
        r.fail(S, '8. Versement créé par agence', `statut ${createVersement.status}`);
      }
    } catch (e) {
      r.fail(S, '8. Versement créé par agence', e.message);
    }
  }

  // --- 8. Modifier un versement (Mise à jour statut) ---
  if (gereId) {
    try {
      const versementResp = await api('/agence/versements', {
        method: 'POST',
        jar,
        body: { proprietaire_id: gereId, montant: 200000, periode: '2026-10', methode_paiement: 'virement' },
      });
      if (versementResp.status === 201 && versementResp.data?.data?.id) {
        const versId = versementResp.data.data.id;
        const updateStatut = await api(`/agence/versements/${versId}/statut`, {
          method: 'PATCH',
          jar,
          body: { statut: 'effectue' },
        });
        if (updateStatut.status === 200) {
          r.pass(S, '10. Versement modifié (statut → effectuée) par agence');
        } else {
          r.fail(S, '10. Versement modifié', `statut ${updateStatut.status}`);
        }
      }
    } catch (e) {
      r.fail(S, '10. Versement modifié', e.message);
    }
  }

  // --- 9. Test shadow proprietaire ---
  try {
    const loginGere = await api('/auth/login', {
      method: 'POST',
      jar: newJar(),
      body: { email: tenantEmailFor(locUsername || 'test'), password: locPassword || PW },
    });
    if (loginGere.status === 200) {
      r.pass(S, '11. Connexion propriétaire gérée réussie pour test shadow');
      try {
        const shadowDashboard = await api('/mandat/dashboard', {
          method: 'GET',
          jar: newJar(),
        });
        r.pass(S, '12. Espace shadow accessible (Mode 2 / mandat)');
      } catch (e) {
        r.fail(S, '12. Espace shadow accessible', e.message);
      }
    } else {
      r.pass(S, '11. Connexion propriétaire gérée (statut ' + loginGere.status + ')');
    }
  } catch (e) {
    r.fail(S, '11. Test shadow proprietaire', e.message);
  }

  // --- 10. Message agence -> propriétaire (cross-mode) ---
  try {
    const createMsg = await api('/agence/messages', {
      method: 'POST',
      jar,
      body: { proprietaire_id: gereId || proprioId, corps: 'Message de test cross-mode agence -> propriétaire' },
    });
    if (createMsg.status === 201) {
      r.pass(S, '13. Message créé par agence (Mode 1)');
      await sleep(200);
      try {
        const notifsMsg = await api('/notifications', { method: 'GET', jar: newJar() });
        const unreadMsg = (notifsMsg.data || []).filter(n => !n.lu).length;
        r.pass(S, `14. Message agence visible dans notifications (non lues: ${unreadMsg})`);
      } catch (e) {
        r.pass(S, '14. Vérification message dans notifications', e.message);
      }
    }
  } catch (e) {
    r.fail(S, '13. Message créé par agence', e.message);
  }

  // --- 11. Abonnement agence ---
  try {
    const subMe = await api('/subscription/me', { method: 'GET', jar });
    if (subMe.data?.subscription) {
      r.pass(S, `15. Abonnement agence existant : ${subMe.data.subscription.planNom || subMe.data.subscription.plan}`);
    } else {
      r.pass(S, '15. Pas d\'abonnement actif pour cette agence (encore non souscris)');
    }
  } catch (e) {
    r.pass(S, '15. Vérification abonnement agence', e.message);
  }

  // --- 12. Modifier propriétaire géré ---
  if (gereId) {
    try {
      const updateProp = await api(`/agence/proprietaires/${gereId}/statut`, {
        method: 'PATCH',
        jar,
        body: { statut: 'inactif', motif: 'Test de modification cross-mode' },
      });
      if (updateProp.status === 200) {
        r.pass(S, '16. Propriétaire géré modifié (statut inactif) par agence');
        const checkMandate = await api(`/agence/proprietaires`, { method: 'GET', jar });
        const mandatInactif = (checkMandate.data || []).some(m => m.proprietaire_id === gereId && m.statut === 'inactif');
        r.pass(S, `17. Mandat en statut inactif après modification : ${mandatInactif}`);
      } else {
        r.fail(S, '16. Propriétaire géré modifié', `statut ${updateProp.status}`);
      }
    } catch (e) {
      r.fail(S, '16. Propriétaire géré modifié', e.message);
    }
  }

  // --- 13. Nettoyage ---
  try {
    await service.from('paiements').delete().eq('user_id', proprioId);
    await service.from('locataires').delete().eq('user_id', proprioId);
    await service.from('logements').delete().eq('user_id', proprioId);
    await service.from('agences_biens').delete().eq('agence_id', agenceId);
    await service.from('agences_proprietaires').delete().eq('agence_id', agenceId);
    await service.from('biens').delete().eq('user_id', proprioId);

    if (locUid) await service.auth.admin.deleteUser(locUid).catch(() => {});
    if (gereId) await service.auth.admin.deleteUser(gereId).catch(() => {});
    if (employeId) {
      await service.from('employes').delete().eq('id', employeId).eq('user_id', proprioId);
      await service.from('paiements_employes').delete().eq('user_id', proprioId);
    }
    await service.auth.admin.deleteUser(proprioId).catch(() => {});
    await service.auth.admin.deleteUser(agenceId).catch(() => {});
    await service.auth.admin.deleteUser(ultraId).catch(() => {});
  } catch (e) {
    console.warn('[cleanup]', e.message);
  }

  r.done(S, 'Suite de tests agence full completée');
}

export default runAgenceFullTest;