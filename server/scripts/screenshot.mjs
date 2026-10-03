// ============================================================
// MIM - Captures d'echan de l'application (Chrome headless + CDP)
//
// Aucune dependance : WebSocket et fetch sont natifs depuis Node 22.
//  1. connexion HTTP pour obtenir le cookie de session ;
//  2. Chrome headless pilote en CDP (port 9222) ;
//  3. injection du cookie, navigation, capture PNG.
//
//   node scripts/screenshot.mjs
// ============================================================

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://localhost:3000';
const PORT = 9222;
const PROFILE = 'C:\\Users\\EsNova\\AppData\\Local\\Temp\\opencode\\mim-chrome-profile';
const OUT = path.resolve('images');

// Comptes de test du seed (seed.js : OWNER_PASSWORD)
const COMPTES = {
  proprio: { email: 'mim-e2e-is_test-owner1@mimtest.com', password: 'Test1234!' },
};

// Compte agence AVEC des donnees reelles (2 biens, 2 proprietaires lies)
// — le compte seed n'a aucune liaison, son tableau de bord affiche 0 partout.
// Identifiants hors depot : la regle du projet (cf. commit de securite sur
// les artefacts de test) interdit tout credential en clair dans le code.
// Fournir avant la capture :
//   MIM_SCREENSHOT_AGENCE_EMAIL / MIM_SCREENSHOT_AGENCE_PASSWORD
// Sans cela, les cibles agence sont simplement sautees.
if (process.env.MIM_SCREENSHOT_AGENCE_EMAIL && process.env.MIM_SCREENSHOT_AGENCE_PASSWORD) {
  COMPTES.agence = {
    email: process.env.MIM_SCREENSHOT_AGENCE_EMAIL,
    password: process.env.MIM_SCREENSHOT_AGENCE_PASSWORD,
  };
}

// Chaque cible : nom de fichier, URL, compte requis.
const CIBLES = [
  { fichier: 'demo-proprio-dashboard.png', url: '/PartProprietaires/dashboard.html', compte: 'proprio' },
  { fichier: 'demo-agence-dashboard.png', url: '/PartAgence/first_Mode/dashboard.html', compte: 'agence' },
  { fichier: 'demo-agence-portefeuille.png', url: '/PartAgence/first_Mode/portefeuille.html', compte: 'agence' },
  { fichier: 'demo-agence-versements.png', url: '/PartAgence/first_Mode/versements.html', compte: 'agence' },
  { fichier: 'demo-proprio-abonnements.png', url: '/PartProprietaires/abonnements.html', compte: 'proprio' },
];

// ─── Connexion HTTP : recupere les cookies de session ────────
async function login(compte) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, referer: `${BASE}/` },
    body: JSON.stringify(compte),
  });
  if (!res.ok) throw new Error(`login ${compte.email} -> HTTP ${res.status}`);
  const raw = res.headers.get('set-cookie') || '';
  const cookies = [];
  for (const part of raw.split(/,(?=[^;]+=)/)) {
    const paire = part.trim().split(';')[0];
    const eq = paire.indexOf('=');
    if (eq > 0) cookies.push({ name: paire.slice(0, eq), value: paire.slice(eq + 1) });
  }
  if (!cookies.some((c) => c.name === 'mim_token')) throw new Error('cookie mim_token absent');
  return cookies;
}

// Verifie QUEL compte porte le recueil de cookies : sans ce controle, un
// decalage de session produit une capture parfaitement reussie... de la
// mauvaise interface.
async function quiSuisJe(cookies) {
  const res = await fetch(`${BASE}/api/auth/me`, {
    headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
  });
  if (!res.ok) throw new Error(`/api/auth/me -> HTTP ${res.status}`);
  const j = await res.json();
  return String(j?.user?.email || j?.email || '').toLowerCase();
}

// ─── CDP : client WebSocket minimal ──────────────────────────
function cdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const attentes = new Map();
  const evenements = [];
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => {
      resolve({
        envoyer(method, params = {}, sessionId) {
          const msg = { id: ++id, method, params };
          if (sessionId) msg.sessionId = sessionId;
          ws.send(JSON.stringify(msg));
          return new Promise((ok, ko) => {
            attentes.set(msg.id, { ok, ko });
            setTimeout(() => { if (attentes.delete(msg.id)) ko(new Error(`timeout ${method}`)); }, 45000);
          });
        },
        surEvent(nom, fn) { evenements.push({ nom, fn }); },
        fermer() { try { ws.close(); } catch { } },
      });
    });
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      if (m.id && attentes.has(m.id)) {
        const { ok, ko } = attentes.get(m.id);
        attentes.delete(m.id);
        m.error ? ko(new Error(`${m.error.message}`)) : ok(m.result);
      } else if (m.method) {
        for (const e of evenements) if (e.nom === m.method) e.fn(m.params);
      }
    });
    ws.addEventListener('error', () => reject(new Error('WebSocket CDP')));
  });
}

// ─── Chrome headless ────────────────────────────────────────
// Tue les instances laisseees par un passage precedent. On filtre sur le
// chemin du profil : votre Chrome de bureau n'est jamais touche.
async function nettoyerChrome() {
  const cmd = [
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\"",
    `| Where-Object { $_.CommandLine -like '*${path.basename(PROFILE)}*' }`,
    '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
  ].join(' ');
  await new Promise((ok) => {
    const p = spawn('powershell', ['-NoProfile', '-Command', cmd], { stdio: 'ignore' });
    p.on('exit', ok);
  });
  await sleep(1200);
}

