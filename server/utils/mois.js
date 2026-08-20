// ============================================================
// MIM - Utilitaires de mois (formatage "janv. 2026")
// ============================================================

export const MOIS_FR = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

export function formatMois(mois) {
  if (!mois) return '';
  const [y, m] = String(mois).split('-');
  return `${MOIS_FR[Number(m) - 1] || ''} ${y}`.trim();
}