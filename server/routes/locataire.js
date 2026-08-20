import { Router } from 'express';
import { authedClient, serviceClient } from '../app.js';
import { gitAutoBackup } from '../utils/gitBackup.js';
import { notify, logementNomOf } from '../utils/notifications.js';
import { TYPE_MOYEN_LABELS } from '../utils/paiementMethodes.js';
import { formatMois } from '../utils/mois.js';

const router = Router();

// Références déclarées par le locataire : simples indications, jamais
// une preuve automatique de paiement (MIM ne vérifie pas les comptes).
const REF_MAX_LENGTH = 80;

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
    gitAutoBackup(`Sauvegarde auto : incident signalé par le locataire ${uid}`);

    res.status(201).json({ success: true, data, message: 'Incident signalé avec succès.' });
  } catch (err) {
    console.error('[locataire/incidents]', err.message);
    res.status(500).json({ success: false, message: 'Une erreur est survenue.' });
  }
});

// ============================================================
// Confirmation d'un paiement par le locataire.
//
// Flux « déclaration + validation propriétaire » : le locataire paie
// directement le propriétaire (hors MIM), déclare son paiement et le
// confirme ici (« en_validation ») ; le propriétaire réalise la
// validation métier. Le flux PayDunya (paiement en ligne MIM) passe
// directement à « paye » via l'IPN et n'utilise pas cette route.
// La fiche locataire est DÉDUITE de account_uid : on ne fait jamais
// confiance à un id envoyé par le frontend, et un locataire ne peut
// confirmer qu'un paiement rattaché à SA fiche. La mise à jour est
// conditionnelle (statut attendu) : anti-double-clic.
// ============================================================
router.post('/paiements/:id/confirmer', async (req, res) => {
  const uid = req.user.id;
  const admin = serviceClient();

  try {
    const { data: locataire, error: locError } = await admin
      .from('locataires')
      .select('id, nom')
      .eq('account_uid', uid)
      .maybeSingle();

    if (locError) {
      console.error('[locataire/confirmer]', locError.message);
      return res.status(500).json({ success: false, message: 'Erreur lors de la confirmation.' });
    }

    if (!locataire) {
      return res.status(403).json({ success: false, message: 'Votre compte n\'est pas lié à une fiche locataire.' });
    }

    const { data: paiement } = await admin
      .from('paiements')
      .select('id, user_id, locataire_id, montant, mois, statut, reference')
      .eq('id', req.params.id)
      .eq('locataire_id', locataire.id)
      .maybeSingle();

    if (!paiement) {
      return res.status(404).json({ success: false, message: 'Paiement introuvable.' });
    }

    if (paiement.statut !== 'a_confirmer') {
      const message =
        paiement.statut === 'en_validation'
          ? 'Paiement déjà confirmé : il attend la validation du propriétaire.'
          : paiement.statut === 'paye'
            ? 'Ce paiement est déjà validé.'
            : 'Ce paiement n\'attend pas de confirmation.';
      return res.status(400).json({ success: false, message });
    }

    // Mise à jour conditionnelle : une seule confirmation gagne en cas de course.
    const { data: updated, error } = await admin
      .from('paiements')
      .update({ statut: 'en_validation' })
      .eq('id', paiement.id)
      .eq('statut', 'a_confirmer')
      .select()
      .maybeSingle();

    if (error) {
      console.error('[locataire/confirmer] update :', error.message);
      return res.status(500).json({ success: false, message: 'Impossible de confirmer le paiement.' });
    }

    if (!updated) {
      return res.status(409).json({ success: false, message: 'Ce paiement a déjà été traité.' });
    }

    await notify(
      paiement.user_id,
      'paiement',
      `Le locataire ${locataire.nom || '—'} confirme son paiement de ${Number(paiement.montant).toLocaleString('fr-FR')} FCFA pour ${paiement.mois}. À valider.`
    );
    gitAutoBackup(`Sauvegarde auto : confirmation de paiement par le locataire ${uid}`);

    res.json({ success: true, data: updated, message: 'Paiement confirmé : il attend la validation du propriétaire.' });
  } catch (err) {
    console.error('[locataire/confirmer]', err.message);
    res.status(500).json({ success: false, message: 'Une erreur est survenue.' });
  }
});

