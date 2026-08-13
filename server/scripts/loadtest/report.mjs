// ============================================================
// MIM — LOADTEST : rapport final consolidé
//   Agrège results-phases.json + results-db.json + results-frontend.json
//   → REPORT-LOADTEST.md + résumé console.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (f, def) => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8')); }
  catch { return def; }
};

const phases = read('results-phases.json', { results: [] });
const db = read('results-db.json', { checks: [] });
const fe = read('results-frontend.json', { results: [] });

const all = [
  ...phases.results.map((x) => ({ ...x, source: 'phases' })),
  ...db.checks.map((x) => ({ name: x.name, ok: x.ok, detail: x.detail, source: 'db' })),
  ...fe.results.map((x) => ({ ...x, source: 'frontend' })),
];

const pass = all.filter((x) => x.ok === true).length;
const fail = all.filter((x) => x.ok === false).length;
const blocked = all.filter((x) => x.ok !== true && x.ok !== false).length;

const perf = all.filter((x) => x.detail && (x.name.includes('perf') || String(x.detail).includes('ms') || String(x.detail).includes('cpu=')));
const fails = all.filter((x) => x.ok === false);
const notes = all.filter((x) => x.ok !== true && x.ok !== false);

const lines = [];
lines.push('# RAPPORT LOADTEST — MIM 100 propriétaires × 100 locataires (10 000)');
lines.push('');
lines.push(`Généré : ${new Date().toISOString()}`);
lines.push('');
lines.push('## Synthèse');
lines.push('');
lines.push(`- **Total vérifications : ${all.length}**`);
lines.push(`- ✅ PASS : **${pass}**`);
lines.push(`- ❌ FAIL : **${fail}**`);
lines.push(`- ⛔ BLOCKED/NOTE : **${blocked}**`);
lines.push('');
lines.push('## Résultats par phase');
lines.push('');
lines.push('| Phase | PASS | FAIL | BLOCKED |');
lines.push('|---|---|---|---|');
const bySuite = {};
for (const r of all) {
  const s = r.suite || (r.source === 'db' ? 'P20-db' : r.source === 'frontend' ? 'P18-frontend' : '?');
  bySuite[s] = bySuite[s] || { pass: 0, fail: 0, blocked: 0 };
  if (r.ok === true) bySuite[s].pass++;
  else if (r.ok === false) bySuite[s].fail++;
  else bySuite[s].blocked++;
}
for (const [s, v] of Object.entries(bySuite)) lines.push(`| ${s} | ${v.pass} | ${v.fail} | ${v.blocked} |`);
lines.push('');

if (fails.length) {
  lines.push('## Échecs (bugs candidats)');
  lines.push('');
  lines.push('| ID | Phase | Test | Détail |');
  lines.push('|---|---|---|---|');
  fails.forEach((f, k) => {
    lines.push(`| BUG-${String(k + 1).padStart(2, '0')} | ${f.suite || '—'} | ${f.name} | ${String(f.detail).replace(/\|/g, '/').slice(0, 200)} |`);
  });
  lines.push('');
}

if (notes.length) {
  lines.push('## Notes (comportements observés)');
  lines.push('');
  for (const n of notes) lines.push(`- **[${n.suite || n.source}] ${n.name}** — ${n.detail}`);
  lines.push('');
}

if (perf.length) {
  lines.push('## Mesures de performance');
  lines.push('');
  for (const p of perf) lines.push(`- **[${p.suite || p.source}] ${p.name}** — ${p.detail}`);
  lines.push('');
}

const md = lines.join('\n');
fs.writeFileSync(path.join(__dirname, 'REPORT-LOADTEST.md'), md, 'utf8');

console.log(md);
console.log(`\n→ ${path.join(__dirname, 'REPORT-LOADTEST.md')}`);
