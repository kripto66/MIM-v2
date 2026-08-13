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

  if (result.reason === 'disabled') {
    return res.json({
      success: false,
      message: 'Sauvegarde git désactivée (variable GIT_REPO_PATH manquante ou NODE_ENV=production sans GIT_BACKUP=true).',
    });
  }

  if (result.reason === 'git_introuvable') {
    return res.json({
      success: false,
      message: 'Binaire git introuvable (définir GIT_BIN ou ajouter git au PATH).',
    });
  }

  res.status(500).json({ success: false, message: 'Échec de la sauvegarde.' });
});

export default router;
