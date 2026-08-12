import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createClient } from '@supabase/supabase-js';

import authRoutes from './routes/auth.js';
import statsRoutes from './routes/stats.js';
import gitRoutes from './routes/git.js';
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`MIM API démarrée sur http://localhost:${PORT}`);
});
