// ============================================================
// MIM - Harness de test (léger, sans dépendance externe)
// ============================================================

export const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3100/api';
export const REMOTE_OPT_IN = 'I_UNDERSTAND_REMOTE_E2E';
export const SEED_OPT_IN = 'I_UNDERSTAND_E2E_SEED';
export const LOCAL_OPT_IN = 'I_UNDERSTAND_LOCAL_E2E';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLocalHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return LOCAL_HOSTS.has(host) || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function isRemoteUrl(value) {
  try {
    return !isLocalHost(new URL(String(value)).hostname);
  } catch {
    return true;
  }
}

function hasExactOptIn(env, names, expected) {
  return names.some((name) => String(env[name] || '').trim() === expected);
}

export function assertTestDatabaseAllowed(env = process.env) {
  const databaseUrl = env.SUPABASE_URL;
  if (!databaseUrl) throw new Error('SUPABASE_URL est requis pour lancer les tests E2E.');

  if (isRemoteUrl(databaseUrl) && !hasExactOptIn(env, ['MIM_E2E_ALLOW_REMOTE', 'E2E_ALLOW_REMOTE', 'MIM_TEST_ALLOW_REMOTE', 'ALLOW_REMOTE_E2E', 'MIM_ALLOW_REMOTE_E2E'], REMOTE_OPT_IN)) {
    throw new Error(`Base E2E distante refusée. Définissez MIM_E2E_ALLOW_REMOTE=${REMOTE_OPT_IN} pour confirmer explicitement une base distante.`);
  }

  if (env.TEST_BASE && isRemoteUrl(env.TEST_BASE) && !hasExactOptIn(env, ['MIM_E2E_ALLOW_REMOTE', 'E2E_ALLOW_REMOTE', 'MIM_TEST_ALLOW_REMOTE', 'ALLOW_REMOTE_E2E', 'MIM_ALLOW_REMOTE_E2E'], REMOTE_OPT_IN)) {
    throw new Error(`Endpoint E2E distant refusé. Définissez MIM_E2E_ALLOW_REMOTE=${REMOTE_OPT_IN} pour confirmer explicitement un endpoint distant.`);
  }
}

export function assertSeedAllowed(env = process.env) {
  if (!hasExactOptIn(env, ['MIM_E2E_ALLOW_SEED', 'E2E_ALLOW_SEED', 'MIM_TEST_SEED', 'MIM_E2E_SEED', 'ALLOW_E2E_SEED'], SEED_OPT_IN)) {
    throw new Error(`Seed E2E refusé. Définissez MIM_E2E_ALLOW_SEED=${SEED_OPT_IN} pour confirmer explicitement les données de test.`);
  }
  if (env.SUPABASE_URL && !isRemoteUrl(env.SUPABASE_URL) && !hasExactOptIn(env, ['MIM_E2E_ALLOW_LOCAL'], LOCAL_OPT_IN)) {
    throw new Error(`Seed E2E local refusé. Définissez MIM_E2E_ALLOW_LOCAL=${LOCAL_OPT_IN} après avoir vérifié la base locale.`);
  }
}

export function newJar() {
  return { cookies: [] };
}

function cookieHeader(jar) {
  if (!jar || !jar.cookies.length) return '';
  return jar.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

export async function api(path, { method = 'GET', body, jar, raw = false, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  const cookie = cookieHeader(jar);
  if (cookie) {
    h.Cookie = cookie;
    const csrf = jar.cookies.find((c) => c.name === 'mim_csrf');
    if (csrf) h['X-CSRF-Token'] = csrf.value;
    try { h.Origin = new URL(BASE).origin; } catch {}
  }

  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  if (jar) {
    let setCookies = [];
    if (typeof res.headers.getSetCookie === 'function') {
      setCookies = res.headers.getSetCookie();
    }
    for (const sc of setCookies) {
      const [kv] = sc.split(';');
      const eq = kv.indexOf('=');
      const name = kv.slice(0, eq).trim();
      const value = kv.slice(eq + 1).trim();
      const existing = jar.cookies.findIndex((c) => c.name === name);
      const pair = { name, value };
      if (existing >= 0) jar.cookies[existing] = pair;
      else jar.cookies.push(pair);
    }
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    /* corps non JSON */
  }

  if (raw) return { status: res.status, data, headers: res.headers };
  return { status: res.status, data };
}

export async function createConfirmedSession(service, { account_type: accountType = 'proprietaire', name, email, phone, password }) {
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name, phone },
    app_metadata: { mim_account_type: accountType },
  });
  if (error || !data?.user?.id) throw new Error(error?.message || 'Utilisateur de test non créé');
  const jar = newJar();
  const login = await api('/auth/login', { method: 'POST', jar, body: { email, password } });
  if (login.status !== 200) throw new Error(`Connexion de test impossible: ${login.status}`);
  return { user: data.user, jar, login };
}

