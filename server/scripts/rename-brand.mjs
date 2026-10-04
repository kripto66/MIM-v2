import { readFileSync, writeFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = 'C:\\xampp\\htdocs\\MIM2.1\\MIM';
const SKIP = /node_modules|\.git|backups|video-marketing/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (SKIP.test(full)) continue;
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(js|css|md)$/.test(entry)) yield full;
  }
}

const pairs = [
  [/abonnements MIM des propriétaires/g, 'abonnements Okarne GM des propriétaires'],
  [/abonnement MIM est/g, 'abonnement Okarne GM est'],
  [/abonnement MIM expire/g, 'abonnement Okarne GM expire'],
  [/abonnement MIM enregistré/g, 'abonnement Okarne GM enregistré'],
  [/Admin MIM/g, 'Admin Okarne GM'],
  [/document\.title = `MIM - /g, 'document.title = `Okarne GM - '],
  [/onboarding-logo">MIM</g, 'onboarding-logo">Okarne GM<'],
  [/hors MIM/g, 'hors Okarne GM'],
  [/administration MIM/g, 'administration Okarne GM'],
  [/Document généré par MIM/g, 'Document généré par Okarne GM'],
  [/mot de passe MIM/g, 'mot de passe Okarne GM'],
  [/lo-gin|depuis le dashboard MIM/g, 'depuis le dashboard Okarne GM'],
  [/branding MIM/g, 'branding Okarne GM'],
  [/locataires de MIM/g, 'locataires de Okarne GM'],
  [/friendlyName: 'MIM App'/g, "friendlyName: 'Okarne GM'"],
  [/Sauvegarde code MIM/g, 'Sauvegarde code Okarne GM'],
  [/Sauvegarde manuelle depuis le dashboard MIM/g, 'Sauvegarde manuelle depuis le dashboard Okarne GM'],
];

let changed = 0;
for (const f of walk(ROOT)) {
  let c = readFileSync(f, 'utf8');
  const orig = c;
  for (const [re, rep] of pairs) c = c.replace(re, rep);
  if (c !== orig) {
    writeFileSync(f, c, 'utf8');
    changed++;
    console.log('updated', f);
  }
}
console.log('changed', changed);
