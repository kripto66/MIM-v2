import { Router } from 'express';
import { authedClient } from '../server.js';

const router = Router();

const MOIS_FR = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

function formatMois(mois) {
  if (!mois) return '';
  const [y, m] = String(mois).split('-');
  return `${MOIS_FR[Number(m) - 1] || ''} ${y}`.trim();
}

function lastMonthPayment(paiements) {
  const sorted = [...(paiements || [])].sort((a, b) =>
    String(b.mois || '').localeCompare(String(a.mois || ''))
  );
  return sorted[0] || null;
}

router.get('/dashboard', async (req, res) => {
  const uid = req.user.id;
  const sb = authedClient(req.user.supabase_token);

  try {
    const { data: locataire, error: locError } = await sb
      .from('locataires')
      .select('*')
      .eq('account_uid', uid)
      .maybeSingle();

    if (locError) {
      console.error('[locataire/dashboard]', locError.message);
      return res.status(500).json({ success: false, message: 'Erreur lors du chargement.' });
    }

    if (!locataire) {
      return res.json({
        success: true,
        linked: false,
        message: 'Votre compte est créé. Contactez votre propriétaire pour être rattaché à une fiche locataire (même adresse email).',
        locataire: null,
        logement: null,
        bien: null,
        paiements: [],
        incidents: [],
        notifications: [],
        stats: null,
      });
    }

    const logementId = locataire.logement_id;

    let logement = null;
    let bien = null;

    if (logementId) {
      const { data: l, error: lErr } = await sb
        .from('logements')
        .select('*')
        .eq('id', logementId)
        .maybeSingle();

      if (!lErr && l) logement = l;

      if (logement?.bien_id) {
        const { data: b, error: bErr } = await sb
          .from('biens')
          .select('*')
          .eq('id', logement.bien_id)
          .maybeSingle();

        if (!bErr && b) bien = b;
      }
    }

    const { data: paiements = [], error: pErr } = await sb
      .from('paiements')
      .select('*')
      .eq('locataire_id', locataire.id)
      .order('mois', { ascending: false });

    if (pErr) console.warn('[locataire/dashboard] paiements :', pErr.message);

    const { data: incidents = [], error: iErr } = await sb
      .from('incidents')
      .select('*')
      .eq('logement_id', logementId)
      .order('created_at', { ascending: false });

    if (iErr) console.warn('[locataire/dashboard] incidents :', iErr.message);

    const dernier = lastMonthPayment(paiements);
    const paiementStatut = dernier?.statut || null;
    const incidentsOuverts = incidents.filter((i) => i.statut !== 'resolu').length;

    const notifications = [];

    if (paiementStatut === 'retard') {
      notifications.push({
        type: 'paiement',
        message: `Votre loyer de ${formatMois(dernier.mois)} est en retard.`,
        niveau: 'danger',
        date: dernier.date_paiement || null,
      });
    }

    if (paiementStatut === 'attente') {
      notifications.push({
        type: 'paiement',
        message: `Votre loyer de ${formatMois(dernier.mois)} est en attente de règlement.`,
        niveau: 'warning',
        date: dernier.date_paiement || null,
      });
    }

    if (incidentsOuverts > 0) {
      notifications.push({
        type: 'incident',
        message: `${incidentsOuverts} incident(s) en cours sur votre logement.`,
        niveau: 'warning',
        date: incidents[0]?.created_at || null,
      });
    }

    if (!notifications.length) {
      notifications.push({
        type: 'info',
        message: 'Aucune information importante pour le moment.',
        niveau: 'success',
        date: null,
      });
    }

    res.json({
      success: true,
      linked: true,
      locataire,
      logement,
      bien,
      paiements,
      incidents,
      notifications,
      stats: {
        loyer: logement?.loyer_mensuel != null ? Number(logement.loyer_mensuel) : null,
        paiementStatut,
        dernierMois: dernier?.mois || null,
        incidentsOuverts,
      },
    });
  } catch (err) {
    console.error('[locataire/dashboard]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement.' });
  }
});

export default router;
