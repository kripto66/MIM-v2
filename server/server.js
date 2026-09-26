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
  console.error('[FATAL] CORS_ORIGINS doit être configuré en production.');
  process.exit(1);
}

if (process.env.NODE_ENV === 'production') {
  let appUrl = null;
  try {
    appUrl = new URL(process.env.APP_URL || '');
  } catch {
    appUrl = null;
  }
  const smtpPort = Number(process.env.SMTP_PORT || 0);
  if (!appUrl || appUrl.protocol !== 'https:') {
    console.error('[FATAL] APP_URL doit être une URL HTTPS valide en production.');
    process.exit(1);
  }
  if (!process.env.SMTP_HOST || !Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535 || !process.env.SMTP_FROM) {
    console.error('[FATAL] SMTP_HOST, SMTP_PORT et SMTP_FROM doivent être configurés en production.');
    process.exit(1);
  }
}

app.listen(PORT, () => {
  console.log(`MIM API démarrée sur http://localhost:${PORT}`);
});
