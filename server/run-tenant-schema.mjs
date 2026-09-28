import { readFileSync } from 'node:fs';

// Verrou identique à run-schema.mjs (audit H3) : ce script pousse un SQL
// legacy qui n'est plus aligné sur les migrations (il recréait notamment
// la politique `tenant_link_locataire`, supprimée par
// 20260924000000_security_integrity_hardening.sql:435). Une poussée
// accidentelle rouvre donc un accès à des logements, incidents et
// paiements. Le projet n'est plus codé en dur : il doit être explicite.
if (process.env.MIM_ALLOW_LEGACY_SCHEMA_PUSH !== 'I_UNDERSTAND_SCHEMA_PUSH') {
  console.error('Ce script est désactivé. Utilisez Supabase CLI et les migrations versionnées.');
  process.exit(1);
}

const token = process.env.SUPABASE_PAT;
const ref = process.env.SUPABASE_PROJECT_REF;
if (!token || !ref) {
  console.error('SUPABASE_PAT et SUPABASE_PROJECT_REF sont requis pour cette opération explicite.');
  process.exit(1);
}

const query = readFileSync('schema-tenant.sql', 'utf8');

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ query }),
});

const text = await res.text();
console.log('STATUS:', res.status);
console.log('RESPONSE:', text.slice(0, 2000));
