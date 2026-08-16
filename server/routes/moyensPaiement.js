// ============================================================
// MIM - Moyens de paiement du propriÃ©taire (configuration)
//
// Le propriÃ©taire enregistre les moyens par lesquels il accepte
// d'Ãªtre payÃ© (Wave, Orange Money, Virement bancaire, EspÃ¨ces).
// Le locataire les consulte en lecture seule (RLS) et paie
// DIRECTEMENT le propriÃ©taire, hors MIM.
//
// SÃ©curitÃ© : toutes les Ã©critures sont filtrÃ©es par req.user.id.
// ============================================================

import { Router } from 'express';
import { serviceClient } from '../app.js';
import { TYPES_MOYENS_PAIEMENT, sanitizeMoyenBody } from '../utils/paiementMethodes.js';

const router = Router();
const sb = () => serviceClient();

// Liste des moyens de paiement du propriÃ©taire.
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

// CrÃ©ation d'un moyen de paiement.
router.post('/', async (req, res) => {
  try {
    const type = String((req.body || {}).type || '');
    if (!TYPES_MOYENS_PAIEMENT.includes(type)) {
      return res.status(400).json({ success: false, message: 'Type de moyen de paiement invalide.' });
    }

    const clean = sanitizeMoyenBody(type, req.body);
    const { data, error } = await sb()
      .from('moyens_paiement')
      .insert({ user_id: req.user.id, type, ...clean })
      .select()
      .single();

    if (error) {
      console.error('[moyens-paiement] insert :', error.message);
      return res.status(400).json({ success: false, message: 'Erreur lors de l\'enregistrement.' });
    }
    res.status(201).json({ success: true, data, message: 'Moyen de paiement enregistrÃ©.' });
  } catch (err) {
    console.error('[moyens-paiement]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de l\'enregistrement.' });
  }
});

// Mise Ã  jour d'un moyen de paiement (filtrÃ© par le propriÃ©taire).
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

    const clean = sanitizeMoyenBody(existing.type, req.body);
    const { data, error } = await sb()
      .from('moyens_paiement')
      .update(clean)
      .eq('id', existing.id)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (error) {
      console.error('[moyens-paiement] update :', error.message);
      return res.status(400).json({ success: false, message: 'Erreur lors de la mise Ã  jour.' });
    }
    res.json({ success: true, data, message: 'Moyen de paiement mis Ã  jour.' });
  } catch (err) {
    console.error('[moyens-paiement]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de la mise Ã  jour.' });
  }
});

// Suppression (filtrÃ©e par le propriÃ©taire).
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
    res.json({ success: true, data, message: 'Moyen de paiement supprimÃ©.' });
  } catch (err) {
    console.error('[moyens-paiement]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors de la suppression.' });
  }
});

export default router;