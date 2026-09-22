// ============================================================
// MIM - Catalogue des plans d'abonnement propriétaire
//
// Grille mensuelle : Standard 7 000 / Premium 15 000 / Pro 30 000 /
// Agence 50 000 XOF par mois. Les capacités (immeubles, logements,
// locataires) sont définies en base (table public.plans) et TOUJOURS
// lues côté serveur : rien n'est décidé côté frontend. Employés et
// prestataires restent illimités sur tous les plans.
// ============================================================

import { serviceClient } from '../app.js';

// Liste des plans (par défaut : uniquement les actifs, triés par prix).
export async function listPlans(onlyActive = true) {
  let q = serviceClient().from('plans').select('*');
  if (onlyActive) q = q.eq('actif', true);
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
  if (error) return null;
  return data || null;
}

// Plan associé à une ligne de souscription : d'abord plan_id, puis
// correspondance par code (abonnements legacy sans plan_id).
export async function planForSubscription(sub) {
  if (!sub) return null;
  if (sub.plan_id) {
    const { data } = await serviceClient().from('plans').select('*').eq('id', sub.plan_id).maybeSingle();
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
    duree_abonnement: plan.duree_abonnement,
    description: plan.description,
    actif: plan.actif,
  };
}

export const PLAN_CODES = ['standard', 'premium', 'pro', 'agence'];

// Limite d'immeubles d'un propriétaire.
//  * Abonnement avec plan reconnu → max_immeubles du plan ;
//  * Sans abonnement (héritage) ou plan inconnu ('agence' legacy…) →
//    aucune limite (accès historique conservé, fail open volontaire).
export async function maxImmeublesFor(sub) {
  if (!sub) return null;
  const plan = await planForSubscription(sub);
  return plan && plan.max_immeubles > 0 ? plan.max_immeubles : null;
}

// Même logique « fail open » pour logements et locataires (NULL = aucune
// limite, comportement historique conservé).
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