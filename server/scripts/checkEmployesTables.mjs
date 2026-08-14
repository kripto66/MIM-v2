import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

for (const table of ['employes', 'tasks', 'paiements_employes']) {
  const { data, error } = await sb.from(table).select('*').limit(1);
  console.log(`${table}: data=${JSON.stringify(data)} error=${error?.message}`);
}

const { data: prof } = await sb.from('profiles').select('account_type').limit(1);
console.log('profiles sample ok:', Array.isArray(prof));
