import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const dir = 'C:\\xampp\\htdocs\\MIM2.1\\MIM\\PartPublic';
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.html')) continue;
  const p = path.join(dir, f);
  const c = readFileSync(p, 'utf8');
  const n = c.replace(/<span class="brand-text">MyImmo<strong>Management<\/strong><\/span>/g, '<span class="brand-text">Okarne<strong>GM</strong></span>');
  if (n !== c) { writeFileSync(p, n, 'utf8'); console.log('ok', f); }
}
