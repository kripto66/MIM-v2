// ============================================================
// MIM - Suite import CSV (onboarding propriétaire)
//
// Couvre : modèles téléchargeables, import biens / logements /
// locataires / employés (validation, doublons, comptes créés,
// mot de passe initial + must_change_password), isolation entre
// propriétaires, réimportation.
// ============================================================

import { api, newJar, expectSuccess } from './lib.js';

const S = 'import';

function csv(headers, rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '\uFEFF' + [headers.join(';'), ...rows.map((r) => r.map(esc).join(';'))].join('\n') + '\n';
}

const B_HEADERS = ['nom', 'type', 'adresse', 'ville', 'pays', 'description'];
const L_HEADERS = ['bien', 'nom', 'type', 'loyer', 'nombre_chambres', 'adresse', 'statut', 'description'];
const LOC_HEADERS = ['nom', 'prenom', 'email', 'telephone', 'bien', 'logement', 'loyer', 'jour_echeance', 'date_entree', 'statut'];
const EMP_HEADERS = ['nom', 'prenom', 'email', 'telephone', 'poste', 'bien', 'salaire', 'date_embauche', 'statut'];
const G_HEADERS = [
  'bien', 'type_bien', 'adresse_bien', 'ville', 'pays', 'description_bien',
  'logement', 'type_logement', 'nombre_chambres', 'loyer', 'statut_logement', 'description_logement',
  'locataire_nom', 'locataire_prenom', 'locataire_email', 'locataire_telephone',
  'jour_echeance', 'date_entree',
  'employe_nom', 'employe_prenom', 'employe_poste', 'employe_salaire',
  'employe_telephone', 'employe_email',
];

const SUFFIX = Date.now() % 100000;

