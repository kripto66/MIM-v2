import { Router } from 'express';
import { authedClient } from '../app.js';

const router = Router();

// Les notifications sont créées uniquement par le serveur (utils/notifications.js).
// Cette route n'expose que la lecture et le marquage « lu » de ses propres notifications.

router.get('/', async (req, res) => {
  const { data, error } = await authedClient(req.user.supabase_token)
    .from('notifications')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[notifications]', error.message);
    return res.status(500).json({ success: false, message: 'Erreur lors du chargement.' });
  }

  res.json({ success: true, data });
});

router.put('/:id', async (req, res) => {
  const { lu } = req.body;

  if (typeof lu !== 'boolean') {
    return res.status(400).json({ success: false, message: 'Valeur invalide pour le champ « lu ».' });
  }

  const { data, error } = await authedClient(req.user.supabase_token)
    .from('notifications')
    .update({ lu })
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .select()
    .single();

  if (error) {
    console.error('[notifications]', error.message);
    return res.status(400).json({ success: false, message: 'Erreur lors de la mise à jour.' });
  }

  res.json({ success: true, data });
});

// --- Suppression ---

router.delete('/:id', async (req, res) => {
  const { error } = await authedClient(req.user.supabase_token)
    .from('notifications')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);

  if (error) {
    console.error('[notifications] delete', error.message);
    return res.status(400).json({ success: false, message: 'Erreur lors de la suppression.' });
  }

  res.json({ success: true, message: 'Notification supprimée.' });
});

router.delete('/', async (req, res) => {
  const { error } = await authedClient(req.user.supabase_token)
    .from('notifications')
    .delete()
    .eq('user_id', req.user.id);

  if (error) {
    console.error('[notifications] deleteAll', error.message);
    return res.status(400).json({ success: false, message: 'Erreur lors de la suppression.' });
  }

  res.json({ success: true, message: 'Toutes les notifications ont été supprimées.' });
});

export default router;
