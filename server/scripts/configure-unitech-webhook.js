// ============================================================
// MIM - Configuration du webhook UnitechPay
//
// Usage :
//   node scripts/configure-unitech-webhook.js [--url=https://...]
//
// Sans --url, l'URL utilisée est APP_URL (server/.env). L'URL doit être
// HTTPS et publique : UnitechPay appelle ce endpoint serveur-à-serveur.
//
// Sécurité :
//  - La clé API est lue depuis server/.env (jamais affichée, jamais écrite).
//  - L'utilisateur doit confirmer avant toute modification du compte marchand.
//  - Seule l'URL finale (non sensible) est affichée.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');

function loadEnv() {
  const env = {};
  if (!fs.existsSync(envPath)) return env;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

const argUrl = process.argv.find((a) => a.startsWith('--url='))?.split('=').slice(1).join('=');

const env = loadEnv();
const apiKey = env.UNITECH_API_KEY;
if (!apiKey) {
  console.error('UNITECH_API_KEY absente de server/.env : configuration impossible.');
  process.exit(1);
}

const baseUrl = argUrl || env.APP_URL || '';
if (!/^https:\/\//.test(baseUrl)) {
  console.error(`L'URL doit être publique en HTTPS (reçue : ${baseUrl || '(vide)'}).`);
  console.error('Exemple : node scripts/configure-unitech-webhook.js --url=https://xxx.trycloudflare.com');
  process.exit(1);
}

const root = baseUrl.replace(/\/+$/, '');
const webhookUrl = `${root}/api/unitech/webhook`;
const apiBase = env.UNITECH_API_URL || 'https://api.unitech.sn/api';

console.log('---');
console.log(`URL du webhook à enregistrer : ${webhookUrl}`);
console.log('Compte marchand : compte UnitechPay lié à UNITECH_API_KEY');
console.log('Cette opération MODIFIE la configuration webhook du compte marchand.');

const answer = await ask('Confirmer l\'enregistrement de ce webhook ? (oui/non) ');
if (answer.trim().toLowerCase() !== 'oui') {
  console.log('Opération annulée.');
  process.exit(0);
}

const url = new URL(apiBase);
url.searchParams.set('action', 'configure_webhook');

try {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ webhook_url: webhookUrl }),
    timeout: 30000,
  });
  const data = await res.json().catch(() => null);

  if (res.ok && data?.success === true) {
    console.log('SUCCÈS : webhook enregistré :', webhookUrl);
  } else {
    console.error('ÉCHEC :', data?.message || `HTTP ${res.status}`);
    if (data?.details?.length) console.error('Détails :', JSON.stringify(data.details));
    process.exit(1);
  }
} catch (err) {
  console.error('Erreur réseau :', err.message);
  process.exit(1);
}
