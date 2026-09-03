import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const EMAIL = 'ultraesnova@mim.local';
const UID = '10d84295-6f37-40ed-a0ac-8c963c06330e';

const { data: existing, error: ex } = await sb.from('profiles').select('id, account_type, username').eq('id', UID).maybeSingle();
console.log('EXISTING PROFILE:', JSON.stringify(existing), 'ERR:', ex?.message);

const payload = {
  id: UID,
  account_type: 'ultra_admin',
  role: 'ultra_admin',
  name: 'UltraEsNova',
  email: EMAIL,
  username: 'ultraesnova',
  phone: '777777777',
  must_change_password: false,
};

let res;
if (existing) {
  res = await sb.from('profiles').update(payload).eq('id', UID);
  console.log('UPDATE profile:', res.error?.message || 'OK');
} else {
  res = await sb.from('profiles').insert(payload);
  console.log('INSERT profile:', res.error?.message || 'OK');
}
