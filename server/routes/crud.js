import { Router } from 'express';
import { authedClient } from '../server.js';
import { gitAutoBackup } from '../utils/gitBackup.js';

export function createCrudRouter(tableName) {
  const router = Router();

  const userId = (req) => req.user.id;
  const sb = (req) => authedClient(req.user.supabase_token);

  router.get('/', async (req, res) => {
    const { data, error } = await sb(req)
      .from(tableName)
      .select('*')
      .eq('user_id', userId(req))
      .order('created_at', { ascending: false });

    if (error) {
      console.error(`[${tableName}]`, error.message);
      return res.status(500).json({ success: false, message: 'Erreur lors du chargement.' });
    }

    res.json({ success: true, data });
  });

  router.post('/', async (req, res) => {
    const body = { ...req.body, user_id: userId(req) };

    const { data, error } = await sb(req)
      .from(tableName)
      .insert(body)
      .select()
      .single();

    if (error) {
      console.error(`[${tableName}]`, error.message);
      return res.status(400).json({ success: false, message: 'Erreur lors de la création.' });
    }

    await gitAutoBackup(`Sauvegarde auto : ajout dans ${tableName}`);

    res.status(201).json({ success: true, data });
  });

  router.put('/:id', async (req, res) => {
    const id = req.params.id;

    const { data, error } = await sb(req)
      .from(tableName)
      .update(req.body)
      .eq('id', id)
      .eq('user_id', userId(req))
      .select()
      .single();

    if (error) {
      console.error(`[${tableName}]`, error.message);
      return res.status(400).json({ success: false, message: 'Erreur lors de la modification.' });
    }

    await gitAutoBackup(`Sauvegarde auto : modification dans ${tableName}`);

    res.json({ success: true, data });
  });

  router.delete('/:id', async (req, res) => {
    const id = req.params.id;

    const { error } = await sb(req)
      .from(tableName)
      .delete()
      .eq('id', id)
      .eq('user_id', userId(req));

    if (error) {
      console.error(`[${tableName}]`, error.message);
      return res.status(400).json({ success: false, message: 'Erreur lors de la suppression.' });
    }

    await gitAutoBackup(`Sauvegarde auto : suppression dans ${tableName}`);

    res.json({ success: true, message: 'Supprimé avec succès.' });
  });

  return router;
}
