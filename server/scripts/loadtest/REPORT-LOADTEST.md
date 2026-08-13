# RAPPORT LOADTEST — MIM 100 propriétaires × 100 locataires (10 000)

Généré : 2026-08-13T14:34:39.829Z

## Synthèse

- **Total vérifications : 47**
- ✅ PASS : **33**
- ❌ FAIL : **14**
- ⛔ BLOCKED/NOTE : **0**

## Résultats par phase

| Phase | PASS | FAIL | BLOCKED |
|---|---|---|---|
| P20-db | 33 | 10 | 0 |
| P18-frontend | 0 | 4 | 0 |

## Échecs (bugs candidats)

| ID | Phase | Test | Détail |
|---|---|---|---|
| BUG-01 | — | loadtest locataires = 10000 | reçu 9 |
| BUG-02 | — | loadtest logements = 10000 | reçu 9 |
| BUG-03 | — | loadtest paiements = 10000 | reçu 9 |
| BUG-04 | — | loadtest biens = 100 | reçu 3 |
| BUG-05 | — | loadtest incidents = 200 | reçu 6 |
| BUG-06 | — | loadtest prestataires = 100 | reçu 3 |
| BUG-07 | — | loadtest interventions = 100 | reçu 3 |
| BUG-08 | — | loadtest notifications (prévu ≥ 30 000) | reçu 12 |
| BUG-09 | — | must_change_password reset sur comptes testés | reçu 9 |
| BUG-10 | — | répartition statuts 1/3 environ | paye=3 attente=3 retard=3 |
| BUG-11 | — | P18 propriétaire login+dashboard | URL "dashboard.html" non atteinte (actuelle: http://127.0.0.1:3200/PartPublic/connexion.html) |
| BUG-12 | — | P18 locataire change-password + LocaDash | URL "change-password" non atteinte (actuelle: http://127.0.0.1:3200/PartPublic/connexion.html) |
| BUG-13 | — | P18 admin login+stats | URL "admin.html" non atteinte (actuelle: http://127.0.0.1:3200/PartPublic/connexion.html) |
| BUG-14 | — | P18 aucune exception console | Failed to load resource: the server responded with a status of 404 (Not Found) / Access to fetch at 'http://localhost:3000/api/auth/login' from origin 'http://127.0.0.1:3200' has been blocked by CORS  |
