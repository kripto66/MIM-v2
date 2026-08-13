// ============================================================
// MIM — LOADTEST : réinitialisation des mots de passe des
// comptes modifiés par un run de tests (phase 5 + frontend P18),
// pour permettre un re-run propre des phases.
//   node scripts/loadtest/reset-pws.mjs
// ============================================================
import { service, loadState, LT, tenantUsername } from './common.mjs';

const state = loadState();
const targets = [...(state.tenantPasswordChanged || [])];
const forced = `${tenantUsername(1, 3)}@mim.local`;
if (!targets.includes(forced)) targets.push(forced);

let ok = 0;
for (const email of targets) {
  const { data: users, error } = await service.auth.admin.listUsers({ filter: `email=eq.${email}` });
  const u = users?.users?.[0];
  if (!u) { console.log(`  introuvable: ${email}`); continue; }
  const meta = u.user_metadata || {};
  const { error: err } = await service.auth.admin.updateUserById(u.id, {
    password: LT.tenantPw,
    user_metadata: { ...meta, must_change_password: true },
  });
  if (err) console.log(`  echec ${email}: ${err.message}`);
  else { ok++; console.log(`  reset ${email}`); }
}
console.log(`Reset terminé : ${ok}/${targets.length} comptes → ${LT.tenantPw} / must_change_password=true`);
