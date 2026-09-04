// ============================================================
// MIM - Vérification périodique des loyers (cron)
//
// À lancer régulièrement (quotidien) via un cron externe :
//   npm run cron:loyers
// ou, pour une exécution manuelle :
//   node server/scripts/checkLoyers.js
//
// Ce script :
//   1. Crée l'échéance du mois courant pour chaque locataire actif
//      qui n'en a pas encore (statut « attente », montant = loyer).
//   2. Passe en « retard » les échéances « attente » dont le jour
//      d'échéance (jour_echeance) est dépassé, en notifiant le locataire.
//
// Nécessite SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY dans server/.env.
// ============================================================

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DAY_MS = 24 * 60 * 60 * 1000;

// Lecture de l'offset de simulation depuis system_config
async function getSimulationOffset() {
  try {
    const { data } = await supabase
      .from('system_config')
      .select('value')
      .eq('key', 'simulation_offset_days')
      .maybeSingle();
    return parseInt(data?.value, 10) || 0;
  } catch {
    return 0;
  }
}

// Cohérence avec utils/echeances.js : TOUT est calculé en UTC
// (sinon le cron et la chaîne « mois payé + 1 » peuvent diverger
// à la frontière d'un mois selon le fuseau du serveur).
function monthOf(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function main() {
  const simOffset = await getSimulationOffset();
  const now = new Date(Date.now() + simOffset * DAY_MS);
  const currentMonth = monthOf(now);
  // Jour du mois en UTC (même référence que currentMois()).
  const nowUtcDay = now.getUTCDate();

  const { data: locataires, error: locError } = await supabase
    .from('locataires')
    .select('id, user_id, account_uid, logement_id, jour_echeance, date_entree')
    .eq('statut', 'actif')
    .not('logement_id', 'is', null);

  if (locError) throw new Error(`locataires : ${locError.message}`);

  const tenantById = new Map(locataires.map((l) => [l.id, l]));

  // 1. Échéances manquantes du mois courant.
  for (const locataire of locataires) {
    const { data: logement, error: lgError } = await supabase
      .from('logements')
      .select('id, user_id, loyer_mensuel')
      .eq('id', locataire.logement_id)
      .maybeSingle();

    if (lgError || !logement) continue;

    // Un locataire qui n'est pas encore entré (date_entree future) ne doit
    // PAS recevoir d'échéance pour le mois courant : son échéance sera
    // créée au mois de son entrée (creerEcheanceInitiale l'assure déjà,
    // et le cron la créera naturellement à ce moment-là).
    const entryMonth = locataire.date_entree ? String(locataire.date_entree).slice(0, 7) : null;
    if (entryMonth && entryMonth > currentMonth) continue;

    const { data: existing } = await supabase
      .from('paiements')
      .select('id')
      .eq('locataire_id', locataire.id)
      .eq('mois', currentMonth)
      .maybeSingle();

    if (existing) continue;

    const { error } = await supabase.from('paiements').insert({
      user_id: logement.user_id,
      locataire_id: locataire.id,
      logement_id: logement.id,
      montant: logement.loyer_mensuel,
      mois: currentMonth,
      statut: 'attente',
    });

    if (error) {
      console.error(`[cron] échéance ${currentMonth} (locataire ${locataire.id}) :`, error.message);
    } else {
      console.log(`[cron] échéance créée : ${currentMonth} pour locataire ${locataire.id}`);
    }
  }

  // 2. Passage en « retard » des échéances dépassées.
  const { data: attente, error: attError } = await supabase
    .from('paiements')
    .select('id, locataire_id, mois')
    .eq('statut', 'attente');

  if (attError) throw new Error(`paiements : ${attError.message}`);

  for (const paiement of attente) {
    const tenant = tenantById.get(paiement.locataire_id);
    if (!tenant) continue;

    // Échéances antérieures à la date d'entrée (données historiques
    // incohérentes) : on ne les passe pas en retard.
    const entryMonth = tenant.date_entree ? String(tenant.date_entree).slice(0, 7) : null;
    if (entryMonth && paiement.mois < entryMonth) continue;

    const jourEcheance = tenant.jour_echeance ?? 1;
    let overdue = paiement.mois < currentMonth;

    if (paiement.mois === currentMonth) {
      overdue = nowUtcDay > jourEcheance;
    }

    if (!overdue) continue;

    const { error } = await supabase
      .from('paiements')
      .update({ statut: 'retard' })
      .eq('id', paiement.id);

    if (error) {
      console.error(`[cron] passage en retard (${paiement.id}) :`, error.message);
      continue;
    }

    console.log(`[cron] échéance en retard : ${paiement.mois} (paiement ${paiement.id})`);

    if (tenant.account_uid) {
      await supabase.from('notifications').insert({
        user_id: tenant.account_uid,
        type: 'paiement',
        message: `Votre loyer de ${paiement.mois} est en retard.`,
      });
    }
  }

  console.log('[cron] vérification des loyers terminée.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[cron]', err.message);
    process.exit(1);
  });
