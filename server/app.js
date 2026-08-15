import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createClient } from '@supabase/supabase-js';

import authRoutes from './routes/auth.js';
import statsRoutes from './routes/stats.js';
import gitRoutes from './routes/git.js';
import locataireRoutes from './routes/locataire.js';
import notificationsRoutes from './routes/notifications.js';
import adminRoutes from './routes/admin.js';
import subscriptionRoutes from './routes/subscription.js';
import employesRoutes from './routes/employes.js';
import tasksRoutes from './routes/tasks.js';
import employeRoutes from './routes/employe.js';
import unitechRoutes, { webhookRouter } from './routes/unitech.js';
import validationsRoutes from './routes/validations.js';
import moyensPaiementRoutes from './routes/moyensPaiement.js';
import { createCrudRouter } from './routes/crud.js';
import { authenticate, requireActive, requireAdmin, requireRole, authenticatePage, requireZone } from './middleware/auth.js';
import { authRateLimit, apiRateLimit } from './middleware/rateLimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export function authedClient(token) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });
}

export function serviceClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : [];

// En production, seules les origines listées dans CORS_ORIGINS sont autorisées.
// Sans configuration, le CORS est désactivé (appelés en même origine uniquement).
const corsOriginOption = corsOrigins.length
  ? (origin, cb) => {
      if (!origin || corsOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    }
  : false;

app.use(
  cors({
    origin: corsOriginOption,
    credentials: true,
  })
);

// Derrière un reverse proxy (Nginx…), req.ip doit refléter l'IP du client.
if (process.env.TRUST_PROXY === 'true' || process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

// Le webhook UnitechPay est monté AVANT express.json : il doit recevoir le
// corps brut (Buffer) pour vérifier la signature HMAC-SHA256.
app.use('/api/unitech/webhook', webhookRouter);

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

const ROOT = path.join(__dirname, '..');

app.use(express.static(path.join(ROOT, 'PartPublic')));
app.use('/PartPublic', express.static(path.join(ROOT, 'PartPublic')));
// Zones protégées : les pages (et leurs assets) ne sont servies qu'aux
// utilisateurs connectés avec le bon rôle. La protection ne repose plus
// uniquement sur le JavaScript du navigateur.
app.use('/PartProprietaires', authenticatePage(), requireZone('proprietaire', 'agence', 'entreprise'), express.static(path.join(ROOT, 'PartProprietaires')));
app.use('/PartLocataires', authenticatePage(), requireZone('locataire'), express.static(path.join(ROOT, 'PartLocataires')));
app.use('/PartAdmin', authenticatePage(), requireZone('admin'), express.static(path.join(ROOT, 'PartAdmin')));
app.use('/PartEmployes', authenticatePage(), requireZone('employe'), express.static(path.join(ROOT, 'PartEmployes')));
app.use('/images', express.static(path.join(ROOT, 'images')));

app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'MIM API OK' });
});

// Les fonctionnalités métier exigent un compte ACTIF (ni suspendu, ni
// dépendant d'un propriétaire suspendu). Les routes /api/auth restent
// ouvertes aux comptes suspendus : profil, mot de passe, déconnexion, 2FA.
app.use('/api/auth', authRateLimit, authRoutes);
app.use('/api', apiRateLimit);
app.use('/api/stats', authenticate, requireActive, requireRole('proprietaire', 'agence', 'entreprise'), statsRoutes);
app.use('/api/git', authenticate, requireActive, requireRole('proprietaire', 'agence', 'entreprise', 'admin'), gitRoutes);
app.use('/api/locataire', authenticate, requireActive, requireRole('locataire'), locataireRoutes);
app.use('/api/admin', authenticate, requireActive, requireAdmin, adminRoutes);
app.use('/api/subscription', authenticate, requireRole('proprietaire', 'agence', 'entreprise'), subscriptionRoutes);
app.use('/api/employes', authenticate, requireActive, requireRole('proprietaire', 'agence', 'entreprise'), employesRoutes);
app.use('/api/tasks', authenticate, requireActive, requireRole('proprietaire', 'agence', 'entreprise'), tasksRoutes);
app.use('/api/employe', authenticate, requireActive, requireRole('employe'), employeRoutes);
app.use('/api/unitech', authenticate, requireActive, requireRole('proprietaire', 'agence', 'entreprise'), unitechRoutes);
app.use('/api/paiements-validation', authenticate, requireActive, requireRole('proprietaire', 'agence', 'entreprise'), validationsRoutes);
app.use('/api/moyens-paiement', authenticate, requireActive, requireRole('proprietaire', 'agence', 'entreprise'), moyensPaiementRoutes);

const ownerOnly = requireRole('proprietaire', 'agence', 'entreprise');
app.use('/api/biens', authenticate, requireActive, ownerOnly, createCrudRouter('biens'));
app.use('/api/logements', authenticate, requireActive, ownerOnly, createCrudRouter('logements'));
app.use('/api/locataires', authenticate, requireActive, ownerOnly, createCrudRouter('locataires'));
app.use('/api/paiements', authenticate, requireActive, ownerOnly, createCrudRouter('paiements'));
app.use('/api/incidents', authenticate, requireActive, ownerOnly, createCrudRouter('incidents'));
app.use('/api/prestataires', authenticate, requireActive, ownerOnly, createCrudRouter('prestataires'));
app.use('/api/interventions', authenticate, requireActive, ownerOnly, createCrudRouter('interventions'));
app.use('/api/notifications', authenticate, requireActive, notificationsRoutes);

export default app;
