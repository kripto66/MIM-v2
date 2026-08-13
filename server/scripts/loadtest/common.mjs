// ============================================================
// MIM — Harnais LOADTEST 100×100 (10 000 locataires)
// Utilitaires partagés (serveur dédié, API client, namespace).
// ============================================================
import { config } from 'dotenv';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

export const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = path.resolve(__dirname, '..', '..');
config({ path: path.join(SERVER_DIR, '.env') });

export const LT = {
  ts: new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19),
  ownerPrefix: 'loadtest.owner.',
  tenantPrefix: 'loadtest.tenant.',
  ownerDomain: '@loadtest.mim',
  ownerPw: 'LoadTest!2026',
  tenantPw: 'LoadTest!2026',
  tenantPw2: 'LoadTest!2027',
  owners: Number(process.env.LT_OWNERS || '100'),
  perOwner: Number(process.env.LT_PER_OWNER || '100'),
};

export const pad = (n) => String(n).padStart(3, '0');
export const ownerEmail = (i) => `loadtest.owner.${pad(i)}@loadtest.mim`;
export const ownerName = (i) => `LoadTest Owner ${pad(i)}`;
export const tenantUsername = (i, j) => `loadtest.tenant.${pad(i)}.${pad(j)}`;
export const tenantName = (i, j) => `Locataire LT ${pad(i)}-${pad(j)}`;

export function monthNow() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function prevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const isLoadtestEmail = (e) => String(e || '').toLowerCase().startsWith('loadtest.');
export const isLoadtestUsername = (u) => String(u || '').toLowerCase().startsWith('loadtest.');

export const PORT = Number(process.env.LOADTEST_PORT || '3200');
export const BASE = `http://127.0.0.1:${PORT}/api`;
export const PROD = 'http://127.0.0.1:3000/api';

export const service = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// ---- Serveur dédié (rate limit off, git backup off) ----
let serverProc = null;
export function spawnServer() {
  const env = {
    ...process.env,
    PORT: String(PORT),
    RATE_LIMIT_OFF: 'true',
    GIT_REPO_PATH: '',
    GIT_BACKUP: 'false',
    NODE_ENV: '',
  };
  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: SERVER_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', (d) => process.stdout.write(`[lt-srv] ${d}`));
  serverProc.stderr.on('data', (d) => process.stdout.write(`[lt-srv!] ${d}`));
  return serverProc;
}
export function stopServer() {
  if (serverProc) serverProc.kill();
  serverProc = null;
}
export async function waitHealth(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch {
      /* pas prêt */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// ---- Client API (avec cookie jar) ----
export function newJar() {
  return { cookies: [] };
}
function cookieHeader(jar) {
  if (!jar?.cookies?.length) return '';
  return jar.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}
export async function api(base, url, { method = 'GET', body, jar, headers = {}, raw = false } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  const cookie = cookieHeader(jar);
  if (cookie) h.Cookie = cookie;
  const res = await fetch(base + url, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  if (jar && typeof res.headers.getSetCookie === 'function') {
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(';');
      const eq = kv.indexOf('=');
      const name = kv.slice(0, eq).trim();
      const value = kv.slice(eq + 1).trim();
      const ex = jar.cookies.findIndex((c) => c.name === name);
      const pair = { name, value };
      if (ex >= 0) jar.cookies[ex] = pair;
      else jar.cookies.push(pair);
    }
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return raw ? { status: res.status, data, headers: res.headers } : { status: res.status, data };
}
export const apiLt = (url, o) => api(BASE, url, o);
export const apiProd = (url, o) => api(PROD, url, o);

// ---- Statistiques ----
export function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}
export function statSummary(times) {
  const sum = times.reduce((a, b) => a + b, 0);
  return {
    n: times.length,
    mean: +(sum / times.length).toFixed(1),
    p95: +percentile(times, 95).toFixed(1),
    p99: +percentile(times, 99).toFixed(1),
    min: +Math.min(...times).toFixed(1),
    max: +Math.max(...times).toFixed(1),
  };
}

// ---- Base (service role) ----
export async function countAll(table, filter) {
  let q = service.from(table).select('id');
  if (filter) q = q.or(filter);
  const { data, error } = await q;
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return data?.length || 0;
}

// Comptage des données LOADTEST uniquement.
export async function ltCounts() {
  const owners = await countAll('profiles', 'email.like.loadtest.owner.%');
  const register = await countAll('profiles', 'email.like.loadtest.register.%');
  const tenants = await countAll('profiles', 'username.like.loadtest.%');
  return { owners, register, tenants };
}

// ---- Runner léger ----
export class Runner {
  constructor() { this.results = []; }
  record(suite, name, ok, detail = '') { this.results.push({ suite, name, ok, detail }); }
  pass(suite, name, detail = '') { this.record(suite, name, true, detail); }
  fail(suite, name, detail = '') { this.record(suite, name, false, detail); }
  blocked(suite, name, detail = '') { this.record(suite, name, 'blocked', detail); }
  summary() {
    const bySuite = {};
    for (const r of this.results) {
      bySuite[r.suite] = bySuite[r.suite] || { pass: 0, fail: 0, blocked: 0 };
      bySuite[r.suite][r.ok === true ? 'pass' : r.ok === false ? 'fail' : 'blocked']++;
    }
    const total = this.results.length;
    const passed = this.results.filter((r) => r.ok === true).length;
    const failed = this.results.filter((r) => r.ok === false).length;
    const blocked = this.results.filter((r) => r.ok === 'blocked').length;
    console.log('\n──────────────────────────────────────────');
    console.log('RAPPORT LOADTEST');
    console.log('──────────────────────────────────────────');
    for (const [s, v] of Object.entries(bySuite)) {
      console.log(`  ${s.padEnd(22)} PASS ${String(v.pass).padEnd(3)} FAIL ${String(v.fail).padEnd(3)} BLOCKED ${v.blocked}`);
    }
    console.log('──────────────────────────────────────────');
    console.log(`  TOTAL  ${total}   ✅ ${passed}   ❌ ${failed}   ⛔ ${blocked}`);
    console.log('──────────────────────────────────────────');
    const fails = this.results.filter((r) => r.ok !== true);
    for (const f of fails) console.log(`  ❌ [${f.suite}] ${f.name} — ${f.detail}`);
    return { total, passed, failed, blocked };
  }
  async section(title, fn) {
    console.log(`\n  ▸ ${title}`);
    await fn();
  }
  toJSON() { return this.results; }
}

// ---- État persistant ----
export function statePath() { return path.join(__dirname, 'state.json'); }
export function saveState(state) { fs.writeFileSync(statePath(), JSON.stringify(state, null, 2)); }
export function loadState() {
  const p = statePath();
  if (!fs.existsSync(p)) throw new Error(`état absent : ${p} (lancez seed.mjs d'abord)`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