// ============================================================
// Déclaration d'un paiement par le locataire (« J'ai effectué le
// paiement »). Le locataire a payé DIRECTEMENT son propriétaire
// (hors MIM, avec le moyen configuré par celui-ci) puis revient
// déclarer. MIM n'encaisse rien et ne prétend jamais connaître
// l'heure réelle du transfert : seule validation_requested_at
// (heure de la DÉCLARATION, NOW() côté serveur) est enregistrée.
//
// Sécurité :
//   - la fiche locataire est déduite de account_uid ;
//   - le moyen de paiement est vérifié : il doit appartenir au
//     propriétaire du paiement ET être actif ;
//   - montant / mois / propriétaire relus en base (jamais le client) ;
//   - une seule déclaration active possible (mise à jour conditionnelle).
// ============================================================
router.post('/paiements/:id/declarer', async (req, res) => {
  const uid = req.user.id;
  const admin = serviceClient();

  try {
    const { moyen_paiement_id, reference } = req.body || {};

    if (!moyen_paiement_id) {
      return res.status(400).json({ success: false, message: 'Choisissez votre moyen de paiement.' });
    }
    if (reference != null && (typeof reference !== 'string' || reference.length > REF_MAX_LENGTH)) {
      return res.status(400).json({ success: false, message: 'Référence invalide (80 caractères max).' });
    }

    const { data: locataire, error: locError } = await admin
      .from('locataires')
      .select('id, nom')
      .eq('account_uid', uid)
      .maybeSingle();

    if (locError) {
      console.error('[locataire/declarer]', locError.message);
      return res.status(500).json({ success: false, message: 'Erreur lors de la déclaration.' });
    }
    if (!locataire) {
      return res.status(403).json({ success: false, message: 'Votre compte n\'est pas lié à une fiche locataire.' });
    }

    // Paiement relu en base, rattaché à SA fiche : un locataire ne peut
    // jamais déclarer le paiement d'un autre locataire.
    const { data: paiement } = await admin
      .from('paiements')
      .select('id, user_id, locataire_id, logement_id, montant, mois, statut, validation_requested_at')
      .eq('id', req.params.id)
      .eq('locataire_id', locataire.id)
      .maybeSingle();

    if (!paiement) {
      return res.status(404).json({ success: false, message: 'Paiement introuvable.' });
    }
    if (!['attente', 'retard', 'refuse'].includes(paiement.statut)) {
      const message =
        paiement.statut === 'en_validation'
          ? 'Votre paiement est déjà déclaré : il attend la validation du propriétaire.'
          : paiement.statut === 'paye'
            ? 'Ce paiement est déjà validé.'
            : 'Ce paiement ne peut pas être déclaré.';
      return res.status(400).json({ success: false, message });
    }

    // Moyen de paiement : doit appartenir au propriétaire du paiement
    // et être actif (jamais un id arbitraire).
    const { data: moyen } = await admin
      .from('moyens_paiement')
      .select('id, type, nom_titulaire, numero')
      .eq('id', moyen_paiement_id)
      .eq('user_id', paiement.user_id)
      .eq('actif', true)
      .maybeSingle();

    if (!moyen) {
      return res.status(404).json({ success: false, message: 'Moyen de paiement introuvable ou inactif.' });
    }

    // Mise à jour conditionnelle : une seule déclaration gagne en cas
    // de double clic / double requête simultanée.
    const { data: updated, error } = await admin
      .from('paiements')
      .update({
        statut: 'en_validation',
        validation_requested_at: new Date().toISOString(),
        methode_paiement: moyen.type,
        reference: reference ? String(reference).trim() : null,
      })
      .eq('id', paiement.id)
      .in('statut', ['attente', 'retard', 'refuse'])
      .select()
      .maybeSingle();

    if (error) {
      console.error('[locataire/declarer] update :', error.message);
      return res.status(500).json({ success: false, message: 'Impossible d\'enregistrer la déclaration.' });
    }
    if (!updated) {
      return res.status(409).json({ success: false, message: 'Ce paiement a déjà été déclaré.' });
    }

    // Notification au propriétaire : « demande de validation reçue ».
    // MIM n'affirme jamais que le paiement a été reçu.
    const logementNom = await logementNomOf(paiement.logement_id);
    await notify(
      paiement.user_id,
      'paiement',
      `Confirmation de paiement reçue — ${locataire.nom || 'Locataire'} · ${logementNom || 'Logement'} · ` +
        `${Number(paiement.montant).toLocaleString('fr-FR')} FCFA · ${TYPE_MOYEN_LABELS[moyen.type] || moyen.type}. ` +
        'Demande de validation reçue — veuillez vérifier la réception sur votre compte avant de valider.'
    );
    gitAutoBackup(`Sauvegarde auto : déclaration de paiement par le locataire ${uid}`);

    res.json({
      success: true,
      data: updated,
      message: 'Déclaration enregistrée : elle attend la validation de votre propriétaire.',
    });
  } catch (err) {
    console.error('[locataire/declarer]', err.message);
    res.status(500).json({ success: false, message: 'Une erreur est survenue.' });
  }
});

