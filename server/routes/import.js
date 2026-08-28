// ============================================================
// MIM - Routes d'import de données (onboarding propriétaire)
//
//   GET  /api/import/templates/:category   → modèle CSV téléchargeable
//   POST /api/import/preview               → validation sans écriture
//   POST /api/import/execute               → création (ordre dépendances)
//   GET  /api/onboarding/status            → premier accès ? (espace vide)
//
// Sécurité : user_id provient de la session (req.user.id), jamais du
// client. Toutes les lectures/écritures sont filtrées par propriétaire.
// ============================================================

import { Router } from 'express';
import crypto from 'node:crypto';
import { serviceClient } from '../app.js';
import { gitAutoBackup } from '../utils/gitBackup.js';
import { prepareImport, executeImport, decodeCsvBuffer, CATEGORIES, INITIAL_PASSWORD } from '../utils/importCsv.js';
import { splitGroupedCsv, GROUPED_HEADERS, GROUPED_TEMPLATE_ROWS } from '../utils/importGrouped.js';

const router = Router();

// État de progression des imports en cours (mémoire du process).
// POST /execute reste synchrone (compatibilité) mais écrit ici sa
// progression par lots ; GET /import/progress/:runId permet au
// frontend de suivre la barre en temps réel pendant l'exécution.
const importRuns = new Map();
let runSeq = 0;

// Nettoyage périodique : supprime les runs terminés de plus de 30 min.
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, run] of importRuns) {
    if ((run.status === 'done' || run.status === 'error') && run.finishedAt && run.finishedAt < cutoff) {
      importRuns.delete(id);
    }
  }
}, 10 * 60 * 1000).unref();

function newRunId(ownerId) {
  runSeq++;
  return `${Date.now()}-${ownerId.slice(0, 8)}-${runSeq}-${crypto.randomBytes(4).toString('hex')}`;
}

// Décodage du contenu d'un fichier : le frontend peut envoyer le texte brut
// (content) ou le fichier en base64 (content_b64) — ce dernier cas permet de
// décoder correctement les fichiers latin1/ANSI produits par Excel FR.
function fileContent(file) {
  if (!file) return '';
  if (file.content_b64) {
    return decodeCsvBuffer(Buffer.from(file.content_b64, 'base64'));
  }
  return String(file.content || '');
}

// Mode « groupé » : le corps contient { mode: 'grouped', files.grouped }.
// Le fichier unique est découpé en fichiers par catégorie (avec
// résolution de l'héritage) puis injecté dans le moteur standard.
function expandGroupedPayload(body, fileContentFn) {
  const file = body?.files?.grouped;
  if (!file) {
    return { error: 'Fichier groupé manquant.' };
  }
  const content = fileContentFn(file);
  if (!String(content || '').trim()) {
    return { error: 'Le fichier groupé est vide.' };
  }
  const split = splitGroupedCsv(content, { filename: file.filename });
  if (split.error) return { error: split.error };
  if (split.errors.length) {
    const detail = split.errors
      .slice(0, 4)
      .map((e) => `ligne ${e.line} : ${e.message}`)
      .join(' — ');
    const more = split.errors.length > 4 ? ` (+${split.errors.length - 4} autre(s))` : '';
    return { error: `Fichier groupé invalide — ${detail}${more}` };
  }
  if (!split.categories.length) {
    return { error: 'Le fichier groupé ne contient aucune donnée à importer.' };
  }
  return { categories: split.categories, files: split.files };
}

