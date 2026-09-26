import { readFileSync } from 'node:fs';

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

const query = readFileSync('supabase-schema.sql', 'utf8');
const res = await fetch(`https://api.supabase.com/v1/projects/${encodeURIComponent(ref)}/database/query`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ query }),
});

const text = await res.text();
console.log('STATUS:', res.status);
console.log('RESPONSE:', text.slice(0, 500));
