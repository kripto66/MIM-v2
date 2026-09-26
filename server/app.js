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
import ultraAdminRoutes from './routes/ultra-admin.js';
import subscriptionRoutes from './routes/subscription.js';
import bictorysWebhookRoutes from './routes/bictorys.js';
import employesRoutes from './routes/employes.js';
import tasksRoutes from './routes/tasks.js';
import employeRoutes from './routes/employe.js';
import validationsRoutes from './routes/validations.js';
import moyensPaiementRoutes from './routes/moyensPaiement.js';
import importRoutes from './routes/import.js';
import uploadRoutes from './routes/upload.js';
import agenceRoutes from './routes/agence.js';
import mandatRoutes from './routes/mandat.js';
import { createCrudRouter } from './routes/crud.js';
import { authenticate, requireActive, requirePasswordChanged, requireAdmin, requireUltraAdmin, requireRole, authenticatePage, requireZone } from './middleware/auth.js';
import { csrfOriginGuard, csrfInitRoute } from './middleware/csrf.js';
import { requireNoManagedWrites } from './middleware/mandatGuard.js';
import { authRateLimit, apiRateLimit } from './middleware/rateLimit.js';
import { PUBLIC_BASE_URL, SITE_NAME, SITE_DESCRIPTION, SITE_LOCALE, PUBLIC_PAGES } from './seo-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mandatGuard = requireNoManagedWrites();

const app = express();
app.disable('x-powered-by');

export function anonClient() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

export const supabase = anonClient();

export function authedClient(token) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });
}

let serviceClientInstance = null;

export function serviceClient() {
  if (!serviceClientInstance) {
    serviceClientInstance = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return serviceClientInstance;
}

// Origines autorisées pour <img> : les avatars sont hébergés sur Supabase
// Storage (URL http://127.0.0.1:64321/storage/... en local, *.supabase.co
// en production). Sans cela, la CSP bloque le chargement des photos.
const supabaseOrigin = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const imageOrigins = [supabaseOrigin, 'https://*.supabase.co'].filter(Boolean);

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
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  // X-Robots-Tag : noindex pour les zones protégées
  const protectedPrefixes = ['/PartProprietaires', '/PartAgence', '/PartLocataires', '/PartAdmin', '/PartUltraAdmin', '/PartEmployes', '/api'];
  if (protectedPrefixes.some(p => req.path.startsWith(p))) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  }

  // Content-Security-Policy : défense en profondeur contre XSS.
  // 'unsafe-inline' est nécessaire pour les scripts inline du frontend vanilla JS.
  // 'unsafe-eval' est requis si des bibliothèques l'utilisent (vérifier avant de l'activer).
  const cspDirectives = [
    "default-src 'self'",
    "object-src 'none'",
    "script-src 'self' 'unsafe-inline'",           // scripts inline dans les HTML
    "style-src 'self' 'unsafe-inline'",            // styles inline + Google Fonts si besoin
    "img-src 'self' data: blob: " + imageOrigins.join(' '),  // base64 + Supabase Storage (avatars)
    "font-src 'self' data:",                       // polices embarquées
    "connect-src 'self' http://127.0.0.1:64321 https://*.supabase.co wss://*.supabase.co",  // API Supabase
    "frame-ancestors 'none'",                      // pas de framing (renforce X-Frame-Options)
    "base-uri 'self'",
    "form-action 'self'",
  ];
  res.setHeader('Content-Security-Policy', cspDirectives.join('; '));

  // Les pages ne doivent jamais être servies depuis le cache du navigateur
  // (bouton « retour » / bfcache) : après une déconnexion, une page de zone
  // protégée ne doit pas rester visible avec une session invalide.
  if (req.path.endsWith('.html') || req.path.startsWith('/api')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

// Les loyers restent entièrement manuels : le locataire paie directement
// au propriétaire puis déclare, et le propriétaire valide. MIM n'encaisse
// PAS les loyers.
//
// En revanche, l'ABONNEMENT MIM du propriétaire est payé en ligne via
// Bictorys. Son webhook (/api/webhooks/bictorys) est le seul point
// d'entrée capable d'activer une souscription. Le corps brut est requis
// pour vérifier la signature : ce route est monté AVANT express.json.
app.use('/api/webhooks', apiRateLimit, express.raw({ type: () => true, limit: '2mb' }), bictorysWebhookRoutes);

app.use(express.json({ limit: '4mb' }));
app.use(cookieParser());
app.get('/api/csrf-token', csrfInitRoute);
app.use('/api', csrfOriginGuard);

const ROOT = path.join(__dirname, '..');

app.use(express.static(path.join(ROOT, 'PartPublic')));
app.use('/PartPublic', express.static(path.join(ROOT, 'PartPublic')));
// Zones protégées : les pages (et leurs assets) ne sont servies qu'aux
// utilisateurs connectés avec le bon rôle. La protection ne repose plus
// uniquement sur le JavaScript du navigateur.
app.use('/PartProprietaires', authenticatePage(), requireZone('proprietaire', 'agence', 'entreprise'), express.static(path.join(ROOT, 'PartProprietaires')));
app.use('/PartProprietairesShadow', authenticatePage(), requireZone('proprietaire', 'entreprise'), express.static(path.join(ROOT, 'PartProprietairesShadow')));
app.use('/PartLocataires', authenticatePage(), requireZone('locataire'), express.static(path.join(ROOT, 'PartLocataires')));
app.use('/PartAdmin', authenticatePage(), requireZone('admin', 'ultra_admin'), express.static(path.join(ROOT, 'PartAdmin')));
app.use('/PartUltraAdmin', authenticatePage(), requireZone('ultra_admin'), express.static(path.join(ROOT, 'PartUltraAdmin')));
app.use('/PartEmployes', authenticatePage(), requireZone('employe'), express.static(path.join(ROOT, 'PartEmployes')));
app.use('/PartAgence', authenticatePage(), requireZone('agence'), express.static(path.join(ROOT, 'PartAgence')));
app.use('/images', express.static(path.join(ROOT, 'images')));

// ─── SEO ROUTES ────────────────────────────────────────────────────

// robots.txt dynamique
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send(`User-agent: *
Allow: /
Disallow: /PartProprietaires/
Disallow: /PartLocataires/
Disallow: /PartAdmin/
Disallow: /PartUltraAdmin/
Disallow: /PartEmployes/
Disallow: /PartAgence/
Disallow: /api/

# Sitemap (remplacer le domaine quand le nom définitif sera choisi)
Sitemap: ${PUBLIC_BASE_URL}/sitemap.xml
`);
});

