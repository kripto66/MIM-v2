// ============================================================
// MIM - Suite auth : register, login, me, logout, mot de passe,
// username, 2FA (TOTP réel), reset de mot de passe
// ============================================================

import { api, newJar, expectSuccess, BASE, createConfirmedSession } from './lib.js';
import { totpForSecret, totpWindowForSecret } from './totp.js';
import { tenantEmailFor } from '../../utils/tenantAccount.js';

const PW = 'Test1234!';
const S = 'auth';

export async function runAuth(r, ctx) {
  const { service } = ctx;
  const own = newJar();

  // ----------------------------------------------------------
  await r.section('register', async () => {
    const email = `authown${Date.now()}@mimtest.com`;

    const missing = await api('/auth/register', { method: 'POST', body: { account_type: 'proprietaire', name: 'X' } });
    if (missing.status === 400) r.pass(S, 'champs manquants rejetés');
    else r.fail(S, 'champs manquants rejetés', `statut ${missing.status}`);

    const badType = await api('/auth/register', {
      method: 'POST',
      body: { account_type: 'locataire', name: 'X', email: 'a@b.com', phone: '1', password: PW, password_confirm: PW },
    });
    if (badType.status === 400) r.pass(S, 'type locataire refusé (création par le proprio uniquement)');
    else r.fail(S, 'type locataire refusé', `statut ${badType.status}`);

    const weak = await api('/auth/register', {
      method: 'POST',
      body: { account_type: 'proprietaire', name: 'X', email: 'w@b.com', phone: '1', password: 'abc', password_confirm: 'abc' },
    });
    if (weak.status === 400) r.pass(S, 'mot de passe faible refusé');
    else r.fail(S, 'mot de passe faible refusé', `statut ${weak.status}`);

    const reserved = await api('/auth/register', {
      method: 'POST',
      body: { account_type: 'proprietaire', name: 'X', email: 'toto@mim.local', phone: '1', password: PW, password_confirm: PW },
    });
    if (reserved.status === 400 && /r[ée]serv/.test(String(reserved.data?.message || ''))) {
      r.pass(S, 'email @mim.local refusé');
    } else {
      r.fail(S, 'email @mim.local refusé', `statut ${reserved.status} ${JSON.stringify(reserved.data)}`);
    }

    const ok = await api('/auth/register', {
      method: 'POST',
      jar: own,
      body: { account_type: 'proprietaire', name: 'Auth Test', email, phone: '+221700000001', password: PW, password_confirm: PW },
    });
    if (expectSuccess(r, ok, S, r) && ok.data?.emailConfirmationRequired === false) {
      r.pass(S, `inscription propriétaire (${email}) — aucune confirmation e-mail requise`);
    } else {
      r.fail(S, 'inscription propriétaire — aucune confirmation e-mail requise', JSON.stringify(ok.data));
    }

    if (own.cookies.some((c) => c.name === 'mim_token')) r.pass(S, 'session ouverte dès l\'inscription');
    else r.fail(S, 'session ouverte dès l\'inscription', 'cookie mim_token absent');

    const meAfterRegister = await api('/auth/me', { jar: own });
    if (expectSuccess(r, meAfterRegister, S, r) && meAfterRegister.data?.user?.email === email) {
      r.pass(S, 'comptePropriétaire utilisable immédiatement après inscription');
    } else {
      r.fail(S, 'compte propriétaire utilisable immédiatement après inscription', JSON.stringify(meAfterRegister.data));
    }

    const dup = await api('/auth/register', {
      method: 'POST',
      body: { account_type: 'proprietaire', name: 'X2', email, phone: '1', password: PW, password_confirm: PW },
    });
    if (dup.status === 409) r.pass(S, 'email déjà utilisé → 409');
    else if (dup.status === 429) r.blocked(S, 'email déjà utilisé → 409', 'limite d\'inscription GoTrue locale atteinte (non configurable sur cette version)');
    else r.fail(S, 'email déjà utilisé → 409', `statut ${dup.status}`);
  });

  // ----------------------------------------------------------
  await r.section('login / me / logout', async () => {
    const jar = newJar();

    const wrong = await api('/auth/login', { method: 'POST', body: { email: 'authownx@mimtest.com', password: 'wrong' } });
    if (wrong.status === 401) r.pass(S, 'mauvais identifiants → 401');
    else r.fail(S, 'mauvais identifiants → 401', `statut ${wrong.status}`);

    const badPw = await api('/auth/login', { method: 'POST', body: { email: 'authown@mimtest.com', password: 'wrong' } });
    if (badPw.status === 401) r.pass(S, 'mauvais mot de passe → 401');
    else r.fail(S, 'mauvais mot de passe → 401', `statut ${badPw.status}`);

    const seedOwner = ctx.seed.owners[0];
    const ok = await api('/auth/login', { method: 'POST', jar, body: { email: seedOwner.email, password: PW } });
    if (expectSuccess(r, ok, S, r)) {
      r.pass(S, `connexion owner${seedOwner.i} (${seedOwner.email})`);
      if (!jar.cookies.some((c) => c.name === 'mim_token')) r.fail(S, 'cookie mim_token après login', 'cookie absent');
      else r.pass(S, 'cookie mim_token après login');
    }

    const me = await api('/auth/me', { jar });
    if (expectSuccess(r, me, S, r) && me.data.user.email === seedOwner.email) {
      r.pass(S, 'GET /me renvoie le bon compte');
    } else {
      r.fail(S, 'GET /me renvoie le bon compte', JSON.stringify(me.data));
    }

    const noToken = await api('/auth/me');
    if (noToken.status === 401) r.pass(S, 'GET /me sans cookie → 401');
    else r.fail(S, 'GET /me sans cookie → 401', `statut ${noToken.status}`);

    const badToken = await api('/auth/me', { jar: { cookies: [{ name: 'mim_token', value: 'forged.token.here' }] } });
    if (badToken.status === 401) r.pass(S, 'cookie forgé → 401');
    else r.fail(S, 'cookie forgé → 401', `statut ${badToken.status}`);

    // Pages protégées : servies AVEC session (Cache-Control: no-cache —
    // revalidation ETag à chaque retour, garde de session côté client via
    // mim-errors.js sur pageshow), redirigées vers la connexion SANS
    // session ou après logout (le bouton « retour » du navigateur ne peut
    // pas ressusciter une page protégée avec une session invalide).
    const pageOrigin = BASE.replace(/\/api$/, '');
    const page = async (path, jar) => {
      const h = {};
      const cookie = jar ? jar.cookies.map((c) => `${c.name}=${c.value}`).join('; ') : '';
      if (cookie) h.Cookie = cookie;
      const res = await fetch(pageOrigin + path, { headers: h, redirect: 'manual' });
      return {
        status: res.status,
        location: res.headers.get('location') || '',
        cacheControl: res.headers.get('cache-control') || '',
      };
    };

    const withSession = await page('/PartProprietaires/dashboard.html', jar);
    if (withSession.status === 200) {
      r.pass(S, 'page protégée servie avec session (200)');
      if (withSession.cacheControl.includes('no-cache')) {
        r.pass(S, 'page protégée : Cache-Control no-cache (revalidée à chaque retour)');
      } else {
        r.fail(S, 'page protégée : Cache-Control no-cache (revalidée à chaque retour)', withSession.cacheControl);
      }
    } else {
      r.fail(S, 'page protégée servie avec session (200)', `statut ${withSession.status}`);
    }

    const anon = await page('/PartProprietaires/dashboard.html');
    if (anon.status === 302 && anon.location.includes('connexion')) r.pass(S, 'page protégée sans session → redirection connexion (302)');
    else r.fail(S, 'page protégée sans session → redirection connexion (302)', `statut ${anon.status} loc=${anon.location}`);

    const out = await api('/auth/logout', { method: 'POST', jar });
    if (expectSuccess(r, out, S, r)) {
      const after = await api('/auth/me', { jar });
      if (after.status === 401) r.pass(S, 'logout → session invalide');
      else r.fail(S, 'logout → session invalide', `statut ${after.status}`);
    }

    const afterLogout = await page('/PartProprietaires/dashboard.html', jar);
    if (afterLogout.status === 302 && afterLogout.location.includes('connexion')) {
      r.pass(S, 'après logout : page protégée inaccessible (302 vers connexion)');
    } else {
      r.fail(S, 'après logout : page protégée inaccessible (302 vers connexion)', `statut ${afterLogout.status} loc=${afterLogout.location}`);
    }

    // Connexion par username (locataire seed) : propre compte, non modifié.
    const t1 = ctx.seed.owners[0].locataires[0];
    const jarT = newJar();
    const loginU = await api('/auth/login', { method: 'POST', jar: jarT, body: { identifier: t1.username, password: PW } });
    if (expectSuccess(r, loginU, S, r)) r.pass(S, `connexion par username ${t1.username}`);
    const meT = await api('/auth/me', { jar: jarT });
    if (expectSuccess(r, meT, S, r) && meT.data.user.account_type === 'locataire' && meT.data.user.email === '') {
      r.pass(S, 'me locataire : email masqué');
    } else {
      r.fail(S, 'me locataire : email masqué', JSON.stringify(meT.data));
    }
  });

  // ----------------------------------------------------------
  await r.section('changement de mot de passe (forcé + volontaire)', async () => {
    // Compte locataire dédié, créé par owner1 sur un logement dédié.
    const owner1 = ctx.seed.owners[0];
    const lg = await api('/logements', {
      method: 'POST',
      jar: owner1.jar,
      body: { bien_id: owner1.bienId, nom: 'Auth Chg Log', type: 'chambre', adresse: 'A', loyer_mensuel: 25000, statut: 'libre' },
    });
    if (!expectSuccess(r, lg, S, r, [201])) return;
    const lgId = lg.data.data.id;

    const username = `authchg${Date.now() % 100000}`;
    let tenantId = null;
    const cleanup = async () => {
      if (tenantId) await api(`/locataires/${tenantId}`, { method: 'DELETE', jar: owner1.jar });
      await api(`/logements/${lgId}`, { method: 'DELETE', jar: owner1.jar });
    };

    const created = await api('/locataires', {
      method: 'POST',
      jar: owner1.jar,
      body: {
        logement_id: lgId,
        nom: 'Chg MDP',
        username,
        password: PW,
        jour_echeance: 5,
        statut: 'actif',
      },
    });
    if (created.status !== 201) {
      await cleanup();
      r.blocked(S, 'création compte pour change-password', JSON.stringify(created.data));
      return;
    }
    tenantId = created.data.data.id;

    const jarT = newJar();
    const login = await api('/auth/login', { method: 'POST', jar: jarT, body: { identifier: username, password: PW } });
    if (!expectSuccess(r, login, S, r) || !login.data.mustChangePassword) {
      r.fail(S, 'first login → mustChangePassword', JSON.stringify(login.data));
    } else {
      r.pass(S, 'first login → mustChangePassword');
    }

    const newPw = 'NewPass$987';
    const forced = await api('/auth/change-password', {
      method: 'PUT',
      jar: jarT,
      body: { password: newPw, password_confirm: newPw },
    });
    if (expectSuccess(r, forced, S, r)) r.pass(S, 'changement forcé sans mot de passe actuel');

    const jarT2 = newJar();
    const loginNew = await api('/auth/login', { method: 'POST', jar: jarT2, body: { identifier: username, password: newPw } });
    if (expectSuccess(r, loginNew, S, r) && !loginNew.data.mustChangePassword) r.pass(S, 'nouveau mot de passe accepté + flag levé');
    else r.fail(S, 'nouveau mot de passe accepté + flag levé', JSON.stringify(loginNew.data));

    const oldPw = await api('/auth/login', { method: 'POST', body: { identifier: username, password: PW } });
    if (oldPw.status === 401) r.pass(S, 'ancien mot de passe rejeté');
    else r.fail(S, 'ancien mot de passe rejeté', `statut ${oldPw.status}`);

    const wrongCurrent = await api('/auth/change-password', {
      method: 'PUT',
      jar: jarT2,
      body: { current_password: 'nawak', password: 'Another$123', password_confirm: 'Another$123' },
    });
    if (wrongCurrent.status === 400) r.pass(S, 'mauvais mot de passe actuel → 400');
    else r.fail(S, 'mauvais mot de passe actuel → 400', `statut ${wrongCurrent.status}`);

    await cleanup();
  });

  // ----------------------------------------------------------
  await r.section('username (locataire)', async () => {
    const owner1 = ctx.seed.owners[0];
    const lg = await api('/logements', {
      method: 'POST',
      jar: owner1.jar,
      body: { bien_id: owner1.bienId, nom: 'Auth User Log', type: 'chambre', adresse: 'A', loyer_mensuel: 26000, statut: 'libre' },
    });
    if (!expectSuccess(r, lg, S, r, [201])) return;
    const lgId = lg.data.data.id;

    const username = `authuser${Date.now() % 100000}`;
    let tenantId = null;
    const cleanup = async () => {
      if (tenantId) await api(`/locataires/${tenantId}`, { method: 'DELETE', jar: owner1.jar });
      await api(`/logements/${lgId}`, { method: 'DELETE', jar: owner1.jar });
    };

    const created = await api('/locataires', {
      method: 'POST',
      jar: owner1.jar,
      body: {
        logement_id: lgId,
        nom: 'User Test',
        username,
        password: PW,
        jour_echeance: 5,
      },
    });
    if (created.status !== 201) {
      await cleanup();
      r.blocked(S, 'création compte pour username', JSON.stringify(created.data));
      return;
    }
    tenantId = created.data.data.id;

    const jarT = newJar();
    await api('/auth/login', { method: 'POST', jar: jarT, body: { identifier: username, password: PW } });

    const avail = await api('/auth/username-available?username=neverused42', { jar: jarT });
    if (expectSuccess(r, avail, S, r) && avail.data.available === true) r.pass(S, 'username-available (libre)');
    else r.fail(S, 'username-available (libre)', JSON.stringify(avail.data));

    const newName = `renamed${Date.now() % 1000000}`;
    const upd = await api('/auth/update-username', { method: 'PUT', jar: jarT, body: { username: newName } });
    if (expectSuccess(r, upd, S, r)) r.pass(S, `update-username → ${newName}`);

    const jarT2 = newJar();
    const relog = await api('/auth/login', { method: 'POST', jar: jarT2, body: { identifier: newName, password: PW } });
    if (expectSuccess(r, relog, S, r)) r.pass(S, 'connexion avec le nouveau username');
    else r.fail(S, 'connexion avec le nouveau username', JSON.stringify(relog.data));

    const oldName = await api('/auth/login', { method: 'POST', body: { identifier: username, password: PW } });
    if (oldName.status === 401) r.pass(S, 'ancien username rejeté');
    else r.fail(S, 'ancien username rejeté', `statut ${oldName.status}`);

    // Propriétaire ne peut pas changer de username.
    const own = ctx.seed.owners[1];
    const forbidden = await api('/auth/update-username', { method: 'PUT', jar: own.jar, body: { username: 'ownerwant' } });
    if (forbidden.status === 403) r.pass(S, 'propriétaire ne peut pas modifier de username → 403');
    else r.fail(S, 'propriétaire ne peut pas modifier de username → 403', `statut ${forbidden.status}`);

    // ----------------------------------------------------------
    // M-02 : compensation si l'email interne dérivé est déjà pris.
    // Le profil ne doit PAS rester modifié quand l'écriture Auth échoue.
    const { data: fiche } = await service.from('locataires').select('account_uid').eq('id', tenantId).maybeSingle();
    const accountUid = fiche?.account_uid;
    const ghostUsername = `ghost${Date.now() % 1000000}`;
    const ghost = accountUid ? await service.auth.admin.createUser({
      email: tenantEmailFor(ghostUsername),
      password: PW,
      email_confirm: true,
    }) : { error: new Error('compte du locataire introuvable') };
    if (ghost.error) {
      r.blocked(S, 'M-02 : création du compte fantôme', ghost.error.message);
    } else {
      try {
        const blocked = await api('/auth/update-username', { method: 'PUT', jar: jarT, body: { username: ghostUsername } });
        if (blocked.status >= 400) r.pass(S, 'M-02 : email interne déjà pris → refus');
        else r.fail(S, 'M-02 : email interne déjà pris → refus', `statut ${blocked.status}`);

        const { data: prof } = await service.from('profiles').select('username').eq('id', accountUid).maybeSingle();
        if (prof?.username === newName) r.pass(S, 'M-02 : profil compensé (username inchangé)');
        else r.fail(S, 'M-02 : profil compensé (username inchangé)', JSON.stringify(prof));

        const { data: authUser } = await service.auth.admin.getUserById(accountUid);
        if (authUser?.user?.email === tenantEmailFor(newName)) r.pass(S, 'M-02 : email Auth toujours aligné sur le profil');
        else r.fail(S, 'M-02 : email Auth toujours aligné sur le profil', String(authUser?.user?.email));

        const stillLogin = await api('/auth/login', { method: 'POST', jar: newJar(), body: { identifier: newName, password: PW } });
        if (stillLogin.status === 200) r.pass(S, 'M-02 : connexion toujours possible après refus');
        else r.fail(S, 'M-02 : connexion toujours possible après refus', `statut ${stillLogin.status}`);

        // ----------------------------------------------------------
        // M-02 : deux changements concurrents → jamais d'état mélangé.
        const concA = `conca${Date.now() % 1000000}`;
        const concB = `concb${Date.now() % 1000000}`;
        const [ra, rb] = await Promise.all([
          api('/auth/update-username', { method: 'PUT', jar: jarT, body: { username: concA } }),
          api('/auth/update-username', { method: 'PUT', jar: jarT, body: { username: concB } }),
        ]);
        const statuses = [ra.status, rb.status];
        const okCount = statuses.filter((s) => s === 200).length;
        const refusedCount = statuses.filter((s) => s === 409).length;
        if (okCount >= 1 && okCount + refusedCount === 2) r.pass(S, 'M-02 : concurrence → réponses 200/409 uniquement');
        else r.fail(S, 'M-02 : concurrence → réponses 200/409 uniquement', `statuts ${JSON.stringify(statuses)}`);

        const { data: prof2 } = await service.from('profiles').select('username').eq('id', accountUid).maybeSingle();
        const { data: auth2 } = await service.auth.admin.getUserById(accountUid);
        const coherent = Boolean(prof2?.username) && auth2?.user?.email === tenantEmailFor(prof2.username);
        const parmiLesDeux = [concA, concB].includes(prof2?.username);
        if (coherent && parmiLesDeux) r.pass(S, 'M-02 : profil et email interne cohérents après concurrence');
        else r.fail(S, 'M-02 : profil et email interne cohérents après concurrence', `profil=${prof2?.username} email=${auth2?.user?.email}`);
      } finally {
        await service.auth.admin.deleteUser(ghost.data.user.id).catch(() => {});
      }
    }

    await cleanup();
  });

  // ----------------------------------------------------------
  await r.section('2FA (TOTP réel)', async () => {
    const email = `auth2fa${Date.now()}@mimtest.com`;
    let confirmed;
    try {
      confirmed = await createConfirmedSession(service, {
        account_type: 'proprietaire',
        name: '2FA Test',
        email,
        phone: '+221700000099',
        password: PW,
      });
    } catch (error) {
      r.blocked(S, 'register pour 2FA', error.message);
      return;
    }
    const jar = confirmed.jar;

    const status0 = await api('/auth/mfa/status', { jar });
    if (expectSuccess(r, status0, S, r) && status0.data.enabled === false) r.pass(S, 'mfa/status → désactivé au départ');
    else r.fail(S, 'mfa/status → désactivé au départ', JSON.stringify(status0.data));

    const enroll = await api('/auth/mfa/enroll', { method: 'POST', jar });
    if (!expectSuccess(r, enroll, S, r) || !enroll.data.secret || !enroll.data.factorId) {
      r.fail(S, 'mfa/enroll → secret + factorId', JSON.stringify(enroll.data));
      return;
    }
    r.pass(S, 'mfa/enroll → secret + factorId');

    const confirm = await tryCodes(
      (c) => api('/auth/mfa/confirm', { method: 'POST', jar, body: { factorId: enroll.data.factorId, code: c } }),
      totpWindowForSecret(enroll.data.secret)
    );
    if (confirm && (confirm.status === 200 || confirm.status === 201)) r.pass(S, 'mfa/confirm (code TOTP valide)');
    else r.fail(S, 'mfa/confirm (code TOTP valide)', JSON.stringify(confirm?.data || {}));

    const badCode = totpForSecret('AAAAAAAAAAAAAAAA');
    const confirmBad = await api('/auth/mfa/confirm', { method: 'POST', jar, body: { factorId: enroll.data.factorId, code: badCode } });
    if (confirmBad.status === 400) r.pass(S, 'mfa/confirm code erroné → 400');
    else r.fail(S, 'mfa/confirm code erroné → 400', `statut ${confirmBad.status}`);

    const status1 = await api('/auth/mfa/status', { jar });
    if (expectSuccess(r, status1, S, r) && status1.data.enabled === true) r.pass(S, 'mfa/status → activé');
    else r.fail(S, 'mfa/status → activé', JSON.stringify(status1.data));

    // Déconnexion puis connexion → mfaRequired.
    await api('/auth/logout', { method: 'POST', jar });
    const jar2 = newJar();
    const login = await api('/auth/login', { method: 'POST', jar: jar2, body: { email, password: PW } });
    if (expectSuccess(r, login, S, r) && login.data.mfaRequired === true) {
      r.pass(S, 'login → mfaRequired + cookie mim_mfa_pending');
      const hasPending = jar2.cookies.some((c) => c.name === 'mim_mfa_pending');
      if (hasPending) r.pass(S, 'cookie mim_mfa_pending posé');
      else r.fail(S, 'cookie mim_mfa_pending posé', 'cookie absent');
    } else {
      r.fail(S, 'login → mfaRequired + cookie mim_mfa_pending', JSON.stringify(login.data));
    }

    const verify = await tryCodes(
      (c) => api('/auth/verify-2fa', { method: 'POST', jar: jar2, body: { code: c } }),
      totpWindowForSecret(enroll.data.secret)
    );
    if (verify && verify.status === 200) r.pass(S, 'verify-2fa (code TOTP) → session complète');
    else r.fail(S, 'verify-2fa (code TOTP) → session complète', JSON.stringify(verify?.data || {}));

    const me = await api('/auth/me', { jar: jar2 });
    if (expectSuccess(r, me, S, r)) r.pass(S, 'me après 2FA');
    else r.fail(S, 'me après 2FA', JSON.stringify(me.data));

    // Désactivation (reconfirmation par TOTP).
    const disable = await tryCodes(
      (c) => api('/auth/mfa/disable', { method: 'POST', jar: jar2, body: { factorId: enroll.data.factorId, code: c } }),
      totpWindowForSecret(enroll.data.secret)
    );
    if (disable && disable.status === 200) r.pass(S, 'mfa/disable → 2FA désactivée');
    else r.fail(S, 'mfa/disable → 2FA désactivée', JSON.stringify(disable?.data || {}));
  });

  // ----------------------------------------------------------
  await r.section('forgot / reset mot de passe (émission générique)', async () => {
    const email = `authrst${Date.now()}@mimtest.com`;
    try {
      await createConfirmedSession(service, {
        account_type: 'proprietaire',
        name: 'Reset Test',
        email,
        phone: '+221700000098',
        password: PW,
      });
    } catch (error) {
      r.blocked(S, 'register pour reset', error.message);
      return;
    }

    const profileRes = await service.from('profiles').select('id').eq('email', email).maybeSingle();
    const userId = profileRes.data?.id;
    if (!userId) {
      r.blocked(S, 'profil pour reset', JSON.stringify(profileRes.data || profileRes.error));
      return;
    }

    const forgot = await api('/auth/forgot', { method: 'POST', body: { email } });
    if (expectSuccess(r, forgot, S, 'forgot → réponse générique 200')) r.pass(S, 'forgot → réponse générique 200');
    else r.fail(S, 'forgot → réponse générique 200', JSON.stringify(forgot.data));

    // Un jeton est émis en base de façon HACHÉE (le serveur ne renvoie jamais le jeton).
    const { data: rows } = await service
      .from('password_reset_tokens')
      .select('token_hash, expires_at')
      .eq('user_id', userId);
    if (rows?.length === 1 && /^[0-9a-f]{64}$/.test(rows[0].token_hash || '')) {
      r.pass(S, 'un jeton haché (SHA-256) est créé en base');
    } else {
      r.fail(S, 'un jeton haché (SHA-256) est créé en base', JSON.stringify(rows));
    }
    await service.from('password_reset_tokens').delete().eq('user_id', userId);

    // Le lien arrive aussi dans les notifications du compte concerne
    // (canal de secours quand la boite mail est injoignable).
    const { data: resetNotifs } = await service
      .from('notifications')
      .select('type, message')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(5);
    const linkNotif = (resetNotifs || []).find((n) => /reset\.html#token=/.test(String(n.message || '')));
    if (linkNotif && linkNotif.type === 'system') {
      r.pass(S, 'lien de recuperation depose dans les notifications du compte');
    } else {
      r.fail(S, 'lien de recuperation depose dans les notifications du compte', JSON.stringify(resetNotifs));
    }
    await service.from('notifications').delete().eq('user_id', userId).eq('type', 'system');

    const unknown = await api('/auth/forgot', { method: 'POST', body: { email: 'inexistant@mimtest.com' } });
    if (expectSuccess(r, unknown, S, "forgot email inconnu → même réponse (pas d'énumération)")) {
      r.pass(S, "forgot email inconnu → même réponse (pas d'énumération)");
    } else {
      r.fail(S, "forgot email inconnu → même réponse", JSON.stringify(unknown.data));
    }
  });

  // ----------------------------------------------------------
  await r.section('verify-password', async () => {
    const owner = ctx.seed.owners[0];
    const jar = newJar();
    const login = await api('/auth/login', { method: 'POST', jar, body: { email: owner.email, password: PW } });
    if (!expectSuccess(r, login, S, 'login owner pour verify-password')) return;

    const ok = await api('/auth/verify-password', { method: 'POST', jar, body: { password: PW } });
    if (expectSuccess(r, ok, S, 'verify-password correct')) r.pass(S, 'mot de passe correct → 200');
    else r.fail(S, 'mot de passe correct → 200', JSON.stringify(ok.data));

    const wrong = await api('/auth/verify-password', { method: 'POST', jar, body: { password: 'Mauvais123!' } });
    if (wrong.status === 403) r.pass(S, 'mot de passe incorrect → 403');
    else r.fail(S, 'mot de passe incorrect → 403', `statut ${wrong.status}`);

    const noPw = await api('/auth/verify-password', { method: 'POST', jar, body: {} });
    if (noPw.status === 400) r.pass(S, 'mot de passe manquant → 400');
    else r.fail(S, 'mot de passe manquant → 400', `statut ${noPw.status}`);

    const noAuth = await api('/auth/verify-password', { method: 'POST', body: { password: PW } });
    if (noAuth.status === 401) r.pass(S, 'sans session → 401');
    else r.fail(S, 'sans session → 401', `statut ${noAuth.status}`);
  });

  // ----------------------------------------------------------
  // mustChangePassword admin
  await r.section('admin mustChangePassword', async () => {
    const service = ctx.service;
    const adminEmail = `admin.mustchange.${Date.now()}@mim.local`;
    const adminPw = 'Admin1234!';

    const { data: created, error } = await service.auth.admin.createUser({
      email: adminEmail,
      password: adminPw,
      email_confirm: true,
      user_metadata: { name: 'Admin MC Test' },
      app_metadata: { mim_account_type: 'admin' },
    });
    if (error) { r.fail(S, 'création admin mustChange', error.message); return; }

    const adminId = created.user.id;
    await service.from('profiles').update({ account_type: 'admin', role: 'admin', must_change_password: true }).eq('id', adminId);

    const { error: profErr } = await service.from('profiles')
      .update({ must_change_password: true })
      .eq('id', adminId);
    if (profErr) { r.fail(S, 'set must_change_password=true', profErr.message); return; }

    const jar = newJar();
    const login = await api('/auth/login', { method: 'POST', jar, body: { email: adminEmail, password: adminPw } });
    if (login.status !== 200 || !login.data?.success) {
      r.fail(S, 'login admin mustChange', `statut ${login.status} ${JSON.stringify(login.data)}`);
    } else {
      if (login.data.mustChangePassword === true) r.pass(S, 'login admin mustChangePassword=true retourné');
      else r.fail(S, 'login admin mustChangePassword=true retourné', `reçu ${login.data.mustChangePassword}`);

      if (login.data.redirect === 'PartAdmin/admin.html') r.pass(S, 'redirect admin conserve admin.html');
      else r.fail(S, 'redirect admin conserve admin.html', `reçu ${login.data.redirect}`);
    }

    const newPw = 'Admin$New1';
    const changeJar = newJar();
    const login2 = await api('/auth/login', { method: 'POST', jar: changeJar, body: { email: adminEmail, password: adminPw } });
    if (!expectSuccess(r, login2, S, 'login admin pour change-password')) return;

    const change = await api('/auth/change-password', { method: 'PUT', jar: changeJar, body: { password: newPw, password_confirm: newPw } });
    if (expectSuccess(r, change, S, 'change-password admin (forced, no current_password)')) {
      r.pass(S, 'admin mustChangePassword -> change OK sans demander ancien mdp');
    }
  });
}

async function tryCodes(fn, codes) {
  for (const code of codes) {
    const res = await fn(code);
    if (res.status === 200 || res.status === 201) return res;
  }
  return null;
}
