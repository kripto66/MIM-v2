// ============================================================
// MIM - Import groupé « tout-en-un » (un seul fichier CSV)
//
// Au lieu de préparer un fichier par catégorie (biens, logements,
// locataires, employés) — ce qui oblige à recopier le nom du bien
// sur chaque ligne de logement, le bien + le logement + le loyer sur
// chaque ligne de locataire, etc. — le propriétaire remplit UN seul
// fichier où chaque ligne décrit un logement (et son locataire
// éventuel) ou un employé.
//
// Règle d'héritage (comme des cellules fusionnées dans Excel) :
//   une cellule VIDE des colonnes structurelles (bien et ses détails,
//   logement) reprend la valeur de la ligne au-dessus. Les détails du
//   bien ne sont donc saisis qu'une seule fois, à sa première ligne.
//
// Exemple :
//   Résidence X;immeuble;…;Apt 1;appartement;2;150000;…;Diop;Amadou;…
//   ;;;;;;;;;Apt 2;chambre;1;50000;…
//   Villa Y;villa;…;;;;;;;;;;;;;;Fall;Moussa;Gardien;90000;…
//
// Le découpage produit des fichiers par catégorie compatibles avec le
// moteur existant (importCsv.js) : toute la validation, la détection
// de doublons, la création de comptes et les politiques de doublons
// sont réutilisées sans modification.
// ============================================================

import { parseCsv } from './importCsv.js';

// Colonnes du fichier groupé (ordre = modèle téléchargeable).
export const GROUPED_HEADERS = [
  'bien', 'type_bien', 'adresse_bien', 'ville', 'pays', 'description_bien',
  'logement', 'type_logement', 'nombre_chambres', 'loyer', 'statut_logement', 'description_logement',
  'locataire_nom', 'locataire_prenom', 'locataire_email', 'locataire_telephone',
  'jour_echeance', 'date_entree',
  'employe_nom', 'employe_prenom', 'employe_poste', 'employe_salaire',
  'employe_telephone', 'employe_email',
];

// Alias acceptés par colonne (insensibles accents/casse/séparateurs).
const ALIASES = {
  bien: ['bien', 'nombien', 'nomdubien'],
  typebien: ['typebien', 'typedebien', 'typedubien'],
  adressebien: ['adressebien', 'adresse', 'adressepostale'],
  ville: ['ville', 'localite'],
  pays: ['pays'],
  descriptionbien: ['descriptionbien', 'description', 'descriptif'],
  logement: ['logement', 'nomlogement', 'nomdulogement'],
  typelogement: ['typelogement', 'typedelogement'],
  chambres: ['nombrechambres', 'nbchambres', 'chambres', 'nombredeschambres'],
  loyer: ['loyer', 'loyermensuel', 'montantloyer'],
  statutlogement: ['statutlogement', 'statut'],
  descriptionlogement: ['descriptionlogement', 'noteslogement'],
  locatairenom: ['locatairenomb', 'locatairenom', 'nomlocataire', 'nom'],
  locataireprenom: ['locataireprenom', 'prenomlocataire', 'prenom'],
  locataireemail: ['locataireemail', 'emaillocataire', 'email'],
  locatairetelephone: ['locatairetelephone', 'telephonelocataire', 'telephone', 'tel'],
  jourecheance: ['jourecheance', 'jour', 'echeance', 'jourdecheance'],
  dateentree: ['dateentree', 'datedentree'],
  employenom: ['employenom', 'nomemploye', 'employenomb'],
  employeprenom: ['employeprenom', 'prenomemploye'],
  employeposte: ['employeposte', 'poste', 'fonction'],
  employesalaire: ['employesalaire', 'salaire', 'salairemensuel'],
  employetelephone: ['employetelephone', 'telephonneemploye', 'telephoneemploye'],
  employeemail: ['employeemail', 'emailemploye'],
};