export async function runImport(r, ctx) {
  const { service } = ctx;

  // Un propriétaire dédié (espace vide) pour toute la suite.
  const email = `importown${SUFFIX}@mimtest.com`;
  const jar = newJar();
  const reg = await api('/auth/register', {
    method: 'POST',
    jar,
    body: { account_type: 'proprietaire', name: 'Import Owner', email, phone: '+221760000001', password: 'Test1234!', password_confirm: 'Test1234!' },
  });
  if (reg.status !== 201 || !reg.data?.success) {
    r.blocked(S, 'propriétaire de test créé', JSON.stringify(reg.data).slice(0, 200));
    return;
  }
  const me = await api('/auth/me', { jar });
  const ownerId = me.data.user.id;

  const bien1 = `Immo Palmiers ${SUFFIX}`;
  const bien2 = `Immo Almadies ${SUFFIX}`;
  const log1 = `Appartement B1-${SUFFIX}`;
  const log2 = `Appartement B2-${SUFFIX}`;
  const logChambre = `Chambre C1-${SUFFIX}`;
  const locNom = `Diop Import${SUFFIX}`;
  const locPrenom = 'Amadou';
  const empNom = `Fall Import${SUFFIX}`;
  const empPrenom = 'Moussa';

  // ----------------------------------------------------------
  await r.section('onboarding / status', async () => {
    const st = await api('/onboarding/status', { jar });
    if (expectSuccess(r, st, S, r) && st.data.needsOnboarding === true) {
      r.pass(S, 'espace vide → needsOnboarding=true');
    } else {
      r.fail(S, 'espace vide → needsOnboarding=true', JSON.stringify(st.data));
    }
  });

  // ----------------------------------------------------------
  await r.section('modèles CSV téléchargeables', async () => {
    for (const cat of ['biens', 'logements', 'locataires', 'employes', 'grouped']) {
      const res = await fetch(`http://127.0.0.1:3100/api/import/templates/${cat}`, {
        headers: { Cookie: jar.cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
      });
const text = await res.text();
      if (res.status === 200 && text.split('\n')[0].includes(';')) {
        r.pass(S, `modèle ${cat} téléchargeable (CSV)`);
      } else {
        r.fail(S, `modèle ${cat} téléchargeable (CSV)`, `statut ${res.status} — ${text.slice(0, 80)}`);
      }
    }
    const bad = await api('/import/templates/nawak', { jar });
    if (bad.status === 404) r.pass(S, 'catégorie inconnue → 404');
    else r.fail(S, 'catégorie inconnue → 404', `statut ${bad.status}`);
  });

  // ----------------------------------------------------------
  await r.section('import biens', async () => {
    const empty = await api('/import/preview', {
      method: 'POST',
      jar,
      body: { categories: ['biens'], files: { biens: { filename: 'v.csv', content: '' } } },
    });
    if (empty.status === 400) r.pass(S, 'fichier vide → rejeté');
    else r.fail(S, 'fichier vide → rejeté', `statut ${empty.status}`);

    const noType = csv(['nom'], [['Sans type']]);
    const noTypeP = await api('/import/preview', {
      method: 'POST',
      jar,
      body: { categories: ['biens'], files: { biens: { filename: 'n.csv', content: noType } } },
    });
    if (expectSuccess(r, noTypeP, S, r) && noTypeP.data.categories[0].errors.some((e) => e.champ === 'type')) {
      r.pass(S, 'colonne « type » manquante → erreur en-tête');
    } else {
      r.fail(S, 'colonne « type » manquante → erreur en-tête', JSON.stringify(noTypeP.data));
    }

    const content = csv(B_HEADERS, [
      [bien1, 'immeuble', '12 Av', 'Dakar', 'Sénégal', 'B1'],
      [bien2, 'villa', 'Lot 45', 'Dakar', 'Sénégal', ''],
    ]);
    const prev = await api('/import/preview', {
      method: 'POST',
      jar,
      body: { categories: ['biens'], files: { biens: { filename: 'b.csv', content } } },
    });
    if (expectSuccess(r, prev, S, r) && prev.data.totals.ok === 2 && prev.data.totals.errors === 0) {
      r.pass(S, 'aperçu 2 biens valides');
    } else {
      r.fail(S, 'aperçu 2 biens valides', JSON.stringify(prev.data));
    }

    const exe = await api('/import/execute', {
      method: 'POST',
      jar,
      body: { categories: ['biens'], files: { biens: { filename: 'b.csv', content } } },
    });
    if (expectSuccess(r, exe, S, r, [201]) && exe.data.report.categories[0].created === 2) {
      r.pass(S, 'exécution : 2 biens créés');
    } else {
      r.fail(S, 'exécution : 2 biens créés', JSON.stringify(exe.data));
    }

    const dupContent = csv(B_HEADERS, [[bien1, 'immeuble', '', '', '', '']]);
    const dupP = await api('/import/preview', {
      method: 'POST',
      jar,
      body: { categories: ['biens'], files: { biens: { filename: 'd.csv', content: dupContent } } },
    });
    if (expectSuccess(r, dupP, S, r) && dupP.data.categories[0].duplicates.length === 1) {
      r.pass(S, 'doublon bien détecté à l’aperçu');
    } else {
      r.fail(S, 'doublon bien détecté à l’aperçu', JSON.stringify(dupP.data));
    }
    const dupE = await api('/import/execute', {
      method: 'POST',
      jar,
      body: { categories: ['biens'], files: { biens: { filename: 'd.csv', content: dupContent } }, duplicatePolicy: 'ignore' },
    });
    if (expectSuccess(r, dupE, S, r, [201]) && dupE.data.report.categories[0].ignored === 1) {
      r.pass(S, 'doublon bien ignoré à l’exécution (politique ignore)');
    } else {
      r.fail(S, 'doublon bien ignoré à l’exécution (politique ignore)', JSON.stringify(dupE.data));
    }
  });

  // ----------------------------------------------------------
  await r.section('import logements', async () => {
    const noBien = csv(L_HEADERS, [['Bien fantôme 9Z', log1, 'appartement', '150000', '2', '', 'libre', '']]);
    const noBienP = await api('/import/preview', {
      method: 'POST',
      jar,
      body: { categories: ['logements'], files: { logements: { filename: 'l.csv', content: noBien } } },
    });
    if (expectSuccess(r, noBienP, S, r) && noBienP.data.categories[0].errors.some((e) => /n'existe pas/.test(e.message))) {
      r.pass(S, 'bien inexistant → erreur ligne');
    } else {
      r.fail(S, 'bien inexistant → erreur ligne', JSON.stringify(noBienP.data));
    }

    const badLoyer = csv(L_HEADERS, [[bien1, log1, 'appartement', '0', '2', '', 'libre', '']]);
    const badLoyerP = await api('/import/preview', {
      method: 'POST',
      jar,
      body: { categories: ['logements'], files: { logements: { filename: 'l.csv', content: badLoyer } } },
    });
    if (expectSuccess(r, badLoyerP, S, r) && badLoyerP.data.categories[0].errors.some((e) => /loyer/.test(e.message))) {
      r.pass(S, 'loyer invalide → erreur ligne');
    } else {
      r.fail(S, 'loyer invalide → erreur ligne', JSON.stringify(badLoyerP.data));
    }

    const content = csv(L_HEADERS, [
      [bien1, log1, 'appartement', '150000', '2', '', 'libre', ''],
      [bien1, log2, 'appartement', '120000', '1', '', 'libre', ''],
      [bien2, logChambre, 'chambre', '40000', '', '', 'libre', ''],
    ]);
    const prev = await api('/import/preview', {
      method: 'POST',
      jar,
      body: { categories: ['logements'], files: { logements: { filename: 'l.csv', content } } },
    });
    if (expectSuccess(r, prev, S, r) && prev.data.totals.ok === 3) {
      r.pass(S, 'aperçu 3 logements valides');
    } else {
      r.fail(S, 'aperçu 3 logements valides', JSON.stringify(prev.data));
    }

    const exe = await api('/import/execute', {
      method: 'POST',
      jar,
      body: { categories: ['logements'], files: { logements: { filename: 'l.csv', content } } },
    });
    if (expectSuccess(r, exe, S, r, [201]) && exe.data.report.categories[0].created === 3) {
      r.pass(S, 'exécution : 3 logements créés');
    } else {
      r.fail(S, 'exécution : 3 logements créés', JSON.stringify(exe.data));
    }

    const dupP = await api('/import/preview', {
      method: 'POST',
      jar,
      body: { categories: ['logements'], files: { logements: { filename: 'l.csv', content: csv(L_HEADERS, [[bien1, log1, 'appartement', '150000', '2', '', 'libre', '']]) } } },
    });
    if (expectSuccess(r, dupP, S, r) && dupP.data.categories[0].duplicates.length === 1) {
      r.pass(S, 'doublon logement détecté');
    } else {
      r.fail(S, 'doublon logement détecté', JSON.stringify(dupP.data));
    }
  });

  // ----------------------------------------------------------
  await r.section('import locataires + comptes', async () => {
    const content = csv(LOC_HEADERS, [
      [locNom, locPrenom, `imp${SUFFIX}a@exemple.com`, '+22177111111', bien1, log1, '', '5', '2026-09-01', 'actif'],
      ['Ndiaye', 'Aminata', '', '+22178222222', bien1, log2, '120000', '10', '', 'actif'],
      ['Sow', 'Ibra', '', '+22179333333', bien2, logChambre, '99999', '15', '', 'actif'],
    ]);
    const prev = await api('/import/preview', {
      method: 'POST',
      jar,
      body: { categories: ['locataires'], files: { locataires: { filename: 'l.csv', content } } },
    });
    if (expectSuccess(r, prev, S, r) && prev.data.totals.ok === 3 && prev.data.categories[0].accounts.length === 3) {
      r.pass(S, 'aperçu 3 locataires + 3 usernames générés');
    } else {
      r.fail(S, 'aperçu 3 locataires + 3 usernames générés', JSON.stringify(prev.data));
    }

    const exe = await api('/import/execute', {
      method: 'POST',
      jar,
      body: { categories: ['locataires'], files: { locataires: { filename: 'l.csv', content } } },
    });
    if (!expectSuccess(r, exe, S, r, [201])) {
      r.fail(S, 'exécution locataires', JSON.stringify(exe.data));
      return;
    }
    const cat = exe.data.report.categories[0];
    if (cat.created === 3 && cat.accounts.length === 3) {
      r.pass(S, 'exécution : 3 locataires + 3 comptes créés');
    } else {
      r.fail(S, 'exécution : 3 locataires + 3 comptes créés', JSON.stringify(cat));
      return;
    }

    // Le premier locataire doit exister en base, rattaché au bon logement.
    const { data: fiche } = await service
      .from('locataires')
      .select('id, nom, account_uid, username, logement_id')
      .eq('user_id', ownerId)
      .ilike('nom', locNom)
      .maybeSingle();
    if (fiche?.account_uid && fiche?.username && fiche?.logement_id) {
      r.pass(S, 'fiche locataire créée avec compte + logement');
    } else {
      r.fail(S, 'fiche locataire créée avec compte + logement', JSON.stringify(fiche));
    }

    // Le profil auth du locataire : must_change_password = true, mot de passe initial.
    if (fiche?.account_uid) {
      const { data: profile } = await service
        .from('profiles')
        .select('must_change_password, username')
        .eq('id', fiche.account_uid)
        .maybeSingle();
      if (profile?.must_change_password === true && profile.username === fiche.username) {
        r.pass(S, 'profil locataire : must_change_password=true + username');
      } else {
        r.fail(S, 'profil locataire : must_change_password=true + username', JSON.stringify(profile));
      }

      // Connexion avec le mot de passe initial 1234 → changement forcé demandé.
      const jarT = newJar();
      const login = await api('/auth/login', {
        method: 'POST',
        jar: jarT,
        body: { identifier: fiche.username, password: '1234' },
      });
      if (expectSuccess(r, login, S, r) && login.data.mustChangePassword === true) {
        r.pass(S, 'login locataire avec 1234 → mustChangePassword');
      } else {
        r.fail(S, 'login locataire avec 1234 → mustChangePassword', JSON.stringify(login.data));
      }

      // Le mot de passe n'est JAMAIS stocké en clair dans auth.users.
      const { data: authUser } = await service.auth.admin.getUserById(fiche.account_uid);
      const userJson = JSON.stringify(authUser || {});
      if (authUser?.user && !userJson.includes('1234')) {
        r.pass(S, 'mot de passe initial non stocké en clair');
      } else {
        r.fail(S, 'mot de passe initial non stocké en clair', userJson.slice(0, 200));
      }

      // Changement forcé du mot de passe.
      const newPw = 'NewPass$987';
      const forced = await api('/auth/change-password', {
        method: 'PUT',
        jar: jarT,
        body: { password: newPw, password_confirm: newPw },
      });
      if (expectSuccess(r, forced, S, r)) r.pass(S, 'changement forcé sans mot de passe actuel');
      else r.fail(S, 'changement forcé sans mot de passe actuel', JSON.stringify(forced.data));

      const jarT2 = newJar();
      const loginNew = await api('/auth/login', {
        method: 'POST',
        jar: jarT2,
        body: { identifier: fiche.username, password: newPw },
      });
      if (expectSuccess(r, loginNew, S, r) && loginNew.data.mustChangePassword === false) {
        r.pass(S, 'nouveau mot de passe accepté + flag levé');
      } else {
        r.fail(S, 'nouveau mot de passe accepté + flag levé', JSON.stringify(loginNew.data));
      }
    }

    // Username unique : un second locataire du même nom reçoit un suffixe.
    const dupName = csv(LOC_HEADERS, [[locNom, locPrenom, '', '+22170444444', bien1, log1, '', '20', '', 'actif']]);
    const dupNameP = await api('/import/preview', {
      method: 'POST',
      jar,
      body: { categories: ['locataires'], files: { locataires: { filename: 'd.csv', content: dupName } } },
    });
    if (expectSuccess(r, dupNameP, S, r) && dupNameP.data.categories[0].duplicates.length === 1) {
      r.pass(S, 'locataire même nom + même logement → doublon détecté');
    } else {
      r.fail(S, 'locataire même nom + même logement → doublon détecté', JSON.stringify(dupNameP.data));
    }

    // Deux locataires du même nom sur des logements différents → usernames distincts.
    const twoSame = csv(LOC_HEADERS, [
      ['Cisse', 'Mamadou', '', '+22170555555', bien1, log1, '', '1', '', 'actif'],
      ['Cisse', 'Mamadou', '', '+22170666666', bien2, logChambre, '', '2', '', 'actif'],
    ]);
    const twoSameP = await api('/import/preview', {
      method: 'POST',
      jar,
      body: { categories: ['locataires'], files: { locataires: { filename: 'd.csv', content: twoSame } } },
    });
    if (expectSuccess(r, twoSameP, S, r) && twoSameP.data.categories[0].accounts.length === 2) {
      const unames = twoSameP.data.categories[0].accounts.map((a) => a.username);
      if (unames[0] !== unames[1]) {
        r.pass(S, 'homonymes → usernames distincts', `${unames[0]} / ${unames[1]}`);
      } else {
        r.fail(S, 'homonymes → usernames distincts', `usernames identiques : ${unames[0]}`);
      }
    } else {
      r.fail(S, 'homonymes → usernames distincts', JSON.stringify(twoSameP.data));
    }
  });
  // ----------------------------------------------------------
  await r.section('import employés + comptes', async () => {
    const content = csv(EMP_HEADERS, [
      [empNom, empPrenom, `imp${SUFFIX}e@exemple.com`, '+22176123456', 'Gardien', '', '150000', '2026-09-01', 'actif'],
      ['Ba', 'Fatou', '', '+22175111111', 'Femme de ménage', '', '35000', '', 'actif'],
    ]);
    const prev = await api('/import/preview', {
      method: 'POST',
      jar,
      body: { categories: ['employes'], files: { employes: { filename: 'e.csv', content } } },
    });
    if (expectSuccess(r, prev, S, r) && prev.data.totals.ok === 2 && prev.data.categories[0].accounts.length === 2) {
      r.pass(S, 'aperçu 2 employés + 2 usernames générés');
    } else {
      r.fail(S, 'aperçu 2 employés + 2 usernames générés', JSON.stringify(prev.data));
    }

    const exe = await api('/import/execute', {
      method: 'POST',
      jar,
      body: { categories: ['employes'], files: { employes: { filename: 'e.csv', content } } },
    });
    if (!expectSuccess(r, exe, S, r, [201])) {
      r.fail(S, 'exécution employés', JSON.stringify(exe.data));
      return;
    }
    const cat = exe.data.report.categories[0];
    if (cat.created === 2 && cat.accounts.length === 2) {
      r.pass(S, 'exécution : 2 employés + 2 comptes créés');
    } else {
      r.fail(S, 'exécution : 2 employés + 2 comptes créés', JSON.stringify(cat));
      return;
    }

    const { data: fiche } = await service
      .from('employes')
      .select('id, nom, account_uid, username, salaire, poste')
      .eq('user_id', ownerId)
      .ilike('nom', empNom)
      .maybeSingle();
    if (fiche?.account_uid && fiche?.username && Number(fiche.salaire) === 150000) {
      r.pass(S, 'fiche employé créée avec compte + salaire');
    } else {
      r.fail(S, 'fiche employé créée avec compte + salaire', JSON.stringify(fiche));
    }

    if (fiche?.account_uid) {
      const { data: profile } = await service
        .from('profiles')
        .select('must_change_password, account_type')
        .eq('id', fiche.account_uid)
        .maybeSingle();
      if (profile?.must_change_password === true && profile.account_type === 'employe') {
        r.pass(S, 'profil employé : must_change_password=true + type employe');
      } else {
        r.fail(S, 'profil employé : must_change_password=true + type employe', JSON.stringify(profile));
      }

      // Login employé avec 1234 ? changement forcé demandé (exigence mission).
      const jarE = newJar();
      const login = await api('/auth/login', {
        method: 'POST',
        jar: jarE,
        body: { identifier: fiche.username, password: '1234' },
      });
      if (expectSuccess(r, login, S, r) && login.data.mustChangePassword === true) {
        r.pass(S, 'login employé avec 1234 ? mustChangePassword');
      } else {
        r.fail(S, 'login employé avec 1234 ? mustChangePassword', JSON.stringify(login.data));
      }
    }

    // Doublon employé (même nom) ? détecté.
    const dupP = await api('/import/preview', {
      method: 'POST',
      jar,
      body: { categories: ['employes'], files: { employes: { filename: 'd.csv', content: csv(EMP_HEADERS, [[empNom, empPrenom, '', '', 'Gardien', '', '50000', '', 'actif']]) } } },
    });
    if (expectSuccess(r, dupP, S, r) && dupP.data.categories[0].duplicates.length === 1) {
      r.pass(S, 'doublon employé détecté');
    } else {
      r.fail(S, 'doublon employé détecté', JSON.stringify(dupP.data));
    }
  });

  // ----------------------------------------------------------
  await r.section('sécurité : isolation entre propriétaires', async () => {
    // Un second propriétaire ne peut PAS référencer les biens/logements du premier.
    const otherEmail = `importother${SUFFIX}@mimtest.com`;
    const jar2 = newJar();
    const reg2 = await api('/auth/register', {
      method: 'POST',
      jar: jar2,
      body: { account_type: 'proprietaire', name: 'Autre Import', email: otherEmail, phone: '+221760000002', password: 'Test1234!', password_confirm: 'Test1234!' },
    });
    if (reg2.status !== 201) {
      r.blocked(S, 'second propriétaire créé', JSON.stringify(reg2.data).slice(0, 200));
      return;
    }

    // Le bien du premier propriétaire n'existe pas pour le second.
    const stealLogement = csv(L_HEADERS, [[bien1, 'Appartement Volé', 'appartement', '100000', '2', '', 'libre', '']]);
    const stealP = await api('/import/preview', {
      method: 'POST',
      jar: jar2,
      body: { categories: ['logements'], files: { logements: { filename: 's.csv', content: stealLogement } } },
    });
    const err = stealP.data?.categories?.[0]?.errors || [];
    if (expectSuccess(r, stealP, S, r) && err.some((e) => /n'existe pas/.test(e.message))) {
      r.pass(S, 'bien d’un autre propriétaire ? introuvable (pas de fuite)');
    } else {
      r.fail(S, 'bien d’un autre propriétaire ? introuvable (pas de fuite)', JSON.stringify(stealP.data));
    }

    // Le bien du premier n'apparaît pas comme doublon chez le second (pas de fuite).
    const dupBien = csv(B_HEADERS, [[bien1, 'immeuble', '', '', '', '']]);
    const dupP2 = await api('/import/preview', {
      method: 'POST',
      jar: jar2,
      body: { categories: ['biens'], files: { biens: { filename: 'b.csv', content: dupBien } } },
    });
    if (expectSuccess(r, dupP2, S, r) && dupP2.data.categories[0].duplicates.length === 0) {
      r.pass(S, 'bien de A non signalé comme doublon chez B');
    } else {
      r.fail(S, 'bien de A non signalé comme doublon chez B', JSON.stringify(dupP2.data));
    }

    // Le second ne peut PAS créer un logement sur le bien du premier.
    const exe2 = await api('/import/execute', {
      method: 'POST',
      jar: jar2,
      body: { categories: ['logements'], files: { logements: { filename: 's.csv', content: stealLogement } } },
    });
    if (exe2.status === 409 && exe2.data.prepared) {
      r.pass(S, 'exécution bloquée sur bien d’un autre propriétaire');
    } else {
      r.fail(S, 'exécution bloquée sur bien d’un autre propriétaire', `statut ${exe2.status} ${JSON.stringify(exe2.data).slice(0, 200)}`);
    }
  });

  // ----------------------------------------------------------
  await r.section('réimportation (doublons)', async () => {
    // Le même fichier de biens ? doublons détectés, politique ignore.
    const content = csv(B_HEADERS, [[bien1, 'immeuble', '12 Av', 'Dakar', 'Sénégal', 'B1']]);
    const prev = await api('/import/preview', {
      method: 'POST',
      jar,
      body: { categories: ['biens'], files: { biens: { filename: 'b.csv', content } } },
    });
    if (expectSuccess(r, prev, S, r) && prev.data.categories[0].duplicates.length === 1) {
      r.pass(S, 'réimport : doublon détecté à l’aperçu');
    } else {
      r.fail(S, 'réimport : doublon détecté à l’aperçu', JSON.stringify(prev.data));
    }

    // Politique abort ? refus global.
    const abort = await api('/import/execute', {
      method: 'POST',
      jar,
      body: { categories: ['biens'], files: { biens: { filename: 'b.csv', content } }, duplicatePolicy: 'abort' },
    });
    if (abort.status === 409 && /doublon/.test(String(abort.data?.message || ''))) {
      r.pass(S, 'réimport : politique abort ? import annulé');
    } else {
      r.fail(S, 'réimport : politique abort ? import annulé', `statut ${abort.status} ${JSON.stringify(abort.data).slice(0, 200)}`);
    }

    // Politique update ? mise à jour des champs fournis.
    const upd = await api('/import/execute', {
      method: 'POST',
      jar,
      body: { categories: ['biens'], files: { biens: { filename: 'b.csv', content: csv(B_HEADERS, [[bien1, 'immeuble', '999 Route Modifiée', '', '', '']]) } }, duplicatePolicy: 'update' },
    });
    if (expectSuccess(r, upd, S, r, [201]) && upd.data.report.categories[0].updated === 1) {
      r.pass(S, 'réimport : politique update ? 1 bien mis à jour');
    } else {
      r.fail(S, 'réimport : politique update ? 1 bien mis à jour', JSON.stringify(upd.data));
    }
    const { data: updatedBien } = await service
      .from('biens')
      .select('adresse')
      .eq('user_id', ownerId)
      .ilike('nom', bien1)
      .maybeSingle();
    if (updatedBien?.adresse === '999 Route Modifiée') {
      r.pass(S, 'adresse effectivement mise à jour en base');
    } else {
      r.fail(S, 'adresse effectivement mise à jour en base', JSON.stringify(updatedBien));
    }
  });

  // ----------------------------------------------------------
  await r.section('import groupé « tout-en-un »', async () => {
    const gBien1 = `Residence Groupe ${SUFFIX}`;
    const gBien2 = `Villa Groupe ${SUFFIX}`;
    const gLogA = `Appartement GA-${SUFFIX}`;
    const gLogB = `Chambre GB-${SUFFIX}`;
    const gLocNom = `Ndiaye Groupe${SUFFIX}`;
    const gEmpNom = `Sarr Groupe${SUFFIX}`;
    const groupedBody = (content) => ({
      mode: 'grouped',
      files: { grouped: { filename: 'tout-en-un.csv', content } },
    });

    // Fichier : bien 1 + 2 logements (héritage) + locataire sur le
    // premier logement ; puis un second bien avec un employé (le
    // changement de bien ne doit PAS hériter du logement précédent).
    const okCsv = csv(G_HEADERS, [
      [gBien1, 'immeuble', 'Av Groupe', 'Dakar', 'Sénégal', '',
        gLogA, 'appartement', '2', '150000', '', '',
        gLocNom, 'Awa', `awa.groupe${SUFFIX}@exemple.com`, '+221770000101', '5', '',
        '', '', '', '', '', ''],
      ['', '', '', '', '', '',
        gLogB, 'chambre', '1', '60000', '', '',
        '', '', '', '', '', '',
        '', '', '', '', '', ''],
      [gBien2, 'villa', '', 'Dakar', 'Sénégal', '',
        '', '', '', '', '', '',
        '', '', '', '', '', '',
        gEmpNom, 'Moussa', 'Jardinier', '70000', '+221770000102', ''],
    ]);

    // Aucun fichier groupé fourni ? rejet clair.
    const noFile = await api('/import/preview', {
      method: 'POST',
      jar,
      body: { mode: 'grouped', files: {}, duplicatePolicy: 'ignore' },
    });
    if (noFile.status === 400 && /manquant/i.test(String(noFile.data?.message || ''))) {
      r.pass(S, 'groupé sans fichier ? rejeté');
    } else {
      r.fail(S, 'groupé sans fichier ? rejeté', `statut ${noFile.status} ${JSON.stringify(noFile.data).slice(0, 160)}`);
    }

    // Ligne mêlant locataire et employé ? rejet structurel (ligne d'origine).
    const mixCsv = csv(G_HEADERS, [
      [gBien1, 'immeuble', '', 'Dakar', 'Sénégal', '',
        'Appartement Mixte', 'appartement', '1', '50000', '', '',
        'Nom Mixte', '', '+221770000103', '', '', '',
        'Emp Mixte', '', 'Gardien', '50000', '', ''],
    ]);
    const mix = await api('/import/preview', { method: 'POST', jar, body: groupedBody(mixCsv) });
    if (mix.status === 400 && /à la fois/.test(String(mix.data?.message || ''))) {
      r.pass(S, 'groupé : ligne locataire + employé ? rejetée');
    } else {
      r.fail(S, 'groupé : ligne locataire + employé ? rejetée', `statut ${mix.status} ${JSON.stringify(mix.data).slice(0, 200)}`);
    }

    // Bien déclaré sans type_bien ? l'erreur du moteur porte le champ « type ».
    const noTypeCsv = csv(G_HEADERS, [
      [`Bien Sans Type ${SUFFIX}`, '', '', '', '', '',
        'Chambre ST', 'chambre', '1', '40000', '', '',
        '', '', '', '', '', '',
        '', '', '', '', '', ''],
    ]);
    const noTypeG = await api('/import/preview', { method: 'POST', jar, body: groupedBody(noTypeCsv) });
    const biensErrs = noTypeG.data?.categories?.find((c) => c.category === 'biens')?.errors || [];
    if (expectSuccess(r, noTypeG, S, r) && biensErrs.some((e) => e.champ === 'type')) {
      r.pass(S, 'groupé : type_bien manquant ? erreur « type »');
    } else {
      r.fail(S, 'groupé : type_bien manquant ? erreur « type »', JSON.stringify(noTypeG.data).slice(0, 300));
    }

    // Aperçu complet : héritage + classification.
    const prev = await api('/import/preview', { method: 'POST', jar, body: groupedBody(okCsv) });
    if (
      expectSuccess(r, prev, S, r) &&
      prev.data.totals.errors === 0 &&
      prev.data.totals.ok === 6 &&
      prev.data.categories.length === 4 &&
      prev.data.categories.find((c) => c.category === 'biens')?.total === 2 &&
      prev.data.categories.find((c) => c.category === 'logements')?.total === 2 &&
      prev.data.categories.find((c) => c.category === 'locataires')?.accounts.length === 1 &&
      prev.data.categories.find((c) => c.category === 'employes')?.accounts.length === 1
    ) {
      r.pass(S, 'groupé : aperçu 2 biens + 2 logements + 1 locataire + 1 employé');
    } else {
      r.fail(S, 'groupé : aperçu 2 biens + 2 logements + 1 locataire + 1 employé', JSON.stringify(prev.data).slice(0, 400));
    }

    // Exécution + effets attendus en base.
    const exe = await api('/import/execute', { method: 'POST', jar, body: groupedBody(okCsv) });
    if (expectSuccess(r, exe, S, r, [201]) && exe.data.report.totals.created === 6) {
      r.pass(S, 'groupé : exécution ? 6 éléments créés');
    } else {
      r.fail(S, 'groupé : exécution ? 6 éléments créés', `statut ${exe.status} ${JSON.stringify(exe.data).slice(0, 300)}`);
      return;
    }

    const { data: locaRow } = await service
      .from('locataires')
      .select('id, username, logement_id, bien_id')
      .eq('user_id', ownerId)
      .ilike('nom', gLocNom)
      .maybeSingle();
    if (locaRow?.username && locaRow.logement_id && locaRow.bien_id) {
      r.pass(S, 'groupé : locataire rattaché au logement importé');
    } else {
      r.fail(S, 'groupé : locataire rattaché au logement importé', JSON.stringify(locaRow));
    }

    const { data: logsBien1 } = await service
      .from('logements')
      .select('id, statut, nom')
      .eq('user_id', ownerId)
      .eq('bien_id', locaRow.bien_id);
    const logA = (logsBien1 || []).find((l) => l.nom === gLogA);
    if ((logsBien1 || []).length === 2 && logA?.statut === 'occupe') {
      r.pass(S, 'groupé : 2 logements sous le bien 1, logement occupé');
    } else {
      r.fail(S, 'groupé : 2 logements sous le bien 1, logement occupé', JSON.stringify(logsBien1));
    }

    const { data: empRow } = await service
      .from('employes')
      .select('id')
      .eq('user_id', ownerId)
      .ilike('nom', gEmpNom)
      .maybeSingle();
    const { data: lienEmp } = await service
      .from('employes_biens')
      .select('id, bien_id')
      .eq('employe_id', empRow?.id || '')
      .maybeSingle();
    if (empRow && lienEmp && lienEmp.bien_id && lienEmp.bien_id !== locaRow.bien_id) {
      r.pass(S, 'groupé : employé affecté à son bien (pas d’héritage parasite)');
    } else {
      r.fail(S, 'groupé : employé affecté à son bien (pas d’héritage parasite)', JSON.stringify({ empRow, lienEmp }));
    }
  });

  // ----------------------------------------------------------
  await r.section('onboarding / status (après import)', async () => {
    const st = await api('/onboarding/status', { jar });
    if (expectSuccess(r, st, S, r) && st.data.needsOnboarding === false) {
      r.pass(S, 'espace configuré ? needsOnboarding=false');
    } else {
      r.fail(S, 'espace configuré ? needsOnboarding=false', JSON.stringify(st.data));
    }
  });
}
