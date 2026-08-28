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
      return false; // fail open — allow login if DB is unreachable
    }

    cachedValue = data?.value === 'true';
    cacheTimestamp = now;
    return cachedValue;
  } catch (err) {
    console.warn('[saasStatus] unexpected:', err.message);
    return false;
  }
}

export function invalidateSaasCache() {
  cachedValue = null;
  cacheTimestamp = 0;
}

export function isAllowedDuringSuspension(accountType) {
  return ALLOWED_DURING_SUSPENSION.includes(accountType);
}
