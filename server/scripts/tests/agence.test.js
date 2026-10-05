// ============================================================
// MIM - Suite « agence » : module agence sans état orphelin (H-19)
//   * création d'un propriétaire géré : 201 seulement si le lien de
//     gestion existe et si les identifiants retournés sont utilisables
//   * compensation de compte : rollback testable (aucun compte orphelin)
//   * locataire avec compte + logement embarqué créé en une passe
//   * échec de validation APRÈS création d'un logement → aucun orphelin
//   * suppressions : mêmes invariants que le CRUD propriétaire
//     (historique locataire / financier) + archivage du compte Auth
//   * quotas du plan (biens / logements / locataires) appliqués côté
//     agence exactement comme pour le propriétaire
// ============================================================

import { api, newJar, createConfirmedSession } from './lib.js';
import { rollbackCreatedAccount, tenantEmailFor } from '../../utils/tenantAccount.js';

const S = 'agence';
const PW = 'Test1234!';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runAgence(r, ctx) {
  const { service } = ctx;
  const stamp = Date.now();

  // --- Comptes de base : une agence et son propriétaire géré ---
  let agence;
  let proprio;
  try {
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

  const agenceId = agence.user.id;
  const proprioId = proprio.user.id;
  const jar = agence.jar;

  const bienId = Number(`9${stamp}`.slice(0, 12));
  const { error: bienErr } = await service.from('biens').insert({
    id: bienId,
    user_id: proprioId,
    nom: `is_test Bien H19 ${stamp}`,
    type: 'appartement',
    adresse: 'Rue H19',
    ville: 'Dakar',
  });
  if (bienErr) {
    r.blocked(S, 'bien H19', bienErr.message);
    return;
  }

  const { data: lg1Row, error: lgErr } = await service
    .from('logements')
    .insert({
      user_id: proprioId,
      bien_id: bienId,
      nom: 'is_test Logement H19 1',
      type: 'appartement',
      adresse: 'Rue H19',
      loyer_mensuel: 75000,
      statut: 'libre',
    })
    .select('id')
    .single();
  if (lgErr || !lg1Row?.id) {
    r.blocked(S, 'logement H19', lgErr?.message || 'identifiant manquant');
    return;
  }
  const lg1Id = lg1Row.id;

  const { error: lienErr } = await service
    .from('agences_proprietaires')
    .insert({ user_id: agenceId, agence_id: agenceId, proprietaire_id: proprioId, statut: 'actif' });
  if (lienErr) {
    r.blocked(S, 'mandat H19', lienErr.message);
    return;
  }
  const { error: bienLienErr } = await service
    .from('agences_biens')
    .insert({ user_id: agenceId, agence_id: agenceId, proprietaire_id: proprioId, bien_id: bienId, statut: 'actif' });
  if (bienLienErr) {
    r.blocked(S, 'mandat bien H19', bienLienErr.message);
    return;
  }

  const countBienLogements = async () => {
    const { count } = await service
      .from('logements')
      .select('id', { count: 'exact', head: true })
      .eq('bien_id', bienId);
    return count ?? -1;
  };

  let gereId = null;
  let p2Id = null;
  let planCode = null;
  let locUid = null;
  let locUsername = null;
  let locPassword = null;
  let employeId = null;
  let employeUid = null;

  try {
    // --- 1. Propriétaire géré : 201 seulement avec lien + identifiants ---
    const createProp = await api('/agence/proprietaires', {
      method: 'POST',
      jar,
      body: { nom: `is_test Géré H19 ${stamp}` },
    });
    const lienCree = createProp.data?.data;
    gereId = lienCree?.proprietaire_id || null;
    if (
      createProp.status === 201 &&
      lienCree?.statut === 'actif' &&
      createProp.data?.generatedUsername &&
      createProp.data?.generatedPassword
    ) {
      r.pass(S, 'H-19 : propriétaire géré créé ET rattaché (201 + identifiants)');
    } else {
      r.fail(
        S,
        'H-19 : propriétaire géré créé ET rattaché (201 + identifiants)',
        `statut ${createProp.status} ${JSON.stringify(createProp.data || {}).slice(0, 200)}`
      );
    }

    if (gereId) {
      const { data: gereProfile } = await service
        .from('profiles')
        .select('account_type, must_change_password')
        .eq('id', gereId)
        .maybeSingle();
      if (gereProfile?.account_type === 'proprietaire' && gereProfile?.must_change_password === true) {
        r.pass(S, 'H-19 : profil du propriétaire géré provisionné (proprietaire, changement de mot de passe exigé)');
      } else {
        r.fail(S, 'H-19 : profil du propriétaire géré provisionné', JSON.stringify(gereProfile));
      }

      const loginGere = await api('/auth/login', {
        method: 'POST',
        jar: newJar(),
        body: {
          email: tenantEmailFor(createProp.data.generatedUsername),
          password: createProp.data.generatedPassword,
        },
      });
      if (loginGere.status === 200) {
        r.pass(S, 'H-19 : identifiants retournés réellement utilisables (connexion du propriétaire géré)');
      } else {
        r.fail(S, 'H-19 : identifiants retournés réellement utilisables', `statut ${loginGere.status}`);
      }
    }

    // --- 2. Compensation : rollback de compte (profil + compte) ---
    const { data: ghost, error: ghostErr } = await service.auth.admin.createUser({
      email: `h19.rollback.${stamp}@mimtest.com`,
      password: PW,
      email_confirm: true,
      user_metadata: { name: 'is_test Rollback H19' },
    });
    const ghostId = ghost?.user?.id;
    if (ghostErr || !ghostId) {
      r.blocked(S, 'compte fantôme H19', ghostErr?.message || 'identifiant manquant');
      return;
    }
    const rb = await rollbackCreatedAccount(service, ghostId, 'test-h19');
    const { data: ghostAfter, error: ghostAfterErr } = await service.auth.admin.getUserById(ghostId);
    const { data: ghostProfile } = await service.from('profiles').select('id').eq('id', ghostId).maybeSingle();
    if (rb.ok && (ghostAfterErr || !ghostAfter?.user?.id) && !ghostProfile) {
      r.pass(S, 'H-19 : rollback de compte supprime le compte Auth ET son profil (aucun orphelin)');
    } else {
      r.fail(S, 'H-19 : rollback de compte supprime le compte Auth ET son profil', JSON.stringify({ rb, ghostAfterErr: ghostAfterErr?.message, ghostProfile }));
    }

    // --- 3. Locataire + compte créé via le module agence ---
    const createLoc = await api(`/agence/bien/${bienId}/locataires`, {
      method: 'POST',
      jar,
      body: { autoAccount: true, nom: `is_test Loc H19 ${stamp}`, logement_id: lg1Id, jour_echeance: 5 },
    });
    const locRow = createLoc.data?.data;
    const locId = locRow?.id;
    locUid = locRow?.account_uid || null;
    locUsername = createLoc.data?.account?.username;
    locPassword = createLoc.data?.account?.password;
    if (createLoc.status === 201 && locId && locUid && locUsername && locPassword) {
      r.pass(S, 'H-19 : locataire + compte + échéance créés en une passe (201)');
    } else {
      r.fail(S, 'H-19 : locataire + compte + échéance créés en une passe (201)', `statut ${createLoc.status} ${JSON.stringify(createLoc.data || {}).slice(0, 240)}`);
    }

    const { data: lg1Apres } = await service.from('logements').select('statut').eq('id', lg1Id).maybeSingle();
    if (lg1Apres?.statut === 'occupe') {
      r.pass(S, 'H-19 : logement marqué occupé après création du locataire');
    } else {
      r.fail(S, 'H-19 : logement marqué occupé après création du locataire', JSON.stringify(lg1Apres));
    }

    // --- 4. Échec de validation APRÈS création du logement embarqué ---
    if (locId) {
      const avant = await countBienLogements();
      const mauvais = await api(`/agence/bien/${bienId}/locataires/${locId}`, {
        method: 'PUT',
        jar,
        body: {
          logement_new: { nom: 'is_test Orphelin H19', type: 'appartement', adresse: 'Rue H19', loyer_mensuel: 60000 },
          jour_echeance: 99,
        },
      });
      const apres = await countBienLogements();
      if (mauvais.status === 400 && mauvais.data?.errors?.jour_echeance && apres === avant) {
        r.pass(S, 'H-19 : validation en échec → aucun logement orphelin (remboursé)');
      } else {
        r.fail(S, 'H-19 : validation en échec → aucun logement orphelin (remboursé)', `statut ${mauvais.status}, logements ${avant} → ${apres}`);
      }
    }

    // --- 4 bis. Non-régression : un e-mail déjà utilisé comme e-mail de
    // récupération ne doit plus faire échouer la création (colonne UNIQUE).
    // Le compte ET la fiche sont créés, un simple avertissement est renvoyé.
    const emailPartage = `is_test.partage.${stamp}@mimtest.com`;
    const bicompte = async (suffixe) => {
      const lg = await api(`/agence/bien/${bienId}/logements`, {
        method: 'POST',
        jar,
        body: { nom: `is_test Lg ${suffixe} ${stamp}`, type: 'chambre', loyer_mensuel: 45000 },
      });
      return api(`/agence/bien/${bienId}/locataires`, {
        method: 'POST',
        jar,
        body: {
          autoAccount: true,
          nom: `is_test Loc ${suffixe} ${stamp}`,
          email: emailPartage,
          logement_id: lg.data?.data?.id,
          jour_echeance: 5,
        },
      });
    };
    const premier = await bicompte('A');
    const second = await bicompte('B');
    if (
      premier.status === 201 &&
      second.status === 201 &&
      second.data?.data?.account_uid &&
      Array.isArray(second.data?.warnings) &&
      second.data.warnings.length > 0
    ) {
      r.pass(S, 'H-19 : e-mail de récupération déjà utilisé → 2e locataire créé + avertissement');
    } else {
      r.fail(
        S,
        'H-19 : e-mail de récupération déjà utilisé → 2e locataire créé + avertissement',
        `statuts ${premier.status}/${second.status} ${JSON.stringify(second.data || {}).slice(0, 200)}`
      );
    }

    // --- 4 ter. MODE 2 : employés, salaires, tâches et moyens de paiement
    // scopés sur le MANDAT (requireMandateBien) et rattachés au
    // PROPRIÉTAIRE GÉRÉ — jamais au compte de l'agence.
    const base = `/agence/bien/${bienId}`;

    const listeBiens = await api(`${base}/biens`, { jar });
    if (listeBiens.status === 200 && (listeBiens.data?.data || []).some((b) => Number(b.id) === Number(bienId))) {
      r.pass(S, 'MODE 2 : /biens scopé renvoie les biens du propriétaire géré');
    } else {
      r.fail(S, 'MODE 2 : /biens scopé renvoie les biens du propriétaire géré', `statut ${listeBiens.status}`);
    }

    const createEmp = await api(`${base}/employes`, {
      method: 'POST',
      jar,
      body: {
        nom: 'Employe',
        prenom: 'Awa',
        poste: 'Gardienne',
        telephone: '+221771234567',
        email: `is_test.emp.${stamp}@mimtest.com`,
        salaire: 125000,
        date_embauche: '2026-01-05',
        statut: 'actif',
        biens: [bienId],
      },
    });
    const empRow = createEmp.data?.data;
    employeId = empRow?.id || null;
    employeUid = empRow?.account_uid || null;
    if (createEmp.status === 201 && employeId && employeUid && createEmp.data?.account?.username && createEmp.data?.account?.password) {
      r.pass(S, 'MODE 2 : compte employé créé via l\'agence (201 + identifiants)');
    } else {
      r.fail(S, 'MODE 2 : compte employé créé via l\'agence (201 + identifiants)', `statut ${createEmp.status} ${JSON.stringify(createEmp.data || {}).slice(0, 240)}`);
    }

    if (employeId) {
      const { data: ficheEmp } = await service
        .from('employes')
        .select('user_id, account_uid, salaire')
        .eq('id', employeId)
        .maybeSingle();
      if (ficheEmp?.user_id === proprioId && ficheEmp?.account_uid === employeUid) {
        r.pass(S, 'MODE 2 : l\'employé appartient au PROPRIÉTAIRE GÉRÉ (pas à l\'agence)');
      } else {
        r.fail(S, 'MODE 2 : l\'employé appartient au PROPRIÉTAIRE GÉRÉ (pas à l\'agence)', JSON.stringify(ficheEmp));
      }

      const { data: affectation } = await service
        .from('employes_biens')
        .select('bien_id')
        .eq('employe_id', employeId)
        .maybeSingle();
      if (Number(affectation?.bien_id) === Number(bienId)) {
        r.pass(S, 'MODE 2 : l\'employé est affecté au bien géré');
      } else {
        r.fail(S, 'MODE 2 : l\'employé est affecté au bien géré', JSON.stringify(affectation));
      }

      const listEmp = await api(`${base}/employes`, { jar });
      if (listEmp.status === 200 && (listEmp.data?.data || []).some((e) => Number(e.id) === Number(employeId))) {
        r.pass(S, 'MODE 2 : liste des employés du propriétaire via le scope bien');
      } else {
        r.fail(S, 'MODE 2 : liste des employés du propriétaire via le scope bien', `statut ${listEmp.status}`);
      }

      // Salaire versé : même contrat que /api/employes/:id/paiements.
      const salaire = await api(`${base}/employes/${employeId}/paiements`, {
        method: 'POST',
        jar,
        body: { montant: 125000, mois: '2026-03', statut: 'attente', date_paiement: '2026-03-05' },
      });
      const histSalaire = await api(`${base}/employes/${employeId}/paiements`, { jar });
      const { data: ligneSalaire } = await service
        .from('paiements_employes')
        .select('user_id, montant')
        .eq('employe_id', employeId)
        .maybeSingle();
      if (
        salaire.status === 201 &&
        (histSalaire.data?.data || []).length === 1 &&
        ligneSalaire?.user_id === proprioId &&
        Number(ligneSalaire?.montant) === 125000
      ) {
        r.pass(S, 'MODE 2 : salaire versé puis relu (imputé au propriétaire géré)');
      } else {
        r.fail(S, 'MODE 2 : salaire versé puis relu (imputé au propriétaire géré)', `statuts ${salaire.status}/${histSalaire.status} ${JSON.stringify(ligneSalaire)}`);
      }

      // Un employé d'un AUTRE propriétaire reste hors de portée.
      const employeEtranger = await service
        .from('employes')
        .insert({ user_id: p2Id || proprioId, nom: 'is_test Intrus', salaire: 1, statut: 'actif' })
        .select('id')
        .single();
      if (employeEtranger?.data?.id && p2Id) {
        const intrusion = await api(`${base}/employes/${employeEtranger.data.id}/paiements`, {
          method: 'POST',
          jar,
          body: { montant: 1000, mois: '2026-03', statut: 'attente' },
        });
        if (intrusion.status === 404) {
          r.pass(S, 'MODE 2 : employé d\'un autre propriétaire inaccessible (404)');
        } else {
          r.fail(S, 'MODE 2 : employé d\'un autre propriétaire inaccessible (404)', `statut ${intrusion.status}`);
        }
      }

      const tache = await api(`${base}/tasks`, {
        method: 'POST',
        jar,
        body: { titre: 'is_test Tache H19', employe_uid: employeUid, statut: 'a_faire' },
      });
      if (tache.status === 201 && tache.data?.data?.employe_uid === employeUid && tache.data?.data?.user_id === proprioId) {
        r.pass(S, 'MODE 2 : tâche assignée à l\'employé du propriétaire géré');
      } else {
        r.fail(S, 'MODE 2 : tâche assignée à l\'employé du propriétaire géré', `statut ${tache.status} ${JSON.stringify(tache.data || {}).slice(0, 200)}`);
      }
    }

    const moyen = await api(`${base}/moyens-paiement`, {
      method: 'POST',
      jar,
      body: { type: 'wave', nom_titulaire: 'is_test Wave H19', numero: '+221771234567' },
    });
    const listMoyens = await api(`${base}/moyens-paiement`, { jar });
    const { data: moyenRow } = await service
      .from('moyens_paiement')
      .select('user_id')
      .eq('id', moyen.data?.data?.id || 0)
      .maybeSingle();
    if (moyen.status === 201 && listMoyens.status === 200 && moyenRow?.user_id === proprioId) {
      r.pass(S, 'MODE 2 : moyen de paiement du propriétaire via le scope bien');
    } else {
      r.fail(S, 'MODE 2 : moyen de paiement du propriétaire via le scope bien', `statuts ${moyen.status}/${listMoyens.status} ${JSON.stringify(moyenRow)}`);
    }

    // --- 5. Suppression d'un logement occupé : refus (parité CRUD) ---
    const delOccupe = await api(`/agence/bien/${bienId}/logements/${lg1Id}`, { method: 'DELETE', jar });
    const { data: lg1Toujours } = await service.from('logements').select('id').eq('id', lg1Id).maybeSingle();
    if (delOccupe.status === 409 && delOccupe.data?.code === 'TENANT_HISTORY_PRESENT' && lg1Toujours) {
      r.pass(S, 'H-19 : suppression d\'un logement avec historique locataire refusée (409)');
    } else {
      r.fail(S, 'H-19 : suppression d\'un logement avec historique locataire refusée (409)', `statut ${delOccupe.status} code=${delOccupe.data?.code}`);
    }

    // --- 6. Suppression d'un logement avec historique financier ---
    const createLg2 = await api(`/agence/bien/${bienId}/logements`, {
      method: 'POST',
      jar,
      body: { nom: 'is_test Logement H19 2', type: 'appartement', adresse: 'Rue H19', loyer_mensuel: 50000 },
    });
    const lg2Id = createLg2.data?.data?.id;
    if (createLg2.status === 201 && lg2Id) {
      r.pass(S, 'H-19 : création d\'un logement via le module agence (201)');
    } else {
      r.fail(S, 'H-19 : création d\'un logement via le module agence (201)', `statut ${createLg2.status} ${JSON.stringify(createLg2.data || {}).slice(0, 200)}`);
    }

    if (lg2Id) {
      const { error: payErr } = await service.from('paiements').insert({
        user_id: proprioId,
        logement_id: lg2Id,
        montant: 50000,
        mois: '2026-09',
        statut: 'attente',
      });
      if (payErr) {
        r.fail(S, 'H-19 : paiement historique injecté', payErr.message);
      } else {
        const delPayante = await api(`/agence/bien/${bienId}/logements/${lg2Id}`, { method: 'DELETE', jar });
        if (delPayante.status === 409 && delPayante.data?.code === 'FINANCIAL_HISTORY_PRESENT') {
          r.pass(S, 'H-19 : suppression d\'un logement avec paiements historiques refusée (409)');
        } else {
          r.fail(S, 'H-19 : suppression d\'un logement avec paiements historiques refusée (409)', `statut ${delPayante.status} code=${delPayante.data?.code}`);
        }
      }
    }

    // --- 7. Archivage du locataire : fiche, compte Auth et logement ---
    if (locId && locUid) {
      const arch = await api(`/agence/bien/${bienId}/locataires/${locId}`, { method: 'DELETE', jar });
      const { data: fiche } = await service
        .from('locataires')
        .select('statut, superseded_at, account_uid')
        .eq('id', locId)
        .maybeSingle();
      const { data: lgLibre } = await service.from('logements').select('statut').eq('id', lg1Id).maybeSingle();
      if (arch.status === 200 && fiche?.statut === 'inactif' && fiche?.superseded_at && fiche?.account_uid === null && lgLibre?.statut === 'libre') {
        r.pass(S, 'H-19 : archivage locataire → fiche close, compte détaché, logement libéré');
      } else {
        r.fail(S, 'H-19 : archivage locataire → fiche close, compte détaché, logement libéré', `statut ${arch.status} ${JSON.stringify({ fiche, lgLibre })}`);
      }

      const loginBanni = await api('/auth/login', {
        method: 'POST',
        jar: newJar(),
        body: { email: tenantEmailFor(locUsername), password: locPassword },
      });
      if (loginBanni.status !== 200) {
        r.pass(S, 'H-19 : compte Auth du locataire désactivé après archivage');
      } else {
        r.fail(S, 'H-19 : compte Auth du locataire désactivé après archivage', `statut ${loginBanni.status}`);
      }
    }

    // --- 8. Quotas du plan : biens / logements / locataires ---
    planCode = `h19_plan_${stamp}`;
    const { error: planErr } = await service.from('plans').insert({
      code: planCode,
      nom: `is_test Plan H19 ${stamp}`,
      prix: 0,
      max_immeubles: 1,
      max_logements: 1,
      max_locataires: 1,
      actif: true,
    });
    if (planErr) {
      r.fail(S, 'H-19 : plan de test à quotas inséré', planErr.message);
    } else {
      const { data: created2, error: p2Err } = await service.auth.admin.createUser({
        email: `proprio2.h19.${stamp}@mimtest.com`,
        password: PW,
        email_confirm: true,
        user_metadata: { name: `is_test Proprio2 H19 ${stamp}` },
        app_metadata: { mim_account_type: 'proprietaire' },
      });
      p2Id = created2?.user?.id || null;
      if (p2Err || !p2Id) {
        r.fail(S, 'H-19 : propriétaire 2 créé', p2Err?.message || 'identifiant manquant');
      } else {
        // Le trigger mim_trial_subscription_on_signup a déjà écrit une
        // souscription d'essai à la création du profil : on upsert (et on
        // écrase plan_id, sinon planForSubscription retiendrait l'essai).
        const { data: planRow } = await service.from('plans').select('id').eq('code', planCode).maybeSingle();
        const { error: subErr } = await service.from('subscriptions').upsert({
          user_id: p2Id,
          plan: planCode,
          plan_id: planRow?.id ?? null,
          statut: 'actif',
          date_expiration: new Date(Date.now() + 30 * 86400000).toISOString(),
        }, { onConflict: 'user_id' });
        if (subErr) r.fail(S, 'H-19 : abonnement du propriétaire 2 inséré', subErr.message);

        await service.from('agences_proprietaires').insert({
          user_id: agenceId,
          agence_id: agenceId,
          proprietaire_id: p2Id,
          statut: 'actif',
        });

        const bien2Id = Number(`8${stamp}`.slice(0, 12));
        const { error: bien2Err } = await service.from('biens').insert({
          id: bien2Id,
          user_id: p2Id,
          nom: `is_test Bien H19 2 ${stamp}`,
          type: 'appartement',
          adresse: 'Rue H19',
          ville: 'Dakar',
        });
        const { data: lg2bRow, error: lg2bErr } = await service
          .from('logements')
          .insert({
            user_id: p2Id,
            bien_id: bien2Id,
            nom: 'is_test Logement H19 quota',
            type: 'appartement',
            adresse: 'Rue H19',
            loyer_mensuel: 40000,
            statut: 'occupe',
          })
          .select('id')
          .single();
        if (!bien2Err && !lg2bErr && lg2bRow?.id) {
          await service.from('agences_biens').insert({
            user_id: agenceId,
            agence_id: agenceId,
            proprietaire_id: p2Id,
            bien_id: bien2Id,
            statut: 'actif',
          });
          await service.from('locataires').insert({
            user_id: p2Id,
            bien_id: bien2Id,
            logement_id: lg2bRow.id,
            nom: 'is_test Loc quota H19',
            statut: 'actif',
            jour_echeance: 5,
          });

          // Le cache d'abonnement serveur vit 2 s : on le laisse expirer
          // avant de mesurer les plafonds.
          await sleep(2200);

          const quotaBiens = await api(`/agence/proprietaires/${p2Id}/biens`, {
            method: 'POST',
            jar,
            body: { nom: 'Bien H19 quota', type: 'appartement' },
          });
          if (quotaBiens.status === 409 && quotaBiens.data?.code === 'IMMEUBLES_LIMIT_REACHED') {
            r.pass(S, 'H-19 : quota immeubles du plan appliqué à la création de bien (409)');
          } else {
            r.fail(S, 'H-19 : quota immeubles du plan appliqué à la création de bien (409)', `statut ${quotaBiens.status} code=${quotaBiens.data?.code}`);
          }

          const quotaLg = await api(`/agence/bien/${bien2Id}/logements`, {
            method: 'POST',
            jar,
            body: { nom: 'Logement H19 quota', type: 'appartement', adresse: 'Rue H19', loyer_mensuel: 40000 },
          });
          if (quotaLg.status === 409 && quotaLg.data?.code === 'LOGEMENTS_LIMIT_REACHED') {
            r.pass(S, 'H-19 : quota logements du plan appliqué via l\'agence (409)');
          } else {
            r.fail(S, 'H-19 : quota logements du plan appliqué via l\'agence (409)', `statut ${quotaLg.status} code=${quotaLg.data?.code}`);
          }

          const quotaLoc = await api(`/agence/bien/${bien2Id}/locataires`, {
            method: 'POST',
            jar,
            body: { autoAccount: true, nom: 'is_test Loc quota H19 2', logement_id: lg2bRow.id },
          });
          if (quotaLoc.status === 409 && quotaLoc.data?.code === 'LOCATAIRES_LIMIT_REACHED') {
            r.pass(S, 'H-19 : quota locataires du plan appliqué via l\'agence (409)');
          } else {
            r.fail(S, 'H-19 : quota locataires du plan appliqué via l\'agence (409)', `statut ${quotaLoc.status} code=${quotaLoc.data?.code}`);
          }
        } else {
          r.fail(S, 'H-19 : parc du propriétaire 2 monté', bien2Err?.message || lg2bErr?.message || 'logement manquant');
        }
      }
    }
  } finally {
    // --- Nettoyage : d'abord les lignes, puis les comptes ---
    if (employeUid) {
      await service.from('moyens_paiement_employes').delete().eq('employe_uid', employeUid);
    }
    if (employeId) {
      await service.from('paiements_employes').delete().eq('employe_id', employeId);
      await service.from('employes_biens').delete().eq('employe_id', employeId);
      await service.from('employes').delete().eq('id', employeId);
    }
    await service.from('employes').delete().eq('user_id', proprioId);
    await service.from('moyens_paiement').delete().eq('user_id', proprioId);
    await service.from('paiements').delete().eq('user_id', proprioId);
    await service.from('locataires').delete().eq('user_id', proprioId);
    await service.from('logements').delete().eq('user_id', proprioId);
    await service.from('agences_biens').delete().eq('agence_id', agenceId);
    await service.from('agences_proprietaires').delete().eq('agence_id', agenceId);
    await service.from('biens').delete().eq('user_id', proprioId);

    if (p2Id) {
      await service.from('employes').delete().eq('user_id', p2Id);
      await service.from('paiements').delete().eq('user_id', p2Id);
      await service.from('locataires').delete().eq('user_id', p2Id);
      await service.from('logements').delete().eq('user_id', p2Id);
      await service.from('biens').delete().eq('user_id', p2Id);
      await service.from('subscriptions').delete().eq('user_id', p2Id);
    }
    if (planCode) await service.from('plans').delete().eq('code', planCode);

    if (employeUid) await service.auth.admin.deleteUser(employeUid).catch(() => {});
    if (locUid) await service.auth.admin.deleteUser(locUid).catch(() => {});
    if (gereId) await service.auth.admin.deleteUser(gereId).catch(() => {});
    if (p2Id) await service.auth.admin.deleteUser(p2Id).catch(() => {});
    await service.auth.admin.deleteUser(proprioId).catch(() => {});
    await service.auth.admin.deleteUser(agenceId).catch(() => {});
  }
}