// sitemap.xml dynamique
app.get('/sitemap.xml', (req, res) => {
  const urls = PUBLIC_PAGES.map((page) => {
    const lastmod = new Date().toISOString().split('T')[0];
    return `  <url>
    <loc>${PUBLIC_BASE_URL}${page.path}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${page.changefreq}</changefreq>
    <priority>${page.priority}</priority>
  </url>`;
  }).join('\n');

  res.type('application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`);
});

// ─── END SEO ROUTES ────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'MIM API OK' });
});

// Les fonctionnalités métier exigent un compte ACTIF (ni suspendu, ni
// dépendant d'un propriétaire suspendu). Les routes /api/auth restent
// ouvertes aux comptes suspendus : profil, mot de passe, déconnexion, 2FA.
// SameSite=Lax sur mim_token protège contre les attaques CSRF.
//
// /api/subscription est monté SANS requireActive : un propriétaire dont
// l'abonnement a expiré doit pouvoir se reconnecter, consulter les plans
// et RENOUVELER en ligne (paiement Bictorys). Les routes /api/subscription
// vérifient elles-mêmes que le compte n'est ni banni ni dépendant d'un
// propriétaire suspendu.
app.use('/api/auth', authRateLimit, authRoutes);
app.use('/api', apiRateLimit);
app.use('/api/stats', authenticate, requireActive, requirePasswordChanged, requireRole('proprietaire', 'agence', 'entreprise'), statsRoutes);
app.use('/api/git', authenticate, requireActive, requirePasswordChanged, requireRole('proprietaire', 'agence', 'entreprise', 'admin'), gitRoutes);
app.use('/api/locataire', authenticate, requireActive, requirePasswordChanged, requireRole('locataire'), locataireRoutes);
app.use('/api/admin', authenticate, requireActive, requirePasswordChanged, requireAdmin, adminRoutes);
app.use('/api/ultra-admin', authenticate, requireActive, requirePasswordChanged, requireUltraAdmin, ultraAdminRoutes);
app.use('/api/subscription', authenticate, requirePasswordChanged, requireRole('proprietaire', 'agence', 'entreprise'), subscriptionRoutes);
app.use('/api/employes', authenticate, requireActive, requirePasswordChanged, requireRole('proprietaire', 'agence', 'entreprise'), mandatGuard, employesRoutes);
app.use('/api/tasks', authenticate, requireActive, requirePasswordChanged, requireRole('proprietaire', 'agence', 'entreprise'), mandatGuard, tasksRoutes);
app.use('/api/employe', authenticate, requireActive, requireRole('employe'), employeRoutes);
app.use('/api/paiements-validation', authenticate, requireActive, requirePasswordChanged, requireRole('proprietaire', 'agence', 'entreprise'), validationsRoutes);
app.use('/api/moyens-paiement', authenticate, requireActive, requirePasswordChanged, requireRole('proprietaire', 'agence', 'entreprise'), moyensPaiementRoutes);
app.use('/api/import', authenticate, requireActive, requirePasswordChanged, requireRole('proprietaire', 'agence', 'entreprise'), importRoutes);
app.use('/api/onboarding', authenticate, requireActive, requirePasswordChanged, requireRole('proprietaire', 'agence', 'entreprise'), importRoutes);
app.use('/api/upload', authenticate, requireActive, requirePasswordChanged, uploadRoutes);
app.use('/api/agence', authenticate, requireActive, requirePasswordChanged, requireRole('agence'), agenceRoutes);
app.use('/api/mandat', authenticate, requireActive, requirePasswordChanged, requireRole('proprietaire', 'entreprise'), mandatRoutes);

const ownerOnly = requireRole('proprietaire', 'agence', 'entreprise');
app.use('/api/biens', authenticate, requireActive, requirePasswordChanged, ownerOnly, mandatGuard, createCrudRouter('biens'));
app.use('/api/logements', authenticate, requireActive, requirePasswordChanged, ownerOnly, mandatGuard, createCrudRouter('logements'));
app.use('/api/locataires', authenticate, requireActive, requirePasswordChanged, ownerOnly, mandatGuard, createCrudRouter('locataires'));
app.use('/api/paiements', authenticate, requireActive, requirePasswordChanged, ownerOnly, mandatGuard, createCrudRouter('paiements'));
app.use('/api/incidents', authenticate, requireActive, requirePasswordChanged, ownerOnly, mandatGuard, createCrudRouter('incidents'));
app.use('/api/prestataires', authenticate, requireActive, requirePasswordChanged, ownerOnly, mandatGuard, createCrudRouter('prestataires'));
app.use('/api/interventions', authenticate, requireActive, requirePasswordChanged, ownerOnly, mandatGuard, createCrudRouter('interventions'));
app.use('/api/notifications', authenticate, requireActive, requirePasswordChanged, notificationsRoutes);

export default app;
