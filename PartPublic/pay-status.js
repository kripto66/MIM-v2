// ============================================================
// MIM - Suivi de paiement PayDunya (partagé)
//
// Utilisé par les pages de retour PayDunya (/paiement-succes,
// /paiement-annule) : lit le token dans l'URL, interroge
// GET /api/paydunya/status/:token (cookie de session MIM requis —
// l'appelant est forcément l'initiateur du paiement) et sonde
// jusqu'à confirmation.
//
// La consultation applique côté serveur la même réconciliation que
// l'IPN : même si la notification PayDunya a été perdue, le simple
// fait d'afficher cette page finalise le paiement (self-healing).
// ============================================================

function payStatusApiBase() {
  const origin = window.location.origin || 'http://localhost:3000';
  const isLocal = origin.includes('localhost') || origin.includes('127.0.0.1');
  return (isLocal ? 'http://localhost:3000' : origin) + '/api';
}

// Une lecture du statut. Lève une erreur si la session est inaccessible.
async function fetchPaydunyaStatus(token) {
  const res = await fetch(`${payStatusApiBase()}/paydunya/status/${encodeURIComponent(token)}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.success) {
    throw new Error(body?.message || 'Statut de paiement indisponible.');
  }
  return body.data;
}

// Sonde le statut jusqu'à un état final (completed / cancelled / failed)
// ou épuisement des tentatives (retour null = « vérification encore en
// cours côté PayDunya »). onUpdate(invoice) est appelé à chaque lecture.
async function pollPaydunyaStatus(token, { intervalMs = 4000, maxAttempts = 45, onUpdate = null } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const invoice = await fetchPaydunyaStatus(token);
      if (typeof onUpdate === 'function') onUpdate(invoice);
      if (['completed', 'cancelled', 'failed'].includes(invoice.status)) {
        return invoice;
      }
    } catch {
      /* session momentanément illisible : on retente */
    }
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

function payStatusTokenFromUrl() {
  return new URLSearchParams(window.location.search).get('token') || '';
}

function payStatusFormatFcfa(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? `${n.toLocaleString('fr-FR')} FCFA` : '';
}

// Lien de retour vers l'espace correspondant au rôle connecté.
async function payStatusHomeLink() {
  try {
    const res = await fetch(`${payStatusApiBase()}/auth/me`, { credentials: 'include' });
    const body = await res.json().catch(() => null);
    const type = body?.user?.account_type;
    if (type === 'locataire') return '/PartLocataires/LocaDash.html';
    if (type === 'employe') return '/PartEmployes/employe.html';
    if (type === 'admin') return '/PartAdmin/admin.html';
    if (['proprietaire', 'agence', 'entreprise'].includes(type)) return '/PartProprietaires/dashboard.html';
  } catch {
    /* non connecté : accueil public */
  }
  return '/index.html';
}
