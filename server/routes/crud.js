import { Router } from 'express';
import { authedClient } from '../server.js';
import { gitAutoBackup } from '../utils/gitBackup.js';

const SCHEMAS = {
  biens: {
    fields: ['nom', 'type', 'adresse', 'ville', 'pays', 'description'],
    emptyToNull: ['adresse', 'ville', 'pays', 'description'],
  },
  logements: {
    fields: ['bien_id', 'nom', 'loyer_mensuel', 'statut', 'description'],
    emptyToNull: ['bien_id', 'description'],
  },
  locataires: {
    fields: ['logement_id', 'nom', 'email', 'phone', 'date_entree', 'statut'],
    emptyToNull: ['logement_id', 'email', 'phone', 'date_entree'],
  },
  paiements: {
    fields: ['locataire_id', 'logement_id', 'montant', 'mois', 'statut', 'date_paiement'],
    emptyToNull: ['logement_id', 'date_paiement'],
  },
  incidents: {
    fields: ['logement_id', 'titre', 'description', 'statut'],
    emptyToNull: ['logement_id', 'description'],
  },
  prestataires: {
    fields: ['nom', 'specialite', 'phone', 'email'],
    emptyToNull: ['specialite', 'phone', 'email'],
  },
  interventions: {
    fields: ['incident_id', 'prestataire_id', 'logement_id', 'titre', 'description', 'statut', 'date_prevue'],
    emptyToNull: ['incident_id', 'prestataire_id', 'logement_id', 'description', 'date_prevue'],
  },
  notifications: {
    fields: ['type', 'message', 'lu'],
    emptyToNull: [],
  },
};

function sanitize(tableName, body) {
  const schema = SCHEMAS[tableName];
  if (!schema || !body || typeof body !== 'object') return {};

  const out = {};
  for (const field of schema.fields) {
    if (body[field] === undefined) continue;

    let value = body[field];

    if (typeof value === 'string') {
      value = value.trim();
      if (value === '' && schema.emptyToNull.includes(field)) value = null;
    }

    if (value === '') continue;

    out[field] = value;
  }

  return out;
}

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
    const body = { ...sanitize(tableName, req.body), user_id: userId(req) };

    if (Object.keys(body).length <= 1) {
      return res.status(400).json({ success: false, message: 'Aucun champ valide fourni.' });
    }

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
    const body = sanitize(tableName, req.body);

    if (Object.keys(body).length === 0) {
      return res.status(400).json({ success: false, message: 'Aucun champ valide fourni.' });
    }

    const { data, error } = await sb(req)
      .from(tableName)
      .update(body)
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
