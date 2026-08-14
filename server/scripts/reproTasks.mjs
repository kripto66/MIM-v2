import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const ownerId = '00000000-0000-0000-0000-000000000000';

try {
  const { data: tasks = [], error } = await sb.from('tasks').select('*').eq('user_id', ownerId).order('created_at', { ascending: false });
  console.log('tasks query:', error ? 'ERROR ' + error.message : 'OK ' + tasks.length);
} catch (e) {
  console.log('tasks query THREW:', e.message);
}

try {
  const uids = [];
  const { data: employes = [], error } = await sb.from('employes').select('id, nom, account_uid').in('account_uid', uids.length ? uids : [null]);
  console.log('employes in query:', error ? 'ERROR ' + error.message : 'OK ' + employes.length);
} catch (e) {
  console.log('employes in query THREW:', e.message);
}
