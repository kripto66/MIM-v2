// ============================================================
// MIM - Simulation temporelle (Ultra Admin)
//
// Permet d'avancer le temps du système pour tester les
// échéances, abonnements, et autres vérifications temporelles.
// L'offset est stocké en DB (system_config) et mis en cache.
//
// NOTE : Ce module crée son propre client Supabase pour éviter
// une dépendance circulaire (app.js → auth.js → subscription.js
// → simulation.js → app.js).
// ============================================================

import { createClient } from '@supabase/supabase-js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 2000;

let cachedOffset = null;
let cacheTimestamp = 0;

function sb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Lit l'offset depuis la DB (avec cache court)
async function readOffset() {
  const now = Date.now();
  if (cachedOffset !== null && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedOffset;
  }

  try {
    const { data, error } = await sb()
      .from('system_config')
      .select('value')
      .eq('key', 'simulation_offset_days')
      .maybeSingle();

    if (error) {
      console.warn('[simulation] DB error:', error.message);
      cachedOffset = 0;
      cacheTimestamp = now;
      return 0;
    }

    cachedOffset = parseInt(data?.value, 10) || 0;
    cacheTimestamp = now;
    return cachedOffset;
  } catch (err) {
    console.warn('[simulation] unexpected:', err.message);
    cachedOffset = 0;
    cacheTimestamp = now;
    return 0;
  }
}

// Écrit l'offset en DB
async function writeOffset(days) {
  try {
    const { error } = await sb()
      .from('system_config')
      .upsert(
        { key: 'simulation_offset_days', value: String(days), updated_at: new Date().toISOString() },
        { onConflict: 'key' }
      );
    if (error) throw error;
    cachedOffset = days;
    cacheTimestamp = Date.now();
    return true;
  } catch (err) {
    console.warn('[simulation] write error:', err.message);
    return false;
  }
}

// Retourne le timestamp actuel simulé (réel + offset)
export async function getNow() {
  const offset = await readOffset();
  return Date.now() + offset * DAY_MS;
}

// Retourne un objet Date simulé
export async function getSimulatedDate() {
  const ts = await getNow();
  return new Date(ts);
}

// Avance d'un jour
export async function advanceDay() {
  const current = await readOffset();
  const newOffset = current + 1;
  const ok = await writeOffset(newOffset);
  if (!ok) return { success: false, error: 'Erreur lors de la mise à jour.' };
  return {
    success: true,
    offset: newOffset,
    realDate: new Date().toISOString(),
    simulatedDate: new Date(Date.now() + newOffset * DAY_MS).toISOString(),
    message: `Jour simulé avancé. Offset : ${newOffset} jour(s).`,
  };
}

// Réinitialise à la vraie heure
export async function resetSimulation() {
  const ok = await writeOffset(0);
  if (!ok) return { success: false, error: 'Erreur lors de la réinitialisation.' };
  return {
    success: true,
    offset: 0,
    realDate: new Date().toISOString(),
    simulatedDate: new Date().toISOString(),
    message: 'Simulation réinitialisée. Date réelle restaurée.',
  };
}

// État actuel de la simulation
export async function getSimulationStatus() {
  const offset = await readOffset();
  return {
    offset,
    realDate: new Date().toISOString(),
    simulatedDate: new Date(Date.now() + offset * DAY_MS).toISOString(),
    isActive: offset !== 0,
  };
}

// Lecture synchrone de l'offset (pour les scripts cron qui lisent d'abord la config)
export function readOffsetSync() {
  return cachedOffset ?? 0;
}

// Charge l'offset une première fois (à appeler au démarrage du cron)
export async function loadOffset() {
  return readOffset();
}
