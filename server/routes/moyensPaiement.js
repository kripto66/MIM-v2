// ============================================================
// MIM - Moyens de paiement du propriétaire (configuration)
//
// Le propriétaire enregistre les moyens par lesquels il accepte
// d'être payé (Wave, Orange Money, Virement bancaire, Espèces).
// Le locataire les consulte en lecture seule (RLS) et paie
// DIRECTEMENT le propriétaire, hors MIM.
//
// Sécurité : toutes les écritures sont filtrées par req.user.id.
// ============================================================

import { Router } from 'express';
import { serviceClient } from '../app.js';
import { TYPES_MOYENS_PAIEMENT } from '../utils/paiementMethodes.js';

const router = Router();
const sb = () => serviceClient();

const CHAMPS = {
  wave: ['nom_titulaire', 'numero', 'lien_paiement', 'instructions'],
  orange_money: ['nom_titulaire', 'numero', 'lien_paiement', 'instructions'],
  virement: ['banque', 'nom_titulaire', 'num_compte', 'iban', 'bic', 'instructions'],
  especes: ['instructions'],
};

function sanitizeBody(type, body) {
  const clean = {};
  for (const field of CHAMPS[type] || []) {
    const v = body?.[field];
    if (v != null && String(v).trim() !== '') clean[field] = String(v).trim().slice(0, 200);
  }
  if (body?.actif === false || body?.actif === true) clean.actif = Boolean(body.actif);
  clean.updated_at = new Date().toISOString();
  return clean;
}

// Liste des moyens de paiement du propriétaire.
router.get('/', async (req, res) => {
  try {
    const { data, error } = await sb()
      .from('moyens_paiement')
      .select('*')
      .eq('user_id', req.user.id)
      .order('type', { ascending: true })
      .order('id', { ascending: true });

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('[moyens-paiement]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement.' });
  }
});

// Création d'un moyen de paiement.
router.post('/', async (req, res) => {
  try {
    const type = String((req.body || {}).type || '');
    if (!TYPES_MOYENS_PAIEMENT.includes(type)) {
      return res.status(400).json({ success: false, message: 'Type de moyen de paiement invalide.' });
    }

    const clean = sanitizeBody(type, req.body);
    const { data, error } = await sb()
      .from('moyens_paiement')
      .insert({ user_id: req.user.id, type, ...clean })
      .select()
      .single();

    if (error) {
      console.error('[moyens-paiement] insert :', error.message);
      return res.status(400).json({ success: false, message: 'Erreur lors de l\'enregistrement.' });
    }
    res.status(201).json({ success: true, data, message: 'Moyen de paiement enregistré.' });
  } catch (err) {
    console.error('[moyens-paiement]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de l\'enregistrement.' });
  }
});

// Mise à jour d'un moyen de paiement (filtré par le propriétaire).
router.put('/:id', async (req, res) => {
  try {
    const { data: existing } = await sb()
      .from('moyens_paiement')
      .select('id, type')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Moyen de paiement introuvable.' });
    }

    const clean = sanitizeBody(existing.type, req.body);
    const { data, error } = await sb()
      .from('moyens_paiement')
      .update(clean)
      .eq('id', existing.id)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) {
      console.error('[moyens-paiement] update :', error.message);
      return res.status(400).json({ success: false, message: 'Erreur lors de la mise à jour.' });
    }
    res.json({ success: true, data, message: 'Moyen de paiement mis à jour.' });
  } catch (err) {
    console.error('[moyens-paiement]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de la mise à jour.' });
  }
});

// Suppression (filtrée par le propriétaire).
router.delete('/:id', async (req, res) => {
  try {
    const { data, error } = await sb()
      .from('moyens_paiement')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ success: false, message: 'Moyen de paiement introuvable.' });
    }
    res.json({ success: true, data, message: 'Moyen de paiement supprimé.' });
  } catch (err) {
    console.error('[moyens-paiement]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de la suppression.' });
  }
});

export default router;