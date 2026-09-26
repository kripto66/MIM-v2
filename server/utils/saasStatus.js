import { serviceClient } from '../app.js';

const ALLOWED_DURING_SUSPENSION = ['admin', 'ultra_admin'];

let cachedValue = null;
let cacheTimestamp = 0;
const CACHE_TTL = 30_000; // 30 seconds

export async function isSaasSuspended() {
  const now = Date.now();
  if (cachedValue !== null && (now - cacheTimestamp) < CACHE_TTL) {
    return cachedValue;
  }

  try {
    const { data, error } = await serviceClient()
      .from('system_config')
      .select('value')
      .eq('key', 'saas_suspended')
      .maybeSingle();

    if (error) {
      console.warn('[saasStatus] DB error:', error.message);
      return true;
    }

    const value = String(data?.value || '').trim().toLowerCase();
    if (value !== 'true' && value !== 'false') {
      console.warn('[saasStatus] configuration invalide, suspension conservée par sécurité');
      return true;
    }
    cachedValue = value === 'true';
    cacheTimestamp = now;
    return cachedValue;
  } catch (err) {
    console.warn('[saasStatus] unexpected:', err.message);
    return true;
  }
}

export function invalidateSaasCache() {
  cachedValue = null;
  cacheTimestamp = 0;
}

export function isAllowedDuringSuspension(accountType) {
  return ALLOWED_DURING_SUSPENSION.includes(accountType);
}
