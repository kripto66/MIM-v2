// ============================================================
// MIM - Harness de test (léger, sans dépendance externe)
// ============================================================

export const BASE = process.env.TEST_BASE || 'http://127.0.0.1:3100/api';

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
  if (cookie) h.Cookie = cookie;

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
