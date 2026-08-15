// ============================================================
// MIM - Moteur d'import CSV (onboarding propriétaire)
//
// Parcours :
//   1. Le propriétaire télécharge les modèles CSV (GET /api/import/templates/:cat).
//   2. Il remplit un fichier par catégorie (biens, logements, locataires, employes).
//   3. POST /api/import/preview : lecture + validation + détection des doublons
//      + génération des usernames (aucune écriture en base).
//   4. POST /api/import/execute : création dans l'ordre des dépendances
//      (biens → logements → locataires → comptes locataires → employes →
//      comptes employes), avec compensation par ligne en cas d'échec.
//
// Règles métier respectées (identiques aux routes existantes) :
//   - user_id provient TOUJOURS de la session (jamais du client) ;
//   - un logement ne peut avoir qu'un seul locataire actif ;
//   - les comptes locataires/employes sont créés via auth.admin avec
//     must_change_password = true et un mot de passe initial temporaire ;
//   - les usernames sont uniques dans toute l'application (générés
//     automatiquement : amadou.diop, amadou.diop2, …).
// ============================================================

import { tenantEmailFor, usernameIsValid } from './tenantAccount.js';
import { notify } from './notifications.js';

export const INITIAL_PASSWORD = '1234';
export const CATEGORIES = ['biens', 'logements', 'locataires', 'employes'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ------------------------------------------------------------
// Décodage des fichiers (BOM UTF-8, fallback latin1 pour Excel FR)
// ------------------------------------------------------------

export function decodeCsvBuffer(buf) {
  if (!buf || !buf.length) return '';
  let data = buf;
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) data = buf.subarray(3);
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(data);
  if (utf8.includes('\uFFFD')) {
    return new TextDecoder('latin1').decode(data);
  }
  return utf8;
}

// ------------------------------------------------------------
// Parseur CSV (sans dépendance) : virgule ou point-virgule,
// champs entre guillemets, retours à la ligne.
// ------------------------------------------------------------

function detectDelimiter(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  let inQuote = false;
  let semicolons = 0;
  let commas = 0;
  for (const ch of firstLine) {
    if (ch === '"') inQuote = !inQuote;
    else if (!inQuote) {
      if (ch === ';') semicolons++;
      else if (ch === ',') commas++;
    }
  }
  return semicolons > commas ? ';' : ',';
}