async function demarrerChrome() {
  await nettoyerChrome();
  try { rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); }
  catch (e) { console.log(`  (profil non purge : ${e.code})`); }
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  proc.unref();

  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) { const j = await r.json(); return j.webSocketDebuggerUrl; }
    } catch { }
  }
  throw new Error('Chrome CDP indisponible');
}

// ─── Capture ────────────────────────────────────────────────
async function capturer(cli, sessionId, url, fichier, cookies, emailAttendu) {
  await cli.envoyer('Page.enable', {}, sessionId);
  await cli.envoyer('Network.enable', {}, sessionId);
  await cli.envoyer('Runtime.enable', {}, sessionId);
  await cli.envoyer('Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false }, sessionId);

  // Purge totale : sans elle, une session precedente peut survivre au
  // changement de compte (cookie homonyme conserve par Chrome).
  await cli.envoyer('Network.clearBrowserCookies', {}, sessionId);
  for (const c of cookies) {
    await cli.envoyer('Network.setCookie', { ...c, url: BASE, path: '/' }, sessionId);
  }
  const verif = await cli.envoyer('Network.getCookies', { urls: [BASE] }, sessionId);
  const vu = (verif.cookies || []).map((c) => c.name).join(',');
  if (!vu.includes('mim_token')) throw new Error(`cookies non poses (${vu || 'vide'})`);

  // Charge l'origine AVANT le controle : la cible demarre sur about:blank,
  // depuis lequel une URL relative ne peut pas etre resolue.
  await cli.envoyer('Page.navigate', { url: `${BASE}/` }, sessionId);
  await attendreCharge(cli, sessionId);

  // Controle decsifif : on demande au NAVIGATEUR qui il est, pas au recueil.
  // On recupere le corps TEXTUEL (le remote object ne se serialise pas bien)
  // et on l'analyse cote Node.
  const idRes = await cli.envoyer('Runtime.evaluate', {
    expression: "fetch('/api/auth/me',{credentials:'same-origin'}).then(r=>r.text())",
    awaitPromise: true, returnByValue: true,
  }, sessionId);
  const brut = String(idRes.result?.value || '');
  let emailVu = '';
  try {
    const j = JSON.parse(brut);
    emailVu = String((j.user && j.user.email) || j.email || '').toLowerCase();
  } catch { /* corps non JSON : on laisse emailVu vide, le controle echouera */ }
  if (emailVu !== emailAttendu) {
    throw new Error(`navigateur : « ${emailVu || brut.slice(0, 60) || 'vide'} » au lieu de « ${emailAttendu} »`);
  }

  await cli.envoyer('Page.navigate', { url }, sessionId);
  await attendreCharge(cli, sessionId);
  await sleep(4500); // donnees asynchrones + animations d'entree

  const { data } = await cli.envoyer('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(path.join(OUT, fichier), Buffer.from(data, 'base64'));
  console.log(`      ^ ${emailAttendu}`);
  return Buffer.from(data, 'base64').length;
}

// Attente par sondage : plus sur qu'un evenement pouvant etre perdu
// lorsque des listeners s'accumulent d'une capture a l'autre.
async function attendreCharge(cli, sessionId) {
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const r = await cli.envoyer('Runtime.evaluate',
        { expression: 'document.readyState', returnByValue: true }, sessionId);
      if (r.result?.value === 'complete') return;
    } catch { }
  }
}

// ─── Main ───────────────────────────────────────────────────
const cookiesParCompte = {};
for (const [nom, compte] of Object.entries(COMPTES)) {
  const cookies = await login(compte);
  const identite = await quiSuisJe(cookies);
  if (identite !== compte.email.toLowerCase()) {
    throw new Error(`${nom} : cookie pour « ${identite} » au lieu de « ${compte.email} »`);
  }
  cookiesParCompte[nom] = cookies;
  console.log(`  session ${nom} verifiee : ${identite}`);
}

mkdirSync(OUT, { recursive: true });
const wsUrl = await demarrerChrome();
console.log('  Chrome CDP pret');

const cli = await cdp(wsUrl);
const { targetId } = await cli.envoyer('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cli.envoyer('Target.attachToTarget', { targetId, flatten: true });

let ok = 0;
for (const c of CIBLES) {
  if (!COMPTES[c.compte]) {
    console.log(`  --  ${c.fichier.padEnd(34)} saute : compte « ${c.compte} » non configure (MIM_SCREENSHOT_AGENCE_*)`);
    continue;
  }
  try {
    const octets = await capturer(cli, sessionId, BASE + c.url, c.fichier,
      cookiesParCompte[c.compte], COMPTES[c.compte].email.toLowerCase());
    console.log(`  OK  ${c.fichier.padEnd(34)} ${String(Math.round(octets / 1024)).padStart(4)} Ko`);
    ok++;
  } catch (e) {
    console.log(`  KO  ${c.fichier.padEnd(34)} ${e.message}`);
  }
}

cli.fermer();
await nettoyerChrome();
console.log(`\n  ${ok}/${CIBLES.length} captures -> images/`);
