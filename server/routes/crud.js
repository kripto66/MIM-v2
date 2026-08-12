import { Router } from 'express';
import { authedClient, serviceClient } from '../app.js';
import { gitAutoBackup } from '../utils/gitBackup.js';
import { tenantEmailFor, usernameIsValid } from '../utils/tenantAccount.js';
import { passwordRuleError } from '../utils/passwordPolicy.js';
import { notify, tenantUidOfLogement, tenantUidOfLocataire, logementNomOf } from '../utils/notifications.js';

const SCHEMAS = {
  biens: {
    fields: ['nom', 'type', 'adresse', 'ville', 'pays', 'description'],
    emptyToNull: ['adresse', 'ville', 'pays', 'description'],
  },
  logements: {
    fields: ['bien_id', 'nom', 'type', 'nombre_chambres', 'adresse', 'loyer_mensuel', 'statut', 'description'],
    emptyToNull: ['bien_id', 'nombre_chambres', 'adresse', 'description'],
  },
  locataires: {
    fields: ['logement_id', 'nom', 'username', 'email', 'phone', 'date_entree', 'jour_echeance', 'statut'],
    emptyToNull: ['logement_id', 'email', 'phone', 'date_entree', 'jour_echeance'],
  },
  paiements: {
    fields: ['locataire_id', 'logement_id', 'montant', 'mois', 'statut', 'date_paiement'],
    emptyToNull: ['logement_id', 'date_paiement'],
  },
  incidents: {
    fields: ['logement_id', 'titre', 'description', 'photo', 'statut'],
    emptyToNull: ['logement_id', 'description', 'photo'],
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

// Validation par ressource : messages en français, remontés champ par champ.
// En mode `partial` (PUT), les champs absents ne sont pas exigés.
function validateResource(tableName, body, partial = false) {
  const errors = {};
  const present = (f) => body[f] !== undefined && body[f] !== null && body[f] !== '';
  const check = (field, rule, message) => {
    if (partial && !present(field)) return;
    if (rule()) errors[field] = message;
  };

  switch (tableName) {
    case 'biens':
      check('nom', () => !present('nom'), 'Le nom est obligatoire.');
      check('type', () => !present('type'), 'Le type est obligatoire.');
      break;

    case 'logements':
      check('nom', () => !present('nom'), 'Le nom du logement est obligatoire.');
      check('type', () => present('type') && !['appartement', 'chambre'].includes(body.type), 'Type de logement invalide.');
      check('nombre_chambres', () => body.type === 'appartement' && !present('nombre_chambres'), 'Indiquez le nombre de chambres.');
      check('nombre_chambres', () => present('nombre_chambres') && Number(body.nombre_chambres) < 1, 'Le nombre de chambres doit être au moins 1.');
      check('adresse', () => !present('adresse'), 'L\'adresse est obligatoire.');
      check('loyer_mensuel', () => !present('loyer_mensuel') || Number(body.loyer_mensuel) <= 0, 'Le loyer mensuel doit être supérieur à 0.');
      break;

    case 'locataires':
      check('nom', () => !present('nom'), 'Le nom est obligatoire.');
      check('email', () => present('email') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email), 'Adresse email invalide.');
      check('jour_echeance', () => present('jour_echeance') && (Number(body.jour_echeance) < 1 || Number(body.jour_echeance) > 31), 'Le jour d\'échéance doit être entre 1 et 31.');
      break;

    case 'paiements':
      check('montant', () => !present('montant') || Number(body.montant) <= 0, 'Le montant doit être supérieur à 0.');
      check('mois', () => !present('mois'), 'Le mois est obligatoire.');
      break;

    case 'incidents':
      check('titre', () => !present('titre'), 'Le titre est obligatoire.');
      check('photo', () => present('photo') && !/^data:image\/[a-zA-Z]+;base64,/.test(body.photo), 'Format de photo invalide.');
      check('photo', () => present('photo') && body.photo.length > 2500000, 'La photo est trop lourde (maximum 2,5 Mo).');
      break;

    case 'prestataires':
      check('nom', () => !present('nom'), 'Le nom est obligatoire.');
      break;

    case 'interventions':
      check('titre', () => !present('titre'), 'Le titre est obligatoire.');
      break;

    default:
      break;
  }

  return errors;
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
  // Notifications à la création
  // ============================================================
  async function notifyOnCreate(tableName, data, ownerId) {
    try {
      if (tableName === 'paiements') {
        const montant = Number(data.montant || 0).toLocaleString('fr-FR');
        await notify(ownerId, 'paiement', `Nouveau paiement de ${montant} FCFA pour ${data.mois}.`);
        const tenantUid = await tenantUidOfLocataire(data.locataire_id);
        if (tenantUid) await notify(tenantUid, 'paiement', `Un paiement a été enregistré pour votre loyer de ${data.mois}.`);
      } else if (tableName === 'incidents') {
        const nom = await logementNomOf(data.logement_id);
        const tenantUid = await tenantUidOfLogement(data.logement_id);
        if (tenantUid) {
          await notify(tenantUid, 'incident', `Un incident a été signalé sur votre logement${nom ? ` (${nom})` : ''} : ${data.titre}.`);
        }
      } else if (tableName === 'interventions') {
        const nom = await logementNomOf(data.logement_id);
        await notify(ownerId, 'intervention', `Intervention programmée : ${data.titre}${nom ? ` (${nom})` : ''}.`);
        const tenantUid = await tenantUidOfLogement(data.logement_id);
        if (tenantUid) await notify(tenantUid, 'intervention', `Une intervention est programmée pour votre logement : ${data.titre}.`);
      }
    } catch (err) {
      console.warn('[notifyOnCreate]', err.message);
    }
  }

  // ============================================================
  // Notifications à la modification
  // ============================================================
  async function notifyOnUpdate(tableName, prev, next, ownerId) {
    try {
      if (tableName === 'paiements') {
        const tenantUid = await tenantUidOfLocataire(next.locataire_id ?? prev.locataire_id);
        const mois = next.mois || prev.mois;
        if (tenantUid && prev.statut !== next.statut && next.statut === 'paye') {
          await notify(tenantUid, 'paiement', `Votre loyer de ${mois} a été confirmé.`);
        } else if (tenantUid && prev.statut !== next.statut && next.statut === 'retard') {
          await notify(tenantUid, 'paiement', `Votre loyer de ${mois} est en retard.`);
        }
      } else if (tableName === 'incidents') {
        const tenantUid = await tenantUidOfLogement(next.logement_id ?? prev.logement_id);
        if (tenantUid) {
          await notify(tenantUid, 'incident', `Votre incident « ${next.titre || prev.titre} » a été mis à jour.`);
        }
      } else if (tableName === 'interventions') {
        const tenantUid = await tenantUidOfLogement(next.logement_id ?? prev.logement_id);
        if (tenantUid && prev.statut !== next.statut && next.statut === 'termine') {
          await notify(tenantUid, 'intervention', `L'intervention « ${next.titre || prev.titre} » est terminée.`);
        }
      }
    } catch (err) {
      console.warn('[notifyOnUpdate]', err.message);
    }
  }

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
    const rawJour = req.body.jour_echeance;
    const jourEcheance = rawJour === '' || rawJour == null ? 1 : Number(rawJour);
    const statut = req.body.statut || 'actif';

    if (!nom) {
      return res.status(400).json({ success: false, message: 'Le nom est obligatoire.', errors: { nom: 'Le nom est obligatoire.' } });
    }

    if (!usernameIsValid(username)) {
      return res.status(400).json({
        success: false,
        message: 'Le username doit contenir entre 3 et 32 caractères (lettres minuscules, chiffres, . _ -).',
        errors: { username: 'Le username doit contenir au moins 3 caractères (lettres minuscules, chiffres, . _ -).' },
      });
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Adresse email invalide.', errors: { email: 'Adresse email invalide.' } });
    }

    const pwError = passwordRuleError(password);
    if (pwError) {
      return res.status(400).json({ success: false, message: pwError, errors: { password: pwError } });
    }

    const jour = Number(jourEcheance);
    if (Number.isNaN(jour) || jour < 1 || jour > 31) {
      return res.status(400).json({ success: false, message: 'Le jour d\'échéance doit être entre 1 et 31.', errors: { jour_echeance: 'Le jour d\'échéance doit être entre 1 et 31.' } });
    }

    // Un propriétaire ne peut créer un locataire que pour ses propres logements.
    if (logementId) {
      const { data: logement, error: logementError } = await admin
        .from('logements')
        .select('id, user_id')
        .eq('id', logementId)
        .maybeSingle();

      if (logementError || !logement || logement.user_id !== ownerId) {
        return res.status(400).json({ success: false, message: 'Logement introuvable ou ne vous appartient pas.', errors: { logement_id: 'Logement introuvable ou ne vous appartient pas.' } });
      }
    }

    // Username unique dans toute l'application (messages clairs, pas d'erreur technique).
    const { data: existingUsername } = await admin
      .from('profiles')
      .select('id')
      .ilike('username', username)
      .maybeSingle();

    if (existingUsername) {
      return res.status(409).json({ success: false, message: 'Ce nom d\'utilisateur est déjà utilisé.', errors: { username: 'Ce nom d\'utilisateur est déjà utilisé.' } });
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
        return res.status(409).json({ success: false, message: 'Ce nom d\'utilisateur est déjà utilisé.', errors: { username: 'Ce nom d\'utilisateur est déjà utilisé.' } });
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
      jour_echeance: jour,
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

    await notify(accountUid, 'info', 'Votre compte locataire a été créé par votre propriétaire. À votre première connexion, vous devrez choisir un nouveau mot de passe.');
    await gitAutoBackup(`Sauvegarde auto : ajout dans locataires (avec compte ${username})`);

    res.status(201).json({ success: true, data, accountCreated: true });
  }

  router.post('/', async (req, res) => {
    if (tableName === 'locataires' && req.body?.username && req.body?.password) {
      return createTenantWithAccount(req, res);
    }

    const body = { ...sanitize(tableName, req.body), user_id: userId(req) };

    const errors = validateResource(tableName, body, false);
    if (Object.keys(errors).length) {
      return res.status(400).json({ success: false, message: 'Veuillez corriger les champs en rouge.', errors });
    }

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

    await notifyOnCreate(tableName, data, userId(req));
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

    const errors = validateResource(tableName, body, true);
    if (Object.keys(errors).length) {
      return res.status(400).json({ success: false, message: 'Veuillez corriger les champs en rouge.', errors });
    }

    if (Object.keys(body).length === 0) {
      return res.status(400).json({ success: false, message: 'Aucun champ valide fourni.' });
    }

    const { data: prev } = await sb(req)
      .from(tableName)
      .select('*')
      .eq('id', id)
      .eq('user_id', userId(req))
      .maybeSingle();

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

    if (prev) await notifyOnUpdate(tableName, prev, data, userId(req));
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
