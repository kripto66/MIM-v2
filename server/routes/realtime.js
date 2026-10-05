import { Router } from 'express';

const router = Router();

// Retourne au navigateur les paramètres nécessaires pour ouvrir une
// connexion Supabase Realtime authentifiée (RLS appliquée). Le token est
// le jeton Supabase de la session courante : le client Realtime ne voit
// donc que les lignes autorisées par les policies existantes.
router.get('/session', (req, res) => {
  res.json({
    success: true,
    url: process.env.SUPABASE_PUBLIC_URL || process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
    userId: req.user.id,
    token: req.user.supabase_token,
    expiresAt: req.user.supabase_expires_at || null,
  });
});

export default router;
