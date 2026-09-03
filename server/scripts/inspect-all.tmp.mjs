import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data, error } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (error) { console.error('ERR', error.message); process.exit(1); }
console.log('TOTAL ACCOUNTS:', (data?.users||[]).length);
for (const u of (data?.users||[])) {
  console.log('-', u.email, '| type:', (u.user_metadata?.account_type||''), '| name:', (u.user_metadata?.name||''));
}
