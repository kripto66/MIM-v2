// ============================================================
// MIM - Envoi d'e-mails (Nodemailer)
//
// Config via variables d'environnement :
//   SMTP_HOST, SMTP_PORT (587 par défaut), SMTP_USER, SMTP_PASSWORD,
//   SMTP_FROM, SMTP_SECURE (1/true pour TLS direct), SMTP_SIMULATE
//
// SMTP_SIMULATE=1 (ou SMTP_HOST absent) : aucun e-mail réel n'est
// envoyé — seuls la destination et l'objet sont loggés (jamais le
// contenu sensible). Utile en dev et dans les tests.
// ============================================================

import nodemailer from 'nodemailer';

let transport = null;

const envBool = (v) => v === '1' || v === 'true' || v === 'TRUE';

function useSimulation() {
  if (process.env.NODE_ENV === 'production') return false;
  return envBool(process.env.SMTP_SIMULATE) || !process.env.SMTP_HOST;
}

function getTransport() {
  if (transport) return transport;
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: envBool(process.env.SMTP_SECURE),
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD || '' } : undefined,
  });
  return transport;
}

function defaultFrom() {
  return process.env.SMTP_FROM || 'Okarne Global Management <no-reply@mim-app.com>';
}

/**
 * Envoie un e-mail.
 * @param {object} opts { to, subject, html, text }
 * @returns {Promise<{sent?: boolean, simulated?: boolean}>}
 */
export async function sendMail({ to, subject, html, text }) {
  if (useSimulation()) {
    console.log(`[mail:simulation] -> ${to} | ${subject}`);
    return { simulated: true };
  }

  if (!process.env.SMTP_HOST) {
    const error = new Error('SMTP_HOST est requis pour envoyer les e-mails.');
    error.code = 'SMTP_NOT_CONFIGURED';
    throw error;
  }

  const t = getTransport();
  try {
    await t.sendMail({
      from: defaultFrom(),
      to,
      subject,
      html,
      text: text || 'Veuillez utiliser un client e-mail compatible HTML.',
    });
    return { sent: true };
  } catch (err) {
    err.code = 'SMTP_ERROR';
    throw err;
  }
}