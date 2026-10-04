import { Router } from 'express';
import { gitAutoBackup } from '../utils/gitBackup.js';

const router = Router();

router.post('/backup', async (req, res) => {
  const result = await gitAutoBackup('Sauvegarde manuelle depuis le dashboard Okarne GM');

  if (result.success) {
    return res.json({ success: true, message: 'Sauvegarde effectuée avec succès.' });
  }

  if (result.reason === 'push_failed') {
    // H-16 : le commit local a été créé mais le remote est injoignable.
    return res.status(502).json({
      success: false,
      message: 'Commit local créé mais la poussée a échoué : la prochaine sauvegarde retentera.',
    });
  }

  if (result.reason === 'queue_full') {
    return res.status(503).json({
      success: false,
      message: 'File de sauvegarde saturée, réessayez dans un instant.',
    });
  }

  if (result.reason === 'timeout') {
    return res.status(504).json({
      success: false,
      message: 'Sauvegarde trop longue, réessayez dans un instant.',
    });
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
