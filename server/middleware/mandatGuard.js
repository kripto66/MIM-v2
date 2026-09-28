// ============================================================
// MIM - Protection des ressources placées sous mandat
//
// Un propriétaire qui a confié ses biens à une agence ne peut plus
// les gérer lui-même : il consulte, il dialogue et il confirme ses
// versements (espace « délégué »). Ce garde-fou est appliqué au
// niveau HTTP, sur TOUTES les routes d'écriture, afin que l'interface
// streamline ne soit pas la seule protection.
//
// Règle : si le propriétaire possède au moins un mandat actif ET que
// la ressource ciblée appartient à un bien couvert par ce mandat,
// l'écriture est refusée (403 MANDAT_MANAGED_BY_AGENCY).
//
// CORRECTION D'AUDIT — le bien visé est désormais résolu CÔTÉ SERVEUR :
//   - PUT/PATCH/DELETE /:id : le :id est un id de LIGNE, pas de bien.
//     On relit la ligne (scopée au propriétaire) et on en déduit son
//     logement puis son bien.
//   - POST sans `bien_id` : on suit `logement_id` / `locataire_id` /
//     `incident_id` (les champs réellement utilisés par crud.js).
// Auparavant, `bienIds.has(rowId)` était presque toujours faux et
// l'écriture passait, y compris sur un bien délégué.
// ============================================================

import { serviceClient } from '../app.js';

const WRITE_TABLES = new Set([
  'biens',
  'logements',
  'locataires',
  'paiements',
  'incidents',
  'prestataires',
  'interventions',
  'employes',
  'tasks',
  'paiements-validation',
  'moyens-paiement',
  'import',
  'onboarding',
]);

