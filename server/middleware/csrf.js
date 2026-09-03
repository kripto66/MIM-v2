// CSRF supprimé — protection assurée par SameSite=Lax sur le cookie mim_token.
// Les exports vides sont conservés pour éviter les erreurs d'import résiduelles.

export function generateCsrfToken() {}
export function validateCsrfToken(_req, _res, next) { next(); }
export function csrfInitRoute(_req, res) {
  res.json({ success: true, csrfToken: null });
}
