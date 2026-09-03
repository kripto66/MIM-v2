import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data, error } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (error) { console.error('ERR', error.message); process.exit(1); }
for (const u of (data?.users || [])) {
  const t = (u.user_metadata?.account_type || '').toLowerCase();
  const e = (u.email || '').toLowerCase();
  if (t === 'ultra_admin' || e.includes('ad2009')) {
    console.log('AUTH EMAIL:', u.email, '| ID:', u.id, '| type:', t, '| meta:', JSON.stringify(u.user_metadata));
  }
}
const { data: profs, error: pe } = await sb.from('profiles').select('id,email,username,account_type,role,name').eq('account_type', 'ultra_admin');
console.log('PROFILES:', JSON.stringify(profs, null, 2), 'ERR:', pe?.message);
