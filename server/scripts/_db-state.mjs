import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const testUid = '994bbe59-81e3-4799-a837-2f0332172f78';
const { data, error } = await sb.from('notifications')
  .select('id, user_id, message, created_at')
  .eq('user_id', testUid)
  .order('created_at', { ascending: false });
console.log('notifs test employé (user_id):', error ? 'ERROR ' + error.message : JSON.stringify(data));

const { data: n3, error: e3 } = await sb.from('notifications')
  .select('id, user_id, message')
  .ilike('message', '%Salaire 2026-08%');
console.log('notifs salaire test:', e3 ? 'ERROR ' + e3.message : JSON.stringify((n3 || []).slice(0, 5)));
