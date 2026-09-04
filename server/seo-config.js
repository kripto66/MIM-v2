// ============================================================
// MIM - Configuration SEO centralisée
//
// Toute URL absolue du projet doit passer par ce module.
// Pour changer le domaine, modifier PUBLIC_BASE_URL ici
// ou dans le fichier .env du serveur.
// ============================================================

// En production, PUBLIC_BASE_URL est défini dans .env.
// En dev, on fallback sur APP_URL ou http://localhost:3000.
const BASE = process.env.PUBLIC_BASE_URL
  || process.env.APP_URL
  || 'http://localhost:3000';

// Supprimer le slash final
export const PUBLIC_BASE_URL = BASE.replace(/\/+$/, '');

export const SITE_NAME = 'MyImmoManagement';
export const SITE_TAGLINE = 'Gestion immobilière simplifiée';
export const SITE_DESCRIPTION = 'MIM permet aux propriétaires et agences de gérer leurs biens, logements, locataires, employés, paiements et incidents depuis une seule plateforme.';
export const SITE_LOCALE = 'fr_SN';
export const SITE_OG_TYPE = 'website';

// Image sociale pour les partages (Open Graph / Twitter Cards)
export const SOCIAL_IMAGE = `${PUBLIC_BASE_URL}/images/social-share.svg`;

// Pages publiques indexables
export const PUBLIC_PAGES = [
  { path: '/',            title: 'Gestion immobilière simplifiée | MyImmoManagement', description: 'MIM est la plateforme de gestion immobilière pour propriétaires et agences. Gérez biens, locataires, paiements et employés en un seul endroit.', priority: 1.0, changefreq: 'weekly' },
  { path: '/connexion',   title: 'Connexion — MyImmoManagement', description: 'Connectez-vous à votre espace MyImmoManagement pour gérer vos biens, locataires et paiements.', priority: 0.6, changefreq: 'monthly' },
  { path: '/createCompte', title: 'Créez un compte gratuit — MyImmoManagement', description: 'Inscrivez-vous gratuitement sur MyImmoManagement et commencez à gérer votre patrimoine immobilier.', priority: 0.8, changefreq: 'monthly' },
];

// Pages à ne PAS indexer (noindex)
export const NOINDEX_PATHS = [
  '/connexion',
  '/forgot',
  '/reset',
  '/change-password',
  '/2fa',
  '/PartProprietaires',
  '/PartLocataires',
  '/PartAdmin',
  '/PartUltraAdmin',
  '/PartEmployes',
  '/api',
];
