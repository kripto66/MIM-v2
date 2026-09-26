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

function bodyBienId(req) {
  const fromBody = req.body && (req.body.bien_id ?? req.body.bienId);
  if (fromBody !== undefined && fromBody !== null && fromBody !== '') {
    const n = Number(fromBody);
    if (Number.isInteger(n) && n > 0) return n;
  }
  const fromParams = req.params && (req.params.bienId ?? req.params.bien_id ?? req.params.id);
  if (fromParams !== undefined && fromParams !== null && fromParams !== '') {
    const n = Number(fromParams);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

// Les tables de PERSONNES ne sont jamais instruites par un bien : dès
// qu'un propriétaire est délégué, la création d'un locataire ou d'un
// employé lui est refusée (l'agence les gère dans son espace).
const PERSON_TABLES = new Set(['locataires', 'employes']);

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

      const bienIds = await mandatedBienIds(req.user.id);
      if (!bienIds.size) return next();

      const { data: ownBiens, error: ownErr } = await serviceClient()
        .from('biens')
        .select('id')
        .eq('user_id', req.user.id);
      if (ownErr) throw new Error(ownErr.message);

      const allBiens = (ownBiens || []).map((b) => Number(b.id));
      const toutEstConfie = allBiens.length > 0 && allBiens.every((id) => bienIds.has(id));

      const target = bodyBienId(req);
      const concerne = target != null ? bienIds.has(target) : toutEstConfie;
      if (!concerne) return next();

      return res.status(403).json({
        success: false,
        code: 'MANDAT_MANAGED_BY_AGENCY',
        message: 'Ce bien est géré par votre agence depuis votre espace délégué.',
      });
    } catch (err) {
      console.error('[mandat/guard]', err.message);
      return res.status(500).json({ success: false, message: 'Vérification du mandat impossible.' });
    }
  };
}
