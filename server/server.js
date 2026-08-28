import 'dotenv/config';
import app from './app.js';

const PORT = process.env.PORT || 3000;

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.error('[FATAL] JWT_SECRET doit être défini et contenir au moins 16 caractères.');
  process.exit(1);
}

if (process.env.RATE_LIMIT_OFF === 'true' && process.env.NODE_ENV === 'production') {
  console.warn('[WARN] RATE_LIMIT_OFF est activé en production — la protection anti-brute-force est désactivée.');
}

if (!process.env.CORS_ORIGINS && process.env.NODE_ENV === 'production') {
  console.warn('[WARN] CORS_ORIGINS non configuré — le CORS réfère toutes les origines en production.');
}

app.listen(PORT, () => {
  console.log(`MIM API démarrée sur http://localhost:${PORT}`);
});
