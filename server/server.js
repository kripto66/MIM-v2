import './loadEnv.js';
import app from './app.js';

const PORT = process.env.PORT || 3000;

// ─── Garde-fous de configuration (fail-closed) ──────────────────────
//
// Les attributs `Secure` des cookies, le HSTS, l'exigence CORS, la
// bascule hors simulation Bictorys et le comportement de TRUST_PROXY
// dépendent tous de NODE_ENV. Un déploiement qui omet NODE_ENV active
// silencieusement TOUS ces garde-fous : le serveur démarre, l'interface
// répond, et rien n'indique que la sécurité est désactivée.
// On refuse donc de démarrer tant que la configuration n'est pas
// explicite.

const NODE_ENV = process.env.NODE_ENV;
const VALID_ENVS = ['development', 'test', 'production'];

if (!NODE_ENV || !VALID_ENVS.includes(NODE_ENV)) {
  console.error(
    `[FATAL] NODE_ENV doit être défini explicitement (${VALID_ENVS.join(' | ')}) — valeur actuelle : ${NODE_ENV || '(absente)'}.`,
  );
  process.exit(1);
}

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.error('[FATAL] JWT_SECRET doit être défini et contenir au moins 16 caractères.');
  process.exit(1);
}

const envBool = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());

const simulate = envBool(process.env.BICTORYS_SIMULATE);
const autoConfirm = envBool(process.env.BICTORYS_AUTOCONFIRM);

if (NODE_ENV === 'production') {
  // Un paiement « simulé auto-confirmé » active un abonnement sans aucun
  // encaissement : c'est une porte ouverte sur des abonnements gratuits.
  if (simulate || autoConfirm) {
    console.error(
      '[FATAL] BICTORYS_SIMULATE / BICTORYS_AUTOCONFIRM actifs en production : ' +
        'les abonnements seraient activés sans encaissement. Définissez BICTORYS_SIMULATE=0 et BICTORYS_AUTOCONFIRM=0.',
    );
    process.exit(1);
  }
  if (envBool(process.env.SMTP_SIMULATE)) {
    console.error('[FATAL] SMTP_SIMULATE actif en production : les e-mails (reset, invitations) ne partiraient pas.');
    process.exit(1);
  }
  if (!process.env.CORS_ORIGINS) {
    console.error('[FATAL] CORS_ORIGINS doit être configuré en production.');
    process.exit(1);
  }
  if (String(process.env.TRUST_PROXY || '').trim() === '') {
    console.error(
      '[FATAL] TRUST_PROXY doit être défini en production (true derrière Nginx/load-balancer, false en accès direct). ' +
        'Sans cela, le rate limit est soit partagé par tout le monde, soit contournable via X-Forwarded-For.',
    );
    process.exit(1);
  }
  if (envBool(process.env.GIT_BACKUP)) {
    console.warn('[WARN] GIT_BACKUP est activé en production — les sauvegardes git sont opt-in par conception.');
  }

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
} else {
  if (simulate || autoConfirm) {
    console.warn('[WARN] Paiement Bictorys SIMULÉ avec auto-confirmation — usage strictement local/de développement.');
  }
}

if (envBool(process.env.RATE_LIMIT_OFF) && NODE_ENV === 'production') {
  console.warn('[WARN] RATE_LIMIT_OFF est activé en production — la protection anti-brute-force est désactivée.');
}

// ─── Résilience du processus ────────────────────────────────────────
// Un handler de route qui laisse échapper une promesse ne doit plus
// pouvoir arrêter Node : la requête concernée reçoit un 500 via le
// middleware d'erreur d'app.js, et le serveur continue de servir les
// autres requêtes. Le sandwich d'un process manager (pm2, systemd,
// Docker restart:always) reste recommandé pour les crashs natifs.
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL:async] unhandledRejection intercepté (processus maintenu en vie) :', reason?.stack || reason);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL:async] uncaughtException intercepté (processus maintenu en vie) :', err?.stack || err);
});

const server = app.listen(PORT, () => {
  console.log(`MIM API démarrée sur http://localhost:${PORT} [${NODE_ENV}]`);
});

// Une erreur d'écoute (port occupé, permission refusée) est fatale : le
// handler global ci-dessus maintiendrait en vie un processus qui n'écoute
// rien. On sort proprement pour que le process manager redémarre.
server.on('error', (err) => {
  console.error(`[FATAL] Échec de l'écoute sur le port ${PORT} : ${err.message}`);
  process.exit(1);
});
