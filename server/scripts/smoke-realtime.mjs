import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const url = process.env.SUPABASE_URL || 'http://127.0.0.1:64321';
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!service) {
  console.error('SUPABASE_SERVICE_ROLE_KEY requis (env server/.env)');
  process.exit(2);
}
const sb = createClient(url, service, { auth: { persistSession: false } });
sb.realtime.setAuth(service);

const ch = sb.channel('smoke');
let got = null;
ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, (p) => { got = p; });
await new Promise((r) => ch.subscribe((s) => { if (s === 'SUBSCRIBED') r(); }));

// insère une notification de test
const { data: user } = await sb.from('profiles').select('id').limit(1).single();
await sb.from('notifications').insert({ user_id: user.id, type: 'test', message: 'rt-smoke', lu: false });
await new Promise((r) => setTimeout(r, 3000));
console.log(got ? 'REALTIME_OK' : 'REALTIME_MISS');
process.exit(got ? 0 : 1);
