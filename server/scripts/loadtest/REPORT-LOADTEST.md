# RAPPORT LOADTEST — MIM 100 propriétaires × 100 locataires (10 000)

Généré : 2026-08-13T17:35:02.608Z

## Synthèse

- **Total vérifications : 165**
- ✅ PASS : **131**
- ❌ FAIL : **14**
- ⛔ BLOCKED/NOTE : **20**

## Résultats par phase

| Phase | PASS | FAIL | BLOCKED |
|---|---|---|---|
| P5-auth | 0 | 0 | 1 |
| owner002 | 10 | 0 | 0 |
| owner003 | 10 | 0 | 0 |
| owner001 | 10 | 0 | 0 |
| P6-listes | 2 | 0 | 0 |
| P8-admin | 15 | 0 | 2 |
| P9-idor | 7 | 0 | 1 |
| P10-occup | 4 | 0 | 0 |
| P12-inc | 4 | 0 | 0 |
| P13-prest | 4 | 0 | 0 |
| P14-notif | 4 | 0 | 0 |
| P16-charge | 10 | 0 | 12 |
| P17-stab | 4 | 0 | 0 |
| P19-sec | 8 | 0 | 4 |
| P20-db | 35 | 8 | 0 |
| P18-frontend | 4 | 6 | 0 |

## Échecs (bugs candidats)

