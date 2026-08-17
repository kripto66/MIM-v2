// ============================================================
// MIM - Suite auth : register, login, me, logout, mot de passe,
// username, 2FA (TOTP réel), reset de mot de passe
// ============================================================

import { api, newJar, expectSuccess, BASE } from './lib.js';
import { totpForSecret, totpWindowForSecret } from './totp.js';

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
    if (expectSuccess(r, ok, S, r)) {
      r.pass(S, `inscription propriétaire (${email})`);
      if (!own.cookies.some((c) => c.name === 'mim_token')) r.fail(S, 'cookie mim_token posé', 'cookie absent');
      else r.pass(S, 'cookie mim_token posé');
    }

    const dup = await api('/auth/register', {
      method: 'POST',
      body: { account_type: 'proprietaire', name: 'X2', email, phone: '1', password: PW, password_confirm: PW },
    });
    if (dup.status === 409) r.pass(S, 'email déjà utilisé → 409');
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

    // Pages protégées : servies AVEC session (Cache-Control: no-store),
    // redirigées vers la connexion SANS session ou après logout (le
    // bouton « retour » du navigateur ne peut pas ressusciter la page).
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
      if (withSession.cacheControl.includes('no-store')) {
        r.pass(S, 'page protégée : Cache-Control no-store (pas de bfcache après logout)');
      } else {
        r.fail(S, 'page protégée : Cache-Control no-store (pas de bfcache après logout)', withSession.cacheControl);
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

    await cleanup();
  });

  // ----------------------------------------------------------
  await r.section('2FA (TOTP réel)', async () => {
    const email = `auth2fa${Date.now()}@mimtest.com`;
    const jar = newJar();
    const reg = await api('/auth/register', {
      method: 'POST',
      jar,
      body: { account_type: 'proprietaire', name: '2FA Test', email, phone: '+221700000099', password: PW, password_confirm: PW },
    });
    if (reg.status !== 201) {
      r.blocked(S, 'register pour 2FA', JSON.stringify(reg.data));
      return;
    }

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
  await r.section('forgot / reset mot de passe', async () => {
    const email = `authrst${Date.now()}@mimtest.com`;
    const reg = await api('/auth/register', {
      method: 'POST',
      body: { account_type: 'proprietaire', name: 'Reset Test', email, phone: '+221700000098', password: PW, password_confirm: PW },
    });
    if (reg.status !== 201) {
      r.blocked(S, 'register pour reset', JSON.stringify(reg.data));
      return;
    }

    const forgot = await api('/auth/forgot', { method: 'POST', body: { email } });
    if (expectSuccess(r, forgot, S, r)) r.pass(S, 'forgot → réponse générique 200');
    else r.fail(S, 'forgot → réponse générique 200', JSON.stringify(forgot.data));

    const unknown = await api('/auth/forgot', { method: 'POST', body: { email: 'inexistant@mimtest.com' } });
    if (expectSuccess(r, unknown, S, r)) r.pass(S, 'forgot email inconnu → même réponse (pas d’énumération)');
    else r.fail(S, 'forgot email inconnu → même réponse', JSON.stringify(unknown.data));

    // Génère un vrai lien de récupération via l'API admin Supabase.
    const { data: linkData, error: linkErr } = await service.auth.admin.generateLink({ type: 'recovery', email });
    if (linkErr || !linkData?.properties) {
      r.blocked(S, 'generateLink recovery', String(linkErr?.message || ''));
      return;
    }

    const actionLink = linkData.properties.action_link || '';
    const tokens = extractRecoveryTokens(actionLink);
    if (!tokens.code && !tokens.access_token && !tokens.token_hash) {
      r.blocked(S, 'tokens de récupération extraits', `lien : ${actionLink}`);
      return;
    }

    const newPw = 'Reset$Pass1';
    const body = { password: newPw, password_confirm: newPw, ...tokens };
    const reset = await api('/auth/reset-password', { method: 'POST', body });
    if (expectSuccess(r, reset, S, r)) r.pass(S, 'reset-password (lien réel) → 200');
    else r.fail(S, 'reset-password (lien réel) → 200', JSON.stringify(reset.data));

    const jar = newJar();
    const loginNew = await api('/auth/login', { method: 'POST', jar, body: { email, password: newPw } });
    if (expectSuccess(r, loginNew, S, r)) r.pass(S, 'connexion avec le nouveau mot de passe');
    else r.fail(S, 'connexion avec le nouveau mot de passe', JSON.stringify(loginNew.data));

    const loginOld = await api('/auth/login', { method: 'POST', body: { email, password: PW } });
    if (loginOld.status === 401) r.pass(S, 'ancien mot de passe rejeté');
    else r.fail(S, 'ancien mot de passe rejeté', `statut ${loginOld.status}`);

    const noToken = await api('/auth/reset-password', {
      method: 'POST',
      body: { password: newPw, password_confirm: newPw },
    });
    if (noToken.status === 401) r.pass(S, 'reset sans jeton → 401');
    else r.fail(S, 'reset sans jeton → 401', `statut ${noToken.status}`);
  });
}

async function tryCodes(fn, codes) {
  for (const code of codes) {
    const res = await fn(code);
    if (res.status === 200 || res.status === 201) return res;
  }
  return null;
}

function extractRecoveryTokens(url) {
  const out = {};
  try {
    const u = new URL(url);
    const fragment = new URLSearchParams(u.hash.replace(/^#/, ''));
    if (fragment.get('access_token')) {
      out.access_token = fragment.get('access_token');
      out.refresh_token = fragment.get('refresh_token') || '';
    }
    const query = u.searchParams;
    if (query.get('code')) out.code = query.get('code');
    if (query.get('token')) out.token_hash = query.get('token');
  } catch {
    const m = String(url).match(/access_token=([^&]+)/);
    if (m) out.access_token = m[1];
  }
  return out;
}
