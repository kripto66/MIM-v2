// ============================================================
// MIM - Suite resetpwd : récupération de mot de passe sur mesure
//   * jeton généré côté serveur, stocké UNIQUEMENT haché,
//   * usage unique, expiration 30 min,
//   * réponse générique (anti-énumération),
//   * rate-limit par IP + email (test unitaire du middleware).
// ============================================================

import { api, newJar, createConfirmedSession } from './lib.js';
import { forgotPasswordRateLimit } from '../../middleware/rateLimit.js';
import { generateResetToken, hashResetToken } from '../../utils/passwordReset.js';

const PW = 'Test1234!';
const S = 'resetpwd';
const DAY = 24 * 60 * 60 * 1000;

async function registerProprio(service, name, phone) {
  const email = `${name.toLowerCase()}${Date.now()}@mimtest.com`;
  const created = await createConfirmedSession(service, {
    account_type: 'proprietaire',
    name,
    email,
    phone,
    password: PW,
  });
  return { id: created.user.id, email };
}

async function insertToken(service, userId, rawToken, expiresAt) {
  const { error } = await service.from('password_reset_tokens').insert({
    user_id: userId,
    token_hash: hashResetToken(rawToken),
    expires_at: expiresAt.toISOString(),
  });
  if (error) throw error;
}

async function cleanTokens(service, userId) {
  await service.from('password_reset_tokens').delete().eq('user_id', userId);
}

async function tryReset(r, name, body) {
  const res = await api('/auth/reset-password', { method: 'POST', body });
  if (res.status === 400) r.pass(S, name);
  else r.fail(S, name, `statut ${res.status} — ${String(JSON.stringify(res.data)).slice(0, 200)}`);
}

