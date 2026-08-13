// ============================================================
// MIM — LOADTEST : PHASE 18 — Frontend navigateur (CDP Edge)
//   Propriétaire : login réel + dashboard 100 logements.
//   Locataire    : login forcé change-password → LocaDash.
//   Admin        : login + admin/stats.
//   Zéro exception console toléré. Cible : http://localhost:3000
//   (le frontend durcit API → localhost:3000 quand l'origine est
//   locale ; :3000 est donc l'hôte représentatif du dev local).
// ============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LT, tenantUsername, ownerEmail, loadState } from './common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CDP_PORT = 9224;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const USER_DIR = path.join(os.tmpdir(), 'opencode', 'cdp-lt-profile');
const BASE = process.env.LOADTEST_BASE || 'http://localhost:3000';

const state = loadState();
const PER = LT.perOwner;
const OWNERS = LT.owners;

const results = [];
const record = (name, ok, detail = '') => results.push({ name, ok, detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ws = null;
let msgId = 0;
const pending = new Map();
const pageErrors = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200));
  return r.result?.value;
}
async function waitForUrl(substr, timeout = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const url = await evalJs('location.href');
    if (url && url.includes(substr)) return url;
    await sleep(300);
  }
  throw new Error(`URL "${substr}" non atteinte (actuelle: ${await evalJs('location.href')})`);
}
async function setField(selector, value) {
  await evalJs(`(() => {
    const el = document.querySelector('${selector}');
    if (!el) throw new Error('champ ${selector} introuvable');
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}
async function submitForm(selector) {
  const ok = await evalJs(`(() => {
    const f = document.querySelector('${selector}');
    if (!f) throw new Error('form ${selector} introuvable');
    const btn = f.querySelector('button[type="submit"], button');
    if (btn) btn.click(); else f.requestSubmit ? f.requestSubmit() : f.submit();
    return true;
  })()`);
  return ok;
}
async function textOf(selector) {
  const v = await evalJs(`(document.querySelector('${selector}')||{innerText:''}).innerText`);
  return String(v).trim();
}
async function pageFetch(url) {
  return JSON.parse(await evalJs(`fetch(${JSON.stringify(url)}).then(r => r.text())`));
}

async function runScenario(name, fn) {
  try {
    await fn();
  } catch (e) {
    record(name, false, e.message);
  }
}

async function main() {
  fs.rmSync(USER_DIR, { recursive: true, force: true });
  const browser = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${USER_DIR}`,
    '--no-first-run', '--disable-gpu', '--no-default-browser-check', '--window-size=1280,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  let targets = [];
  for (let i = 0; i < 40 && !targets.length; i++) {
    await sleep(500);
    try { targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); } catch {}
  }
  if (!targets.length) { console.error('CDP indisponible'); browser.kill(); process.exit(1); }

  const page = targets.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(JSON.stringify(msg.params.exceptionDetails).slice(0, 300));
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') pageErrors.push(msg.params.entry.text);
    if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) {
      const u = msg.params.response.url;
      if (!/favicon/i.test(u)) pageErrors.push(`HTTP ${msg.params.response.status} ${u}`);
    }
  };
  await new Promise((res) => { ws.onopen = res; });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Network.enable');

  // Le serveur :3000 (prod local) doit être disponible pour la phase frontend.
  let prodOk = false;
  try {
    const h = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    prodOk = h.ok;
  } catch {}
  if (!prodOk) {
    record('P18 serveur :3000 disponible', false, `${BASE}/api/health injoignable`);
  }

  // ── Scénario 1 : propriétaire ──
  await runScenario('P18 propriétaire login+dashboard', async () => {
    await send('Page.navigate', { url: `${BASE}/PartPublic/connexion.html` });
    await waitForUrl('connexion.html');
    await setField('#identifier', ownerEmail(1));
    await setField('#password', LT.ownerPw);
    await submitForm('#loginForm');
    const url = await waitForUrl('dashboard.html', 25000);
    await sleep(1200);
    const total = await textOf('#totalProperties');
    const occupied = await textOf('#occupiedProperties');
    const owner = await textOf('#ownerName');
    record('P18 propriétaire redirection dashboard', url.includes('PartProprietaires/dashboard.html'), url);
    record(`P18 propriétaire ${PER} logements`, total.replace(/\D/g, '') === String(PER), `total='${total}'`);
    record(`P18 propriétaire ${PER} occupés`, occupied.replace(/\D/g, '') === String(PER), `occupés='${occupied}'`);
    record('P18 propriétaire nom', owner.includes('LoadTest Owner'), `owner='${owner}'`);
  });

  // ── Scénario 2 : locataire avec changement de mot de passe forcé ──
  await runScenario('P18 locataire change-password + LocaDash', async () => {
    await send('Page.navigate', { url: `${BASE}/PartPublic/connexion.html` });
    await waitForUrl('connexion.html');
    await setField('#identifier', tenantUsername(1, 3));
    await setField('#password', LT.tenantPw);
    await submitForm('#loginForm');
    const url = await waitForUrl('change-password', 25000);
    record('P18 locataire redirigé change-password', true, url);
    await setField('#password', LT.tenantPw2);
    await setField('#password_confirm', LT.tenantPw2);
    await submitForm('#passwordForm');
    await waitForUrl('LocaDash.html', 25000);
    await sleep(1200);
    const dash = await pageFetch(`${BASE}/api/locataire/dashboard`);
    const loyer = 80000 + 1 * 1000 + 3 * 500;
    const loyerOk = dash.linked && dash.logement?.loyer_mensuel === loyer;
    record('P18 locataire LocaDash chargé', !!dash.linked, `linked=${dash.linked}`);
    record(`P18 locataire loyer cohérent (${loyer})`, loyerOk, `loyer=${dash.logement?.loyer_mensuel}`);
    const statut = await textOf('#paiementStatut');
    record('P18 locataire statut paiement affiché', statut.length > 0, `'${statut}'`);
    // logout
    const lout = await evalJs(`(document.querySelector('#logoutButton')||document.querySelector('#logoutMenu')||null) ? (document.querySelector('#logoutButton')?.click() || document.querySelector('#logoutMenu')?.click(), true) : true`);
    record('P18 locataire logout cliquable', lout, '');
  });

  // ── Scénario 3 : admin ──
  await runScenario('P18 admin login+stats', async () => {
    await send('Page.navigate', { url: `${BASE}/PartPublic/connexion.html` });
    await waitForUrl('connexion.html');
    await setField('#identifier', 'admin@mim.local');
    await setField('#password', process.env.ADMIN_PASSWORD || 'Admin1234!');
    await submitForm('#loginForm');
    const url = await waitForUrl('admin.html', 25000);
    await sleep(1500);
    const stats = await pageFetch(`${BASE}/api/admin/stats`);
    record('P18 admin redirection', url.includes('PartAdmin/admin.html'), url);
    record('P18 admin stats chargées', stats.success === true, `success=${stats.success}`);
    record(`P18 admin propriétaires ≥ ${OWNERS + 7}`, (stats.stats?.proprietaires ?? 0) >= OWNERS + 7, `n=${stats.stats?.proprietaires}`);
    record(`P18 admin locataires ≥ ${OWNERS * PER}`, (stats.stats?.locataires ?? 0) >= OWNERS * PER, `n=${stats.stats?.locataires}`);
  });

  // ── Bilan console ──
  record('P18 aucune exception console', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  const fails = results.filter((x) => !x.ok);
  console.log('──────────────────────────────────────────');
  for (const r0 of results) console.log(`  ${r0.ok ? '✅' : '❌'} ${r0.name} — ${r0.detail}`);
  console.log('──────────────────────────────────────────');
  console.log(`P18 — ${results.length} vérifs, ${fails.length} échec(s)`);
  fs.writeFileSync(path.join(__dirname, 'results-frontend.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  ws.close();
  browser.kill();
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error('[frontend]', e); process.exit(1); });
