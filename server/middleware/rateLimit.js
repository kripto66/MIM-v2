import crypto from 'node:crypto';

// ============================================================
// M-06 — Rate limit distribué.
//
// Les compteurs vivent en base (`rate_limit_buckets`, RPC
// `rate_limit_bump`) : partagés entre tous les process/instances et
// survivant aux redémarrages. Le Map local ci-dessous n'est plus que
// le filet de sécurité si la base est injoignable (fail-open
// journalisé) — sans base, aucune requête ne passe de toute façon.
//
// app.js est importé en DYNAMIQUE : un import statique créerait le
// cycle app.js -> routes/auth.js -> rateLimit.js -> app.js, et auth.js
// lit les export const de ce module au top-level (TDZ au chargement).
// ============================================================

const buckets = new Map();

const RATE_LIMIT_OFF = process.env.RATE_LIMIT_OFF === 'true';

let serviceClientFn = null;
async function serviceClient() {
  if (!serviceClientFn) {
    const mod = await import('../app.js');
    serviceClientFn = mod.serviceClient;
  }
  return serviceClientFn();
}

// Compteur local de secours : même sémantique fenêtrée que la RPC.
function bumpLocal(key, windowMs) {
  const now = Date.now();
  const entry = buckets.get(key);

  if (!entry || now - entry.start >= windowMs) {
    buckets.set(key, { start: now, count: 1 });
    return { count: 1, start: now, fresh: true };
  }

  entry.count += 1;
  return { count: entry.count, start: entry.start, fresh: false };
}

// Incrémente le compteur de la clé (une seule aller-retour base).
// Ne lève jamais : base indisponible → repli mémoire + warn, la
// protection reste active à l'échelle du process.
async function bump(key, windowMs) {
  try {
    const sb = await serviceClient();
    const { data, error } = await sb.rpc('rate_limit_bump', {
      p_key: key,
      p_window_ms: windowMs,
    });
    if (error) throw new Error(error.message);

    const start = Date.parse(data?.window_start || '');
    const count = Number(data?.count || 0);
    if (!Number.isFinite(start) || count < 1) throw new Error('réponse RPC invalide');

    // « fresh » = premier coup de la fenêtre : celui-ci passe toujours
    // (sémantique historique du limiteur, inchangée).
    return { count, start, fresh: count === 1 };
  } catch (err) {
    console.warn('[rate-limit] bascule mémoire (base indisponible) :', err.message);
    return bumpLocal(key, windowMs);
  }
}

// Purge des fenêtres closes : la plus longue fenêtre des limiteurs
// actifs fait 10 minutes, une heure de marge est sans effet utile.
// Nettoie aussi le Map de secours (garde-fou mémoire si la base est
// restée longtemps injoignable).
export function startRateLimitSweep(intervalMs = 5 * 60 * 1000) {
  const run = () => {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [key, entry] of buckets) {
      if (entry.start < cutoff) buckets.delete(key);
    }
    serviceClient()
      .then((sb) => sb.from('rate_limit_buckets').delete().lt('window_start', new Date(cutoff).toISOString()))
      .then(({ error }) => {
        if (error) console.warn('[rate-limit/purge]', error.message);
      })
      .catch((err) => console.warn('[rate-limit/purge]', err.message));
  };
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

export function makeLimiter({ windowMs, max, message, keyFn }) {
  return async (req, res, next) => {
    if (RATE_LIMIT_OFF) return next();

    try {
      const key = keyFn ? keyFn(req) : `${req.ip}:${req.baseUrl || ''}${req.path}`;
      const r = await bump(key, windowMs);

      // Le premier coup d'une fenêtre passe toujours (comportement
      // historique) ; au-delà, count >= max → 429 avec Retry-After.
      if (!r.fresh && r.count >= max) {
        const remaining = Math.max(1, Math.ceil((r.start + windowMs - Date.now()) / 1000));
        res.setHeader('Retry-After', remaining);
        return res.status(429).json({ success: false, message });
      }

      return next();
    } catch (err) {
      // Dernier recours (fail-open documenté) : le limiteur ne doit
      // jamais être la raison du refus d'une requête légitime.
      console.warn('[rate-limit]', err.message);
      return next();
    }
  };
}

export const authRateLimit = makeLimiter({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: 'Trop de tentatives. Réessayez dans quelques minutes.',
  keyFn: (req) => {
    const identifier = String(req.body?.identifier || req.body?.email || req.body?.username || '').trim().toLowerCase();
    return `auth:${req.ip}:${req.baseUrl || ''}${req.path}:${identifier}`;
  },
});

export const apiRateLimit = makeLimiter({
  windowMs: 60 * 1000,
  max: 300,
  message: 'Trop de requêtes. Veuillez patienter.',
});

export const forgotPasswordRateLimit = makeLimiter({
  windowMs: 10 * 60 * 1000,
  max: 3,
  message: 'Trop de demandes de réinitialisation. Réessayez dans quelques minutes.',
  keyFn: (req) => `forgot:${req.ip}:${String(req.body?.email || '').trim().toLowerCase()}`,
});

export const mfaVerifyRateLimit = makeLimiter({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: 'Trop de tentatives de vérification. Réessayez dans quelques minutes.',
  keyFn: (req) => {
    const challenge = String(req.cookies?.mim_mfa_pending || '');
    const digest = challenge ? crypto.createHash('sha256').update(challenge).digest('hex') : 'anonymous';
    return `mfa:${req.ip}:${digest}`;
  },
});

// Limite globale par adresse IP. Les limiteurs ci-dessus sont clés
// « ip + chemin » : un scanner peut donc balayer des milliers de chemins
// à quota illimité. req.ip reflète l'adresse réelle du client parce que
// TRUST_PROXY est réglé dans app.js avant tout montage de route.
export const globalIpRateLimit = makeLimiter({
  windowMs: 60 * 1000,
  max: 600,
  message: 'Trop de requêtes. Veuillez patienter.',
  keyFn: (req) => `ip:${req.ip}`,
});
