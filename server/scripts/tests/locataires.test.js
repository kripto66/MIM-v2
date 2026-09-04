// ============================================================
// MIM - Suite « Locataire en une seule étape »
//
// Vérifie le formulaire unique : le POST /api/locataires (mode
// autoAccount) crée logement + compte + échéance en une requête,
// avec username généré et mot de passe initial 1234.
// ============================================================

import { api, expectSuccess, newJar } from './lib.js';

const S = 'locataires';

function currentMoisUTC() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function nextMois(mois) {
  const [y, m] = mois.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function runLocataires(r, ctx) {
  const service = ctx.service;
  const owner1 = ctx.seed.owners[0];
  const owner2 = ctx.seed.owners[1];
  const jar = owner1.jar;
  const jar2 = owner2.jar;
  const moisCourant = currentMoisUTC();

  const createdLocataires = [];

  // ----------------------------------------------------------
  await r.section('création unique : logement + compte + échéance', async () => {
    const res = await api('/locataires', {
      method: 'POST',
      jar,
      body: {
        nom: 'Amadou Diop',
        email: 'amadou.diop@exemple.com',
        phone: '+221771234567',
        jour_echeance: 5,
        date_entree: '2026-01-01',
        statut: 'actif',
        autoAccount: true,
        logement: {
          bien_id: owner1.bienId,
          nom: 'Appartement 3B',
          type: 'appartement',
          nombre_chambres: 3,
          adresse: 'Rue 12, Sicap Mbao',
          loyer_mensuel: 175000,
        },
      },
    });

    if (!expectSuccess(r, res, S, r, [201])) {
      r.fail(S, 'création en une requête', JSON.stringify(res.data));
      return;
    }
    if (res.data.autoAccount !== true || res.data.account?.username !== 'amadou.diop' || res.data.account?.password !== '1234') {
      r.fail(S, 'création en une requête', `autoAccount/account inattendus : ${JSON.stringify(res.data.account)}`);
    } else {
      r.pass(S, 'création en une requête (201, autoAccount, username amadou.diop, mdp 1234)');
    }

    const fiche = res.data.data;
    createdLocataires.push(fiche);

    // Fiche locataire en base.
    const { data: row } = await service
      .from('locataires')
      .select('id, user_id, account_uid, username, logement_id, jour_echeance, statut')
      .eq('id', fiche.id)
      .maybeSingle();
    if (
      row &&
      row.user_id === owner1.id &&
      row.account_uid &&
      row.username === 'amadou.diop' &&
      row.logement_id &&
      row.jour_echeance === 5 &&
      row.statut === 'actif'
    ) {
      r.pass(S, 'fiche locataire complète (compte lié, logement, échéance le 5)');
    } else {
      r.fail(S, 'fiche locataire complète', JSON.stringify(row));
    }

    // Logement créé + occupé.
    const { data: lg } = await service
      .from('logements')
      .select('id, bien_id, nom, loyer_mensuel, statut')
      .eq('id', row?.logement_id)
      .maybeSingle();
    if (lg && lg.bien_id === owner1.bienId && lg.nom === 'Appartement 3B' && Number(lg.loyer_mensuel) === 175000 && lg.statut === 'occupe') {
      r.pass(S, 'logement auto-créé (occupé, loyer 175 000)');
    } else {
      r.fail(S, 'logement auto-créé', JSON.stringify(lg));
    }

    // Échéance initiale du mois courant.
    const { data: ech } = await service
      .from('paiements')
      .select('id, user_id, locataire_id, logement_id, montant, mois, statut')
      .eq('locataire_id', fiche.id)
      .maybeSingle();
    if (
      ech &&
      ech.user_id === owner1.id &&
      ech.logement_id === row?.logement_id &&
      Number(ech.montant) === 175000 &&
      ech.mois === moisCourant &&
      ech.statut === 'attente'
    ) {
      r.pass(S, `échéance initiale créée (${moisCourant}, 175 000, attente)`);
    } else {
      r.fail(S, 'échéance initiale créée', JSON.stringify(ech));
    }

    // Profil du compte : must_change_password.
    const { data: profile } = await service
      .from('profiles')
      .select('must_change_password, account_type')
      .eq('id', row?.account_uid)
      .maybeSingle();
    if (profile?.must_change_password === true && profile.account_type === 'locataire') {
      r.pass(S, 'profil : must_change_password=true, type locataire');
    } else {
      r.fail(S, 'profil : must_change_password=true', JSON.stringify(profile));
    }

    // Login avec 1234 possible (mot de passe initial fonctionnel).
    const login = await api('/auth/login', {
      method: 'POST',
      body: { identifier: 'amadou.diop', password: '1234' },
    });
    if (login.status === 200 && login.data.mustChangePassword === true) {
      r.pass(S, 'login avec 1234 → mustChangePassword renvoyé');
    } else {
      r.fail(S, 'login avec 1234 → mustChangePassword renvoyé', `statut ${login.status} ${JSON.stringify(login.data).slice(0, 200)}`);
    }
  });

  // ----------------------------------------------------------
  await r.section('usernames uniques (3 x Amadou Diop)', async () => {
    const usernames = [];
    for (let i = 0; i < 3; i++) {
      const res = await api('/locataires', {
        method: 'POST',
        jar,
        body: {
          nom: 'Amadou Diop',
          jour_echeance: 10,
          statut: 'actif',
          autoAccount: true,
          logement: {
            bien_id: owner1.bienId,
            nom: `Appartement Homonyme ${i + 1}`,
            type: 'appartement',
            nombre_chambres: 2,
            adresse: 'Rue des Homonymes',
            loyer_mensuel: 120000,
          },
        },
      });
      if (!expectSuccess(r, res, S, r, [201])) {
        r.fail(S, `création homonyme ${i + 1}`, JSON.stringify(res.data));
        return;
      }
      usernames.push(res.data.account?.username);
      createdLocataires.push(res.data.data);
    }

    const unique = new Set(usernames);
    const expected = ['amadou.diop2', 'amadou.diop3', 'amadou.diop4'];
    if (usernames.length === 3 && unique.size === 3 && usernames.every((u, i) => u === expected[i])) {
      r.pass(S, 'usernames distincts : ' + usernames.join(', '));
    } else {
      r.fail(S, 'usernames distincts', JSON.stringify(usernames));
    }
  });

  // ----------------------------------------------------------
  await r.section('première connexion : username + mot de passe', async () => {
    const res = await api('/locataires', {
      method: 'POST',
      jar,
      body: {
        nom: 'Fatou Ba',
        phone: '+221770000001',
        jour_echeance: 8,
        statut: 'actif',
        autoAccount: true,
        logement: {
          bien_id: owner1.bienId,
          nom: 'Chambre C1',
          type: 'chambre',
          adresse: 'Adresse Fatou',
          loyer_mensuel: 40000,
        },
      },
    });
    if (!expectSuccess(r, res, S, r, [201])) {
      r.fail(S, 'locataire Fatou Ba créé', JSON.stringify(res.data));
      return;
    }
    const fiche = res.data.data;
    const baseUsername = res.data.account?.username || 'fatou.ba';
    const newUsername = `${baseUsername}x`.slice(0, 32);
    createdLocataires.push(fiche);

    // Connexion avec le mot de passe initial.
    const jarT = newJar();
    const login = await api('/auth/login', {
      method: 'POST',
      jar: jarT,
      body: { identifier: baseUsername, password: '1234' },
    });
    if (login.status === 200 && login.data.mustChangePassword === true) {
      r.pass(S, 'connexion initiale (1234) → changement forcé');
    } else {
      r.fail(S, 'connexion initiale (1234) → changement forcé', `statut ${login.status}`);
      return;
    }

    // Changement du username.
    const updU = await api('/auth/update-username', {
      method: 'PUT',
      jar: jarT,
      body: { username: newUsername },
    });
    if (expectSuccess(r, updU, S, r) && updU.data.username === newUsername) {
      r.pass(S, `username modifié (${baseUsername} → ${newUsername})`);
    } else {
      r.fail(S, 'username modifié', JSON.stringify(updU.data));
    }

    // Changement du mot de passe (premier accès, sans mot de passe courant).
    const updP = await api('/auth/change-password', {
      method: 'PUT',
      jar: jarT,
      body: { password: 'NouveauMotDePasse!1', password_confirm: 'NouveauMotDePasse!1' },
    });
    if (expectSuccess(r, updP, S, r)) {
      r.pass(S, 'mot de passe modifié (mode forcé, sans mdp courant)');
    } else {
      r.fail(S, 'mot de passe modifié', JSON.stringify(updP.data));
    }

    // Le profil n'exige plus de changement.
    const { data: profile } = await service
      .from('profiles')
      .select('must_change_password, username')
      .eq('id', fiche.account_uid)
      .maybeSingle();
    if (profile?.must_change_password === false && profile.username === newUsername) {
      r.pass(S, 'must_change_password désactivé + username synchronisé');
    } else {
      r.fail(S, 'must_change_password désactivé', JSON.stringify(profile));
    }

    // Re-connexion avec les nouveaux identifiants.
    const login2 = await api('/auth/login', {
      method: 'POST',
      jar: newJar(),
      body: { identifier: newUsername, password: 'NouveauMotDePasse!1' },
    });
    if (login2.status === 200 && login2.data.mustChangePassword === false) {
      r.pass(S, 're-connexion (nouveau username + mdp) → compte normal');
    } else {
      r.fail(S, 're-connexion (nouveau username + mdp)', `statut ${login2.status}`);
    }

    // L'ancien username ne fonctionne plus.
    const oldLogin = await api('/auth/login', {
      method: 'POST',
      body: { identifier: baseUsername, password: '1234' },
    });
    if (oldLogin.status === 401) r.pass(S, 'ancien username refusé');
    else r.fail(S, 'ancien username refusé', `statut ${oldLogin.status}`);
  });

  // ----------------------------------------------------------
  await r.section('paiement immédiat du locataire créé', async () => {
    const fiche = createdLocataires[0];
    const { data: ech } = await service
      .from('paiements')
      .select('id, logement_id, montant, mois, statut')
      .eq('locataire_id', fiche.id)
      .eq('statut', 'attente')
      .maybeSingle();
    if (!ech) {
      r.fail(S, 'échéance disponible pour le paiement', 'aucun paiement attente');
      return;
    }

    // Moyen de paiement du propriétaire.
    const moyen = await api('/moyens-paiement', {
      method: 'POST',
      jar,
      body: { type: 'wave', nom_titulaire: 'Propriétaire 1', numero: '+221771000000', actif: true },
    });
    if (!expectSuccess(r, moyen, S, r, [201])) {
      r.fail(S, 'moyen de paiement créé', JSON.stringify(moyen.data));
      return;
    }
    const moyenId = moyen.data.data.id;

    // Le locataire voit les moyens du propriétaire.
    const jarT = newJar();
    const login = await api('/auth/login', { method: 'POST', jar: jarT, body: { identifier: 'amadou.diop', password: '1234' } });
    if (login.status !== 200) {
      r.fail(S, 'login locataire pour le paiement', `statut ${login.status}`);
      return;
    }
    const moyens = await api('/locataire/moyens-paiement', { jar: jarT });
    if (expectSuccess(r, moyens, S, r) && (moyens.data.data || []).some((m) => m.id === moyenId)) {
      r.pass(S, 'locataire voit le moyen de paiement du propriétaire');
    } else {
      r.fail(S, 'locataire voit le moyen de paiement', JSON.stringify(moyens.data).slice(0, 300));
    }

    // Déclaration du paiement.
    const dec = await api(`/locataire/paiements/${ech.id}/declarer`, {
      method: 'POST',
      jar: jarT,
      body: { moyen_paiement_id: moyenId, reference: 'WAVE-PROG-1' },
    });
    if (expectSuccess(r, dec, S, r) && dec.data.data?.statut === 'en_validation') {
      r.pass(S, 'déclaration de paiement → en_validation');
    } else {
      r.fail(S, 'déclaration de paiement', JSON.stringify(dec.data));
    }

    // Notification au propriétaire.
    const notif = await api('/notifications', { jar });
    if (expectSuccess(r, notif, S, r) && (notif.data.data || []).some((n) => n.type === 'paiement')) {
      r.pass(S, 'propriétaire notifié de la déclaration');
    } else {
      r.fail(S, 'propriétaire notifié de la déclaration', JSON.stringify(notif.data).slice(0, 300));
    }

// Validation par le propriétaire → paiement payé. L'échéance du mois
    // suivant n'est PAS créée prématurément (mois strictement futur) : le
    // locataire reste sur le mois courant (assurance à l'ouverture du dashboard).
    const val = await api(`/paiements-validation/${ech.id}/valider`, { method: 'POST', jar });
    if (expectSuccess(r, val, S, 'validation propriétaire → paiement payé') && val.data.data?.statut === 'paye') {
      r.pass(S, 'validation propriétaire → paiement payé');
    } else {
      r.fail(S, 'validation propriétaire', JSON.stringify(val.data));
    }

    const moisSuivant = nextMois(moisCourant);
    if (val.data.echeance == null) r.pass(S, `échéance future (${moisSuivant}) non annoncée`);
    else r.fail(S, 'échéance future non annoncée', JSON.stringify(val.data.echeance));

    const { data: suiv } = await service
      .from('paiements')
      .select('id, mois, montant, statut')
      .eq('locataire_id', fiche.id)
      .eq('mois', moisSuivant)
      .maybeSingle();
    if (!suiv) r.pass(S, `aucune échéance prématurée (${moisSuivant}) en base`);
    else r.fail(S, 'aucune échéance prématurée en base', JSON.stringify(suiv));
  });

  // ----------------------------------------------------------
  await r.section('édition : compte conservé', async () => {
    const fiche = createdLocataires.find((f) => f.nom === 'Fatou Ba') || createdLocataires[2];
    const upd = await api(`/locataires/${fiche.id}`, {
      method: 'PUT',
      jar,
      body: { nom: 'Fatou Ba Modifiée', phone: '+221770000002', jour_echeance: 12 },
    });
    if (expectSuccess(r, upd, S, r) && upd.data.data.nom === 'Fatou Ba Modifiée') {
      r.pass(S, 'locataire modifié (nom, téléphone, échéance)');
    } else {
      r.fail(S, 'locataire modifié', JSON.stringify(upd.data));
    }

    // Aucun nouveau compte : l'ancien username continue de fonctionner.
    const login = await api('/auth/login', {
      method: 'POST',
      body: { identifier: `${fiche.username}x`, password: 'NouveauMotDePasse!1' },
    });
    if (login.status === 200) r.pass(S, 'compte inchangé après édition (username toujours valide)');
    else r.fail(S, 'compte inchangé après édition', `statut ${login.status}`);
  });

  // ----------------------------------------------------------
  await r.section('isolation entre propriétaires', async () => {
    // Le bien du propriétaire 1 n'existe pas pour le propriétaire 2.
    const steal = await api('/locataires', {
      method: 'POST',
      jar: jar2,
      body: {
        nom: 'Voleur',
        jour_echeance: 5,
        statut: 'actif',
        autoAccount: true,
        logement: {
          bien_id: owner1.bienId,
          nom: 'Appartement Volé',
          type: 'appartement',
          nombre_chambres: 2,
          adresse: 'X',
          loyer_mensuel: 50000,
        },
      },
    });
    if (steal.status === 400) r.pass(S, 'bien de A → refusé pour B (400)');
    else r.fail(S, 'bien de A → refusé pour B', `statut ${steal.status} ${JSON.stringify(steal.data).slice(0, 200)}`);

    // Le logement de A ne peut pas être référencé par B.
    const logementDeA = createdLocataires[0].logement_id;
    const stealLg = await api('/locataires', {
      method: 'POST',
      jar: jar2,
      body: {
        nom: 'Voleur 2',
        logement_id: logementDeA,
        jour_echeance: 5,
        statut: 'actif',
        autoAccount: true,
      },
    });
    if (stealLg.status === 400) r.pass(S, 'logement de A → refusé pour B (400)');
    else r.fail(S, 'logement de A → refusé pour B', `statut ${stealLg.status} ${JSON.stringify(stealLg.data).slice(0, 200)}`);

    // Aucune donnée de A visible chez B.
    const listB = await api('/locataires', { jar: jar2 });
    const nomsDeA = createdLocataires.map((f) => f.nom);
    if (expectSuccess(r, listB, S, r) && !(listB.data.data || []).some((t) => nomsDeA.includes(t.nom))) {
      r.pass(S, 'aucun locataire de A visible chez B');
    } else {
      r.fail(S, 'aucun locataire de A visible chez B', JSON.stringify(listB.data).slice(0, 300));
    }
  });

  // ----------------------------------------------------------
  await r.section('suppression : compte désactivé + logement libéré', async () => {
    const fiche = createdLocataires[0];
    const logementId = fiche.logement_id;

    const del = await api(`/locataires/${fiche.id}`, { method: 'DELETE', jar });
    if (expectSuccess(r, del, S, r)) {
      r.pass(S, 'locataire supprimé');
    } else {
      r.fail(S, 'locataire supprimé', JSON.stringify(del.data));
    }

    const login = await api('/auth/login', { method: 'POST', body: { identifier: 'amadou.diop', password: '1234' } });
    if (login.status === 401) r.pass(S, 'compte désactivé après suppression');
    else r.fail(S, 'compte désactivé après suppression', `statut ${login.status}`);

    const { data: lg } = await service.from('logements').select('statut').eq('id', logementId).maybeSingle();
    if (lg?.statut === 'libre') r.pass(S, 'logement libéré (statut libre)');
    else r.fail(S, 'logement libéré', JSON.stringify(lg));
  });
}