| ID | Phase | Test | Détail |
|---|---|---|---|
| BUG-01 | — | loadtest locataires = 10000 | reçu 9 |
| BUG-02 | — | loadtest logements = 10000 | reçu 9 |
| BUG-03 | — | loadtest paiements = 10000 | reçu 9 |
| BUG-04 | — | loadtest biens = 100 | reçu 3 |
| BUG-05 | — | loadtest prestataires = 100 | reçu 3 |
| BUG-06 | — | loadtest interventions = 100 | reçu 3 |
| BUG-07 | — | loadtest incidents ≥ 200 (202 avec signalements P7 nettoyés) | reçu 6 |
| BUG-08 | — | loadtest notifications (prévu ≥ 30 000) | reçu 20 |
| BUG-09 | — | P18 propriétaire 100 logements | total='3' |
| BUG-10 | — | P18 propriétaire 100 occupés | occupés='3' |
| BUG-11 | — | P18 locataire change-password + LocaDash | URL "change-password" non atteinte (actuelle: http://localhost:3000/PartPublic/connexion.html) |
| BUG-12 | — | P18 admin propriétaires ≥ 107 | n=10 |
| BUG-13 | — | P18 admin locataires ≥ 10000 | n=11 |
| BUG-14 | — | P18 aucune exception console | Failed to load resource: the server responded with a status of 404 (Not Found) / HTTP 401 http://localhost:3000/api/auth/login / Failed to load resource: the server responded with a status of 401 (Una |

## Notes (comportements observés)

- **[P5-auth] échantillon** — aucun locataire trouvé
- **[P8-admin] temps de réponse admin/stats à l'échelle 10k** — 61ms
- **[P8-admin] suspension propriétaire** — owner 50 absent
- **[P9-idor] UUID malformé (/logements/abc)** — reçu 404 null
- **[P16-charge] docker stats AVANT charge** — supabase_db_MIM cpu=0.61% mem=162.6MiB / 3.678GiB
supabase_auth_MIM cpu=0.00% mem=44.78MiB / 3.678GiB
- **[P16-charge] GET /stats/dashboard × 10** — total=143ms {"200":10}
- **[P16-charge] GET /stats/dashboard × 25** — total=333ms {"200":25}
- **[P16-charge] GET /stats/dashboard × 50** — total=804ms {"200":50}
- **[P16-charge] GET /stats/dashboard × 100** — total=1940ms {"200":100}
- **[P16-charge] GET /stats/dashboard × 200** — total=9047ms {"200":200}
- **[P16-charge] GET /stats/dashboard × 500** — total=17218ms {"200":500}
- **[P16-charge] GET /notifications × 50** — total=130ms {"200":50}
- **[P16-charge] GET /notifications × 200** — total=588ms {"200":200}
- **[P16-charge] 1 connexions locataires simultanées** — total=649ms {"200":1}
- **[P16-charge] docker stats APRÈS charge** — supabase_db_MIM cpu=0.30% mem=170.5MiB / 3.678GiB
supabase_auth_MIM cpu=0.00% mem=44.37MiB / 3.678GiB
- **[P16-charge] burst 350 GET /stats/dashboard sur :3000 (rate limit ON)** — total=12679ms {"200":300,"429":50}
- **[P19-sec] verify-2fa sans session pending** — reçu 401 — Session de vérification expirée.
- **[P19-sec] Set-Cookie mim_token** — mim_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY1YWExM2UxLTUwNzctNDk3Yy1iYThiLTFkOTJjY2UyMDVmYSIsImFjY291bnRfdHlwZSI6InByb3ByaWV0YWlyZSIsInN1cGFiYXNlX3Rva2VuIjoiZXlKaGJHY2lPaUpGVXpJMU5pSXNJbXRwWkNJNkltSTRNVEkyT1dZeExUSXhaRGd0TkdZeVpTMWlOekU1TFdNeU1qUXdZVGcwTUdRNU1DSXNJblI1Y0NJNklrcFhWQ0o5LmV5SnBjM01pT2lKb2RIUndPaTh2TVRJM0xqQXVNQzR4T2pZME16SXhMMkYxZEdndmRqRWlMQ0p6ZFdJaU9pSTJOV0ZoTVRObE1TMDFNRGMzTFRRNU4yTXRZbUU0WWkweFpEa3lZMk5sTWpBMVptRWlMQ0poZFdRaU9pSmhkWFJvWlc1MGFXTmhkR1ZrSWl3aVpYaHdJam94TnpnMk5qTTJNREUzTENKcFlYUWlPakUzT0RZMk16STBNVGNzSW1WdFlXbHNJam9pYkc5aFpIUmxjM1F1YjNkdVpYSXVNREF5UUd4dllXUjBaWE4wTG0xcGJTSXNJbkJvYjI1bElqb2lJaXdpWVhCd1gyMWxkR0ZrWVhSaElqcDdJbkJ5YjNacFpHVnlJam9pWlcxaGFXd2lMQ0p3Y205MmFXUmxjbk1pT2xzaVpXMWhhV3dpWFgwc0luVnpaWEpmYldWMFlXUmhkR0VpT25zaVlXTmpiM1Z1ZEY5MGVYQmxJam9pY0hKdmNISnBaWFJoYVhKbElpd2laVzFoYVd4ZmRtVnlhV1pwWldRaU9uUnlkV1VzSW01aGJXVWlPaUpNYjJGa1ZHVnpkQ0JQZDI1bGNpQXdNRElpTENKeWIyeGxJam9pY0hKdmNISnBaWFJoYVhKbEluMHNJbkp2YkdVaU9pSmhkWFJvWlc1MGFXTmhkR1ZrSWl3aVlXRnNJam9pWVdGc01TSXNJbUZ0Y2lJNlczc2liV1YwYUc5a0lqb2ljR0Z6YzNkdmNtUWlMQ0owYVcxbGMzUmhiWEFpT2pFM09EWTJNekkwTVRkOVhTd2ljMlZ6YzJsdmJsOXBaQ0k2SW1KbFpHUmhNVEF5TFdFeE16a3RORGRrWXkwNU9XRXpMV0ZtTjJVNU1URmxOek15T1NJc0ltbHpYMkZ1YjI1NWJXOTFjeUk2Wm1Gc2MyVjkuMWNxY2hfN0Zfc3VmaktyT0RNdE9zUDNENW9hRDIzM0Z1eF9iNTFOSnFBalFDR3BYZm9YcFIweW8ydGdQN2dBay1PbkFuc1Q5b05sOEpEZXc0Nk9KYVEiLCJyZWZyZXNoX3Rva2VuIjoid2s0b2l2b2IycXk2Iiwic3VwYWJhc2VfZXhwaXJlc19hdCI6MTc4NjYzNjAxNywiaWF0IjoxNzg2NjMyNDE3LCJleHAiOjE3ODcyMzcyMTd9.IqjhEBK9R_rh-6Jn-zve0xEvHd34G3bOaRlfeHgfwsk; Max-Age=604800; Path=/; Expires=Thu, 20 Aug 2026 14:46:57 GMT; HttpOnly; SameSite=Lax
- **[P19-sec] forgot password (SMTP local)** — reçu 200 — Si cette adresse est enregistrée, un lien de réinitialisation a été envoyé.
- **[P19-sec] champs hors-schéma sur /biens** — reçu 201 — données: {"id":232,"user_id":"16a28f93-7553-4c8a-be97-f021663eb9ef","nom":"Extra Field","type":"maison","adresse":null,"ville":null,"pays":null,"description":n

## Mesures de performance

- **[P8-admin] temps de réponse admin/stats à l'échelle 10k** — 61ms
- **[P16-charge] docker stats AVANT charge** — supabase_db_MIM cpu=0.61% mem=162.6MiB / 3.678GiB
supabase_auth_MIM cpu=0.00% mem=44.78MiB / 3.678GiB
- **[P16-charge] GET /stats/dashboard × 10** — total=143ms {"200":10}
- **[P16-charge] GET /stats/dashboard × 25** — total=333ms {"200":25}
- **[P16-charge] GET /stats/dashboard × 50** — total=804ms {"200":50}
- **[P16-charge] GET /stats/dashboard × 100** — total=1940ms {"200":100}
- **[P16-charge] GET /stats/dashboard × 200** — total=9047ms {"200":200}
- **[P16-charge] GET /stats/dashboard × 500** — total=17218ms {"200":500}
- **[P16-charge] GET /notifications × 50** — total=130ms {"200":50}
- **[P16-charge] GET /notifications × 200** — total=588ms {"200":200}
- **[P16-charge] 1 connexions locataires simultanées** — total=649ms {"200":1}
- **[P16-charge] docker stats APRÈS charge** — supabase_db_MIM cpu=0.30% mem=170.5MiB / 3.678GiB
supabase_auth_MIM cpu=0.00% mem=44.37MiB / 3.678GiB
- **[P16-charge] burst 350 GET /stats/dashboard sur :3000 (rate limit ON)** — total=12679ms {"200":300,"429":50}
