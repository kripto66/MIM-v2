import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

const envPath = 'C:/xampp/htdocs/MIM2.1/MIM/server/.env';
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1').trim();
}
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9224;
const BASE = 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ts = Date.now().toString().slice(-8);
const owner = { email: `ownere2e${ts}@mim.local`, pw: 'Azerty123!' };
let ownerUid = null;
const exceptions = [];
let chrome;

try {
  const u = await sb.auth.admin.createUser({ email: owner.email, password: owner.pw, email_confirm: true, user_metadata: { account_type: 'proprietaire', role: 'proprietaire', name: 'Owner E2E', username: '', phone: '' } });
  if (!u.data?.user?.id) throw new Error('createUser: ' + u.error?.message);
  ownerUid = u.data.user.id;

  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--user-data-dir=C:\\Users\\EsNova\\AppData\\Local\\Temp\\opencode\\cp6', '--no-first-run', BASE + '/PartPublic/connexion.html'], { stdio: 'ignore' });
  await sleep(2500);
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    else if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push((m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').slice(0, 200));
    }
  };
  const send = (method, params = {}) => new Promise((res) => { const mid = ++id; pend.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;

  await send('Page.enable');
  await send('Runtime.enable');

  // Connexion via le formulaire réel
  await send('Page.navigate', { url: BASE + '/PartPublic/connexion.html' });
  await sleep(1500);
  await ev(`document.querySelector('#identifier').value='${owner.email}'; document.querySelector('#password').value='${owner.pw}'; document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); 'ok'`);
  await sleep(3000);

  const afterLogin = await ev(`({ href: location.href, cookie: document.cookie.includes('mim_token') })`);
  console.log('après connexion UI:', JSON.stringify(afterLogin));

  // Dashboard propriétaire : rendu réel
  const dash = await ev(`({
    url: location.href,
    ownerName: document.getElementById('ownerName')?.textContent?.trim(),
    statCards: document.querySelectorAll('.stat-card').length,
    totalProperties: document.getElementById('totalProperties')?.textContent?.trim(),
    apiMessage: document.getElementById('apiMessage')?.textContent?.trim().slice(0, 120),
  })`);
  console.log('dashboard:', JSON.stringify(dash));

  // Page employés : chargement + onglet tâches
  await send('Page.navigate', { url: BASE + '/PartProprietaires/employes.html' });
  await sleep(2500);
  const emp = await ev(`({
    url: location.href,
    hasAddBtn: !!document.getElementById('addBtn'),
    employesTab: document.querySelector('.tab.active')?.dataset?.tab,
  })`);
  console.log('employes.html:', JSON.stringify(emp));
  await ev(`document.querySelector('[data-tab="taches"]').click()`);
  await sleep(300);
  const tab = await ev(`document.querySelector('.tab.active')?.dataset?.tab`);
  console.log('onglet actif après clic:', tab);

  // Garde de zone : un propriétaire n'accède pas à PartAdmin
  await send('Page.navigate', { url: BASE + '/PartAdmin/admin.html' });
  await sleep(2000);
  const adminNav = await ev(`({ url: location.href })`);
  console.log('propriétaire -> /PartAdmin:', JSON.stringify(adminNav));

  console.log('exceptions JS:', exceptions.length ? exceptions : 'aucune');
  ws.close();
} catch (err) {
  console.log('EXCEPTION E2E:', err.message);
} finally {
  if (chrome) chrome.kill();
  if (ownerUid) {
    try { await sb.auth.admin.deleteUser(ownerUid); } catch {}
    const { count } = await sb.from('profiles').select('id', { count: 'exact' }).eq('id', ownerUid);
    console.log('profil restant après cleanup:', count || 0);
  }
  process.exit(0);
}
