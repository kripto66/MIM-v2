// ============================================================
// MIM — LOADTEST : réinitialisation des mots de passe des
// comptes modifiés par un run de tests (phase 5 + frontend P18),
// pour permettre un re-run propre des phases.
//   node scripts/loadtest/reset-pws.mjs
// ============================================================
import { execSync } from 'node:child_process';
import { service, loadState, LT, tenantUsername } from './common.mjs';

const psqlId = (email) => {
  const out = execSync(`docker exec supabase_db_MIM psql -U postgres -d postgres -tA -c "SELECT id FROM auth.users WHERE email='${email}';"`, { encoding: 'utf8' }).trim();
  return out || null;
};

const state = loadState();
const raw = [...(state.tenantPasswordChanged || [])];
const forced = `${tenantUsername(1, 3)}@mim.local`;
if (!raw.includes(forced)) raw.push(forced);
const targets = raw.map((t) => (t.endsWith('@mim.local') ? t : `${t}@mim.local`));

let ok = 0;
for (const email of targets) {
  const id = psqlId(email);
  if (!id) { console.log(`  introuvable: ${email}`); continue; }
  const { data: user } = await service.auth.admin.getUserById(id);
  if (!user) { console.log(`  getUserById échec: ${email}`); continue; }
  const meta = user.user_metadata || {};
  const { error: err } = await service.auth.admin.updateUserById(id, {
    password: LT.tenantPw,
    user_metadata: { ...meta, must_change_password: true },
  });
  const { error: err2 } = await service.from('profiles').update({ must_change_password: true }).eq('id', id);
  if (err || err2) console.log(`  echec ${email}: ${err?.message || err2?.message}`);
  else { ok++; console.log(`  reset ${email}`); }
}
console.log(`Reset terminé : ${ok}/${targets.length} comptes → ${LT.tenantPw} / must_change_password=true`);