function normalizeKey(h) {
  return String(h || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const ALIAS_INDEX = (() => {
  const idx = new Map();
  for (const [key, aliases] of Object.entries(ALIASES)) {
    for (const a of aliases) if (!idx.has(a)) idx.set(a, key);
  }
  return idx;
})();

// Colonne source (index dans la ligne brute) pour chaque clé groupée.
function buildColumnIndex(rawHeaders) {
  const index = new Map();
  rawHeaders.forEach((h, i) => {
    const key = ALIAS_INDEX.get(normalizeKey(h));
    if (key && !index.has(key)) index.set(key, i);
  });
  return index;
}

// Colonnes concernées par l'héritage « cellule vide = ligne au-dessus ».
const INHERITED_KEYS = [
  'bien', 'typebien', 'adressebien', 'ville', 'pays', 'descriptionbien', 'logement',
];

const LOCATAIRE_KEYS = ['locatairenom', 'locataireprenom', 'locataireemail', 'locatairetelephone'];
const EMPLOYE_KEYS = ['employenom', 'employeprenom', 'employeposte', 'employesalaire', 'employetelephone', 'employeemail'];

// Échappement CSV (point-virgule, guillemets, retours ligne).
function escCell(v) {
  const s = String(v ?? '');
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(headers, rows) {
  const lines = [headers.join(';'), ...rows.map((r) => r.map(escCell).join(';'))];
  return `\uFEFF${lines.join('\n')}\n`;
}

// En-têtes des fichiers générés : EXACTEMENT ceux des modèles par
// catégorie (mêmes alias reconnus par importCsv.js). La dernière
// colonne « ligne » conserve le numéro de ligne d'origine dans le
// fichier groupé (colonne ignorée par le moteur d'import).
const OUT_HEADERS = {
  biens: ['nom', 'type', 'adresse', 'ville', 'pays', 'description', 'ligne'],
  logements: ['bien', 'nom', 'type', 'loyer', 'nombre_chambres', 'adresse', 'statut', 'description', 'ligne'],
  locataires: ['nom', 'prenom', 'email', 'telephone', 'bien', 'logement', 'loyer', 'jour_echeance', 'date_entree', 'statut', 'ligne'],
  employes: ['nom', 'prenom', 'email', 'telephone', 'poste', 'bien', 'salaire', 'date_embauche', 'statut', 'ligne'],
};

// ------------------------------------------------------------
// Découpage du fichier groupé en fichiers par catégorie.
// Retour :
//   { categories, files, errors, warnings, counts }
//   - categories/files : payload compatible prepareImport/executeImport
//   - errors           : problèmes de STRUCTURE (ligne du fichier groupé)
//   - warnings         : informations non bloquantes
// ------------------------------------------------------------
export function splitGroupedCsv(text, { filename = '' } = {}) {
  const parsed = parseCsv(text);
  const errors = [];
  const warnings = [];

  const colIndex = buildColumnIndex(parsed.rawHeaders || []);
  if (!colIndex.size) {
    return {
      error:
        'Aucune colonne reconnue dans le fichier groupé. Téléchargez le modèle « Tout-en-un » et conservez sa première ligne.',
    };
  }

  // Colonnes attendues absentes : la plupart sont facultatives, mais
  // sans « bien » ni « logement » ni personnes, aucune ligne ne peut
  // produire quoi que ce soit — signalons les colonnes clés manquantes.
  const missingEssential = [];
  for (const key of ['bien', 'logement', ...LOCATAIRE_KEYS, ...EMPLOYE_KEYS]) {
    if (!colIndex.has(key)) missingEssential.push(key);
  }
  if (missingEssential.length === [...'bien', 'logement', ...LOCATAIRE_KEYS, ...EMPLOYE_KEYS].length) {
    errors.push({ line: 1, message: 'Colonnes indispensables absentes (bien, logement, locataire_nom ou employe_nom).' });
  }

  const cell = (v, key) => {
    if (!v || !v.raw) return '';
    const i = colIndex.get(key);
    return i === undefined ? '' : String(v.raw[i] ?? '').trim();
  };

  const inherited = {};
  for (const k of INHERITED_KEYS) inherited[k] = '';

  const emittedBiens = new Set(); // nom (lower)
  const emittedLogements = new Set(); // `${bien}|${nom}` (lower)

  const rowsOut = { biens: [], logements: [], locataires: [], employes: [] };
  const counts = { biens: 0, logements: 0, locataires: 0, employes: 0 };
  let lastLine = 0;

  for (const [idx, row] of parsed.rows.entries()) {
    const line = idx + 2; // ligne 1 = en-tête
    lastLine = line;

    // Héritage : une cellule vide reprend la valeur du dessus.
    for (const k of INHERITED_KEYS) {
      const v = cell(row, k);
      if (v !== '') inherited[k] = v;
    }

    const bien = inherited.bien;
    const typeBien = inherited.typebien;
    const logement = inherited.logement;

    const hasLocataire = LOCATAIRE_KEYS.some((k) => cell(row, k) !== '') ||
      cell(row, 'jourecheance') !== '' || cell(row, 'dateentree') !== '';
    const hasEmploye = EMPLOYE_KEYS.some((k) => cell(row, k) !== '');

    if (hasLocataire && hasEmploye) {
      errors.push({
        line,
        message: 'Une ligne ne peut pas contenir à la fois un locataire (locataire_…) et un employé (employe_…). Séparez-les en deux lignes.',
      });
      continue;
    }

    // --- Bien : émis une seule fois, à sa première apparition. ---
    if (bien) {
      const key = bien.toLowerCase();
      if (!emittedBiens.has(key)) {
        emittedBiens.add(key);
        if (!typeBien) {
          errors.push({
            line,
            message: `Première ligne du bien « ${bien} » : indiquez son type (type_bien : immeuble, villa, maison, terrain…).`,
          });
        } else {
          rowsOut.biens.push([
            bien,
            typeBien,
            inherited.adressebien,
            inherited.ville,
            inherited.pays,
            inherited.descriptionbien,
            line,
          ]);
          counts.biens++;
        }
      }
    }

    const bienKey = bien ? bien.toLowerCase() : '';
    const logementKey = logement ? `${bienKey}|${logement.toLowerCase()}` : null;

    // --- Logement (+ éventuellement son locataire). ---
    if (logement || hasLocataire) {
      if (logement && !emittedLogements.has(logementKey)) {
        emittedLogements.add(logementKey);
        rowsOut.logements.push([
          bien,
          logement,
          cell(row, 'typelogement'),
          cell(row, 'loyer'),
          cell(row, 'chambres'),
          '', // adresse du logement : hérite implicitement du bien côté interface
          cell(row, 'statutlogement'),
          cell(row, 'descriptionlogement'),
          line,
        ]);
        counts.logements++;
      }
      if (hasLocataire) {
        rowsOut.locataires.push([
          cell(row, 'locatairenom'),
          cell(row, 'locataireprenom'),
          cell(row, 'locataireemail'),
          cell(row, 'locatairetelephone'),
          bien,
          logement,
          '', // loyer : celui du logement fait foi (aucune répétition)
          cell(row, 'jourecheance'),
          cell(row, 'dateentree'),
          'actif',
          line,
        ]);
        counts.locataires++;
      }
      continue;
    }

    // --- Employé seul (rattaché au bien hérité s'il y en a un). ---
    if (hasEmploye) {
      rowsOut.employes.push([
        cell(row, 'employenom'),
        cell(row, 'employeprenom'),
        cell(row, 'employeemail'),
        cell(row, 'employetelephone'),
        cell(row, 'employeposte'),
        bien,
        cell(row, 'employesalaire'),
        '',
        'actif',
        line,
      ]);
      counts.employes++;
      continue;
    }

    // Ligne sans bien nouveau, sans logement, sans personne : pure
    // ligne de continuation (tout hérité, rien à créer) → ignorée.
  }

  const categories = Object.entries(rowsOut)
    .filter(([, rows]) => rows.length > 0)
    .map(([cat]) => cat);

  if (!categories.length && !errors.length) {
    errors.push({
      line: Math.max(lastLine, 1),
      message: 'Aucune donnée exploitable trouvée dans le fichier groupé.',
    });
  }

  const baseName = String(filename || 'tout-en-un').replace(/\.csv$/i, '');
  const files = {};
  for (const cat of categories) {
    files[cat] = {
      filename: `${baseName}.csv`,
      content: buildCsv(OUT_HEADERS[cat], rowsOut[cat]),
    };
  }

  return { categories, files, errors, warnings, counts };
}
