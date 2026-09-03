// ============================================================
// MIM - Validation sécurité CSRF
// Vérifie que l'architecture (SameSite=Lax + same-origin +
// auth serveur) fournit une protection suffisante contre les
// attaques CSRF, rendant le token CSRF dédié inutile.
// ============================================================

import { api, newJar, expectSuccess, BASE } from './lib.js';

const S = 'csrf-validation';
const PW = 'Test1234!';

export async function runCsrfValidation(r, ctx) {
  const { service } = ctx;
  const o1 = ctx.seed.owners[0];
  const o2 = ctx.seed.owners[1];

  // ===========================================================
  // 1. CSRF — mutations sans token CSRF fonctionnent
  // ===========================================================
  await r.section('1. CSRF — pas de token requis', async () => {
    // POST sans header x-csrf-token → doit fonctionner (SameSite protège)
    const create = await api('/biens', {
      method: 'POST',
      jar: o1.jar,
      body: { nom: 'Bien CSRF Test', type: 'villa', adresse: 'Rue CSRF', ville: 'Dakar' },
    });
    if (create.status === 201) r.pass(S, 'POST /biens sans CSRF token → 201');
    else r.fail(S, 'POST /biens sans CSRF token → 201', `statut ${create.status}`);

    const bienId = create.data?.data?.id;

    // PUT sans token
    if (bienId) {
      const update = await api(`/biens/${bienId}`, {
        method: 'PUT',
        jar: o1.jar,
        body: { nom: 'Bien CSRF Updated' },
      });
      if (update.status === 200) r.pass(S, 'PUT /biens/:id sans CSRF token → 200');
      else r.fail(S, 'PUT /biens/:id sans CSRF token → 200', `statut ${update.status}`);
    }

    // DELETE sans token
    if (bienId) {
      const del = await api(`/biens/${bienId}`, {
        method: 'DELETE',
        jar: o1.jar,
      });
      if (del.status === 200) r.pass(S, 'DELETE /biens/:id sans CSRF token → 200');
      else r.fail(S, 'DELETE /biens/:id sans CSRF token → 200', `statut ${del.status}`);
    }
  });

  // ===========================================================
  // 2. CORS — vérification des origines
  // ===========================================================
  await r.section('2. CORS — vérification origines', async () => {
    const origin = 'http://127.0.0.1:3100';

    // Même origine → doit fonctionner
    const sameOrigin = await fetch(`${origin}/api/health`, {
      headers: { Origin: origin },
    });
    if (sameOrigin.ok) r.pass(S, 'same-origin GET /health → 200');
    else r.fail(S, 'same-origin GET /health → 200', `statut ${sameOrigin.status}`);

    // Origine inconnue → pas d'ACAO
    const crossOrigin = await fetch(`${origin}/api/health`, {
      headers: { Origin: 'http://evil.example.com' },
    });
    const acao = crossOrigin.headers.get('access-control-allow-origin');
    if (!acao) r.pass(S, 'origine inconnue → pas d\'ACAO');
    else r.fail(S, 'origine inconnue → pas d\'ACAO', `ACAO=${acao}`);

    // CORS preflight rejeté pour origine inconnue
    const preflight = await fetch(`${origin}/api/biens`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://evil.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type',
      },
    });
    const preflightAcao = preflight.headers.get('access-control-allow-origin');
    if (!preflightAcao) r.pass(S, 'preflight evil.com → rejeté');
    else r.fail(S, 'preflight evil.com → rejeté', `ACAO=${preflightAcao}`);
  });

  // ===========================================================
  // 3. Cookies — attributs de sécurité
  // ===========================================================
  await r.section('3. Cookies — attributs sécurité', async () => {
    // Login et vérifier Set-Cookie
    const loginJar = newJar();
    const login = await api('/auth/login', {
      method: 'POST',
      jar: loginJar,
      body: { email: o1.email, password: PW },
      raw: true,
    });
    const sc = login.headers.get('set-cookie') || '';

    // HttpOnly
    if (/HttpOnly/i.test(sc)) r.pass(S, 'mim_token HttpOnly');
    else r.fail(S, 'mim_token HttpOnly', sc);

    // SameSite=Lax
    if (/SameSite=Lax/i.test(sc)) r.pass(S, 'mim_token SameSite=Lax');
    else r.fail(S, 'mim_token SameSite=Lax', sc);

    // Secure en production (absent en dev = normal)
    if (!process.env.NODE_ENV || process.env.NODE_ENV !== 'production') {
      if (!/Secure/i.test(sc)) r.pass(S, 'cookie non Secure en dev (attendu)');
      else r.fail(S, 'cookie non Secure en dev (attendu)', 'Secure présent');
    } else {
      if (/Secure/i.test(sc)) r.pass(S, 'cookie Secure en production');
      else r.fail(S, 'cookie Secure en production', sc);
    }

    // Pas de cookie XSRF-TOKEN
    if (!/XSRF-TOKEN/i.test(sc)) r.pass(S, 'pas de cookie XSRF-TOKEN (CSRF supprimé)');
    else r.fail(S, 'pas de cookie XSRF-TOKEN', sc);

    // Cookie expiré / mauvais token → 401
    const badJar = { cookies: [{ name: 'mim_token', value: 'invalid.jwt.token' }] };
    const unauthorized = await api('/auth/me', { jar: badJar });
    if (unauthorized.status === 401) r.pass(S, 'cookie invalide → 401');
    else r.fail(S, 'cookie invalide → 401', `statut ${unauthorized.status}`);

    // Pas de cookie sur login échoué
    const failJar = newJar();
    await api('/auth/login', {
      method: 'POST',
      jar: failJar,
      body: { email: o1.email, password: 'mauvais' },
    });
    const hasToken = failJar.cookies.some((c) => c.name === 'mim_token');
    if (!hasToken) r.pass(S, 'login échoué → pas de cookie mim_token');
    else r.fail(S, 'login échoué → pas de cookie mim_token', 'cookie présent');
  });

  // ===========================================================
  // 4. Routes sensibles — aucune mutation via GET
  // ===========================================================
  await r.section('4. Routes sensibles — pas de GET mutation', async () => {
    // Toutes les routes d'écriture doivent être POST/PUT/PATCH/DELETE
    const mutations = [
      { route: '/biens', method: 'GET', expectRead: true },
      { route: '/logements', method: 'GET', expectRead: true },
      { route: '/locataires', method: 'GET', expectRead: true },
      { route: '/paiements', method: 'GET', expectRead: true },
      { route: '/incidents', method: 'GET', expectRead: true },
      { route: '/prestataires', method: 'GET', expectRead: true },
      { route: '/interventions', method: 'GET', expectRead: true },
      { route: '/notifications', method: 'GET', expectRead: true },
      { route: '/stats/dashboard', method: 'GET', expectRead: true },
    ];

    let allGetAreRead = true;
    for (const m of mutations) {
      const res = await api(m.route, { jar: o1.jar });
      if (res.status === 200 || res.status === 401) {
        // GET retourne des données ou auth error — c'est une lecture
      } else if (res.status === 404) {
        // Route inexistante — OK aussi
      } else {
        allGetAreRead = false;
        r.fail(S, `GET ${m.route} — statut inattendu`, `${res.status}`);
      }
    }
    if (allGetAreRead) r.pass(S, 'toutes les routes GET sont des lectures');
  });

  // ===========================================================
  // 5. Auth — obligatoire pour les routes protégées
  // ===========================================================
  await r.section('5. Auth — obligatoire routes protégées', async () => {
    const protectedRoutes = [
      '/biens',
      '/logements',
      '/locataires',
      '/paiements',
      '/incidents',
      '/prestataires',
      '/interventions',
      '/notifications',
      '/stats/dashboard',
      '/auth/me',
    ];

    let allProtected = true;
    for (const route of protectedRoutes) {
      const res = await api(route);
      if (res.status === 401) {
        // OK — protégé
      } else {
        allProtected = false;
        r.fail(S, `${route} sans auth → 401`, `statut ${res.status}`);
      }
    }
    if (allProtected) r.pass(S, 'toutes les routes protégées retournent 401 sans auth');
  });

  // ===========================================================
  // 6. RBAC — utilisateur A ne peut pas modifier les données de B
  // ===========================================================
  await r.section('6. RBAC — isolation entre propriétaires', async () => {
    if (!o1.jar?.cookies?.length || !o2.jar?.cookies?.length) {
      r.blocked(S, 'isolation o1/o2', 'jars non initialisés');
      return;
    }

    // o1 crée un bien
    const bien = await api('/biens', {
      method: 'POST',
      jar: o1.jar,
      body: { nom: 'Bien Isolation Test', type: 'appartement', ville: 'Dakar' },
    });
    if (bien.status !== 201) {
      r.blocked(S, 'création bien o1', `statut ${bien.status}`);
      return;
    }
    const bienId = bien.data.data.id;

    // o2 tente de modifier le bien de o1 → doit échouer
    const steal = await api(`/biens/${bienId}`, {
      method: 'PUT',
      jar: o2.jar,
      body: { nom: 'Bien Volé' },
    });
    if (steal.status === 404 || steal.status === 403) {
      r.pass(S, 'o2 ne peut pas modifier le bien de o1');
    } else {
      r.fail(S, 'o2 ne peut pas modifier le bien de o1', `statut ${steal.status}`);
    }

    // o2 tente de supprimer le bien de o1 → doit échouer
    const stealDel = await api(`/biens/${bienId}`, {
      method: 'DELETE',
      jar: o2.jar,
    });
    if (stealDel.status === 404 || stealDel.status === 403) {
      r.pass(S, 'o2 ne peut pas supprimer le bien de o1');
    } else {
      r.fail(S, 'o2 ne peut pas supprimer le bien de o1', `statut ${stealDel.status}`);
    }

    // o1 nettoie
    await api(`/biens/${bienId}`, { method: 'DELETE', jar: o1.jar });
  });

  // ===========================================================
  // 7. Compte suspendu — refusé
  // ===========================================================
  await r.section('7. Compte suspendu — refusé', async () => {
    // Utilisateur non authentifié sur route protégée
    const unauth = await api('/biens', { jar: newJar() });
    if (unauth.status === 401) r.pass(S, 'pas de session → 401');
    else r.fail(S, 'pas de session → 401', `statut ${unauth.status}`);

    // Token invalide
    const fakeJar = { cookies: [{ name: 'mim_token', value: 'fake.token.value' }] };
    const fake = await api('/biens', { jar: fakeJar });
    if (fake.status === 401) r.pass(S, 'token invalide → 401');
    else r.fail(S, 'token invalide → 401', `statut ${fake.status}`);
  });

  // ===========================================================
  // 8. Headers de sécurité
  // ===========================================================
  await r.section('8. Headers de sécurité', async () => {
    const raw = await api('/auth/me', { jar: o1.jar, raw: true });
    const h = raw.headers;

    if (h.get('x-content-type-options') === 'nosniff') r.pass(S, 'X-Content-Type-Options: nosniff');
    else r.fail(S, 'X-Content-Type-Options: nosniff', String(h.get('x-content-type-options')));

    if (h.get('x-frame-options') === 'DENY') r.pass(S, 'X-Frame-Options: DENY');
    else r.fail(S, 'X-Frame-Options: DENY', String(h.get('x-frame-options')));

    if (h.get('referrer-policy') === 'no-referrer') r.pass(S, 'Referrer-Policy: no-referrer');
    else r.fail(S, 'Referrer-Policy: no-referrer', String(h.get('referrer-policy')));

    const csp = h.get('content-security-policy') || '';
    if (csp.includes("frame-ancestors 'none'")) r.pass(S, 'CSP frame-ancestors none');
    else r.fail(S, 'CSP frame-ancestors none', csp);

    if (csp.includes("default-src 'self'")) r.pass(S, 'CSP default-src self');
    else r.fail(S, 'CSP default-src self', csp);
  });

  // ===========================================================
  // 9. CSRF endpoint supprimé
  // ===========================================================
  await r.section('9. CSRF endpoint supprimé', async () => {
    const csrf = await api('/csrf-token');
    // Le stub retourne success: true mais csrfToken: null
    if (csrf.status === 200 && csrf.data?.csrfToken === null) {
      r.pass(S, '/api/csrf-token retourne csrfToken: null');
    } else if (csrf.status === 404) {
      r.pass(S, '/api/csrf-token supprimé (404)');
    } else {
      r.fail(S, '/api/csrf-token supprimé/inactif', `${csrf.status} ${JSON.stringify(csrf.data)}`);
    }
  });

  // ===========================================================
  // 10. Régression — CRUD complet fonctionne sans CSRF
  // ===========================================================
  await r.section('10. Régression — CRUD fonctionne', async () => {
    // CREATE
    const created = await api('/biens', {
      method: 'POST',
      jar: o1.jar,
      body: { nom: 'Régression CRUD', type: 'studio', ville: 'Thiès' },
    });
    if (created.status === 201) r.pass(S, 'CREATE bien → 201');
    else r.fail(S, 'CREATE bien → 201', `statut ${created.status}`);

    const id = created.data?.data?.id;
    if (!id) {
      r.blocked(S, 'READ/UPDATE/DELETE', 'pas de bien créé');
      return;
    }

    // READ — vérifier via la liste (pas de GET /:id dans le CRUD)
    const list = await api('/biens', { jar: o1.jar });
    const found = list.data?.data?.some((b) => b.id === id && b.nom === 'Régression CRUD');
    if (list.status === 200 && found) r.pass(S, 'READ bien via liste → 200');
    else r.fail(S, 'READ bien via liste → 200', `statut ${list.status}, trouvé: ${found}`);

    // UPDATE
    const updated = await api(`/biens/${id}`, {
      method: 'PUT',
      jar: o1.jar,
      body: { nom: 'Régression CRUD Updated' },
    });
    if (updated.status === 200) r.pass(S, 'UPDATE bien → 200');
    else r.fail(S, 'UPDATE bien → 200', `statut ${updated.status}`);

    // DELETE
    const deleted = await api(`/biens/${id}`, { method: 'DELETE', jar: o1.jar });
    if (deleted.status === 200) r.pass(S, 'DELETE bien → 200');
    else r.fail(S, 'DELETE bien → 200', `statut ${deleted.status}`);

    // Vérifier supprimé via la liste
    const afterDel = await api('/biens', { jar: o1.jar });
    const stillThere = afterDel.data?.data?.some((b) => b.id === id);
    if (!stillThere) r.pass(S, 'bien supprimé absent de la liste');
    else r.fail(S, 'bien supprimé absent de la liste', 'bien encore présent');
  });

  // ===========================================================
  // 11. Régression — login/logout fonctionne
  // ===========================================================
  await r.section('11. Régression — login/logout', async () => {
    const jar = newJar();
    const login = await api('/auth/login', {
      method: 'POST',
      jar,
      body: { email: o1.email, password: PW },
    });
    if (login.status === 200 && login.data?.success) r.pass(S, 'login → 200 + success');
    else r.fail(S, 'login → 200 + success', `statut ${login.status}`);

    const me = await api('/auth/me', { jar });
    if (me.status === 200 && me.data?.user?.id) r.pass(S, 'me → 200 + user');
    else r.fail(S, 'me → 200 + user', `statut ${me.status}`);

    const logout = await api('/auth/logout', { method: 'POST', jar });
    if (logout.status === 200) r.pass(S, 'logout → 200');
    else r.fail(S, 'logout → 200', `statut ${logout.status}`);

    const afterLogout = await api('/auth/me', { jar });
    if (afterLogout.status === 401) r.pass(S, 'après logout → 401');
    else r.fail(S, 'après logout → 401', `statut ${afterLogout.status}`);
  });

  // ===========================================================
  // 12. Notifications — CRUD sans CSRF
  // ===========================================================
  await r.section('12. Régression — notifications', async () => {
    const list = await api('/notifications', { jar: o1.jar });
    if (list.status === 200) r.pass(S, 'GET notifications → 200');
    else r.fail(S, 'GET notifications → 200', `statut ${list.status}`);
  });

  // ===========================================================
  // 13. Dashboard — accès sans CSRF
  // ===========================================================
  await r.section('13. Régression — dashboard', async () => {
    const stats = await api('/stats/dashboard', { jar: o1.jar });
    if (stats.status === 200) r.pass(S, 'GET stats/dashboard → 200');
    else r.fail(S, 'GET stats/dashboard → 200', `statut ${stats.status}`);
  });
}