export const ROTATED_PASSWORD = 'MimRotated1234!';

export async function loginForBusiness(identifier, initialPassword = 'Test1234!', jar = newJar()) {
  let login = await api('/auth/login', {
    method: 'POST',
    jar,
    body: { identifier, password: initialPassword },
  });
  if (login.status !== 200 && initialPassword !== ROTATED_PASSWORD) {
    login = await api('/auth/login', {
      method: 'POST',
      jar,
      body: { identifier, password: ROTATED_PASSWORD },
    });
  }
  let change = null;
  if (login.status === 200 && login.data?.mustChangePassword) {
    change = await api('/auth/change-password', {
      method: 'PUT',
      jar,
      body: { password: ROTATED_PASSWORD, password_confirm: ROTATED_PASSWORD },
    });
  }
  return { jar, login, change };
}


// ============================================================
// Runner
// ============================================================

export class Runner {
  constructor() {
    this.results = [];
  }

  record(suite, name, ok, detail = '') {
    this.results.push({ suite, name, ok, detail });
  }

  pass(suite, name, detail = '') {
    this.record(suite, name, true, detail);
  }

  fail(suite, name, detail = '') {
    this.record(suite, name, false, detail);
  }

  blocked(suite, name, detail = '') {
    this.record(suite, name, 'blocked', detail);
  }

  async section(title, fn) {
    process.stdout.write(`\n  ▸ ${title}\n`);
    await fn();
  }

  summary() {
    const total = this.results.length;
    const passed = this.results.filter((r) => r.ok === true).length;
    const failed = this.results.filter((r) => r.ok === false).length;
    const blocked = this.results.filter((r) => r.ok === 'blocked').length;

    const bySuite = {};
    for (const r of this.results) {
      bySuite[r.suite] = bySuite[r.suite] || { pass: 0, fail: 0, blocked: 0 };
      bySuite[r.suite][r.ok === true ? 'pass' : r.ok === false ? 'fail' : 'blocked']++;
    }

    console.log('\n──────────────────────────────────────────');
    console.log('RAPPORT DES TESTS');
    console.log('──────────────────────────────────────────');
    for (const [suite, s] of Object.entries(bySuite)) {
      console.log(
        `  ${suite.padEnd(28)} PASS ${String(s.pass).padEnd(3)} FAIL ${String(s.fail).padEnd(3)} BLOCKED ${s.blocked}`
      );
    }
    console.log('──────────────────────────────────────────');
    console.log(`  TOTAL  ${total}   ✅ ${passed}   ❌ ${failed}   ⛔ ${blocked}`);
    console.log('──────────────────────────────────────────');

    const failures = this.results.filter((r) => r.ok !== true);
    if (failures.length) {
      console.log('\nDétails des échecs/bloqués :');
      for (const f of failures) {
        console.log(`  ❌ [${f.suite}] ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
      }
    }

    return { total, passed, failed, blocked };
  }
}

// ============================================================
// Assertions utilitaires
// ============================================================

export function okStatus(runner, res, suite, name, allowed = [200, 201]) {
  if (typeof name !== 'string') name = '—';
  if (!allowed.includes(res.status)) {
    runner.fail(suite, name, `statut ${res.status} (attendu ${allowed.join('/')}) — ${String(JSON.stringify(res.data) || '').slice(0, 300)}`);
    return false;
  }
  return true;
}

export function expectSuccess(runner, res, suite, name, allowed = [200, 201]) {
  if (typeof name !== 'string') name = '—';
  if (!okStatus(runner, res, suite, name, allowed)) return false;
  if (!res.data || res.data.success !== true) {
    runner.fail(suite, name, `success !== true : ${String(JSON.stringify(res.data) || '').slice(0, 300)}`);
    return false;
  }
  return true;
}
