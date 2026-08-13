// ============================================================
// MIM - Création / mise à jour d'un compte administrateur
//   node scripts/createAdmin.js --email=admin@mim.local --password=... [--name="Admin MIM"]
// ============================================================

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

function arg(name) {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`));
  return found ? found.split('=').slice(1).join('=') : undefined;
}

const email = (arg('email') || process.env.ADMIN_EMAIL || '').toLowerCase();
const password = arg('password') || process.env.ADMIN_PASSWORD;
const name = arg('name') || process.env.ADMIN_NAME || 'Admin MIM';

if (!email || !password) {
  console.error('Usage : node scripts/createAdmin.js --email=admin@mim.local --password=... [--name="Admin MIM"]');
  process.exit(1);
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const profileOf = async (id) => {
  const { data } = await sb.from('profiles').select('id, account_type, name, email').eq('id', id).maybeSingle();
  return data;
};

const { data: existing } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
let user = (existing?.users || []).find((u) => u.email?.toLowerCase() === email);

if (!user) {
  const { data, error } = await sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { account_type: 'admin', name, role: 'admin' },
  });
  if (error) {
    console.error('Échec création :', error.message);
    process.exit(1);
  }
  user = data.user;
  console.log(`Compte créé : ${email}`);
} else {
  const { error } = await sb.auth.admin.updateUserById(user.id, {
    user_metadata: { ...(user.user_metadata || {}), account_type: 'admin', name, role: 'admin' },
  });
  if (error) {
    console.error('Échec mise à jour :', error.message);
    process.exit(1);
  }
  console.log(`Compte existant mis à jour : ${email}`);
}

const profile = await profileOf(user.id);
if (profile && profile.account_type !== 'admin') {
  const { error } = await sb.from('profiles').update({ account_type: 'admin', role: 'admin', name }).eq('id', user.id);
  if (error) {
    console.error('Échec maj profil :', error.message);
    process.exit(1);
  }
  console.log('Profil mis à jour → admin.');
}

console.log(`ID : ${user.id}`);
console.log('Compte administrateur prêt. Connexion : http://localhost:3000/PartPublic/connexion.html');
