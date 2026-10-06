// ============================================================
// MIM - Catalogue des plans d'abonnement
//
// Deux audiences cohabitent (colonne public.plans.audience) :
//   * 'proprietaire' : standard 3 000 / premium 6 000 /
//     pro 9 000 / agence 50 000 XOF par mois ;
//   * 'agence' : Starter 12 000 / Pro 25 000 / Ultra 60 000.
//     Le 3e palier porte le code historique 'agence_business' :
//     seul son NOM affiché a changé (« Agence Ultra »), le code
//     reste pour ne pas casser les abonnements existants.
//
// Un compte ne voit QUE les plans de son audience : la vérification
// est refaite au checkout (fail-closed), pas seulement dans l'UI.
// Les capacités (biens, logements, locataires, employés,
// prestataires) sont définies en base et TOUJOURS lues côté serveur —
// une valeur NULL signifie « illimité » (check_quota_for_plan).
// ============================================================

import { serviceClient } from '../app.js';

export const AUDIENCES = ['proprietaire', 'agence'];

export function audienceForAccount(accountType) {
  return accountType === 'agence' ? 'agence' : 'proprietaire';
}

// Liste des plans (par défaut : uniquement les actifs d'une audience).
export async function listPlans(onlyActive = true, audience = 'proprietaire') {
  let q = serviceClient().from('plans').select('*');
  if (onlyActive) q = q.eq('actif', true);
  if (audience && AUDIENCES.includes(audience)) q = q.eq('audience', audience);
  q = q.order('prix', { ascending: true });
  const { data, error } = await q;
  if (error) throw new Error(`plans: ${error.message}`);
  return data || [];
}

export async function planByCode(code, onlyActive = true) {
  if (!code) return null;
  let q = serviceClient().from('plans').select('*').eq('code', String(code).trim().toLowerCase());
  if (onlyActive) q = q.eq('actif', true);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`plans: ${error.message}`);
  return data || null;
}

// Plan associé à une ligne de souscription : d'abord plan_id, puis
// correspondance par code (abonnements legacy sans plan_id).
export async function planForSubscription(sub) {
  if (!sub) return null;
  if (sub.plan_id) {
    const { data, error } = await serviceClient().from('plans').select('*').eq('id', sub.plan_id).maybeSingle();
    if (error) throw new Error(`plans: ${error.message}`);
    if (data) return data;
  }
  return planByCode(sub.plan);
}

// Vue publique d'un plan (jamais les colonnes internes inutiles).
export function planView(plan) {
  if (!plan) return null;
  return {
    id: plan.id,
    code: plan.code,
    nom: plan.nom,
    type: plan.type,
    prix: Number(plan.prix),
    devise: plan.devise,
    max_immeubles: plan.max_immeubles,
    max_logements: plan.max_logements,
    max_locataires: plan.max_locataires,
    max_employes: plan.max_employes,
    max_prestataires: plan.max_prestataires,
    duree_abonnement: plan.duree_abonnement,
    audience: plan.audience || 'proprietaire',
    description: plan.description,
    actif: plan.actif,
  };
}

export const PLAN_CODES = ['standard', 'premium', 'pro', 'agence', 'agence_starter', 'agence_pro', 'agence_business'];

// Limite d'immeubles d'un propriétaire.
//  * Abonnement avec plan reconnu → max_immeubles du plan ;
//  * Sans abonnement (héritage) ou capacité NULL → aucune limite ;
//    les valeurs 0 sont refusées par les contraintes PostgreSQL.
export async function maxImmeublesFor(sub) {
  if (!sub) return null;
  const plan = await planForSubscription(sub);
  return plan && plan.max_immeubles > 0 ? plan.max_immeubles : null;
}

// Les capacités NULL restent sans limite pour les données legacy ; les
// valeurs nulles ou négatives ne sont pas autorisées par le schéma.
export async function maxLogementsFor(sub) {
  if (!sub) return null;
  const plan = await planForSubscription(sub);
  return plan && plan.max_logements > 0 ? plan.max_logements : null;
}

export async function maxLocatairesFor(sub) {
  if (!sub) return null;
  const plan = await planForSubscription(sub);
  return plan && plan.max_locataires > 0 ? plan.max_locataires : null;
}