export function parseCsv(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const delim = detectDelimiter(raw);

  const cells = [];
  const rows = [];
  let row = [];
  let cell = '';
  let inQuote = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuote) {
      if (ch === '"') {
        if (raw[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);

  if (!rows.length) return { headers: [], rows: [] };

  const headerRow = rows.shift().map((h) => String(h || '').trim());
  const byKey = new Map();
  headerRow.forEach((h, idx) => {
    const key = normalizeHeader(h);
    if (key && !byKey.has(key)) byKey.set(key, idx);
  });

  const parsedRows = rows
    .filter((r) => r.some((c) => String(c || '').trim() !== ''))
    .map((r) => {
      const values = {};
      for (const [key, idx] of byKey.entries()) {
        values[key] = idx < r.length ? String(r[idx] || '').trim() : '';
      }
      return { values, raw: r };
    });

  return { headers: [...byKey.keys()], rows: parsedRows };
}

// ------------------------------------------------------------
// Normalisation des en-têtes (insensible aux accents / casse / séparateurs)
// ------------------------------------------------------------

export function normalizeHeader(h) {
  return String(h || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const HEADER_ALIASES = {
  nom: ['nom', 'nomcomplet', 'nomlocataire', 'nomemploye', 'nomdubien', 'nomduproprietaire', 'designation'],
  prenom: ['prenom', 'prenoms'],
  type: ['type', 'typedebien', 'typedelogement'],
  adresse: ['adresse', 'adressebien', 'adressepostale'],
  ville: ['ville', 'localite'],
  pays: ['pays', 'pays'],
  description: ['description', 'descriptif', 'notes'],
  bien: ['bien', 'nombien', 'nomdubien', 'bienrattache', 'bienlie'],
  logement: ['logement', 'nomlogement', 'nomdulogement', 'logementlie'],
  loyer: ['loyer', 'loyermensuel', 'montantloyer'],
  salaire: ['salaire', 'salairemensuel', 'remuneration', 'montantsalaire'],
  email: ['email', 'mail', 'courriel', 'adresseemail'],
  telephone: ['telephone', 'tel', 'phone', 'portable', 'numerotelephone', 'numerotel'],
  jour: ['jour', 'jourecheance', 'echeance', 'jourdecheance', 'jourpaiement'],
  chambres: ['chambres', 'nombrechambres', 'nbchambres', 'nombredeschambres'],
  statut: ['statut', 'etat'],
  poste: ['poste', 'fonction', 'role', 'metier'],
  dateentree: ['dateentree', 'datedentree'],
  dateembauche: ['dateembauche', 'datedembauche'],
};

function resolveHeader(header) {
  const h = normalizeHeader(header);
  for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(h)) return canonical;
  }
  return null;
}

export function mapHeaders(parsed) {
  const mapping = {};
  for (const header of parsed.headers) {
    const canonical = resolveHeader(header);
    if (canonical && !mapping[canonical]) mapping[canonical] = header;
  }
  return mapping;
}

// ------------------------------------------------------------
// Valeurs numériques / booléennes
// ------------------------------------------------------------

export function parseNumberFr(value) {
  if (value === '' || value == null) return null;
  let s = String(value).replace(/[\s\u00A0\u202F]/g, '').replace(/\u20AC/g, '').trim();
  if (!s) return null;
  if (/^\d+,\d+$/.test(s)) s = s.replace(',', '.');
  else if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// ------------------------------------------------------------
// Génération des usernames (convention : prenom.nom, puis 2, 3, …)
// ------------------------------------------------------------

function slugBase(prenom, nom) {
  const strip = (s) =>
    String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  let base = `${strip(prenom)}.${strip(nom)}`
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\.{2,}/g, '.');
  if (base.length < 3) base = 'utilisateur';
  if (base.length > 30) base = base.slice(0, 30).replace(/\.+$/, '');
  return base;
}

async function usernameTaken(sb, username) {
  const { data } = await sb.from('profiles').select('id').ilike('username', username).maybeSingle();
  return Boolean(data);
}

export async function uniqueUsername(sb, prenom, nom) {
  const base = slugBase(prenom, nom);
  if (!(await usernameTaken(sb, base))) return base;
  for (let i = 2; i <= 99; i++) {
    const candidate = `${base}${i}`.slice(0, 32);
    if (usernameIsValid(candidate) && !(await usernameTaken(sb, candidate))) return candidate;
  }
  const fallback = `${base}${Date.now() % 10000}`.slice(0, 32);
  return usernameIsValid(fallback) ? fallback : `utilisateur${Date.now() % 100000}`;
}

export function splitFullName(nom, prenom) {
  const first = String(prenom || '').trim();
  const last = String(nom || '').trim();
  if (first) return { prenom: first, nom: last || first };
  const parts = last.split(/\s+/);
  if (parts.length > 1) {
    return { prenom: parts[0], nom: parts.slice(1).join(' ') };
  }
  return { prenom: '', nom: last };
}

// ------------------------------------------------------------
// Définition des catégories importables
// ------------------------------------------------------------

const CATEGORY_DEFS = {
  biens: {
    label: 'Biens',
    required: ['nom', 'type'],
    fields: ['nom', 'type', 'adresse', 'ville', 'pays', 'description'],
  },
  logements: {
    label: 'Logements',
    required: ['nom', 'type', 'loyer'],
    fields: ['bien', 'nom', 'type', 'loyer', 'chambres', 'adresse', 'statut', 'description'],
  },
  locataires: {
    label: 'Locataires',
    required: ['nom'],
    fields: ['nom', 'prenom', 'email', 'telephone', 'bien', 'logement', 'loyer', 'jour', 'dateentree', 'statut'],
  },
  employes: {
    label: 'Employés',
    required: ['nom'],
    fields: ['nom', 'prenom', 'email', 'telephone', 'poste', 'bien', 'salaire', 'dateembauche', 'statut'],
  },
};

// ------------------------------------------------------------
// Préparation : validation + doublons + aperçu (aucune écriture)
// ------------------------------------------------------------

export async function prepareImport(sb, ownerId, payload) {
  const { categories = [], files = {}, duplicatePolicy = 'ignore' } = payload || {};

  if (!categories.length) {
    return { error: 'Sélectionnez au moins une catégorie à importer.' };
  }
  for (const cat of categories) {
    if (!CATEGORIES.includes(cat)) {
      return { error: `Catégorie inconnue : ${cat}` };
    }
    const file = files[cat];
    if (!file || !String(file.content || '').trim()) {
      return { error: `Le fichier de la catégorie « ${CATEGORY_DEFS[cat].label} » est vide ou manquant.` };
    }
  }

  const categoryReports = [];
  const seenUsernames = new Set();
  const bienNoms = new Set();

  for (const cat of categories) {
    const def = CATEGORY_DEFS[cat];
    const file = files[cat];
    const parsed = parseCsv(String(file.content || ''));
    const mapping = mapHeaders(parsed);

    const report = {
      category: cat,
      label: def.label,
      filename: file.filename || '',
      total: parsed.rows.length,
      ok: 0,
      errors: [],
      warnings: [],
      duplicates: [],
      sample: [],
      accounts: [],
      headers: parsed.headers,
      unknownHeaders: parsed.headers.filter((h) => !resolveHeader(h)),
    };

    for (const required of def.required) {
      if (!mapping[required]) {
        report.errors.push({ line: 0, champ: required, message: `Colonne « ${requiredLabel(required)} » manquante dans l'en-tête.` });
      }
    }

    if (report.errors.some((e) => e.line === 0)) {
      categoryReports.push(report);
      continue;
    }

    for (const [idx, row] of parsed.rows.entries()) {
      const line = idx + 2; // ligne 1 = en-tête
      const v = row.values;

      if (report.sample.length < 8) {
        report.sample.push({ line, apercu: apercuOf(cat, v) });
      }

      // --- Validations communes ---
      let email = v.email || '';
      if (email && !EMAIL_RE.test(email)) {
        report.errors.push({ line, champ: 'email', message: 'Adresse email invalide.' });
        email = '';
      }

      let statut = v.statut || 'actif';
      if (cat !== 'employes' && !['actif', 'inactif'].includes(statut)) {
        report.errors.push({ line, champ: 'statut', message: `Statut « ${statut} » invalide (actif ou inactif).` });
        statut = 'actif';
      }
      if (cat === 'employes' && !['actif', 'inactif'].includes(statut)) {
        report.errors.push({ line, champ: 'statut', message: `Statut « ${statut} » invalide (actif ou inactif).` });
        statut = 'actif';
      }

      let generated = null;
      if (cat === 'biens') {
        await prepareBien(sb, ownerId, report, { line, v, seenUsernames, bienNoms });
      } else if (cat === 'logements') {
        await prepareLogement(sb, ownerId, report, { line, v, seenUsernames, bienNoms });
      } else if (cat === 'locataires') {
        generated = await prepareLocataire(sb, ownerId, report, { line, v, seenUsernames, bienNoms });
      } else if (cat === 'employes') {
        generated = await prepareEmploye(sb, ownerId, report, { line, v, seenUsernames, bienNoms });
      }

      if (generated) {
        report.accounts.push({ line, username: generated, account_type: cat === 'locataires' ? 'locataire' : 'employe' });
        const sampleRow = report.sample.find((s) => s.line === line);
        if (sampleRow) sampleRow.username = generated;
      }

      report.ok++;
    }

    // Les erreurs de champ neutralisent les doublons affichés pour la même ligne.
    const lineErrors = new Set(report.errors.map((e) => e.line));
    if (lineErrors.size) {
      report.duplicates = report.duplicates.filter((d) => !lineErrors.has(d.line));
    }
    report.ok = Math.max(0, report.ok - report.errors.length - report.duplicates.length);

    categoryReports.push(report);
  }

  const totals = categoryReports.reduce(
    (acc, c) => {
      acc.total += c.total;
      acc.ok += c.ok;
      acc.errors += c.errors.length;
      acc.duplicates += c.duplicates.length;
      return acc;
    },
    { total: 0, ok: 0, errors: 0, duplicates: 0 }
  );

  return {
    ready: totals.errors === 0,
    totals,
    duplicatePolicy,
    categories: categoryReports,
  };
}

function requiredLabel(key) {
  return { nom: 'Nom', type: 'Type', loyer: 'Loyer' }[key] || key;
}

function apercuOf(cat, v) {
  switch (cat) {
    case 'biens':
      return [v.nom, v.type, v.ville].filter(Boolean).join(' · ');
    case 'logements':
      return [v.bien, v.nom, v.type, v.loyer].filter(Boolean).join(' · ');
    case 'locataires':
      return [v.prenom, v.nom, v.bien, v.logement].filter(Boolean).join(' · ');
    case 'employes':
      return [v.prenom, v.nom, v.poste, v.salaire].filter(Boolean).join(' · ');
    default:
      return '';
  }
}

function hasLineErrors(report, line) {
  return report.errors.some((e) => e.line === line);
}

async function prepareBien(sb, ownerId, report, ctx) {
  const { line, v, bienNoms } = ctx;

  if (report.errors.some((e) => e.line === 0)) return;

  const nom = v.nom || '';
  const type = v.type || '';
  if (!nom) report.errors.push({ line, champ: 'nom', message: 'Le nom est obligatoire.' });
  if (!type) report.errors.push({ line, champ: 'type', message: 'Le type est obligatoire.' });
  if (hasLineErrors(report, line)) return;

  const key = nom.toLowerCase();
  if (bienNoms.has(key)) {
    report.duplicates.push({ line, champ: 'nom', message: 'Doublon dans le fichier : un autre bien de ce fichier porte ce nom.' });
    return;
  }
  bienNoms.add(key);

  const { data: existing } = await sb
    .from('biens')
    .select('id, nom, type, adresse, ville')
    .eq('user_id', ownerId)
    .ilike('nom', nom)
    .maybeSingle();

  if (existing) {
    report.duplicates.push({ line, champ: 'nom', message: `Un bien « ${nom} » existe déjà dans votre espace.`, existing });
    return;
  }
}

async function prepareLogement(sb, ownerId, report, ctx) {
  const { line, v, bienNoms } = ctx;

  if (report.errors.some((e) => e.line === 0)) return;

  const nom = v.nom || '';
  if (!nom) {
    report.errors.push({ line, champ: 'nom', message: 'Le nom du logement est obligatoire.' });
    return;
  }

  let type = String(v.type || '').toLowerCase();
  if (type === 'appartement') type = 'appartement';
  else if (type === 'chambre') type = 'chambre';
  else {
    report.errors.push({ line, champ: 'type', message: `Type de logement « ${v.type || ''} » invalide (appartement ou chambre).` });
    return;
  }

  const loyer = parseNumberFr(v.loyer);
  if (loyer === null || Number.isNaN(loyer) || loyer <= 0) {
    report.errors.push({ line, champ: 'loyer', message: 'Le loyer doit être un nombre positif.' });
    return;
  }

  let chambres = null;
  if (v.chambres !== undefined && v.chambres !== '') {
    chambres = parseNumberFr(v.chambres);
    if (Number.isNaN(chambres) || chambres < 1) {
      report.errors.push({ line, champ: 'chambres', message: 'Le nombre de chambres doit être au moins 1.' });
      return;
    }
  }
  if (type === 'appartement' && (chambres === null)) {
    report.errors.push({ line, champ: 'chambres', message: 'Indiquez le nombre de chambres pour un appartement.' });
    return;
  }

  if (v.statut !== undefined && v.statut !== '' && !['libre', 'occupe', 'maintenance'].includes(v.statut)) {
    report.errors.push({ line, champ: 'statut', message: `Statut « ${v.statut} » invalide (libre, occupe ou maintenance).` });
    return;
  }

  if (hasLineErrors(report, line)) return;

  let bienId = null;
  if (v.bien) {
    const { data: bien } = await sb
      .from('biens')
      .select('id, nom')
      .eq('user_id', ownerId)
      .ilike('nom', v.bien)
      .maybeSingle();
    if (!bien) {
      report.errors.push({ line, champ: 'bien', message: `Le bien « ${v.bien} » n'existe pas dans votre espace.` });
      return;
    }
    bienId = bien.id;
  }

  const { data: existing } = await sb
    .from('logements')
    .select('id, nom, loyer_mensuel')
    .eq('user_id', ownerId)
    .eq('bien_id', bienId)
    .ilike('nom', nom)
    .maybeSingle();

  if (existing) {
    report.duplicates.push({ line, champ: 'nom', message: `Un logement « ${nom} » existe déjà pour ce bien.`, existing });
    return;
  }
}

async function prepareLocataire(sb, ownerId, report, ctx) {
  const { line, v, seenUsernames } = ctx;

  if (report.errors.some((e) => e.line === 0)) return;

  const { prenom, nom } = splitFullName(v.nom, v.prenom);
  if (!nom) {
    report.errors.push({ line, champ: 'nom', message: 'Le nom est obligatoire.' });
    return;
  }

  let jour = v.jour === '' || v.jour == null ? 1 : parseNumberFr(v.jour);
  if (jour === null || Number.isNaN(jour) || jour < 1 || jour > 31) {
    report.errors.push({ line, champ: 'jour', message: 'Le jour d\'échéance doit être entre 1 et 31.' });
    return;
  }

  if (v.dateentree && !DATE_RE.test(v.dateentree)) {
    report.errors.push({ line, champ: 'dateentree', message: `Date d'entrée « ${v.dateentree} » invalide (format AAAA-MM-JJ).` });
    return;
  }

  if (hasLineErrors(report, line)) return;

  let logementId = null;
  let logementNom = null;
  if (v.bien || v.logement) {
    if (!v.bien || !v.logement) {
      report.errors.push({ line, champ: 'logement', message: 'Indiquez à la fois le Bien et le Logement (ou laissez les deux vides).' });
      return;
    }
    const { data: logement } = await sb
      .from('logements')
      .select('id, nom, loyer_mensuel, statut')
      .eq('user_id', ownerId)
      .ilike('nom', v.logement)
      .maybeSingle();

    if (!logement) {
      report.errors.push({ line, champ: 'logement', message: `Le logement « ${v.logement} » n'existe pas dans votre espace.` });
      return;
    }
    const { data: bien } = await sb
      .from('biens')
      .select('id, nom')
      .eq('user_id', ownerId)
      .eq('id', logement.bien_id)
      .ilike('nom', v.bien)
      .maybeSingle();

    if (!bien) {
      report.errors.push({ line, champ: 'bien', message: `Le logement « ${v.logement} » n'appartient pas au bien « ${v.bien} ».` });
      return;
    }

    if (v.loyer !== undefined && v.loyer !== '') {
      const loyer = parseNumberFr(v.loyer);
      if (loyer === null || Number.isNaN(loyer) || loyer <= 0) {
        report.errors.push({ line, champ: 'loyer', message: 'Le loyer doit être un nombre positif.' });
        return;
      }
      const loyerLogement = Number(logement.loyer_mensuel || 0);
      if (loyer !== loyerLogement) {
        report.warnings.push({ line, message: `Le loyer saisi (${loyer}) diffère du loyer du logement (${loyerLogement}) : c'est le loyer du logement qui sera utilisé.` });
      }
    }
    logementId = logement.id;
    logementNom = logement.nom;
  }

  if (hasLineErrors(report, line)) return;

  // Doublons : même logement + même nom ; ou même email.
  if (logementId) {
    const { data: sameNom } = await sb
      .from('locataires')
      .select('id, nom')
      .eq('user_id', ownerId)
      .eq('logement_id', logementId)
      .ilike('nom', nom)
      .maybeSingle();
    if (sameNom) {
      report.duplicates.push({ line, champ: 'nom', message: `Un locataire « ${nom} » est déjà enregistré pour ce logement.`, existing: sameNom });
      return;
    }
  }
  if (v.email) {
    const { data: sameEmail } = await sb
      .from('locataires')
      .select('id, nom, email')
      .eq('user_id', ownerId)
      .ilike('email', v.email)
      .maybeSingle();
    if (sameEmail) {
      report.duplicates.push({ line, champ: 'email', message: `Un locataire existe déjà avec l'email « ${v.email} ».`, existing: sameEmail });
      return;
    }
  }

  // Username généré (visible dans l'aperçu, créé à l'exécution).
  const username = await uniqueUsername(sb, prenom, nom);
  let final = username;
  let n = 2;
  while (seenUsernames.has(final)) {
    final = `${username}${n}`.slice(0, 32);
    n++;
  }
  seenUsernames.add(final);
  return final;
}

async function prepareEmploye(sb, ownerId, report, ctx) {
  const { line, v, seenUsernames } = ctx;

  if (report.errors.some((e) => e.line === 0)) return;

  const { prenom, nom } = splitFullName(v.nom, v.prenom);
  if (!nom) {
    report.errors.push({ line, champ: 'nom', message: 'Le nom est obligatoire.' });
    return;
  }

  let salaire = 0;
  if (v.salaire !== undefined && v.salaire !== '') {
    salaire = parseNumberFr(v.salaire);
    if (Number.isNaN(salaire) || salaire < 0) {
      report.errors.push({ line, champ: 'salaire', message: 'Le salaire doit être un nombre positif.' });
      return;
    }
  }

  if (v.dateembauche && !DATE_RE.test(v.dateembauche)) {
    report.errors.push({ line, champ: 'dateembauche', message: `Date d'embauche « ${v.dateembauche} » invalide (format AAAA-MM-JJ).` });
    return;
  }

  if (v.bien) {
    report.warnings.push({ line, message: 'MIM n\'associe pas les employés à un bien : la colonne « Bien » est ignorée.' });
  }

  if (hasLineErrors(report, line)) return;

  if (v.email) {
    const { data: sameEmail } = await sb
      .from('employes')
      .select('id, nom, email')
      .eq('user_id', ownerId)
      .ilike('email', v.email)
      .maybeSingle();
    if (sameEmail) {
      report.duplicates.push({ line, champ: 'email', message: `Un employé existe déjà avec l'email « ${v.email} ».`, existing: sameEmail });
      return;
    }
  }

  const { data: sameNom } = await sb
    .from('employes')
    .select('id, nom, poste')
    .eq('user_id', ownerId)
    .ilike('nom', nom)
    .maybeSingle();

  if (sameNom) {
    report.duplicates.push({ line, champ: 'nom', message: `Un employé « ${nom} » existe déjà dans votre espace.`, existing: sameNom });
    return;
  }

  const username = await uniqueUsername(sb, prenom, nom);
  let final = username;
  let n = 2;
  while (seenUsernames.has(final)) {
    final = `${username}${n}`.slice(0, 32);
    n++;
  }
  seenUsernames.add(final);
  return final;
}

// ------------------------------------------------------------
// Exécution : création (avec compensation par ligne)
// ------------------------------------------------------------

export async function executeImport(sb, ownerId, payload) {
  const prepared = await prepareImport(sb, ownerId, payload);
  if (prepared.error) return prepared;
  if (!prepared.ready) {
    return {
      error: 'L\'import est bloqué : corrigez d\'abord les erreurs de validation signalées.',
      prepared,
    };
  }

  const duplicatePolicy = prepared.duplicatePolicy;

  const report = {
    categories: [],
    totals: { created: 0, updated: 0, ignored: 0, accounts: 0 },
    accounts: [],
  };

  const bienCache = new Map(); // nom (lower) -> {id, nom}
  const logementCache = new Map(); // `${bienNom}|${logementNom}` -> {id, nom, loyer_mensuel}
  const usernameSet = new Set();

  for (const catReport of prepared.categories) {
    const cat = catReport.category;
    const def = CATEGORY_DEFS[cat];
    const parsed = parseCsv(String(payload.files[cat].content || ''));
    const mapping = mapHeaders(parsed);

    const result = {
      category: cat,
      label: def.label,
      filename: catReport.filename,
      total: parsed.rows.length,
      created: 0,
      updated: 0,
      ignored: 0,
      rowErrors: [],
      accounts: [],
    };

    for (const [idx, row] of parsed.rows.entries()) {
      const line = idx + 2;
      const v = row.values;

      try {
        if (cat === 'biens') {
          await importBien(sb, ownerId, { line, v, result, duplicatePolicy, bienCache });
        } else if (cat === 'logements') {
          await importLogement(sb, ownerId, { line, v, result, duplicatePolicy, bienCache });
        } else if (cat === 'locataires') {
          await importLocataire(sb, ownerId, { line, v, result, duplicatePolicy, logementCache, bienCache, usernameSet });
        } else if (cat === 'employes') {
          await importEmploye(sb, ownerId, { line, v, result, duplicatePolicy, usernameSet });
        }
      } catch (err) {
        console.error(`[import/${cat}] ligne ${line} :`, err.message);
        result.rowErrors.push({ line, message: `Erreur technique : ${err.message || 'inconnue'}` });
      }
    }

    report.categories.push(result);
    report.totals.created += result.created;
    report.totals.updated += result.updated;
    report.totals.ignored += result.ignored;
    report.totals.accounts += result.accounts.length;
    report.accounts.push(...result.accounts);
  }

  return { report };
}

async function importBien(sb, ownerId, ctx) {
  const { line, v, result, duplicatePolicy, bienCache } = ctx;

  const nom = String(v.nom || '').trim();
  const type = String(v.type || '').trim();
  if (!nom || !type) {
    result.rowErrors.push({ line, message: 'Nom ou type manquant.' });
    return;
  }

  const key = nom.toLowerCase();
  if (bienCache.has(key)) {
    result.rowErrors.push({ line, message: `Bien « ${nom} » déjà traité dans ce fichier.` });
    return;
  }

  const { data: existing } = await sb
    .from('biens')
    .select('id, nom')
    .eq('user_id', ownerId)
    .ilike('nom', nom)
    .maybeSingle();

  if (existing) {
    if (duplicatePolicy === 'update') {
      const updates = {};
      for (const field of ['type', 'adresse', 'ville', 'pays', 'description']) {
        if (v[field] !== undefined && v[field] !== '') updates[field] = v[field];
      }
      const { error } = await sb.from('biens').update(updates).eq('id', existing.id).eq('user_id', ownerId);
      if (error) result.rowErrors.push({ line, message: `Mise à jour impossible : ${error.message}` });
      else result.updated++;
      return;
    }
    result.ignored++;
    return;
  }

  const { data, error } = await sb
    .from('biens')
    .insert({
      user_id: ownerId,
      nom,
      type,
      adresse: v.adresse || null,
      ville: v.ville || null,
      pays: v.pays || null,
      description: v.description || null,
    })
    .select()
    .single();

  if (error) {
    result.rowErrors.push({ line, message: `Création impossible : ${error.message}` });
    return;
  }
  bienCache.set(key, { id: data.id, nom: data.nom });
  result.created++;
}

async function importLogement(sb, ownerId, ctx) {
  const { line, v, result, duplicatePolicy, bienCache } = ctx;

  const nom = String(v.nom || '').trim();
  if (!nom) {
    result.rowErrors.push({ line, message: 'Le nom du logement est obligatoire.' });
    return;
  }

  let type = String(v.type || '').toLowerCase();
  if (type !== 'appartement' && type !== 'chambre') {
    result.rowErrors.push({ line, message: `Type de logement « ${v.type || ''} » invalide.` });
    return;
  }

  const loyer = parseNumberFr(v.loyer);
  if (loyer === null || Number.isNaN(loyer) || loyer <= 0) {
    result.rowErrors.push({ line, message: 'Loyer invalide.' });
    return;
  }

  let chambres = null;
  if (v.chambres !== undefined && v.chambres !== '') {
    chambres = parseNumberFr(v.chambres);
    if (Number.isNaN(chambres) || chambres < 1) {
      result.rowErrors.push({ line, message: 'Nombre de chambres invalide.' });
      return;
    }
  }
  if (type === 'appartement' && chambres === null) {
    result.rowErrors.push({ line, message: 'Nombre de chambres obligatoire pour un appartement.' });
    return;
  }

  const statut = v.statut || 'libre';
  if (!['libre', 'occupe', 'maintenance'].includes(statut)) {
    result.rowErrors.push({ line, message: `Statut « ${statut} » invalide.` });
    return;
  }

  // Résolution du bien (nom) — périmètre propriétaire uniquement.
  let bienId = null;
  if (v.bien) {
    const cached = bienCache.get(v.bien.toLowerCase());
    if (cached) {
      bienId = cached.id;
    } else {
      const { data: bien } = await sb
        .from('biens')
        .select('id')
        .eq('user_id', ownerId)
        .ilike('nom', v.bien)
        .maybeSingle();
      if (!bien) {
        result.rowErrors.push({ line, message: `Le bien « ${v.bien} » n'existe pas dans votre espace.` });
        return;
      }
      bienId = bien.id;
      bienCache.set(v.bien.toLowerCase(), bien);
    }
  }

  const { data: existing } = await sb
    .from('logements')
    .select('id')
    .eq('user_id', ownerId)
    .eq('bien_id', bienId)
    .ilike('nom', nom)
    .maybeSingle();

  if (existing) {
    if (duplicatePolicy === 'update') {
      const updates = {};
      if (v.loyer !== undefined && v.loyer !== '') updates.loyer_mensuel = loyer;
      if (v.chambres !== undefined && v.chambres !== '') updates.nombre_chambres = chambres;
      if (v.adresse !== undefined && v.adresse !== '') updates.adresse = v.adresse;
      if (v.description !== undefined && v.description !== '') updates.description = v.description;
      if (v.statut !== undefined && v.statut !== '') updates.statut = statut;
      updates.type = type;
      const { error } = await sb.from('logements').update(updates).eq('id', existing.id).eq('user_id', ownerId);
      if (error) result.rowErrors.push({ line, message: `Mise à jour impossible : ${error.message}` });
      else result.updated++;
      return;
    }
    result.ignored++;
    return;
  }

  const { data, error } = await sb
    .from('logements')
    .insert({
      user_id: ownerId,
      bien_id: bienId,
      nom,
      type,
      nombre_chambres: chambres,
      loyer_mensuel: loyer,
      statut,
      adresse: v.adresse || null,
      description: v.description || null,
    })
    .select()
    .single();

  if (error) {
    result.rowErrors.push({ line, message: `Création impossible : ${error.message}` });
    return;
  }
  logementCache.set(`${String(bienId)}|${nom.toLowerCase()}`, { id: data.id, nom: data.nom, loyer_mensuel: Number(data.loyer_mensuel || 0) });
  result.created++;
}

async function resolveLogement(sb, ownerId, { v, bienCache, logementCache }) {
  if (!v.bien || !v.logement) return { logementId: null, loyerLogement: null };

  let bienId = null;
  const cachedBien = bienCache.get(v.bien.toLowerCase());
  if (cachedBien) {
    bienId = cachedBien.id;
  } else {
    const { data: bien } = await sb
      .from('biens')
      .select('id')
      .eq('user_id', ownerId)
      .ilike('nom', v.bien)
      .maybeSingle();
    if (!bien) return { error: `Le bien « ${v.bien} » n'existe pas dans votre espace.` };
    bienId = bien.id;
    bienCache.set(v.bien.toLowerCase(), bien);
  }

  const cacheKey = `${String(bienId)}|${v.logement.toLowerCase()}`;
  const cached = logementCache.get(cacheKey);
  if (cached) {
    return { logementId: cached.id, loyerLogement: cached.loyer_mensuel, logementStatut: cached.statut };
  }

  const { data: logement } = await sb
    .from('logements')
    .select('id, nom, loyer_mensuel, statut, bien_id')
    .eq('user_id', ownerId)
    .eq('bien_id', bienId)
    .ilike('nom', v.logement)
    .maybeSingle();

  if (!logement) {
    return { error: `Le logement « ${v.logement} » n'existe pas dans votre espace.` };
  }
  const entry = { id: logement.id, nom: logement.nom, loyer_mensuel: Number(logement.loyer_mensuel || 0), statut: logement.statut };
  logementCache.set(cacheKey, entry);
  return { logementId: entry.id, loyerLogement: entry.loyer_mensuel, logementStatut: entry.statut };
}

async function importLocataire(sb, ownerId, ctx) {
  const { line, v, result, duplicatePolicy, logementCache, bienCache, usernameSet } = ctx;

  const { prenom, nom } = splitFullName(v.nom, v.prenom);
  if (!nom) {
    result.rowErrors.push({ line, message: 'Le nom est obligatoire.' });
    return;
  }

  const jour = v.jour === '' || v.jour == null ? 1 : parseNumberFr(v.jour);
  if (jour === null || Number.isNaN(jour) || jour < 1 || jour > 31) {
    result.rowErrors.push({ line, message: 'Jour d\'échéance invalide.' });
    return;
  }

  const email = v.email || null;
  const statut = v.statut || 'actif';
  if (statut !== 'actif' && statut !== 'inactif') {
    result.rowErrors.push({ line, message: `Statut « ${statut} » invalide.` });
    return;
  }

  const resolved = await resolveLogement(sb, ownerId, { v, bienCache, logementCache });
  if (resolved.error) {
    result.rowErrors.push({ line, message: resolved.error });
    return;
  }
  const { logementId, loyerLogement } = resolved;

  // Doublon (relu en base, jamais uniquement depuis l'aperçu).
  if (logementId) {
    const { data: sameNom } = await sb
      .from('locataires')
      .select('id')
      .eq('user_id', ownerId)
      .eq('logement_id', logementId)
      .ilike('nom', nom)
      .maybeSingle();
    if (sameNom) {
      if (duplicatePolicy === 'update') {
        const updates = {};
        if (v.telephone !== undefined && v.telephone !== '') updates.phone = v.telephone;
        if (v.dateentree !== undefined && v.dateentree !== '') updates.date_entree = v.dateentree;
        if (jour !== 1 || v.jour !== undefined) updates.jour_echeance = jour;
        if (statut !== 'actif' || v.statut !== undefined) updates.statut = statut;
        const { error } = await sb.from('locataires').update(updates).eq('id', sameNom.id).eq('user_id', ownerId);
        if (error) result.rowErrors.push({ line, message: `Mise à jour impossible : ${error.message}` });
        else result.updated++;
        return;
      }
      result.ignored++;
      return;
    }
  }
  if (email) {
    const { data: sameEmail } = await sb
      .from('locataires')
      .select('id')
      .eq('user_id', ownerId)
      .ilike('email', email)
      .maybeSingle();
    if (sameEmail) {
      result.ignored++;
      return;
    }
  }

  // Un logement ne peut avoir qu'un seul locataire actif.
  if (logementId && statut === 'actif') {
    const { data: otherActive } = await sb
      .from('locataires')
      .select('id')
      .eq('user_id', ownerId)
      .eq('logement_id', logementId)
      .eq('statut', 'actif')
      .maybeSingle();
    if (otherActive) {
      result.rowErrors.push({ line, message: 'Ce logement est déjà occupé par un autre locataire actif.' });
      return;
    }
  }

  const username = await uniqueUsername(sb, prenom, nom);
  let final = username;
  let n = 2;
  while (usernameSet.has(final)) {
    final = `${username}${n}`.slice(0, 32);
    n++;
  }
  usernameSet.add(final);

  const { data: createdUser, error: createError } = await sb.auth.admin.createUser({
    email: tenantEmailFor(final),
    password: INITIAL_PASSWORD,
    email_confirm: true,
    user_metadata: {
      account_type: 'locataire',
      role: 'locataire',
      name: nom,
      username: final,
      phone: v.telephone || '',
      must_change_password: true,
    },
  });

  if (createError || !createdUser?.user?.id) {
    result.rowErrors.push({ line, message: `Compte impossible à créer : ${String(createError?.message || '').slice(0, 120)}` });
    return;
  }
  const accountUid = createdUser.user.id;

  const { error: insertError } = await sb.from('locataires').insert({
    user_id: ownerId,
    account_uid: accountUid,
    username: final,
    nom,
    email,
    phone: v.telephone || null,
    logement_id: logementId,
    date_entree: v.dateentree || null,
    jour_echeance: jour,
    statut,
  });

  if (insertError) {
    await sb.auth.admin.deleteUser(accountUid).catch(() => {});
    result.rowErrors.push({ line, message: `Création impossible : ${insertError.message}` });
    return;
  }

  if (logementId) {
    await sb.from('logements').update({ statut: 'occupe' }).eq('id', logementId).eq('user_id', ownerId);
  }

  await notify(accountUid, 'info', 'Votre compte locataire a été créé par votre propriétaire. À votre première connexion, vous devrez choisir un nouveau mot de passe.');

  result.created++;
  result.accounts.push({ line, username: final, account_type: 'locataire', nom });
}

async function importEmploye(sb, ownerId, ctx) {
  const { line, v, result, duplicatePolicy, usernameSet } = ctx;

  const { prenom, nom } = splitFullName(v.nom, v.prenom);
  if (!nom) {
    result.rowErrors.push({ line, message: 'Le nom est obligatoire.' });
    return;
  }

  let salaire = 0;
  if (v.salaire !== undefined && v.salaire !== '') {
    salaire = parseNumberFr(v.salaire);
    if (Number.isNaN(salaire) || salaire < 0) {
      result.rowErrors.push({ line, message: 'Salaire invalide.' });
      return;
    }
  }

  const email = v.email || null;
  const statut = v.statut || 'actif';
  if (statut !== 'actif' && statut !== 'inactif') {
    result.rowErrors.push({ line, message: `Statut « ${statut} » invalide.` });
    return;
  }

  if (v.bien) {
    // MIM n'associe pas les employés à un bien : colonne ignorée (avertissement en aperçu).
  }

  const { data: sameNom } = await sb
    .from('employes')
    .select('id')
    .eq('user_id', ownerId)
    .ilike('nom', nom)
    .maybeSingle();
  if (sameNom) {
    if (duplicatePolicy === 'update') {
      const updates = {};
      if (v.poste !== undefined && v.poste !== '') updates.poste = v.poste;
      if (v.telephone !== undefined && v.telephone !== '') updates.phone = v.telephone;
      if (v.email !== undefined && v.email !== '') updates.email = email;
      if (v.salaire !== undefined && v.salaire !== '') updates.salaire = salaire;
      if (v.dateembauche !== undefined && v.dateembauche !== '') updates.date_embauche = v.dateembauche;
      if (statut !== 'actif' || v.statut !== undefined) updates.statut = statut;
      const { error } = await sb.from('employes').update(updates).eq('id', sameNom.id).eq('user_id', ownerId);
      if (error) result.rowErrors.push({ line, message: `Mise à jour impossible : ${error.message}` });
      else result.updated++;
      return;
    }
    result.ignored++;
    return;
  }
  if (email) {
    const { data: sameEmail } = await sb
      .from('employes')
      .select('id')
      .eq('user_id', ownerId)
      .ilike('email', email)
      .maybeSingle();
    if (sameEmail) {
      result.ignored++;
      return;
    }
  }

  const username = await uniqueUsername(sb, prenom, nom);
  let final = username;
  let n = 2;
  while (usernameSet.has(final)) {
    final = `${username}${n}`.slice(0, 32);
    n++;
  }
  usernameSet.add(final);

  const { data: createdUser, error: createError } = await sb.auth.admin.createUser({
    email: tenantEmailFor(final),
    password: INITIAL_PASSWORD,
    email_confirm: true,
    user_metadata: {
      account_type: 'employe',
      role: 'employe',
      name: nom,
      username: final,
      phone: v.telephone || '',
      must_change_password: true,
    },
  });

  if (createError || !createdUser?.user?.id) {
    result.rowErrors.push({ line, message: `Compte impossible à créer : ${String(createError?.message || '').slice(0, 120)}` });
    return;
  }
  const accountUid = createdUser.user.id;

  const { error: insertError } = await sb.from('employes').insert({
    user_id: ownerId,
    account_uid: accountUid,
    username: final,
    nom,
    poste: v.poste || null,
    salaire,
    email,
    phone: v.telephone || null,
    date_embauche: v.dateembauche || null,
    statut,
  });

  if (insertError) {
    await sb.auth.admin.deleteUser(accountUid).catch(() => {});
    result.rowErrors.push({ line, message: `Création impossible : ${insertError.message}` });
    return;
  }

  await notify(accountUid, 'info', 'Votre compte employé a été créé par votre employeur. À votre première connexion, vous devrez choisir un nouveau mot de passe.');

  result.created++;
  result.accounts.push({ line, username: final, account_type: 'employe', nom });
}