// ============================================================
// Moyens de paiement ACTIFS du propriétaire du logement du
// locataire (lecture seule). Le propriétaire est déduit de la
// fiche locataire : jamais fourni par le client.
// ============================================================
router.get('/moyens-paiement', async (req, res) => {
  const uid = req.user.id;
  const admin = serviceClient();

  try {
    const { data: locataire } = await admin
      .from('locataires')
      .select('id')
      .eq('account_uid', uid)
      .maybeSingle();

    if (!locataire) {
      return res.json({ success: true, data: [], moyens: [], message: 'Compte non lié à une fiche locataire.' });
    }

    // Propriétaire déduit : user_id du paiement le plus récent du
    // locataire (ou du logement). Un locataire ne choisit jamais le
    // propriétaire.
    const { data: paiement } = await admin
      .from('paiements')
      .select('user_id')
      .eq('locataire_id', locataire.id)
      .order('mois', { ascending: false })
      .limit(1)
      .maybeSingle();
    const ownerId = paiement?.user_id;

    if (!ownerId) {
      return res.json({ success: true, data: [], moyens: [] });
    }

    const { data: moyens = [], error } = await admin
      .from('moyens_paiement')
      .select('*')
      .eq('user_id', ownerId)
      .eq('actif', true)
      .order('type', { ascending: true });

    if (error) {
      console.error('[locataire/moyens-paiement]', error.message);
      return res.status(500).json({ success: false, message: 'Erreur lors du chargement.' });
    }

    res.json({ success: true, data: moyens, moyens });
  } catch (err) {
    console.error('[locataire/moyens-paiement]', err.message);
    res.status(500).json({ success: false, message: 'Erreur lors du chargement.' });
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

    if (paiementStatut === 'a_confirmer') {
      computedNotifications.push({
        type: 'paiement',
        message: `Votre paiement de ${formatMois(dernier.mois)} a été reçu : confirmez-le depuis votre espace.`,
        niveau: 'warning',
        date: dernier.date_paiement || null,
        created_at: dernier.date_paiement || null,
      });
    }

    if (paiementStatut === 'en_validation') {
      computedNotifications.push({
        type: 'paiement',
        message: `Votre paiement de ${formatMois(dernier.mois)} est confirmé : il attend la validation du propriétaire.`,
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

    const { data: profile } = await sb
      .from('profiles')
      .select('avatar_url')
      .eq('id', uid)
      .maybeSingle();

    res.json({
      success: true,
      linked: true,
      locataire: { ...locataire, avatar_url: profile?.avatar_url || null },
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
