const buckets = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    if (now - entry.start >= 10 * 60 * 1000) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

const RATE_LIMIT_OFF = process.env.RATE_LIMIT_OFF === 'true';

function makeLimiter({ windowMs, max, message }) {
  return (req, res, next) => {
    if (RATE_LIMIT_OFF) return next();
    // Clé sur le chemin (sans la query string) : évite de contourner la limite
    // en variant les paramètres d'URL. req.ip reflète l'IP client quand le
    // trust proxy est activé (voir app.js).
    const key = `${req.ip}:${req.baseUrl || ''}${req.path}`;
    const now = Date.now();
    const entry = buckets.get(key);

    if (!entry || now - entry.start >= windowMs) {
      buckets.set(key, { start: now, count: 1 });
      return next();
    }

    entry.count += 1;

    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((windowMs - (now - entry.start)) / 1000));
      return res.status(429).json({ success: false, message });
    }

    return next();
  };
}

export const authRateLimit = makeLimiter({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: 'Trop de tentatives. Réessayez dans quelques minutes.',
});

export const apiRateLimit = makeLimiter({
  windowMs: 60 * 1000,
  max: 300,
  message: 'Trop de requêtes. Veuillez patienter.',
});
