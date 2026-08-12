import { readFileSync } from 'node:fs';

const token = process.env.SUPABASE_PAT;
const ref = 'wjrlklqzuxyixlhahlie';
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
