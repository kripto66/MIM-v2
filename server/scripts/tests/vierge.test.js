// ============================================================
// MIM - Suite « Propriétaire vierge »
//
// Un propriétaire totalement nouveau (compte fraîchement créé)
// doit avoir un dashboard 100 % vide (aucune donnée fictive),
// puis pouvoir créer un locataire et un employé dont le username
// est généré automatiquement côté serveur (unique), avec un mot
// de passe initial temporaire et un changement obligatoire à la
// première connexion. Vérifie aussi l'isolation de ses données.
// ============================================================

import { api, expectSuccess, newJar } from './lib.js';

const S = 'vierge';

export async function runVierge(r, ctx) {
  const service = ctx.service;
  const suffix = Date.now() % 100000;
  const email = `vierge${suffix}@mimtest.com`;
  const nameTag = `V${suffix}`;
  const jar = newJar();
  const owner = { jar, email, id: null };

  // ----------------------------------------------------------
  await r.section('nouveau propriétaire vierge : création + connexion', async () => {
    const reg = await api('/auth/register', {
      method: 'POST',
      jar,
      body: {
        account_type: 'proprietaire',
        name: `Propriétaire Vierge ${nameTag}`,
        email,
        phone: '+221760000001',
        password: 'Vierge1234!',
        password_confirm: 'Vierge1234!',
      },
    });
    if (reg.status === 201 && reg.data.success) {
      r.pass(S, 'compte propriétaire créé (201)');
    } else {
      r.fail(S, 'compte propriétaire créé', `statut ${reg.status} ${JSON.stringify(reg.data).slice(0, 200)}`);
      return;
    }

    const me = await api('/auth/me', { jar });
    if (me.status === 200 && me.data?.user?.id) {
      owner.id = me.data.user.id;
      r.pass(S, 'connexion établie');
    } else {
      r.fail(S, 'connexion établie', JSON.stringify(me.data));
    }
  });

  // ----------------------------------------------------------
  await r.section('dashboard vierge : tous les compteurs à 0', async () => {
    const res = await api('/stats/dashboard', { jar });
    const st = res.data?.stats || {};
    const keys = [
      'totalProperties',
      'occupiedProperties',
      'availableProperties',
      'totalTenants',
      'totalEmployees',
      'expectedRent',
      'paidRent',
      'lateRent',
      'lateCount',
      'paiementsEnValidation',
      'salairesAttente',
      'activeIncidents',
      'activeInterventions',
    ];
    const bad = keys.filter((k) => Number(st[k]) !== 0);
    if (res.status === 200 && bad.length === 0) {
      r.pass(S, 'stats/dashboard → 13 compteurs à 0 (aucune donnée fictive)');
    } else {
      r.fail(S, 'stats/dashboard → 13 compteurs à 0', `bad: ${bad.join(', ')} ${JSON.stringify(st).slice(0, 300)}`);
    }
  });

  // ----------------------------------------------------------
  await r.section('listes vides (aucune donnée inventée)', async () => {
    const eps = ['/biens', '/logements', '/locataires', '/employes', '/paiements', '/incidents', '/prestataires', '/interventions', '/notifications'];
    for (const ep of eps) {
      const res = await api(ep, { jar });
      const arr = Array.isArray(res.data?.data) ? res.data.data : [];
      if (res.status === 200 && arr.length === 0) {
        r.pass(S, `${ep} → 0 élément`);
      } else {
        r.fail(S, `${ep} → 0 élément`, `statut ${res.status}, ${arr.length} élément(s)`);
      }
    }
  });

  // ----------------------------------------------------------
  await r.section('création locataire : username généré + compte réel', async () => {
    const nom = `Amadou Diop Vierge${nameTag}`;
    const res = await api('/locataires', {
      method: 'POST',
      jar,
      body: { nom, jour_echeance: 5, statut: 'actif', autoAccount: true },
    });
    if (!expectSuccess(r, res, S, r, [201])) {
      r.fail(S, 'locataire auto créé', JSON.stringify(res.data));
      return;
    }
    const username = res.data.account?.username;
    const password = res.data.account?.password;
    if (res.data.autoAccount !== true || !username || !password) {
      r.fail(S, 'username généré + mot de passe initial', JSON.stringify(res.data.account));
      return;
    }
    r.pass(S, `locataire auto créé → username ${username} + mdp aléatoire`);

    // En base : fiche locataire + profil auth.
    const { data: fiche } = await service
      .from('locataires')
      .select('id, user_id, account_uid, username')
      .eq('user_id', owner.id)
      .maybeSingle();
    if (fiche && fiche.username === username && fiche.account_uid) {
      r.pass(S, 'fiche en base : username + compte lié');
    } else {
      r.fail(S, 'fiche en base : username + compte lié', JSON.stringify(fiche));
    }

    const { data: profile } = await service
      .from('profiles')
      .select('username, must_change_password, account_type')
      .eq('id', fiche?.account_uid)
      .maybeSingle();
    if (profile && profile.username === username && profile.must_change_password === true && profile.account_type === 'locataire') {
      r.pass(S, 'profil auth : username + must_change_password=true');
    } else {
      r.fail(S, 'profil auth : username + must_change_password=true', JSON.stringify(profile));
    }

    // Connexion avec le mot de passe initial retourné (aléatoire) → changement forcé.
    const jarT = newJar();
    const login = await api('/auth/login', { method: 'POST', jar: jarT, body: { identifier: username, password } });
    if (login.status === 200 && login.data.mustChangePassword === true) {
      r.pass(S, 'connexion locataire (mdp initial) → mustChangePassword');
    } else {
      r.fail(S, 'connexion locataire (mdp initial) → mustChangePassword', `statut ${login.status} ${JSON.stringify(login.data).slice(0, 150)}`);
    }
  });

  // ----------------------------------------------------------
  await r.section('unicité : 3 x même nom de locataire', async () => {
    const usernames = [];
    for (let i = 0; i < 3; i++) {
      const res = await api('/locataires', {
        method: 'POST',
        jar,
        body: { nom: `Locataire Vierge${nameTag}`, jour_echeance: 10, statut: 'actif', autoAccount: true },
      });
      if (res.status === 201 && res.data.account?.username) {
        usernames.push(res.data.account.username);
      } else {
        r.fail(S, `création ${i + 1}/3`, JSON.stringify(res.data).slice(0, 200));
      }
    }
    const unique = new Set(usernames);
    if (usernames.length === 3 && unique.size === 3) {
      r.pass(S, `usernames distincts : ${usernames.join(', ')}`);
    } else {
      r.fail(S, 'usernames distincts', JSON.stringify(usernames));
    }
  });

  // ----------------------------------------------------------
  await r.section('création employé AUTO : username généré + compte réel', async () => {
    const nom = `Employé Vierge${nameTag}`;
    const res = await api('/employes', {
      method: 'POST',
      jar,
      body: { nom, poste: 'Gardien', salaire: 75000 },
    });
    if (!expectSuccess(r, res, S, r, [201])) {
      r.fail(S, 'employé auto créé', JSON.stringify(res.data));
      return;
    }
    const username = res.data.account?.username;
    const password = res.data.account?.password;
    if (res.data.autoAccount !== true || !username || !password) {
      r.fail(S, 'username employé généré + mdp initial', JSON.stringify(res.data.account));
      return;
    }
    r.pass(S, `employé auto créé → username ${username} + mdp aléatoire`);

    // En base : fiche employé + profil auth.
    const { data: fiche } = await service
      .from('employes')
      .select('id, user_id, account_uid, username, salaire')
      .eq('user_id', owner.id)
      .maybeSingle();
    if (fiche && fiche.username === username && fiche.account_uid && Number(fiche.salaire) === 75000) {
      r.pass(S, 'fiche employé en base : username + compte lié + salaire');
    } else {
      r.fail(S, 'fiche employé en base', JSON.stringify(fiche));
    }

    const { data: profile } = await service
      .from('profiles')
      .select('username, must_change_password, account_type')
      .eq('id', fiche?.account_uid)
      .maybeSingle();
    if (profile && profile.username === username && profile.must_change_password === true && profile.account_type === 'employe') {
      r.pass(S, 'profil auth : username + must_change_password=true');
    } else {
      r.fail(S, 'profil auth : username + must_change_password=true', JSON.stringify(profile));
    }

    // Connexion avec le mot de passe initial retourné (aléatoire) → changement forcé.
    const jarE = newJar();
    const login = await api('/auth/login', { method: 'POST', jar: jarE, body: { identifier: username, password } });
    if (login.status === 200 && login.data.mustChangePassword === true) {
      r.pass(S, 'connexion employé (mdp initial) → mustChangePassword');
    } else {
      r.fail(S, 'connexion employé (mdp initial) → mustChangePassword', `statut ${login.status} ${JSON.stringify(login.data).slice(0, 150)}`);
    }

    // Parcours complet : changement du mot de passe, re-connexion, flag levé.
    const updP = await api('/auth/change-password', {
      method: 'PUT',
      jar: jarE,
      body: { password: 'EmployeVierge!7', password_confirm: 'EmployeVierge!7' },
    });
    if (expectSuccess(r, updP, S, r)) {
      r.pass(S, 'mot de passe employé changé (mode forcé)');
    } else {
      r.fail(S, 'mot de passe employé changé', JSON.stringify(updP.data));
      return;
    }

    const { data: profileAfter } = await service
      .from('profiles')
      .select('must_change_password')
      .eq('id', fiche?.account_uid)
      .maybeSingle();
    if (profileAfter?.must_change_password === false) {
      r.pass(S, 'must_change_password levé après changement');
    } else {
      r.fail(S, 'must_change_password levé après changement', JSON.stringify(profileAfter));
    }

    const login2 = await api('/auth/login', { method: 'POST', body: { identifier: username, password: 'EmployeVierge!7' } });
    if (login2.status === 200 && login2.data.mustChangePassword === false) {
      r.pass(S, 're-connexion avec le nouveau mot de passe → compte normal');
    } else {
      r.fail(S, 're-connexion avec le nouveau mot de passe', `statut ${login2.status} ${JSON.stringify(login2.data).slice(0, 150)}`);
    }
  });

  // ----------------------------------------------------------
  await r.section('unicité : 3 x même nom d’employé', async () => {
    const usernames = [];
    for (let i = 0; i < 3; i++) {
      const res = await api('/employes', {
        method: 'POST',
        jar,
        body: { nom: `Employe Auto${nameTag}`, poste: 'Nettoyeur', salaire: 50000 },
      });
      if (res.status === 201 && res.data.account?.username) {
        usernames.push(res.data.account.username);
      } else {
        r.fail(S, `création ${i + 1}/3`, JSON.stringify(res.data).slice(0, 200));
      }
    }
    const unique = new Set(usernames);
    if (usernames.length === 3 && unique.size === 3) {
      r.pass(S, `usernames distincts : ${usernames.join(', ')}`);
    } else {
      r.fail(S, 'usernames distincts', JSON.stringify(usernames));
    }
  });

  // ----------------------------------------------------------
  await r.section('isolation : le propriétaire ne voit que SES données', async () => {
    const res = await api('/stats/dashboard', { jar });
    const st = res.data?.stats || {};
    // 1 locataire « Amadou Diop Vierge… » + 3 locataires uniques + 1 employé + 3 employés.
    const expectedTenants = Number(st.totalTenants);
    const expectedEmployees = Number(st.totalEmployees);
    if (expectedTenants !== 4 || expectedEmployees !== 4) {
      r.fail(S, `stats limitées à ses données (attendu 4 locataires / 4 employés)`, JSON.stringify(st));
      return;
    }
    r.pass(S, `stats isolées : ${expectedTenants} locataires / ${expectedEmployees} employés (4 + 4)`);

    const loc = await api('/locataires', { jar });
    const locs = Array.isArray(loc.data?.data) ? loc.data.data : [];
    const foreign = locs.some((l) => l.user_id !== owner.id);
    if (locs.length === 4 && !foreign) {
      r.pass(S, 'liste locataires : uniquement les siens');
    } else {
      r.fail(S, 'liste locataires : uniquement les siens', JSON.stringify(locs).slice(0, 300));
    }

    const emp = await api('/employes', { jar });
    const emps = Array.isArray(emp.data?.data) ? emp.data.data : [];
    const foreignE = emps.some((e) => e.user_id !== owner.id);
    if (emps.length === 4 && !foreignE) {
      r.pass(S, 'liste employés : uniquement les siens');
    } else {
      r.fail(S, 'liste employés : uniquement les siens', JSON.stringify(emps).slice(0, 300));
    }
  });
}