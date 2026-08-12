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
import { createCrudRouter } from './routes/crud.js';
import { authenticate } from './middleware/auth.js';
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

const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : true;

app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
  })
);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  next();
});

app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

const ROOT = path.join(__dirname, '..');

app.use(express.static(path.join(ROOT, 'PartPublic')));
app.use('/PartPublic', express.static(path.join(ROOT, 'PartPublic')));
app.use('/PartProprietaires', express.static(path.join(ROOT, 'PartProprietaires')));
app.use('/PartLocataires', express.static(path.join(ROOT, 'PartLocataires')));
app.use('/images', express.static(path.join(ROOT, 'images')));

app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'MIM API OK' });
});

app.use('/api/auth', authRateLimit, authRoutes);
app.use('/api', apiRateLimit);
app.use('/api/stats', authenticate, statsRoutes);
app.use('/api/git', authenticate, gitRoutes);
app.use('/api/locataire', authenticate, locataireRoutes);

app.use('/api/biens', authenticate, createCrudRouter('biens'));
app.use('/api/logements', authenticate, createCrudRouter('logements'));
app.use('/api/locataires', authenticate, createCrudRouter('locataires'));
app.use('/api/paiements', authenticate, createCrudRouter('paiements'));
app.use('/api/incidents', authenticate, createCrudRouter('incidents'));
app.use('/api/prestataires', authenticate, createCrudRouter('prestataires'));
app.use('/api/interventions', authenticate, createCrudRouter('interventions'));
app.use('/api/notifications', authenticate, createCrudRouter('notifications'));

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`MIM API démarrée sur http://localhost:${PORT}`);
});
