import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
const dir = 'C:\\xampp\\htdocs\\MIM2.1\\MIM\\PartPublic';
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.html')) continue;
  const p = path.join(dir, f);
  const c = readFileSync(p, 'utf8');
  const n = c.replace(/<span class="brand-mark"[^>]*>\s*<svg[\s\S]{0,400}?<\/svg>\s*<\/span>/g,
    '<img src="/images/logo-okarne.svg" alt="Okarne GM" width="36" height="36" style="display:block;border-radius:8px">');
  if (n !== c) { writeFileSync(p, n, 'utf8'); console.log('ok', f); }
}
