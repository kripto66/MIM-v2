// ============================================================
// MIM - Moyens de paiement du propriétaire (configuration)
//
// Le propriétaire enregistre les moyens par lesquels il accepte
// d'être payé (Wave, Orange Money, Virement bancaire, Espèces).
// Le locataire les consulte en lecture seule (RLS) et paie
// DIRECTEMENT le propriétaire, hors Okarne GM.
//
// Sécurité : toutes les écritures sont filtrées par le propriétaire
// cible (utilisateur connecté, ou propriétaire géré via req.scopeOwnerId
// quand ce routeur est monté sous le scope agence).
// ============================================================

import { Router } from 'express';
import { serviceClient } from '../app.js';
import { TYPES_MOYENS_PAIEMENT, sanitizeMoyenBody, paymentLinkError } from '../utils/paiementMethodes.js';

const router = Router();
const sb = () => serviceClient();

// Propriétaire cible : l'utilisateur connecté en espace propriétaire, le
// PROPRIÉTAIRE GÉRÉ quand le routeur est monté sous le scope agence
// (withScopeOwner). Un moyen de paiement appartient au propriétaire.
function ownerIdOf(req) {
  return req.scopeOwnerId || req.user.id;
}

// Liste des moyens de paiement du propriétaire.
router.get('/', async (req, res) => {
  try {
    const { data, error } = await sb()
      .from('moyens_paiement')
      .select('*')
      .eq('user_id', ownerIdOf(req))
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

    const linkError = paymentLinkError(req.body?.lien_paiement);
    if (linkError) return res.status(400).json({ success: false, message: linkError, errors: { lien_paiement: linkError } });
    const clean = sanitizeMoyenBody(type, req.body);
    const { data, error } = await sb()
      .from('moyens_paiement')
      .insert({ user_id: ownerIdOf(req), type, ...clean })
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
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', ownerIdOf(req))
      .maybeSingle();

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Moyen de paiement introuvable.' });
    }

    const linkError = paymentLinkError(req.body?.lien_paiement);
    if (linkError) return res.status(400).json({ success: false, message: linkError, errors: { lien_paiement: linkError } });
    const clean = sanitizeMoyenBody(existing.type, req.body);
    const { data, error } = await sb()
      .from('moyens_paiement')
      .update(clean)
      .eq('id', existing.id)
      .eq('user_id', ownerIdOf(req))
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
      .eq('user_id', ownerIdOf(req))
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