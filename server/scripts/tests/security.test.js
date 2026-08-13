// ============================================================
// MIM - Suite sécurité : RLS comportementale, CORS, headers,
// cookies, rate limiting (serveur dédié), accès anon
// ============================================================

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { api } from './lib.js';

const S = 'securite';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.join(__dirname, '..', '..');

export async function runSecurity(r, ctx) {
  const { service } = ctx;

  // ----------------------------------------------------------
  await r.section('accès anon', async () => {
    const anonRoutes = ['/biens', '/logements', '/locataires', '/paiements', '/incidents', '/prestataires', '/interventions', '/stats/dashboard'];
    for (const route of anonRoutes) {
      const res = await api(route);
      if (res.status === 401) r.pass(S, `anon ${route} → 401`);
      else r.fail(S, `anon ${route} → 401`, `statut ${res.status}`);
    }

    try {
      const raw = await fetch(`${process.env.SUPABASE_URL}/rest/v1/biens`, {
        headers: { apikey: process.env.SUPABASE_ANON_KEY },
      });
      if (raw.status === 401) r.pass(S, 'PostgREST anon → 401 (grants minimaux)');
      else r.fail(S, 'PostgREST anon → 401 (grants minimaux)', `statut ${raw.status}`);
    } catch (err) {
      r.blocked(S, 'PostgREST anon → 401 (grants minimaux)', err.message);
    }
  });

  // ----------------------------------------------------------
  await r.section('RLS comportementale (PostgREST direct, jeton authentifié)', async () => {
    const o1 = ctx.seed.owners[0];
    const o2 = ctx.seed.owners[1];

    const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const { data: sess, error } = await anon.auth.signInWithPassword({ email: o1.email, password: 'Test1234!' });
    if (error || !sess?.session) {
      r.blocked(S, 'login supabase direct o1', error?.message);
      return;
    }

    const authed = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${sess.session.access_token}` } },
    });

    const { data: biens } = await authed.from('biens').select('id, user_id').eq('user_id', o2.id);
    if (biens?.length === 0) r.pass(S, 'SELECT biens de o2 (en tant que o1) → 0 ligne');
    else r.fail(S, 'SELECT biens de o2 (en tant que o1) → 0 ligne', `${biens?.length} ligne(s) !`);

    const { data: all } = await authed.from('biens').select('id');
    if (all?.length === 1) r.pass(S, 'o1 ne voit que ses propres biens (1)');
    else r.fail(S, 'o1 ne voit que ses propres biens (1)', `${all?.length} bien(s)`);

    // INSERT avec user_id d'autrui → WITH CHECK doit rejeter.
    const { error: insErr } = await authed.from('biens').insert({ user_id: o2.id, nom: 'Intrusion RLS', type: 'villa' });
    if (insErr) r.pass(S, 'INSERT bien au nom de o2 → rejeté (WITH CHECK)');
    else r.fail(S, 'INSERT bien au nom de o2 → rejeté (WITH CHECK)', 'insertion réussie !');

    const { error: notifErr } = await authed.from('notifications').insert({ user_id: o2.id, type: 'info', message: 'intrusion' });
    if (notifErr) r.pass(S, 'INSERT notification pour o2 → rejeté');
    else r.fail(S, 'INSERT notification pour o2 → rejeté', 'insertion réussie !');

    const { data: profOther } = await authed.from('profiles').select('id').eq('id', o2.id);
    if (!profOther || profOther.length === 0) r.pass(S, 'SELECT profil de o2 (en tant que o1) → 0 ligne');
    else r.fail(S, 'SELECT profil de o2 (en tant que o1) → 0 ligne', 'profil visible !');
  });

  // ----------------------------------------------------------
  await r.section('en-têtes de sécurité + cookies', async () => {
    const o1 = ctx.seed.owners[0];
    const raw = await api('/auth/me', { jar: o1.jar, raw: true });

    const h = raw.headers;
    if (h.get('x-content-type-options') === 'nosniff') r.pass(S, 'X-Content-Type-Options: nosniff');
    else r.fail(S, 'X-Content-Type-Options: nosniff', String(h.get('x-content-type-options')));
    if (h.get('x-frame-options') === 'DENY') r.pass(S, 'X-Frame-Options: DENY');
    else r.fail(S, 'X-Frame-Options: DENY', String(h.get('x-frame-options')));
    if (h.get('referrer-policy') === 'no-referrer') r.pass(S, 'Referrer-Policy: no-referrer');
    else r.fail(S, 'Referrer-Policy: no-referrer', String(h.get('referrer-policy')));

    // Set-Cookie du login : HttpOnly + SameSite.
    const res = await api('/auth/login', { method: 'POST', body: { email: o1.email, password: 'Test1234!' }, raw: true });
    const sc = res.headers.get('set-cookie') || '';
    if (/mim_token=/.test(sc) && /HttpOnly/i.test(sc)) r.pass(S, 'cookie mim_token HttpOnly');
    else r.fail(S, 'cookie mim_token HttpOnly', sc);
    if (/SameSite=Lax/i.test(sc)) r.pass(S, 'cookie mim_token SameSite=Lax');
    else r.fail(S, 'cookie mim_token SameSite=Lax', sc);
    if (!/Secure/i.test(sc)) r.pass(S, 'cookie non Secure en développement (attendu)');
    else r.fail(S, 'cookie non Secure en développement (attendu)', 'Secure présent alors que NODE_ENV vide');
  });

  // ----------------------------------------------------------
  await r.section('CORS', async () => {
    const allowed = await fetch('http://127.0.0.1:3100/api/health', { headers: { Origin: 'http://localhost:3000' } });
    if (allowed.headers.get('access-control-allow-origin') === 'http://localhost:3000') r.pass(S, 'origine autorisée → ACAO');
    else r.fail(S, 'origine autorisée → ACAO', String(allowed.headers.get('access-control-allow-origin')));

    const denied = await fetch('http://127.0.0.1:3100/api/health', { headers: { Origin: 'http://evil.example.com' } });
    const acao = denied.headers.get('access-control-allow-origin');
    if (acao === null || acao === undefined) r.pass(S, 'origine inconnue → pas d’ACAO');
    else r.fail(S, 'origine inconnue → pas d’ACAO', `ACAO=${acao}`);
  });

  // ----------------------------------------------------------
  await r.section('verify-2fa sans session de vérification', async () => {
    const res = await api('/auth/verify-2fa', { method: 'POST', body: { code: '123456' } });
    if (res.status === 401) r.pass(S, 'verify-2fa sans cookie mim_mfa_pending → 401');
    else r.fail(S, 'verify-2fa sans cookie mim_mfa_pending → 401', `statut ${res.status}`);
  });

  // ----------------------------------------------------------
  await r.section('rate limiting (serveur dédié, limite active)', async () => {
    const serverProc = spawn(process.execPath, ['server.js'], {
      cwd: SERVER_DIR,
      env: { ...process.env, PORT: '3101', GIT_REPO_PATH: '', GIT_BACKUP: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout.on('data', () => {});
    serverProc.stderr.on('data', () => {});

    try {
      await waitHealth(3101);
      const base = 'http://127.0.0.1:3101/api';
      const email = `rlimit${Date.now()}@mimtest.com`;
      await fetch(`${base}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_type: 'proprietaire', name: 'RL', email, phone: '+221700000000', password: 'Test1234!', password_confirm: 'Test1234!' }),
      });

      let got429 = false;
      let statusLast = 0;
      for (let i = 0; i < 40; i++) {
        const res = await fetch(`${base}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: 'mauvais' }),
        });
        statusLast = res.status;
        if (res.status === 429) {
          got429 = true;
          break;
        }
      }
      if (got429) r.pass(S, `429 après dépassement (dernier statut avant blocage : ${statusLast})`);
      else r.fail(S, '429 après dépassement', `aucun 429 sur 40 tentatives (dernier ${statusLast})`);
    } finally {
      serverProc.kill();
    }
  });

  void service;
}

async function waitHealth(port, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1200) });
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((rr) => setTimeout(rr, 300));
  }
  return false;
}