const TEMPLATES = {
  biens: {
    headers: ['nom', 'type', 'adresse', 'ville', 'pays', 'description'],
    examples: [
      ['Bien Exemple 1', 'immeuble', 'Adresse exemple 1', 'Dakar', 'Sénégal', 'Description du bien'],
      ['Bien Exemple 2', 'villa', 'Adresse exemple 2', 'Dakar', 'Sénégal', ''],
    ],
    hint: 'Type : immeuble, villa, maison, terrain…',
  },
  logements: {
    headers: ['bien', 'nom', 'type', 'loyer', 'nombre_chambres', 'adresse', 'statut', 'description'],
    examples: [
      ['Bien Exemple 1', 'Logement Exemple 1', 'appartement', '150000', '2', 'Adresse exemple 1', 'libre', 'Étage 1, balcon'],
      ['Bien Exemple 1', 'Logement Exemple 2', 'chambre', '50000', '', '', 'libre', ''],
    ],
    hint: '« Bien » doit correspondre à un bien déjà créé (ou importé dans le même fichier). Type : appartement ou chambre.',
  },
  locataires: {
    headers: ['nom', 'prenom', 'email', 'telephone', 'bien', 'logement', 'loyer', 'jour_echeance', 'date_entree', 'statut'],
    examples: [
      ['Nom Exemple 1', 'Prenom Exemple 1', 'locataire1@exemple.com', '+221700000001', 'Bien Exemple 1', 'Logement Exemple 1', '150000', '5', '2026-09-01', 'actif'],
      ['Nom Exemple 2', 'Prenom Exemple 2', '', '+221700000002', 'Bien Exemple 1', 'Logement Exemple 2', '50000', '10', '2026-09-01', 'actif'],
    ],
    hint: 'Le username du compte locataire est généré automatiquement (ex. amadou.diop). Mot de passe initial : 1234 (à changer à la première connexion).',
  },
  employes: {
    headers: ['nom', 'prenom', 'email', 'telephone', 'poste', 'bien', 'salaire', 'date_embauche', 'statut'],
    examples: [
      ['Nom Exemple 1', 'Prenom Exemple 1', 'employe1@exemple.com', '+221700000003', 'Gérant', '', '80000', '2026-09-01', 'actif'],
      ['Nom Exemple 2', 'Prenom Exemple 2', '', '+221700000004', 'Agent d\'entretien', '', '35000', '2026-09-01', 'actif'],
    ],
    hint: 'Salaire : montant mensuel. Le compte employé est créé automatiquement (username généré, mot de passe initial 1234).',
  },
  grouped: {
    headers: GROUPED_HEADERS,
    examples: GROUPED_TEMPLATE_ROWS,
    hint: 'Fichier unique « tout-en-un » : chaque ligne = un logement (et son locataire) ou un employé. Cellule vide = même valeur que la ligne au-dessus (les détails du bien ne se saisissent qu\'une fois).',
  },
};

function csvTemplate(cat) {
  const t = TEMPLATES[cat];
  const lines = [t.headers.join(';'), ...t.examples.map((row) => row.join(';'))];
  return `\uFEFF${lines.join('\n')}\n`;
}

