import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const EMAIL = 'ultraesnova@mim.local';
const PASSWORD = 'amdi2009&!';

const { data: created, error: err } = await sb.auth.admin.createUser({
  email: EMAIL,
  password: PASSWORD,
  email_confirm: true,
  user_metadata: { account_type: 'ultra_admin', name: 'UltraEsNova', role: 'ultra_admin' },
});
if (err) {
  console.error('CREATE USER ERR:', err.message);
  process.exit(1);
}
const uid = created.user.id;
console.log('Auth user créé:', uid);

const { error: upErr } = await sb.auth.admin.updateUserById(uid, {
  user_metadata: { account_type: 'ultra_admin', name: 'UltraEsNova', role: 'ultra_admin' },
});
if (upErr) console.error('META UPDATE ERR:', upErr.message);
else console.log('user_metadata → ultra_admin');

const { error: pErr } = await sb
  .from('profiles')
  .upsert({ id: uid, account_type: 'ultra_admin', role: 'ultra_admin', name: 'UltraEsNova', email: EMAIL, username: 'ultraesnova', must_change_password: false }, { onConflict: 'id' });
if (pErr) console.error('PROFILE UPSERT ERR:', pErr.message);
else console.log('Profil upsert → ultra_admin');

console.log('Prêt. Connexion : identifiant « UltraEsNova » ou « ultraesnova@mim.local » / mdp amdi2009&!');
