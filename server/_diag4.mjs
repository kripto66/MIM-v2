import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';
import fs from 'fs';

const env = {};
for (const line of fs.readFileSync(new URL('.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
}

const BASE = 'http://localhost:3000';

async function ownerSide() {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner.test20260812@example.com', password: 'OwnerTest2026!' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const list = await fetch(`${BASE}/api/crud/locataires`, { headers: { cookie } });
  const data = await list.json();
  const rows = data.data || [];
  const amdi = rows.find(r => r.nom === 'Ahmadou Diop');
  console.log('--- Propriétaire ---');
  console.log('locataires:', rows.map(r => `${r.nom}->logement ${r.logement_id}`).join(' | '));
  console.log('amdi visible:', !!amdi);
}

async function tenantSide() {
  const service = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: link } = await service.auth.admin.generateLink({ type: 'recovery', email: 'amdi@mim.local' });
  const userSb = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data: ver } = await userSb.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'recovery' });
  const session = ver.session;
  const mimToken = jwt.sign(
    { id: ver.user.id, account_type: 'locataire', supabase_token: session.access_token, refresh_token: session.refresh_token, supabase_expires_at: session.expires_at },
    env.JWT_SECRET, { expiresIn: '7d' }
  );
  const res = await fetch(`${BASE}/api/locataire/dashboard`, { headers: { cookie: `mim_token=${mimToken}` } });
  const d = await res.json();
  console.log('--- Locataire (amdi) ---');
  console.log('logement:', d.logement ? `${d.logement.nom} (${d.logement.type})` : 'null');
  console.log('bien:', d.bien ? d.bien.nom : 'null', '| adresse:', d.logement?.adresse, '| loyer:', d.logement?.loyer_mensuel, '| statut:', d.logement?.statut);
  console.log('date entrée:', d.locataire?.date_entree);
}

await ownerSide();
await tenantSide();
