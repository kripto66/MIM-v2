import { Router } from 'express';
import { authedClient, serviceClient } from '../app.js';
import { gitAutoBackup } from '../utils/gitBackup.js';
import { notify, logementNomOf } from '../utils/notifications.js';

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

// ============================================================
// Signalement d'un incident par le locataire.
// Le logement est DÉDUIT de la fiche locataire (account_uid) :
// on ne fait jamais confiance à l'id envoyé par le frontend.
// ============================================================
router.post('/incidents', async (req, res) => {
  const uid = req.user.id;
  const admin = serviceClient();

  try {
    const { data: locataire, error: locError } = await admin
      .from('locataires')
      .select('id, logement_id')
      .eq('account_uid', uid)
      .maybeSingle();

    if (locError) {
      console.error('[locataire/incidents]', locError.message);
      return res.status(500).json({ success: false, message: 'Erreur lors du signalement.' });
    }

    if (!locataire || !locataire.logement_id) {
      return res.status(400).json({ success: false, message: 'Votre compte n\'est pas lié à un logement. Contactez votre propriétaire.' });
    }

    const titre = String(req.body?.titre || '').trim();
    const description = String(req.body?.description || '').trim();
    const photo = req.body?.photo || null;

    if (!titre) {
      return res.status(400).json({ success: false, message: 'Le titre est obligatoire.', errors: { titre: 'Le titre est obligatoire.' } });
    }

    if (titre.length > 120) {
      return res.status(400).json({ success: false, message: 'Le titre est trop long (120 caractères maximum).', errors: { titre: 'Le titre est trop long (120 caractères maximum).' } });
    }

    if (photo) {
      if (!/^data:image\/[a-zA-Z]+;base64,/.test(photo)) {
        return res.status(400).json({ success: false, message: 'Format de photo invalide.', errors: { photo: 'Format de photo invalide.' } });
      }
      if (photo.length > 2500000) {
        return res.status(400).json({ success: false, message: 'La photo est trop lourde (maximum 2,5 Mo).', errors: { photo: 'La photo est trop lourde (maximum 2,5 Mo).' } });
      }
    }

    const logementId = locataire.logement_id;

    const { data: logement } = await admin
      .from('logements')
      .select('id, user_id')
      .eq('id', logementId)
      .maybeSingle();

    if (!logement) {
      return res.status(400).json({ success: false, message: 'Logement introuvable.' });
    }

    const { data, error } = await admin
      .from('incidents')
      .insert({
        user_id: logement.user_id,
        logement_id: logementId,
        titre,
        description: description || null,
        photo: photo || null,
        statut: 'nouveau',
      })
      .select()
      .single();

    if (error) {
      console.error('[locataire/incidents] insert :', error.message);
      return res.status(500).json({ success: false, message: 'Impossible d\'enregistrer l\'incident.' });
    }

    const nom = await logementNomOf(logementId);
    await notify(logement.user_id, 'incident', `Nouvel incident signalé par le locataire${nom ? ` (${nom})` : ''} : ${titre}.`);
    await gitAutoBackup(`Sauvegarde auto : incident signalé par le locataire ${uid}`);

    res.status(201).json({ success: true, data, message: 'Incident signalé avec succès.' });
  } catch (err) {
    console.error('[locataire/incidents]', err.message);
    res.status(500).json({ success: false, message: 'Une erreur est survenue.' });
  }
});

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
        message: 'Votre compte est créé. Contactez votre propriétaire pour être rattaché à une fiche locataire.',
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

    let incidents = [];
    if (logementId) {
      const { data: incidentsData = [], error: iErr } = await sb
        .from('incidents')
        .select('*')
        .eq('logement_id', logementId)
        .order('created_at', { ascending: false });

      if (iErr) console.warn('[locataire/dashboard] incidents :', iErr.message);
      incidents = incidentsData || [];
    }

    // Notifications en base (liées au compte) + alertes calculées en temps réel.
    const { data: dbNotifications = [], error: nErr } = await sb
      .from('notifications')
      .select('*')
      .eq('user_id', uid)
      .order('created_at', { ascending: false });

    if (nErr) console.warn('[locataire/dashboard] notifications :', nErr.message);

    const dernier = lastMonthPayment(paiements);
    const paiementStatut = dernier?.statut || null;
    const incidentsOuverts = incidents.filter((i) => i.statut !== 'resolu').length;

    const computedNotifications = [];

    if (paiementStatut === 'retard') {
      computedNotifications.push({
        type: 'paiement',
        message: `Votre loyer de ${formatMois(dernier.mois)} est en retard.`,
        niveau: 'danger',
        date: dernier.date_paiement || null,
        created_at: dernier.date_paiement || null,
      });
    }

    if (paiementStatut === 'attente') {
      computedNotifications.push({
        type: 'paiement',
        message: `Votre loyer de ${formatMois(dernier.mois)} est en attente de règlement.`,
        niveau: 'warning',
        date: dernier.date_paiement || null,
        created_at: dernier.date_paiement || null,
      });
    }

    if (incidentsOuverts > 0) {
      computedNotifications.push({
        type: 'incident',
        message: `${incidentsOuverts} incident(s) en cours sur votre logement.`,
        niveau: 'warning',
        date: incidents[0]?.created_at || null,
        created_at: incidents[0]?.created_at || null,
      });
    }

    const niveauOf = (type) => {
      const t = String(type || '');
      if (t.includes('retard') || t === 'incident' || t === 'paiement') return 'danger';
      if (t === 'intervention') return 'warning';
      return 'info';
    };

    const notifications = [
      ...(dbNotifications || []).map((n) => ({
        id: n.id,
        type: n.type,
        message: n.message,
        niveau: n.niveau || niveauOf(n.type),
        lu: n.lu,
        date: n.created_at,
        created_at: n.created_at,
      })),
      ...computedNotifications,
    ].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

    if (!notifications.length) {
      notifications.push({
        type: 'info',
        message: 'Aucune information importante pour le moment.',
        niveau: 'success',
        date: null,
        created_at: null,
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
