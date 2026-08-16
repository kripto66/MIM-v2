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
import { serviceClient } from '../app.js';
import { gitAutoBackup } from '../utils/gitBackup.js';
import { prepareImport, executeImport, decodeCsvBuffer, CATEGORIES, INITIAL_PASSWORD } from '../utils/importCsv.js';

const router = Router();

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

const TEMPLATES = {
  biens: {
    headers: ['nom', 'type', 'adresse', 'ville', 'pays', 'description'],
    examples: [
      ['Résidence Les Palmiers', 'immeuble', '12 Avenue des Cocotiers', 'Dakar', 'Sénégal', 'Bâtiment principal, 3 étages'],
      ['Villa Cité du Lac', 'villa', 'Lot 45', 'Dakar', 'Sénégal', ''],
    ],
    hint: 'Type : immeuble, villa, maison, terrain…',
  },
  logements: {
    headers: ['bien', 'nom', 'type', 'loyer', 'nombre_chambres', 'adresse', 'statut', 'description'],
    examples: [
      ['Résidence Les Palmiers', 'Appartement 101', 'appartement', '150000', '2', '12 Avenue des Cocotiers', 'libre', 'Étage 1, balcon'],
      ['Résidence Les Palmiers', 'Chambre 201', 'chambre', '50000', '', '', 'libre', ''],
    ],
    hint: '« Bien » doit correspondre à un bien déjà créé (ou importé dans le même fichier). Type : appartement ou chambre.',
  },
  locataires: {
    headers: ['nom', 'prenom', 'email', 'telephone', 'bien', 'logement', 'loyer', 'jour_echeance', 'date_entree', 'statut'],
    examples: [
      ['Diop', 'Amadou', 'amadou.diop@exemple.com', '+221771234567', 'Résidence Les Palmiers', 'Appartement 101', '150000', '5', '2026-09-01', 'actif'],
      ['Ndiaye', 'Aminata', '', '+221781234567', 'Résidence Les Palmiers', 'Chambre 201', '50000', '10', '2026-09-01', 'actif'],
    ],
    hint: 'Le username du compte locataire est généré automatiquement (ex. amadou.diop). Mot de passe initial : 1234 (à changer à la première connexion).',
  },
  employes: {
    headers: ['nom', 'prenom', 'email', 'telephone', 'poste', 'bien', 'salaire', 'date_embauche', 'statut'],
    examples: [
      ['Sarr', 'Moussa', 'moussa.sarr@exemple.com', '+221761234567', 'Gérant', '', '80000', '2026-09-01', 'actif'],
      ['Ba', 'Fatou', '', '+221751234567', 'Femme de ménage', '', '35000', '2026-09-01', 'actif'],
    ],
    hint: 'Salaire : montant mensuel. Le compte employé est créé automatiquement (username généré, mot de passe initial 1234).',
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

  const { categories = [], files = {}, duplicatePolicy = 'ignore' } = req.body || {};

  // Taille totale raisonnable (le corps est déjà limité à 2 Mo).
  let totalBytes = 0;
  for (const cat of Object.keys(files || {})) {
    totalBytes += String(files[cat]?.content_b64 || files[cat]?.content || '').length;
  }
  if (totalBytes > 1_500_000) {
    return res.status(413).json({ success: false, message: 'Fichiers trop volumineux (maximum 1,5 Mo au total).' });
  }

  try {
    const result = await prepareImport(sb, ownerId, { categories, files, duplicatePolicy, fileContent });
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

  const { categories = [], files = {}, duplicatePolicy = 'ignore' } = req.body || {};

  if (!['ignore', 'update', 'abort'].includes(duplicatePolicy)) {
    return res.status(400).json({ success: false, message: 'Politique de doublons invalide.' });
  }

  try {
    const result = await executeImport(sb, ownerId, { categories, files, duplicatePolicy, fileContent });

    if (result.error) {
      return res.status(409).json({ success: false, message: result.error, prepared: result.prepared });
    }

    const r = result.report;
    const labels = r.categories.map((c) => `${c.created} ${c.label.toLowerCase()}`).join(', ');

    gitAutoBackup(`Sauvegarde auto : import de données (${labels || 'aucun élément'})`);

    res.status(201).json({
      success: true,
      message: `Importation terminée : ${labels || 'aucun élément créé'}.`,
      initialPassword: INITIAL_PASSWORD,
      report: r,
    });
  } catch (err) {
    console.error('[import/execute]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de l\'importation des données.' });
  }
});

// Aide à la vérification (réutilisé par les tests) : catégories valides.
router.get('/meta', (req, res) => {
  res.json({ success: true, categories: CATEGORIES, initialPassword: INITIAL_PASSWORD });
});

export default router;