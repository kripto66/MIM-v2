import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const envPath = 'C:/xampp/htdocs/MIM2.1/MIM/server/.env';
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1').trim();
}
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
const ts = Date.now().toString().slice(-8);
const email = `banprobe${ts}@mim.local`;
const pw = 'Azerty123!';
let uid = null;
try {
  const u = await sb.auth.admin.createUser({ email, password: pw, email_confirm: true, user_metadata: { account_type: 'proprietaire', role: 'proprietaire', name: 'Ban Probe', username: '', phone: '' } });
  uid = u.data.user.id;
  console.log('created:', uid);

  // 1) signInWithPassword d'un utilisateur NON banni (référence)
  const ok = await sb.auth.signInWithPassword({ email, password: pw });
  console.log('login normal ->', ok.error ? 'ERR ' + ok.error.status + ' ' + ok.error.message : 'OK');

  // 2) bannir
  const ban = await sb.auth.admin.updateUserById(uid, { ban_duration: '8760h' });
  console.log('ban ->', ban.error ? 'ERR ' + ban.error.message : 'OK');

  // 3) re-login après ban
  const after = await sb.auth.signInWithPassword({ email, password: pw });
  console.log('login après ban ->', after.error ? 'ERR status=' + after.error.status + ' code=' + after.error.code + ' msg=' + after.error.message : 'OK');

  // 4) recherche admin par email (endpoint filter GoTrue)
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY },
  });
  const body = await res.json();
  const u2 = (body.users || []).find((x) => x.email === email);
  console.log('admin filter users ->', res.status, u2 ? 'trouvé banned_until=' + u2.banned_until : 'AUCUN');
} catch (e) {
  console.log('EXCEPTION', e.message);
} finally {
  if (uid) { try { await sb.auth.admin.deleteUser(uid); } catch {} }
  const { count } = await sb.from('profiles').select('id', { count: 'exact' }).eq('email', email);
  console.log('cleanup profiles restants:', count || 0);
  process.exit(0);
}
