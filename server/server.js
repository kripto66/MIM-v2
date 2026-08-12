import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createClient } from '@supabase/supabase-js';

import authRoutes from './routes/auth.js';
import statsRoutes from './routes/stats.js';
import gitRoutes from './routes/git.js';
import { createCrudRouter } from './routes/crud.js';
import { authenticate } from './middleware/auth.js';

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

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

app.get('/api/health', (req, res) => {
  res.json({ success: true, message: 'MIM API OK' });
});

app.use('/api/auth', authRoutes);
app.use('/api/stats', authenticate, statsRoutes);
app.use('/api/git', authenticate, gitRoutes);

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
