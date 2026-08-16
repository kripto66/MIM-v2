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
    for (const cat of ['biens', 'logements', 'locataires', 'employes']) {
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
  await r.section('import employ�s + comptes', async () => {
    const content = csv(EMP_HEADERS, [
      [empNom, empPrenom, `imp${SUFFIX}e@exemple.com`, '+22176123456', 'Gardien', '', '150000', '2026-09-01', 'actif'],
      ['Ba', 'Fatou', '', '+22175111111', 'Femme de m�nage', '', '35000', '', 'actif'],
    ]);
    const prev = await api('/import/preview', {
      method: 'POST',
      jar,
      body: { categories: ['employes'], files: { employes: { filename: 'e.csv', content } } },
    });
    if (expectSuccess(r, prev, S, r) && prev.data.totals.ok === 2 && prev.data.categories[0].accounts.length === 2) {
      r.pass(S, 'aper�u 2 employ�s + 2 usernames g�n�r�s');
    } else {
      r.fail(S, 'aper�u 2 employ�s + 2 usernames g�n�r�s', JSON.stringify(prev.data));
    }

    const exe = await api('/import/execute', {
      method: 'POST',
      jar,
      body: { categories: ['employes'], files: { employes: { filename: 'e.csv', content } } },
    });
    if (!expectSuccess(r, exe, S, r, [201])) {
      r.fail(S, 'ex�cution employ�s', JSON.stringify(exe.data));
      return;
    }
    const cat = exe.data.report.categories[0];
    if (cat.created === 2 && cat.accounts.length === 2) {
      r.pass(S, 'ex�cution : 2 employ�s + 2 comptes cr��s');
    } else {
      r.fail(S, 'ex�cution : 2 employ�s + 2 comptes cr��s', JSON.stringify(cat));
      return;
    }

    const { data: fiche } = await service
      .from('employes')
      .select('id, nom, account_uid, username, salaire, poste')
      .eq('user_id', ownerId)
      .ilike('nom', empNom)
      .maybeSingle();
    if (fiche?.account_uid && fiche?.username && Number(fiche.salaire) === 150000) {
      r.pass(S, 'fiche employ� cr��e avec compte + salaire');
    } else {
      r.fail(S, 'fiche employ� cr��e avec compte + salaire', JSON.stringify(fiche));
    }

    if (fiche?.account_uid) {
      const { data: profile } = await service
        .from('profiles')
        .select('must_change_password, account_type')
        .eq('id', fiche.account_uid)
        .maybeSingle();
      if (profile?.must_change_password === true && profile.account_type === 'employe') {
        r.pass(S, 'profil employ� : must_change_password=true + type employe');
      } else {
        r.fail(S, 'profil employ� : must_change_password=true + type employe', JSON.stringify(profile));
      }

      // Login employ� avec 1234 ? changement forc� demand� (exigence mission).
      const jarE = newJar();
      const login = await api('/auth/login', {
        method: 'POST',
        jar: jarE,
        body: { identifier: fiche.username, password: '1234' },
      });
      if (expectSuccess(r, login, S, r) && login.data.mustChangePassword === true) {
        r.pass(S, 'login employ� avec 1234 ? mustChangePassword');
      } else {
        r.fail(S, 'login employ� avec 1234 ? mustChangePassword', JSON.stringify(login.data));
      }
    }

    // Doublon employ� (m�me nom) ? d�tect�.
    const dupP = await api('/import/preview', {
      method: 'POST',
      jar,
      body: { categories: ['employes'], files: { employes: { filename: 'd.csv', content: csv(EMP_HEADERS, [[empNom, empPrenom, '', '', 'Gardien', '', '50000', '', 'actif']]) } } },
    });
    if (expectSuccess(r, dupP, S, r) && dupP.data.categories[0].duplicates.length === 1) {
      r.pass(S, 'doublon employ� d�tect�');
    } else {
      r.fail(S, 'doublon employ� d�tect�', JSON.stringify(dupP.data));
    }
  });

  // ----------------------------------------------------------
  await r.section('s�curit� : isolation entre propri�taires', async () => {
    // Un second propri�taire ne peut PAS r�f�rencer les biens/logements du premier.
    const otherEmail = `importother${SUFFIX}@mimtest.com`;
    const jar2 = newJar();
    const reg2 = await api('/auth/register', {
      method: 'POST',
      jar: jar2,
      body: { account_type: 'proprietaire', name: 'Autre Import', email: otherEmail, phone: '+221760000002', password: 'Test1234!', password_confirm: 'Test1234!' },
    });
    if (reg2.status !== 201) {
      r.blocked(S, 'second propri�taire cr��', JSON.stringify(reg2.data).slice(0, 200));
      return;
    }

    // Le bien du premier propri�taire n'existe pas pour le second.
    const stealLogement = csv(L_HEADERS, [[bien1, 'Appartement Vol�', 'appartement', '100000', '2', '', 'libre', '']]);
    const stealP = await api('/import/preview', {
      method: 'POST',
      jar: jar2,
      body: { categories: ['logements'], files: { logements: { filename: 's.csv', content: stealLogement } } },
    });
    const err = stealP.data?.categories?.[0]?.errors || [];
    if (expectSuccess(r, stealP, S, r) && err.some((e) => /n'existe pas/.test(e.message))) {
      r.pass(S, 'bien d�un autre propri�taire ? introuvable (pas de fuite)');
    } else {
      r.fail(S, 'bien d�un autre propri�taire ? introuvable (pas de fuite)', JSON.stringify(stealP.data));
    }

    // Le bien du premier n'appara�t pas comme doublon chez le second (pas de fuite).
    const dupBien = csv(B_HEADERS, [[bien1, 'immeuble', '', '', '', '']]);
    const dupP2 = await api('/import/preview', {
      method: 'POST',
      jar: jar2,
      body: { categories: ['biens'], files: { biens: { filename: 'b.csv', content: dupBien } } },
    });
    if (expectSuccess(r, dupP2, S, r) && dupP2.data.categories[0].duplicates.length === 0) {
      r.pass(S, 'bien de A non signal� comme doublon chez B');
    } else {
      r.fail(S, 'bien de A non signal� comme doublon chez B', JSON.stringify(dupP2.data));
    }

    // Le second ne peut PAS cr�er un logement sur le bien du premier.
    const exe2 = await api('/import/execute', {
      method: 'POST',
      jar: jar2,
      body: { categories: ['logements'], files: { logements: { filename: 's.csv', content: stealLogement } } },
    });
    if (exe2.status === 409 && exe2.data.prepared) {
      r.pass(S, 'ex�cution bloqu�e sur bien d�un autre propri�taire');
    } else {
      r.fail(S, 'ex�cution bloqu�e sur bien d�un autre propri�taire', `statut ${exe2.status} ${JSON.stringify(exe2.data).slice(0, 200)}`);
    }
  });

  // ----------------------------------------------------------
  await r.section('r�importation (doublons)', async () => {
    // Le m�me fichier de biens ? doublons d�tect�s, politique ignore.
    const content = csv(B_HEADERS, [[bien1, 'immeuble', '12 Av', 'Dakar', 'S�n�gal', 'B1']]);
    const prev = await api('/import/preview', {
      method: 'POST',
      jar,
      body: { categories: ['biens'], files: { biens: { filename: 'b.csv', content } } },
    });
    if (expectSuccess(r, prev, S, r) && prev.data.categories[0].duplicates.length === 1) {
      r.pass(S, 'r�import : doublon d�tect� � l�aper�u');
    } else {
      r.fail(S, 'r�import : doublon d�tect� � l�aper�u', JSON.stringify(prev.data));
    }

    // Politique abort ? refus global.
    const abort = await api('/import/execute', {
      method: 'POST',
      jar,
      body: { categories: ['biens'], files: { biens: { filename: 'b.csv', content } }, duplicatePolicy: 'abort' },
    });
    if (abort.status === 409 && /doublon/.test(String(abort.data?.message || ''))) {
      r.pass(S, 'r�import : politique abort ? import annul�');
    } else {
      r.fail(S, 'r�import : politique abort ? import annul�', `statut ${abort.status} ${JSON.stringify(abort.data).slice(0, 200)}`);
    }

    // Politique update ? mise � jour des champs fournis.
    const upd = await api('/import/execute', {
      method: 'POST',
      jar,
      body: { categories: ['biens'], files: { biens: { filename: 'b.csv', content: csv(B_HEADERS, [[bien1, 'immeuble', '999 Route Modifi�e', '', '', '']]) } }, duplicatePolicy: 'update' },
    });
    if (expectSuccess(r, upd, S, r, [201]) && upd.data.report.categories[0].updated === 1) {
      r.pass(S, 'r�import : politique update ? 1 bien mis � jour');
    } else {
      r.fail(S, 'r�import : politique update ? 1 bien mis � jour', JSON.stringify(upd.data));
    }
    const { data: updatedBien } = await service
      .from('biens')
      .select('adresse')
      .eq('user_id', ownerId)
      .ilike('nom', bien1)
      .maybeSingle();
    if (updatedBien?.adresse === '999 Route Modifi�e') {
      r.pass(S, 'adresse effectivement mise � jour en base');
    } else {
      r.fail(S, 'adresse effectivement mise � jour en base', JSON.stringify(updatedBien));
    }
  });

  // ----------------------------------------------------------
  await r.section('onboarding / status (apr�s import)', async () => {
    const st = await api('/onboarding/status', { jar });
    if (expectSuccess(r, st, S, r) && st.data.needsOnboarding === false) {
      r.pass(S, 'espace configur� ? needsOnboarding=false');
    } else {
      r.fail(S, 'espace configur� ? needsOnboarding=false', JSON.stringify(st.data));
    }
  });
}