// ------------------------------------------------------------
// Modèles CSV téléchargeables
// ------------------------------------------------------------
router.get('/templates/:category', (req, res) => {
  const cat = String(req.params.category || '').toLowerCase();
  if (!TEMPLATES[cat]) {
    return res.status(404).json({ success: false, message: 'Catégorie de modèle inconnue.' });
  }
  const t = TEMPLATES[cat];
  const csv = csvTemplate(cat);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="modele_${cat}.csv"`);
  res.send(csv);
});

// ------------------------------------------------------------
// Statut d'onboarding : l'espace du propriétaire est-il vide ?
// ------------------------------------------------------------
router.get('/status', async (req, res) => {
  const sb = serviceClient();
  const ownerId = req.user.id;

  const count = async (table) => {
    const { data } = await sb.from(table).select('id').eq('user_id', ownerId);
    return data?.length || 0;
  };

  try {
    const [biens, logements, locataires, employes] = await Promise.all([
      count('biens'),
      count('logements'),
      count('locataires'),
      count('employes'),
    ]);

    res.json({
      success: true,
      needsOnboarding: biens === 0 && logements === 0 && locataires === 0 && employes === 0,
      counts: { biens, logements, locataires, employes },
    });
  } catch (err) {
    console.error('[onboarding/status]', err.message);
    res.status(500).json({ success: false, message: 'Impossible de vérifier l\'état de votre espace.' });
  }
});

// ------------------------------------------------------------
// Aperçu : lecture + validation (aucune écriture)
// ------------------------------------------------------------
router.post('/preview', async (req, res) => {
  const sb = serviceClient();
  const ownerId = req.user.id;

  const { categories = [], files = {}, duplicatePolicy = 'ignore', mode } = req.body || {};

  // Taille totale raisonnable (le corps est déjà limité à 2 Mo).
  let totalBytes = 0;
  for (const cat of Object.keys(files || {})) {
    totalBytes += String(files[cat]?.content_b64 || files[cat]?.content || '').length;
  }
  if (totalBytes > 1_500_000) {
    return res.status(413).json({ success: false, message: 'Fichiers trop volumineux (maximum 1,5 Mo au total).' });
  }

  try {
    let payload = { categories, files };
    if (mode === 'grouped') {
      payload = expandGroupedPayload(req.body, fileContent);
      if (payload.error) {
        return res.status(400).json({ success: false, message: payload.error });
      }
    }
    const result = await prepareImport(sb, ownerId, { ...payload, duplicatePolicy, fileContent });
    if (result.error) {
      return res.status(400).json({ success: false, message: result.error });
    }
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[import/preview]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de l\'analyse des fichiers.' });
  }
});

// ------------------------------------------------------------
// Exécution de l'import (création effective)
// ------------------------------------------------------------
router.post('/execute', async (req, res) => {
  const sb = serviceClient();
  const ownerId = req.user.id;

  const { categories = [], files = {}, duplicatePolicy = 'ignore', mode } = req.body || {};

  if (!['ignore', 'update', 'abort'].includes(duplicatePolicy)) {
    return res.status(400).json({ success: false, message: 'Politique de doublons invalide.' });
  }

  try {
    let payload = { categories, files };
    if (mode === 'grouped') {
      payload = expandGroupedPayload(req.body, fileContent);
      if (payload.error) {
        return res.status(400).json({ success: false, message: payload.error });
      }
    }

    const runId = newRunId(ownerId);
    const run = { runId, ownerId, done: 0, total: 0, status: 'running', message: 'Démarrage…' };
    importRuns.set(runId, run);

    // Nettoyage des anciennes entrées (max 50 par propriétaire).
    const own = [...importRuns.values()].filter((r) => r.ownerId === ownerId);
    if (own.length > 50) {
      for (const stale of own.slice(0, own.length - 50)) importRuns.delete(stale.runId);
    }

    try {
      const result = await executeImport(sb, ownerId, { ...payload, duplicatePolicy, fileContent }, {
        onProgress: (done, total) => {
          run.done = done;
          run.total = total;
          run.message = `Traitement… ${done}/${total}`;
        },
      });

      run.status = 'done';
      run.message = 'Terminé';
      run.finishedAt = Date.now();

      if (result.error) {
      run.status = 'error';
      run.message = String(result.error || 'Import bloqué');
      run.finishedAt = Date.now();
        return res.status(409).json({ success: false, message: result.error, prepared: result.prepared, runId });
      }

      const r = result.report;
      const labels = r.categories.map((c) => `${c.created} ${c.label.toLowerCase()}`).join(', ');

      gitAutoBackup(`Sauvegarde auto : import de données (${labels || 'aucun élément'})`);

      res.status(201).json({
        success: true,
        message: `Importation terminée : ${labels || 'aucun élément créé'}.`,
        initialPassword: INITIAL_PASSWORD,
        runId,
        report: r,
      });
    } catch (err) {
      run.status = 'error';
      run.message = err?.message || 'Erreur technique';
      run.finishedAt = Date.now();
      console.error('[import/execute]', err.message);
      res.status(500).json({ success: false, message: 'Erreur lors de l\'importation des données.', runId });
    }
  } catch (err) {
    console.error('[import/execute]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de l\'importation des données.' });
  }
});

// ------------------------------------------------------------
// Progression du dernier import du propriétaire (utilisé par le
// frontend pendant que POST /execute est en vol : le run est créé
// dès l'arrivée de la requête, avant tout traitement).
// NOTE : déclarée AVANT /progress/:runId pour que « latest » ne
// soit pas capturé comme un identifiant de run.
// ------------------------------------------------------------
router.get('/progress/latest', async (req, res) => {
  const own = [...importRuns.values()]
    .filter((r) => r.ownerId === req.user.id)
    .sort((a, b) => String(b.runId).localeCompare(String(a.runId)));

  if (!own.length) {
    return res.status(404).json({ success: false, message: 'Aucun import en cours.' });
  }

  const run = own[0];
  const percent = run.total > 0 ? Math.min(100, Math.round((run.done / run.total) * 100)) : 0;

  res.json({
    success: true,
    runId: run.runId,
    done: run.done,
    total: run.total,
    percent,
    status: run.status,
    message: run.message,
  });
});

// ------------------------------------------------------------
// Progression d'un import (polling pendant l'exécution)
// ------------------------------------------------------------
router.get('/progress/:runId', async (req, res) => {
  const run = importRuns.get(String(req.params.runId || ''));
  if (!run || run.ownerId !== req.user.id) {
    return res.status(404).json({ success: false, message: 'Import introuvable.' });
  }

  const percent = run.total > 0 ? Math.min(100, Math.round((run.done / run.total) * 100)) : 0;

  res.json({
    success: true,
    runId: run.runId,
    done: run.done,
    total: run.total,
    percent,
    status: run.status,
    message: run.message,
  });
});

// Aide à la vérification (réutilisé par les tests) : catégories valides.
router.get('/meta', (req, res) => {
  res.json({ success: true, categories: CATEGORIES, initialPassword: INITIAL_PASSWORD });
});

export default router;