// ============================================================
// MIM - Upload des photos de profil (avatars)
// Upload en base64 JSON (limite 2 Mo décodés, jpeg/png/webp),
// stocké dans le bucket Supabase Storage « avatars » (public).
// Le fichier est remplacé par upsert : un seul avatar par compte.
// ============================================================

import { Router } from 'express';
import { serviceClient } from '../app.js';

const router = Router();

const BUCKET = 'avatars';
const MAX_BYTES = 2 * 1024 * 1024;
const DATA_URI_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/i;
const CONTENT_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

async function ensureBucket(sb) {
  try {
    const { data: buckets } = await sb.storage.listBuckets();
    if (!buckets || !buckets.some((b) => b.name === BUCKET)) {
      await sb.storage.createBucket(BUCKET, { public: true });
    }
  } catch (err) {
    console.error('[upload/bucket]', err.message);
  }
}

async function deleteAvatarIfAny(sb, userId, excludePath = null) {
  for (const e of Object.values(CONTENT_TYPES)) {
    const path = `${userId}.${e}`;
    if (path === excludePath) continue;
    const { error } = await sb.storage.from(BUCKET).remove([path]);
    if (!error) break;
  }
}

// ============================================================
// POST /upload/avatar  { dataUri }
// Décode, valide (type + taille), écrit dans Storage et met à
// jour profiles.avatar_url. Renvoie l'URL publique.
// ============================================================
router.post('/avatar', async (req, res) => {
  const sb = serviceClient();
  const userId = req.user.id;
  const dataUri = typeof req.body?.dataUri === 'string' ? req.body.dataUri.trim() : '';

  const match = DATA_URI_RE.exec(dataUri);
  if (!match) {
    return res.status(400).json({ success: false, message: 'Photo invalide : envoyez une image base64 (jpeg, png ou webp).', errors: { avatar: 'Image invalide' } });
  }

  const contentType = match[1].toLowerCase();
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (buffer.length === 0 || buffer.length > MAX_BYTES) {
    return res.status(400).json({ success: false, message: 'Photo trop lourde : taille maximale 2 Mo.', errors: { avatar: 'Photo trop lourde (2 Mo max)' } });
  }

  await ensureBucket(sb);
  const ext = CONTENT_TYPES[contentType];
  const filePath = `${userId}.${ext}`;

  const { error } = await sb.storage.from(BUCKET).upload(filePath, buffer, {
    contentType,
    upsert: true,
  });

  if (error) {
    console.error('[upload/avatar]', error.message);
    return res.status(500).json({ success: false, message: 'Erreur lors de l\'enregistrement de la photo.' });
  }

  const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(filePath);
  const avatarUrl = pub?.publicUrl || null;

  // Une seule photo par compte : on retire les anciennes extensions
  // (jamais le fichier qui vient d'être écrit).
  await deleteAvatarIfAny(sb, userId, filePath).catch(() => {});

  const { error: profileError } = await sb.from('profiles').update({ avatar_url: avatarUrl }).eq('id', userId);
  if (profileError) {
    console.error('[upload/avatar/profile]', profileError.message);
    return res.status(500).json({ success: false, message: 'Photo enregistrée mais profil non mis à jour.' });
  }

  res.json({ success: true, avatar_url: avatarUrl });
});

// ============================================================
// DELETE /upload/avatar
// Supprime la photo de profil et réinitialise profiles.avatar_url.
// ============================================================
router.delete('/avatar', async (req, res) => {
  const sb = serviceClient();
  const userId = req.user.id;

  await deleteAvatarIfAny(sb, userId);

  const { error } = await sb.from('profiles').update({ avatar_url: null }).eq('id', userId);
  if (error) {
    console.error('[upload/avatar/delete]', error.message);
    return res.status(500).json({ success: false, message: 'Erreur lors de la suppression de la photo.' });
  }

  res.json({ success: true, avatar_url: null });
});

export default router;