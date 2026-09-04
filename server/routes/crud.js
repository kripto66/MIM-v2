import { Router } from 'express';
import { authedClient, serviceClient } from '../app.js';
import { gitAutoBackup } from '../utils/gitBackup.js';
import { tenantEmailFor, usernameIsValid, uniqueUsername, splitFullName, INITIAL_PASSWORD } from '../utils/tenantAccount.js';
import { passwordRuleError } from '../utils/passwordPolicy.js';
import { notify, tenantUidOfLogement, tenantUidOfLocataire, logementNomOf } from '../utils/notifications.js';
import { methodePaiementError } from '../utils/paiementMethodes.js';
import { creerEcheanceInitiale, syncMontantEcheancesOuvertes } from '../utils/echeances.js';

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
    fields: ['locataire_id', 'logement_id', 'montant', 'mois', 'statut', 'date_paiement', 'methode_paiement', 'reference'],
    emptyToNull: ['logement_id', 'date_paiement', 'methode_paiement', 'reference'],
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
      check('nombre_chambres', () => present('nombre_chambres') && Number(body.nombre_chambres) < 1, 'Le nombre de chambres doit être au moins 1.');
      check('adresse', () => !present('adresse'), 'L\'adresse est obligatoire.');
      check('loyer_mensuel', () => !present('loyer_mensuel') || Number(body.loyer_mensuel) <= 0, 'Le loyer mensuel doit être supérieur à 0.');
      check('statut', () => present('statut') && !['libre', 'occupe', 'maintenance'].includes(body.statut), 'Statut invalide.');
      break;

    case 'locataires':
      check('nom', () => !present('nom'), 'Le nom est obligatoire.');
      check('email', () => present('email') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email), 'Adresse email invalide.');
      check('jour_echeance', () => present('jour_echeance') && (Number(body.jour_echeance) < 1 || Number(body.jour_echeance) > 31), 'Le jour d\'échéance doit être entre 1 et 31.');
      check('statut', () => present('statut') && !['actif', 'inactif'].includes(body.statut), 'Statut invalide.');
      break;

    case 'paiements':
      check('montant', () => !present('montant') || Number(body.montant) <= 0, 'Le montant doit être supérieur à 0.');
      check('mois', () => !present('mois'), 'Le mois est obligatoire.');
      check('methode_paiement', () => methodePaiementError(body.methode_paiement), methodePaiementError(body.methode_paiement));
      check('reference', () => present('reference') && String(body.reference).length > 80, 'La référence ne doit pas dépasser 80 caractères.');
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
  // Helpers logements (page fusionnée locataires / logements).
  // Le logement est créé/modifié par le propriétaire avec le rôle
  // service : la RLS `owner_all_logements` n'autorise l'insertion
  // que pour des logements dont user_id est l'utilisateur connecté,
  // or l'utilisateur connecté (locataire/propriétaire côté RLS) peut
  // ne pas correspondre ici selon le contexte d'exécution.
  // ============================================================

  // Un logement ne peut être rattaché qu'à un bien du propriétaire
  // connecté : la RLS ne protège pas cette référence croisée, on la
  // vérifie donc explicitement côté serveur.
  async function bienBelongsTo(admin, bienId, ownerId) {
    if (!bienId) return true;

    try {
      const { data } = await admin
        .from('biens')
        .select('id')
        .eq('id', bienId)
        .eq('user_id', ownerId)
        .maybeSingle();

      return Boolean(data);
    } catch (err) {
      console.warn('[bienBelongsTo]', err.message);
      return false;
    }
  }

  // Références croisées (Phase 6) : chaque référence vers une autre
  // ressource doit pointer vers une entité DU MÊME propriétaire, sinon
  // le locataire cible pourrait recevoir des notifications/appels qui ne
  // le concernent pas et les listes d'un tiers révéleraient ses données.
  const REF_RULES = {
    locataires: { logement_id: 'logements' },
    paiements: { locataire_id: 'locataires', logement_id: 'logements' },
    incidents: { logement_id: 'logements' },
    interventions: { incident_id: 'incidents', prestataire_id: 'prestataires', logement_id: 'logements' },
  };

  async function belongsToOwner(admin, ownerId, tableName, body) {
    const rules = REF_RULES[tableName];
    if (!rules) return null;

    for (const [field, refTable] of Object.entries(rules)) {
      const refId = body[field];
      if (refId === undefined || refId === null || refId === '') continue;

      try {
        const { data } = await admin
          .from(refTable)
          .select('user_id')
          .eq('id', refId)
          .maybeSingle();
        if (!data || data.user_id !== ownerId) {
          return { field, message: 'Introuvable ou ne vous appartient pas.' };
        }
      } catch (err) {
        console.warn(`[belongsToOwner] ${refTable}.${field}`, err.message);
        return { field, message: 'Introuvable ou ne vous appartient pas.' };
      }
    }
    return null;
  }

  // Invariant occupation (Phase 7) : un logement = un seul locataire actif.
  async function logementHasOtherActiveTenant(admin, ownerId, logementId, excludeLocataireId) {
    if (!logementId) return false;

    try {
      const { data } = await admin
        .from('locataires')
        .select('id')
        .eq('logement_id', logementId)
        .eq('statut', 'actif')
        .eq('user_id', ownerId);
      return (data || []).some((l) => String(l.id) !== String(excludeLocataireId));
    } catch (err) {
      console.warn('[logementHasOtherActiveTenant]', err.message);
      return false;
    }
  }

  async function createLogementForOwner(admin, ownerId, payload) {
    if (!(await bienBelongsTo(admin, payload?.bien_id, ownerId))) {
      return { errors: { bien_id: 'Bien introuvable ou ne vous appartient pas.' } };
    }

    // L'adresse du logement est héritée du bien si elle n'est pas fournie :
    // le propriétaire ne ressaisit jamais l'adresse (elle vit sur le bien).
    let logementBody = sanitize('logements', payload);
    if (!logementBody.adresse && payload?.bien_id) {
      const { data: bien } = await admin
        .from('biens')
        .select('adresse, ville, pays')
        .eq('id', payload.bien_id)
        .maybeSingle();
      if (bien) {
        const inherited = [bien.adresse, bien.ville, bien.pays].filter(Boolean).join(', ');
        if (inherited) logementBody = { ...logementBody, adresse: inherited };
      }
    }

    const errors = validateResource('logements', logementBody, false);
    if (Object.keys(errors).length) return { errors };

    const body = {
      ...logementBody,
      user_id: ownerId,
      statut: payload?.statut || 'libre',
    };

    const { data, error } = await admin.from('logements').insert(body).select().single();
    if (error) {
      console.error('[createLogement]', error.message);
      return { error };
    }
    return { data };
  }

  async function updateLogementForOwner(admin, ownerId, payload) {
    const { id, ...fields } = payload;
    if (!id) return { errors: { logement_id: 'Logement introuvable.' } };

    const clean = sanitize('logements', fields);
    const errors = validateResource('logements', clean, true);
    if (Object.keys(errors).length) return { errors };

    if (!(await bienBelongsTo(admin, clean.bien_id, ownerId))) {
      return { errors: { bien_id: 'Bien introuvable ou ne vous appartient pas.' } };
    }

    const { data: prevLoyerRow } = await admin
      .from('logements')
      .select('loyer_mensuel')
      .eq('id', id)
      .eq('user_id', ownerId)
      .maybeSingle();

    const { data, error } = await admin
      .from('logements')
      .update(clean)
      .eq('id', id)
      .eq('user_id', ownerId)
      .select()
      .single();

    if (error) {
      console.error('[updateLogement]', error.message);
      return { error };
    }

    // Changement de loyer : les échéances ouvertes (« attente » /
    // « retard ») suivent le nouveau montant.
    if (
      clean.loyer_mensuel !== undefined &&
      prevLoyerRow &&
      Number(clean.loyer_mensuel) !== Number(prevLoyerRow.loyer_mensuel)
    ) {
      const synced = await syncMontantEcheancesOuvertes(admin, {
        logementId: id,
        montant: clean.loyer_mensuel,
      });
      if (synced.error) console.warn('[updateLogement] échéances ouvertes :', synced.error);
    }

    return { data };
  }

  // Remet un logement à « libre » s'il n'est plus occupé par personne.
  async function freeLogementIfUnused(admin, logementId, ownerId) {
    if (!logementId) return;

    try {
      let query = admin
        .from('locataires')
        .select('id')
        .eq('logement_id', logementId);

      if (ownerId) {
        query = query.eq('user_id', ownerId);
      }

      const { data } = await query.maybeSingle();

      if (!data) {
        let update = admin.from('logements').update({ statut: 'libre' }).eq('id', logementId);
        if (ownerId) update = update.eq('user_id', ownerId);
        await update;
      }
    } catch (err) {
      console.warn('[freeLogementIfUnused]', err.message);
    }
  }

  // ============================================================
  // Création d'un locataire AVEC un compte d'authentification.
  //
  // Deux modes :
  //   - mode manuel (historique) : le propriétaire fournit lui-même
  //     username + mot de passe (et le compte est créé tel quel) ;
  //   - mode automatique (formulaire unique « Ajouter un locataire ») :
  //     MIM génère le username (amadou.diop, amadou.diop2, …), le mot
  //     de passe initial (1234, must_change_password = true), crée le
  //     logement embarqué si demandé, l'échéance du mois courant et
  //     renvoie un résumé des identifiants au propriétaire.
  //
  // Les données sensibles (user_id, loyer) ne proviennent JAMAIS du
  // client : user_id vient de la session, le loyer de l'échéance est
  // relu depuis logements.loyer_mensuel.
  // ============================================================
  async function createTenantWithAccount(req, res) {
    const admin = serviceClient();
    const ownerId = userId(req);

    const autoAccount = !req.body?.username && !req.body?.password;
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = autoAccount ? INITIAL_PASSWORD : String(req.body.password || '');
    const nom = String(req.body.nom || '').trim();
    const logementNew = req.body.logement && typeof req.body.logement === 'object' ? req.body.logement : null;
    let logementId = logementNew ? null : req.body.logement_id || null;
    let createdLogementId = null;
    let createdLogement = null;
    const email = req.body.email ? String(req.body.email).trim() : null;
    const phone = req.body.phone ? String(req.body.phone).trim() : null;
    const dateEntree = req.body.date_entree || null;
    const rawJour = req.body.jour_echeance;
    const jourEcheance = rawJour === '' || rawJour == null ? 1 : Number(rawJour);
    const statut = req.body.statut || 'actif';
    let generatedUsername = null;

    if (!nom) {
      return res.status(400).json({ success: false, message: 'Le nom est obligatoire.', errors: { nom: 'Le nom est obligatoire.' } });
    }

    if (!autoAccount) {
      if (!usernameIsValid(username)) {
        return res.status(400).json({
          success: false,
          message: 'Le username doit contenir entre 3 et 32 caractères (lettres minuscules, chiffres, . _ -).',
          errors: { username: 'Le username doit contenir au moins 3 caractères (lettres minuscules, chiffres, . _ -).' },
        });
      }

      const pwError = passwordRuleError(password);
      if (pwError) {
        return res.status(400).json({ success: false, message: pwError, errors: { password: pwError } });
      }
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'Adresse email invalide.', errors: { email: 'Adresse email invalide.' } });
    }

    const jour = Number(jourEcheance);
    if (Number.isNaN(jour) || jour < 1 || jour > 31) {
      return res.status(400).json({ success: false, message: 'Le jour d\'échéance doit être entre 1 et 31.', errors: { jour_echeance: 'Le jour d\'échéance doit être entre 1 et 31.' } });
    }

    // Un propriétaire ne peut créer un locataire que pour ses propres logements.
    let logementLoyer = null;
    let logementBienId = null;
    if (logementId) {
      const { data: logement, error: logementError } = await admin
        .from('logements')
        .select('id, user_id, loyer_mensuel, bien_id')
        .eq('id', logementId)
        .maybeSingle();

      if (logementError || !logement || logement.user_id !== ownerId) {
        return res.status(400).json({ success: false, message: 'Logement introuvable ou ne vous appartient pas.', errors: { logement_id: 'Logement introuvable ou ne vous appartient pas.' } });
      }
      logementLoyer = logement.loyer_mensuel;
      logementBienId = logement.bien_id;
    }

    // Username unique dans toute l'application (messages clairs, pas d'erreur technique).
    if (!autoAccount) {
      const { data: existingUsername } = await admin
        .from('profiles')
        .select('id')
        .ilike('username', username)
        .maybeSingle();

      if (existingUsername) {
        return res.status(409).json({ success: false, code: 'USERNAME_ALREADY_EXISTS', message: 'Ce nom d\'utilisateur est déjà utilisé.', errors: { username: 'Ce nom d\'utilisateur est déjà utilisé.' } });
      }
    } else {
      // Mode automatique : username généré depuis le nom complet.
      const { prenom, nom: nomFamille } = splitFullName(nom);
      generatedUsername = await uniqueUsername(admin, prenom, nomFamille);
      if (!generatedUsername) {
        return res.status(400).json({ success: false, message: 'Impossible de générer un nom d\'utilisateur unique pour ce locataire.' });
      }
    }

    // Création d'un logement embarqué (formulaire unique).
    // Placée après les vérifications pour ne pas laisser un logement
    // orphelin en cas de rejet du formulaire.
    if (logementNew) {
      const created = await createLogementForOwner(admin, ownerId, {
        ...logementNew,
        bien_id: logementNew.bien_id ?? req.body.bien_id ?? null,
        statut: statut === 'actif' ? 'occupe' : 'libre',
      });
      if (created.errors || created.error) {
        const errors = created.errors
          ? Object.fromEntries(Object.entries(created.errors).map(([k, v]) => [`logement_${k}`, v]))
          : {};
        return res.status(400).json({
          success: false,
          message: 'Veuillez corriger les champs du logement.',
          errors,
        });
      }
      logementId = created.data.id;
      createdLogementId = created.data.id;
      createdLogement = created.data;
      logementLoyer = created.data.loyer_mensuel;
      logementBienId = created.data.bien_id;
    }

    // Un logement ne peut avoir qu'un seul locataire actif.
    if (statut === 'actif' && (await logementHasOtherActiveTenant(admin, ownerId, logementId, null))) {
      if (createdLogementId) {
        await admin.from('logements').delete().eq('id', createdLogementId).catch(() => {});
      }
      return res.status(400).json({
        success: false,
        message: 'Ce logement est déjà occupé par un autre locataire actif.',
        errors: { logement_id: 'Ce logement est déjà occupé par un autre locataire actif.' },
      });
    }

    const finalUsername = autoAccount ? generatedUsername : username;

    const { data: createdUser, error: createError } = await admin.auth.admin.createUser({
      email: tenantEmailFor(finalUsername),
      password,
      email_confirm: true,
      user_metadata: {
        account_type: 'locataire',
        role: 'locataire',
        name: nom,
        username: finalUsername,
        phone: phone || '',
        must_change_password: true,
      },
    });

    if (createError || !createdUser?.user?.id) {
      if (createdLogementId) {
        await admin.from('logements').delete().eq('id', createdLogementId).catch(() => {});
      }
      const msg = String(createError?.message || '').toLowerCase();
      if (msg.includes('already') || msg.includes('existe')) {
        return res.status(409).json({ success: false, code: 'USERNAME_ALREADY_EXISTS', message: 'Ce nom d\'utilisateur est déjà utilisé.', errors: { username: 'Ce nom d\'utilisateur est déjà utilisé.' } });
      }
      console.error('[createTenant]', createError?.message);
      return res.status(400).json({ success: false, message: 'Impossible de créer le compte locataire.' });
    }

    const accountUid = createdUser.user.id;

    const body = {
      user_id: ownerId,
      account_uid: accountUid,
      username: finalUsername,
      nom,
      email,
      phone,
      logement_id: logementId,
      bien_id: logementBienId,
      date_entree: dateEntree,
      jour_echeance: jour,
      statut,
    };

    const { data, error } = await admin.from(tableName).insert(body).select().single();

    if (error) {
      if (createdLogementId) {
        await admin.from('logements').delete().eq('id', createdLogementId).catch(() => {});
      }
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

    // Échéance initiale : créée uniquement en mode automatique (formulaire
    // unique). En mode manuel (username/password fournis par le propriétaire),
    // l'échéance du mois courant est assurée à l'ouverture du dashboard
    // locataire (auto-création) ou par le cron checkLoyers.
    let echeance = null;
    if (autoAccount && logementId && logementLoyer != null) {
      echeance = await creerEcheanceInitiale(admin, {
        userId: ownerId,
        locataireId: data.id,
        logementId,
        montant: logementLoyer,
        dateEntree,
      });
      if (echeance.error) {
        await admin.from('paiements').delete().eq('locataire_id', data.id).catch(() => {});
        await admin.from('locataires').delete().eq('id', data.id).eq('user_id', ownerId).catch(() => {});
        await admin.auth.admin.deleteUser(accountUid).catch(() => {});
if (createdLogementId) {
        try {
          await admin.from('logements').delete().eq('id', createdLogementId);
        } catch (cleanupErr) {
          console.warn('[createTenant] nettoyage logement échec :', cleanupErr.message);
        }
      }
        console.error('[createTenant] échéance initiale :', echeance.error);
        return res.status(400).json({ success: false, message: 'Impossible de créer l\'échéance du loyer. Veuillez réessayer.' });
      }
    }

    await notify(accountUid, 'info', 'Votre compte locataire a été créé par votre propriétaire. À votre première connexion, vous devrez choisir un nouveau mot de passe.');
    gitAutoBackup(`Sauvegarde auto : ajout dans locataires (avec compte ${finalUsername})`);

    res.status(201).json({
      success: true,
      data,
      accountCreated: true,
      autoAccount,
      account: autoAccount ? { username: finalUsername, password: INITIAL_PASSWORD } : undefined,
      logement: createdLogement || null,
      echeance: echeance && echeance.created ? { mois: echeance.mois } : null,
    });
  }

  router.post('/', async (req, res) => {
    if (
      tableName === 'locataires' &&
      (req.body?.username || req.body?.password || req.body?.logement || req.body?.autoAccount)
    ) {
      return createTenantWithAccount(req, res);
    }

    const body = { ...sanitize(tableName, req.body), user_id: userId(req) };

    // L'adresse d'un logement est héritée du bien si elle n'est pas fournie.
    if (tableName === 'logements' && !body.adresse && body.bien_id) {
      const { data: bien } = await serviceClient()
        .from('biens')
        .select('adresse, ville, pays')
        .eq('id', body.bien_id)
        .maybeSingle();
      if (bien) {
        const inherited = [bien.adresse, bien.ville, bien.pays].filter(Boolean).join(', ');
        if (inherited) body.adresse = inherited;
      }
    }

    const errors = validateResource(tableName, body, false);
    if (Object.keys(errors).length) {
      return res.status(400).json({ success: false, message: 'Veuillez corriger les champs en rouge.', errors });
    }

    if (tableName === 'logements' && !(await bienBelongsTo(serviceClient(), body.bien_id, userId(req)))) {
      return res.status(400).json({ success: false, message: 'Bien introuvable ou ne vous appartient pas.', errors: { bien_id: 'Bien introuvable ou ne vous appartient pas.' } });
    }

    // Références croisées : toute référence doit appartenir au propriétaire.
    const badRef = await belongsToOwner(serviceClient(), userId(req), tableName, body);
    if (badRef) {
      return res.status(400).json({ success: false, message: badRef.message, errors: { [badRef.field]: badRef.message } });
    }

    // Un logement ne peut avoir qu'un seul locataire actif.
    if (tableName === 'locataires' && body.statut !== 'inactif' && (await logementHasOtherActiveTenant(serviceClient(), userId(req), body.logement_id, null))) {
      return res.status(400).json({ success: false, message: 'Ce logement est déjà occupé par un autre locataire actif.', errors: { logement_id: 'Ce logement est déjà occupé par un autre locataire actif.' } });
    }

    // Dénormalisation locataires.bien_id : reflète le bien du logement
    // (nécessaire pour les politiques RLS employé par bien) — même règle
    // que le PUT générique ci-dessous.
    if (tableName === 'locataires' && body.logement_id) {
      const { data: logementRef } = await serviceClient()
        .from('logements')
        .select('bien_id')
        .eq('id', body.logement_id)
        .maybeSingle();
      body.bien_id = logementRef?.bien_id ?? null;
    }

    // Un paiement confirmé (« paye ») sans date renseignée est daté du jour.
    if (tableName === 'paiements' && body.statut === 'paye' && !body.date_paiement) {
      body.date_paiement = new Date().toISOString().slice(0, 10);
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
    gitAutoBackup(`Sauvegarde auto : ajout dans ${tableName}`);

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

    // Logements embarqués (page fusionnée locataires / logements).
    // logement_new    : crée un logement puis l'attache au locataire.
    // logement_update : modifie un logement existant du propriétaire.
    const logementNew =
      tableName === 'locataires' && req.body?.logement_new && typeof req.body.logement_new === 'object'
        ? req.body.logement_new
        : null;
    const logementUpdate =
      tableName === 'locataires' && req.body?.logement_update && typeof req.body.logement_update === 'object'
        ? req.body.logement_update
        : null;

    if (logementNew) {
      const admin = serviceClient();
      const created = await createLogementForOwner(admin, userId(req), logementNew);
      if (created.errors || created.error) {
        const errors = created.errors
          ? Object.fromEntries(Object.entries(created.errors).map(([k, v]) => [`logement_${k}`, v]))
          : {};
        return res.status(400).json({
          success: false,
          message: 'Veuillez corriger les champs du logement.',
          errors,
        });
      }
      body.logement_id = created.data.id;
    } else if (logementUpdate) {
      const admin = serviceClient();
      const updated = await updateLogementForOwner(admin, userId(req), logementUpdate);
      if (updated.errors || updated.error) {
        const errors = updated.errors
          ? Object.fromEntries(Object.entries(updated.errors).map(([k, v]) => [`logement_${k}`, v]))
          : {};
        return res.status(400).json({
          success: false,
          message: 'Veuillez corriger les champs du logement.',
          errors,
        });
      }
    }

    // Dénormalisation locataires.bien_id : reflète le bien du logement
    // (nécessaire pour les politiques RLS employé par bien).
    if (tableName === 'locataires' && body.logement_id) {
      const { data: logementRef } = await serviceClient()
        .from('logements')
        .select('bien_id')
        .eq('id', body.logement_id)
        .maybeSingle();
      body.bien_id = logementRef?.bien_id ?? null;
    }

    const errors = validateResource(tableName, body, true);
    if (Object.keys(errors).length) {
      return res.status(400).json({ success: false, message: 'Veuillez corriger les champs en rouge.', errors });
    }

    if (tableName === 'logements' && !(await bienBelongsTo(serviceClient(), body.bien_id, userId(req)))) {
      return res.status(400).json({ success: false, message: 'Bien introuvable ou ne vous appartient pas.', errors: { bien_id: 'Bien introuvable ou ne vous appartient pas.' } });
    }

    // Un paiement confirmé (« paye ») sans date renseignée est daté du jour.
    if (tableName === 'paiements' && body.statut === 'paye' && !body.date_paiement) {
      body.date_paiement = new Date().toISOString().slice(0, 10);
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

    if (!prev) {
      return res.status(404).json({ success: false, message: 'Introuvable.' });
    }

    // Références croisées : toute référence doit appartenir au propriétaire.
    const badRef = await belongsToOwner(serviceClient(), userId(req), tableName, body);
    if (badRef) {
      return res.status(400).json({ success: false, message: badRef.message, errors: { [badRef.field]: badRef.message } });
    }

    // Un logement ne peut avoir qu'un seul locataire actif.
    if (tableName === 'locataires') {
      const targetLogementId = body.logement_id ?? prev.logement_id;
      const willBeActive = (body.statut ?? prev.statut) === 'actif';
      if (willBeActive && (await logementHasOtherActiveTenant(serviceClient(), userId(req), targetLogementId, id))) {
        return res.status(400).json({ success: false, message: 'Ce logement est déjà occupé par un autre locataire actif.', errors: { logement_id: 'Ce logement est déjà occupé par un autre locataire actif.' } });
      }
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

    await notifyOnUpdate(tableName, prev, data, userId(req));

    // Changement de loyer : les échéances ouvertes (« attente » /
    // « retard ») suivent le nouveau montant, sinon le locataire
    // paierait l'ancien loyer jusqu'à l'échéance suivante.
    if (
      tableName === 'logements' &&
      body.loyer_mensuel !== undefined &&
      prev &&
      Number(body.loyer_mensuel) !== Number(prev.loyer_mensuel)
    ) {
      const synced = await syncMontantEcheancesOuvertes(serviceClient(), {
        logementId: id,
        montant: body.loyer_mensuel,
      });
      if (synced.error) console.warn('[logements] échéances ouvertes :', synced.error);
    }

    // Synchronisation du statut des logements quand le locataire change de logement.
    if (tableName === 'locataires' && prev) {
      const admin = serviceClient();
      const oldLogement = prev.logement_id;
      const newLogement = data.logement_id;

      if (newLogement && newLogement !== oldLogement) {
        await admin
          .from('logements')
          .update({ statut: 'occupe' })
          .eq('id', newLogement)
          .eq('user_id', userId(req));
      }
      if (oldLogement && oldLogement !== newLogement) {
        await freeLogementIfUnused(admin, oldLogement, userId(req));
      } else if (newLogement) {
        // Même logement conservé : il reste occupé par le locataire.
        await admin
          .from('logements')
          .update({ statut: 'occupe' })
          .eq('id', newLogement)
          .eq('user_id', userId(req));
      }
    }

    gitAutoBackup(`Sauvegarde auto : modification dans ${tableName}`);

    res.json({ success: true, data });
  });

  router.delete('/:id', async (req, res) => {
    const id = req.params.id;
    const admin = serviceClient();

    // Introuvable ou ne nous appartient pas : on ne renvoie pas 200
    // (un succès vide masquerait une tentative sur les données d'un tiers).
    const { data: existing } = await admin
      .from(tableName)
      .select('id')
      .eq('id', id)
      .eq('user_id', userId(req))
      .maybeSingle();

    if (!existing) {
      return res.status(404).json({ success: false, message: 'Introuvable.' });
    }

    // Impossible de supprimer un bien encore pourvu de logements :
    // on évite de laisser des logements orphelins.
    if (tableName === 'biens') {
      const { data: ref } = await admin
        .from('logements')
        .select('id')
        .eq('bien_id', id)
        .maybeSingle();

      if (ref) {
        return res.status(400).json({
          success: false,
          message: 'Ce bien contient des logements. Supprimez d\'abord les logements.',
        });
      }
    }

    // Impossible de supprimer un logement encore occupé par un locataire :
    // on évite de laisser la fiche du locataire sans logement par accident.
    if (tableName === 'logements') {
      const { data: ref } = await admin
        .from('locataires')
        .select('id')
        .eq('logement_id', id)
        .maybeSingle();

      if (ref) {
        return res.status(400).json({
          success: false,
          message: 'Ce logement est occupé par un locataire. Supprimez d\'abord le locataire.',
        });
      }
    }

    // La suppression d'un locataire désactive aussi son compte d'accès :
    // plus aucun login ne fonctionnera avec ce username.
    if (tableName === 'locataires') {
      const { data: row } = await admin
        .from('locataires')
        .select('account_uid, logement_id')
        .eq('id', id)
        .eq('user_id', userId(req))
        .maybeSingle();

      const { error } = await sb(req)
        .from('locataires')
        .delete()
        .eq('id', id)
        .eq('user_id', userId(req));

      if (error) {
        console.error('[locataires]', error.message);
        return res.status(400).json({ success: false, message: 'Erreur lors de la suppression.' });
      }

      if (row?.account_uid) {
        const { error: delErr } = await admin.auth.admin.deleteUser(row.account_uid);
        if (delErr) console.warn('[locataires] suppression du compte :', delErr.message);
      }

      await freeLogementIfUnused(admin, row?.logement_id, userId(req));
      gitAutoBackup(`Sauvegarde auto : suppression locataire (compte ${row?.account_uid || 'sans compte'})`);
      return res.json({ success: true, message: 'Supprimé avec succès. Le compte du locataire est désactivé.' });
    }

    const { error } = await sb(req)
      .from(tableName)
      .delete()
      .eq('id', id)
      .eq('user_id', userId(req));

    if (error) {
      console.error(`[${tableName}]`, error.message);
      return res.status(400).json({ success: false, message: 'Erreur lors de la suppression.' });
    }

    gitAutoBackup(`Sauvegarde auto : suppression dans ${tableName}`);

    res.json({ success: true, message: 'Supprimé avec succès.' });
  });

  return router;
}
