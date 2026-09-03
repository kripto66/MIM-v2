import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { data, error } = await sb.from('profiles').select('*').limit(1);
console.log('SAMPLE COLUMNS:', data ? Object.keys(data[0]||{}).join(', ') : 'none', 'ERR:', error?.message);
