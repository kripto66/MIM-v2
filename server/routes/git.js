import { Router } from 'express';
import { gitAutoBackup } from '../utils/gitBackup.js';

const router = Router();

router.post('/backup', async (req, res) => {
  const result = await gitAutoBackup('Sauvegarde manuelle depuis le dashboard MIM');

  if (result.success) {
    return res.json({ success: true, message: 'Sauvegarde effectuée avec succès.' });
  }

  if (result.reason === 'nothing_to_commit') {
    return res.json({ success: true, message: 'Rien à sauvegarder (déjà à jour).' });
  }

  res.status(500).json({ success: false, message: 'Échec de la sauvegarde.' });
});

export default router;
