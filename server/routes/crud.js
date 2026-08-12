import { Router } from 'express';
import { authedClient, serviceClient } from '../app.js';
import { gitAutoBackup } from '../utils/gitBackup.js';
import { tenantEmailFor, usernameIsValid } from '../utils/tenantAccount.js';

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
    fields: ['logement_id', 'nom', 'username', 'email', 'phone', 'date_entree', 'statut'],
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

  // ============================================================
  // Création d'un locataire AVEC un compte d'authentification.
  // Règle métier : seul le propriétaire crée les comptes locataires
  // (username + mot de passe temporaire, email optionnel).
  // ============================================================
  async function createTenantWithAccount(req, res) {
    const admin = serviceClient();
    const ownerId = userId(req);

    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const nom = String(req.body.nom || '').trim();
    const logementId = req.body.logement_id || null;
    const email = req.body.email ? String(req.body.email).trim() : null;
    const phone = req.body.phone ? String(req.body.phone).trim() : null;
    const dateEntree = req.body.date_entree || null;
    const statut = req.body.statut || 'actif';

    if (!nom) {
      return res.status(400).json({ success: false, message: 'Le nom est obligatoire.' });
    }

    if (!usernameIsValid(username)) {
      return res.status(400).json({
        success: false,
        message: 'Username invalide (3 à 32 caractères : lettres minuscules, chiffres, . _ -).',
      });
    }

    if (password.length < 8) {
      return res.status(400).json({ success: false, message: 'Le mot de passe doit contenir au moins 8 caractères.' });
    }

    // Un propriétaire ne peut créer un locataire que pour ses propres logements.
    if (logementId) {
      const { data: logement, error: logementError } = await admin
        .from('logements')
        .select('id, user_id')
        .eq('id', logementId)
        .maybeSingle();

      if (logementError || !logement || logement.user_id !== ownerId) {
        return res.status(400).json({ success: false, message: 'Logement introuvable ou ne vous appartient pas.' });
      }
    }

    const { data: createdUser, error: createError } = await admin.auth.admin.createUser({
      email: tenantEmailFor(username),
      password,
      email_confirm: true,
      user_metadata: {
        account_type: 'locataire',
        role: 'locataire',
        name: nom,
        username,
        phone: phone || '',
        must_change_password: true,
      },
    });

    if (createError || !createdUser?.user?.id) {
      const msg = String(createError?.message || '').toLowerCase();
      if (msg.includes('already') || msg.includes('existe')) {
        return res.status(409).json({ success: false, message: 'Ce username est déjà utilisé.' });
      }
      console.error('[createTenant]', createError?.message);
      return res.status(400).json({ success: false, message: 'Impossible de créer le compte locataire.' });
    }

    const accountUid = createdUser.user.id;

    const body = {
      user_id: ownerId,
      account_uid: accountUid,
      username,
      nom,
      email,
      phone,
      logement_id: logementId,
      date_entree: dateEntree,
      statut,
    };

    const { data, error } = await admin.from(tableName).insert(body).select().single();

    if (error) {
      await admin.auth.admin.deleteUser(accountUid).catch(() => {});
      console.error('[createTenant]', error.message);
      return res.status(400).json({ success: false, message: 'Erreur lors de la création du locataire.' });
    }

    if (logementId) {
      await admin
        .from('logements')
        .update({ statut: 'occupe' })
        .eq('id', logementId)
        .eq('user_id', ownerId);
    }

    await gitAutoBackup(`Sauvegarde auto : ajout dans locataires (avec compte ${username})`);

    res.status(201).json({ success: true, data, accountCreated: true });
  }

  router.post('/', async (req, res) => {
    if (tableName === 'locataires' && req.body?.username && req.body?.password) {
      return createTenantWithAccount(req, res);
    }

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

    // Le username d'un locataire se change depuis son profil (compte locataire),
    // pas depuis l'espace propriétaire, pour éviter toute désynchronisation.
    if (tableName === 'locataires') {
      delete body.username;
      delete body.password;
    }

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