const METHOD_BLOCKED = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function activeMandate(userId) {
  const { data, error } = await serviceClient()
    .from('agences_proprietaires')
    .select('id')
    .eq('proprietaire_id', userId)
    .eq('statut', 'actif')
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

async function mandatedBienIds(userId) {
  const { data, error } = await serviceClient()
    .from('agences_biens')
    .select('bien_id')
    .eq('proprietaire_id', userId)
    .eq('statut', 'actif');
  if (error) throw new Error(error.message);
  return new Set((data || []).map((l) => Number(l.bien_id)).filter(Boolean));
}

function toPosInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function rowOf(sb, table, id, ownerId) {
  const { data, error } = await sb
    .from(table)
    .select('*')
    .eq('id', id)
    .eq('user_id', ownerId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

async function bienOfLogement(sb, logementId, ownerId) {
  if (!logementId) return null;
  const { data, error } = await sb
    .from('logements')
    .select('bien_id')
    .eq('id', logementId)
    .eq('user_id', ownerId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toPosInt(data.bien_id) : null;
}

// Tables sans aucun lien vers un bien : le mandat ne peut pas les
// instruire, on applique la règle historique (blocage si TOUT est confié).
const NO_BIEN_TABLES = new Set(['prestataires', 'tasks', 'paiements-validation', 'moyens-paiement']);

// Tables dont la colonne `:id` est un id de ligne à résoudre.
const ROW_TABLES = new Set([
  'logements',
  'locataires',
  'paiements',
  'incidents',
  'interventions',
  'employes',
]);

/**
 * Déduit le bien concerné par l'écriture.
 * Retourne :
 *   - un nombre      => bien identifié
 *   - null           => impossible à identifier (applique la règle « tout confié »)
 *   - undefined      => table sans lien de bien
 */
async function resolveBienId(req, table, ownerId) {
  const sb = serviceClient();
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const rowId = toPosInt(req.params?.id ?? req.params?.bienId ?? req.params?.bien_id);

  if (NO_BIEN_TABLES.has(table)) return undefined;

  if (table === 'biens') {
    return toPosInt(body.bien_id ?? body.bienId) ?? rowId;
  }

  if (table === 'logements') {
    if (rowId) {
      const row = await rowOf(sb, 'logements', rowId, ownerId);
      return row ? toPosInt(row.bien_id) : toPosInt(body.bien_id ?? body.bienId);
    }
    return toPosInt(body.bien_id ?? body.bienId);
  }

  // Tables liées à un logement : on lit d'abord la ligne ciblée (PUT /
  // PATCH / DELETE), sinon on suit le corps de la requête (POST).
  let logementId = toPosInt(body.logement_id ?? body.logementId);
  let locataireId = toPosInt(body.locataire_id ?? body.locataireId);
  let incidentId = toPosInt(body.incident_id ?? body.incidentId);

  if (ROW_TABLES.has(table) && rowId) {
    const row = await rowOf(sb, table, rowId, ownerId);
    if (row) {
      logementId = toPosInt(row.logement_id) ?? logementId;
      locataireId = toPosInt(row.locataire_id) ?? locataireId;
      incidentId = toPosInt(row.incident_id) ?? incidentId;
      if (row.bien_id !== undefined) {
        const direct = toPosInt(row.bien_id);
        if (direct) return direct;
      }
    }
  }

  if (logementId) return bienOfLogement(sb, logementId, ownerId);

  if (table === 'interventions' && incidentId) {
    const incident = await rowOf(sb, 'incidents', incidentId, ownerId);
    if (incident) return bienOfLogement(sb, incident.logement_id, ownerId);
  }

  if (table === 'paiements' && locataireId) {
    const locataire = await rowOf(sb, 'locataires', locataireId, ownerId);
    if (locataire) {
      if (toPosInt(locataire.bien_id)) return toPosInt(locataire.bien_id);
      return bienOfLogement(sb, locataire.logement_id, ownerId);
    }
  }

  if (table === 'locataires' && rowId) {
    const row = await rowOf(sb, 'locataires', rowId, ownerId);
    if (row && toPosInt(row.bien_id)) return toPosInt(row.bien_id);
  }

  return null;
}

// Les tables de PERSONNES ne sont jamais instruites par un bien : dès
// qu'un propriétaire est délégué, la création d'un locataire ou d'un
// employé lui est refusée (l'agence les gère dans son espace).
const PERSON_TABLES = new Set(['locataires', 'employes']);

// Catégories d'import qui créent des personnes : couvertes par
// PERSON_TABLES, donc bloquées dès qu'un mandat existe.
const IMPORT_PERSON_CATEGORIES = new Set(['locataires', 'employes']);

function deny(res) {
  return res.status(403).json({
    success: false,
    code: 'MANDAT_MANAGED_BY_AGENCY',
    message: 'Ce bien est géré par votre agence depuis votre espace délégué.',
  });
}

export function requireNoManagedWrites() {
  return async function managedWritesGuard(req, res, next) {
    if (!METHOD_BLOCKED.has(req.method)) return next();
    if (req.user?.account_type !== 'proprietaire') return next();

    // Dans un middleware monté via app.use(), req.path est relatif au
    // montage : c'est req.baseUrl qui porte le nom de la ressource.
    const mount = String(req.baseUrl || '').split('/').filter(Boolean);
    const table = String(mount[mount.length - 1] || req.path || '').split('/').filter(Boolean)[0] || '';
    if (!WRITE_TABLES.has(table)) return next();

    try {
      const mandat = await activeMandate(req.user.id);
      if (!mandat) return next();

      if (PERSON_TABLES.has(table)) {
        return res.status(403).json({
          success: false,
          code: 'MANDAT_MANAGED_BY_AGENCY',
          message: 'La gestion des locataires et des employés est assurée par votre agence.',
        });
      }

      // Import / onboarding : les catégories « locataires » et
      // « employes » sont couvertes par PERSON_TABLES même si la
      // ressource n'est pas nommée ainsi dans l'URL.
      if (table === 'import' || table === 'onboarding') {
        const categories = Array.isArray(req.body?.categories) ? req.body.categories : [];
        if (categories.some((c) => IMPORT_PERSON_CATEGORIES.has(String(c)))) {
          return res.status(403).json({
            success: false,
            code: 'MANDAT_MANAGED_BY_AGENCY',
            message: 'La gestion des locataires et des employés est assurée par votre agence.',
          });
        }
      }

      const bienIds = await mandatedBienIds(req.user.id);
      if (!bienIds.size) return next();

      const { data: ownBiens, error: ownErr } = await serviceClient()
        .from('biens')
        .select('id')
        .eq('user_id', req.user.id);
      if (ownErr) throw new Error(ownErr.message);

      const allBiens = (ownBiens || []).map((b) => Number(b.id));
      const toutEstConfie = allBiens.length > 0 && allBiens.every((id) => bienIds.has(id));

      const target = await resolveBienId(req, table, req.user.id);
      // target === undefined : table sans lien de bien.
      // target === null      : lien de bien mais non résolvable.
      // Dans les deux cas on retombe sur la règle historique.
      const concerne = typeof target === 'number' ? bienIds.has(target) : toutEstConfie;
      if (!concerne) return next();

      return deny(res);
    } catch (err) {
      // Fail-closed : une erreur de résolution ne doit jamais laisser
      // l'écriture passer.
      console.error('[mandat/guard]', err.message);
      return res.status(500).json({ success: false, message: 'Vérification du mandat impossible.' });
    }
  };
}