export async function runResetPwd(r, ctx) {
  const { service } = ctx;

  const user = await registerProprio(service, 'ResetPwd', '+221799000001');
  if (!user) {
    r.blocked(S, 'register resetpwd', 'impossible de créer le compte de test');
    return;
  }

  // 1) Email EXISTANT → réponse générique (le token part en e-mail simulé).
  const forgotExists = await api('/auth/forgot', { method: 'POST', body: { email: user.email } });
  if (forgotExists.status === 200 && forgotExists.data?.success === true) r.pass(S, 'email existant → réponse générique 200');
  else r.fail(S, 'email existant → réponse générique 200', JSON.stringify(forgotExists.data));
  await cleanTokens(service, user.id);

  // 2) Email INCONNU → TOUT À FAIT la même réponse (pas d'énumération), aucun jeton.
  const forgotUnknown = await api('/auth/forgot', { method: 'POST', body: { email: 'personnexiste@mimtest.com' } });
  if (forgotUnknown.status === 200 && forgotExists.data?.success === true) r.pass(S, 'email inexistant → même réponse générique');
  else r.fail(S, 'email inexistant → même réponse générique', JSON.stringify(forgotUnknown.data));
  const { data: afterUnknown } = await service
    .from('password_reset_tokens')
    .select('id')
    .eq('user_id', user.id);
  if (!afterUnknown?.length) r.pass(S, 'aucun jeton créé pour un email inexistant');
  else r.fail(S, 'aucun jeton créé pour un email inexistant', JSON.stringify(afterUnknown));

  // 3) Réinitialisation RÉUSSIE → le nouveau mot de passe fonctionne.
  const rawValid = generateResetToken();
  await insertToken(service, user.id, rawValid, new Date(Date.now() + 60 * DAY)); // +60 j (offset simulé +30 j)
  const newPw = 'Reset$Pass1';
  const reset = await api('/auth/reset-password', {
    method: 'POST',
    body: { token: rawValid, password: newPw, password_confirm: newPw },
  });
  if (reset.status === 200 && reset.data?.success === true) r.pass(S, 'réinitialisation réussie (jeton valide)');
  else r.fail(S, 'réinitialisation réussie (jeton valide)', JSON.stringify(reset.data));

  const jar = newJar();
  const loginNew = await api('/auth/login', { method: 'POST', jar, body: { email: user.email, password: newPw } });
  if (loginNew.status === 200) r.pass(S, 'connexion avec le NOUVEAU mot de passe');
  else r.fail(S, 'connexion avec le NOUVEAU mot de passe', JSON.stringify(loginNew.data));

  const loginOld = await api('/auth/login', { method: 'POST', body: { email: user.email, password: PW } });
  if (loginOld.status === 401) r.pass(S, 'ANCIEN mot de passe refusé');
  else r.fail(S, 'ANCIEN mot de passe refusé', `statut ${loginOld.status}`);

  // 4) Réutilisation du MÊME jeton (consommé) → invalide.
  const reuse = await api('/auth/reset-password', {
    method: 'POST',
    body: { token: rawValid, password: newPw, password_confirm: newPw },
  });
  if (reuse.status === 400) r.pass(S, 'jeton déjà utilisé → 400 (usage unique)');
  else r.fail(S, 'jeton déjà utilisé → 400', `statut ${reuse.status} ${JSON.stringify(reuse.data)}`);

  // 5) Jeton EXPIRÉ → invalide.
  const rawExpired = generateResetToken();
  await insertToken(service, user.id, rawExpired, new Date(Date.now() - 60 * 60 * 1000)); // -1 h
  await tryReset(r, 'jeton expiré → 400', { token: rawExpired, password: newPw, password_confirm: newPw });
  await cleanTokens(service, user.id);

  // 6) Mauvais jeton (jamais émis) → invalide, même réponse.
  await tryReset(r, 'mauvais jeton → 400', { token: generateResetToken(), password: newPw, password_confirm: newPw });

  // 7) Nouveau mot de passe INVALIDE (règles MIM) → 400 avec détails.
  const rawWeak = generateResetToken();
  await insertToken(service, user.id, rawWeak, new Date(Date.now() + 60 * DAY));
  const weak = await api('/auth/reset-password', { method: 'POST', body: { token: rawWeak, password: 'abc', password_confirm: 'abc' } });
  if (weak.status === 400 && weak.data?.errors?.password) r.pass(S, 'nouveau mdp invalide → 400 + détails');
  else r.fail(S, 'nouveau mdp invalide → 400 + détails', JSON.stringify(weak.data));
  await cleanTokens(service, user.id);

  // 8) Mots de passe différents → 400.
  const rawMismatch = generateResetToken();
  await insertToken(service, user.id, rawMismatch, new Date(Date.now() + 60 * DAY));
  await tryReset(r, 'mots de passe différents → 400', {
    token: rawMismatch,
    password: newPw,
    password_confirm: newPw + 'x',
  });

  // 9) Jeton manquant → 400.
  await tryReset(r, 'jeton manquant → 400', { password: newPw, password_confirm: newPw });

  await cleanTokens(service, user.id);

  // 10) Rate-limit du forfait (unitaire) : 3/10 min, clé IP + email.
  await r.section('rate-limit du forfait (unitaire)', async () => {
    const call = async (email) => {
      let status = 200;
      let finish;
      const done = new Promise((resolve) => { finish = resolve; });
      const fakeRes = {
        setHeader: () => {},
        status: (c) => {
          status = c;
          return { json: () => { finish(); } };
        },
      };
      forgotPasswordRateLimit(
        { ip: '10.0.0.9', body: { email }, baseUrl: '/auth', path: '/forgot' },
        fakeRes,
        () => { finish(); }
      );
      await done;
      return status;
    };

    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push(await call('fraudeur@mimtest.com'));
    const ok = statuses.filter((s) => s === 200).length;
    const blocked = statuses.filter((s) => s === 429).length;
    if (ok === 2 && blocked === 3) r.pass(S, 'limite 3/10 min atteinte (5 coups → 2 ok, 3 bloqués)');
    else r.fail(S, 'limite 3/10 min atteinte', `statuts ${JSON.stringify(statuses)}`);

    const other = await call('AutreUser@mimtest.com');
    if (other === 200) r.pass(S, 'clé IP+email : autre email non bloqué');
    else r.fail(S, 'clé IP+email : autre email non bloqué', `statut ${other}`);
  });
}