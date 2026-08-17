import 'dotenv/config';
import { api, newJar, BASE } from './scripts/tests/lib.js';
import { createClient } from '@supabase/supabase-js';

const service = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function main() {
  const jar = newJar();
  const email = `debug.owner.${Date.now()}@mim.test`;
  const reg = await api('/auth/register', {
    method: 'POST',
    jar,
    body: { account_type: 'proprietaire', name: 'Debug Owner', email, phone: '+221771234567', password: 'DebugPass123!', password_confirm: 'DebugPass123!' },
  });
  console.log('register:', reg.status, JSON.stringify(reg.data).slice(0, 150));

  const bien = await api('/biens', { method: 'POST', jar, body: { nom: 'Debug Res', type: 'immeuble', adresse: 'Rue D 1', ville: 'Dakar' } });
  console.log('bien:', bien.status, JSON.stringify(bien.data).slice(0, 150));
  const bienId = bien.data.data.id;

  await api('/logements', {
    method: 'POST',
    jar,
    body: { bien_id: bienId, nom: 'Debug App 1', type: 'appartement', nombre_chambres: 2, loyer_mensuel: 90000, statut: 'libre' },
  });

  const emp = await api('/employes', {
    method: 'POST',
    jar,
    body: { nom: 'Debug Agent', poste: 'Gardien', biens: [bienId] },
  });
  console.log('employe:', emp.status, JSON.stringify(emp.data).slice(0, 250));
  if (emp.status !== 201) return;
  const username = emp.data.account.username;

  const liaison = await service.from('employes_biens').select('*').eq('employe_id', emp.data.data.id);
  console.log('liaison db:', JSON.stringify(liaison.error || liaison.data));

  const jar2 = newJar();
  const ownerLogin = await api('/auth/login', { method: 'POST', jar: jar2, body: { identifier: email, password: 'DebugPass123!' } });
  console.log('owner login:', ownerLogin.status, 'cookies:', JSON.stringify(jar2.cookies));
  const meOwner = await api('/auth/me', { jar: jar2 });
  console.log('owner auth/me:', meOwner.status);

  const ejar = newJar();
  const login = await api('/auth/login', { method: 'POST', ejar, body: { identifier: username, password: '1234' } });
  console.log('login:', login.status, JSON.stringify(login.data));
  console.log('jar cookies after login:', JSON.stringify(ejar.cookies));

  const meAuth = await api('/auth/me', { jar: ejar });
  console.log('auth/me:', meAuth.status, JSON.stringify(meAuth.data).slice(0, 200));

  const me = await api('/employe/me', { jar: ejar });
  console.log('employe/me:', me.status, JSON.stringify(me.data).slice(0, 300));

  const logements = await api('/employe/logements', { jar: ejar });
  console.log('employe/logements:', logements.status, JSON.stringify(logements.data).slice(0, 400));

  const dash = await api('/employe/dashboard', { jar: ejar });
  console.log('employe/dashboard:', dash.status, JSON.stringify(dash.data).slice(0, 400));
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });