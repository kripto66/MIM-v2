# RAPPORT LOADTEST — MIM 100 propriétaires × 100 locataires (10 000)

Généré : 2026-08-13T14:44:16.801Z

## Synthèse

- **Total vérifications : 169**
- ✅ PASS : **138**
- ❌ FAIL : **11**
- ⛔ BLOCKED/NOTE : **20**

## Résultats par phase

| Phase | PASS | FAIL | BLOCKED |
|---|---|---|---|
| P5-auth | 0 | 0 | 1 |
| owner001 | 10 | 0 | 0 |
| owner002 | 10 | 0 | 0 |
| owner003 | 10 | 0 | 0 |
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
| P18-frontend | 11 | 3 | 0 |

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
| BUG-09 | — | P18 admin propriétaires ≥ [object Object],[object Object],[object Object]7 | n=10 |
| BUG-10 | — | P18 admin locataires ≥ NaN | n=11 |
| BUG-11 | — | P18 aucune exception console | Failed to load resource: the server responded with a status of 404 (Not Found) |

## Notes (comportements observés)

- **[P5-auth] échantillon** — aucun locataire trouvé
- **[P8-admin] temps de réponse admin/stats à l'échelle 10k** — 53ms
- **[P8-admin] suspension propriétaire** — owner 50 absent
- **[P9-idor] UUID malformé (/logements/abc)** — reçu 404 null
- **[P16-charge] docker stats AVANT charge** — supabase_db_MIM cpu=0.26% mem=161.8MiB / 3.678GiB
supabase_auth_MIM cpu=0.03% mem=45.08MiB / 3.678GiB
- **[P16-charge] GET /stats/dashboard × 10** — total=169ms {"200":10}
- **[P16-charge] GET /stats/dashboard × 25** — total=334ms {"200":25}
- **[P16-charge] GET /stats/dashboard × 50** — total=1511ms {"200":50}
- **[P16-charge] GET /stats/dashboard × 100** — total=2020ms {"200":100}
- **[P16-charge] GET /stats/dashboard × 200** — total=5144ms {"200":200}
- **[P16-charge] GET /stats/dashboard × 500** — total=16730ms {"200":500}
- **[P16-charge] GET /notifications × 50** — total=193ms {"200":50}
- **[P16-charge] GET /notifications × 200** — total=651ms {"200":200}
- **[P16-charge] 1 connexions locataires simultanées** — total=722ms {"200":1}
- **[P16-charge] docker stats APRÈS charge** — supabase_db_MIM cpu=0.23% mem=168.9MiB / 3.678GiB
supabase_auth_MIM cpu=0.00% mem=45.01MiB / 3.678GiB
- **[P16-charge] burst 350 GET /stats/dashboard sur :3000 (rate limit ON)** — total=14664ms {"200":300,"429":50}
- **[P19-sec] verify-2fa sans session pending** — reçu 401 — Session de vérification expirée.
- **[P19-sec] Set-Cookie mim_token** — mim_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImM3ZjE3NDhiLTlmOTItNDJiMy1hNmZkLTY3NzVkZGU3ZjRiOSIsImFjY291bnRfdHlwZSI6InByb3ByaWV0YWlyZSIsInN1cGFiYXNlX3Rva2VuIjoiZXlKaGJHY2lPaUpGVXpJMU5pSXNJbXRwWkNJNkltSTRNVEkyT1dZeExUSXhaRGd0TkdZeVpTMWlOekU1TFdNeU1qUXdZVGcwTUdRNU1DSXNJblI1Y0NJNklrcFhWQ0o5LmV5SnBjM01pT2lKb2RIUndPaTh2TVRJM0xqQXVNQzR4T2pZME16SXhMMkYxZEdndmRqRWlMQ0p6ZFdJaU9pSmpOMll4TnpRNFlpMDVaamt5TFRReVlqTXRZVFptWkMwMk56YzFaR1JsTjJZMFlqa2lMQ0poZFdRaU9pSmhkWFJvWlc1MGFXTmhkR1ZrSWl3aVpYaHdJam94TnpnMk5qTTFPRE00TENKcFlYUWlPakUzT0RZMk16SXlNemdzSW1WdFlXbHNJam9pYkc5aFpIUmxjM1F1YjNkdVpYSXVNREF5UUd4dllXUjBaWE4wTG0xcGJTSXNJbkJvYjI1bElqb2lJaXdpWVhCd1gyMWxkR0ZrWVhSaElqcDdJbkJ5YjNacFpHVnlJam9pWlcxaGFXd2lMQ0p3Y205MmFXUmxjbk1pT2xzaVpXMWhhV3dpWFgwc0luVnpaWEpmYldWMFlXUmhkR0VpT25zaVlXTmpiM1Z1ZEY5MGVYQmxJam9pY0hKdmNISnBaWFJoYVhKbElpd2laVzFoYVd4ZmRtVnlhV1pwWldRaU9uUnlkV1VzSW01aGJXVWlPaUpNYjJGa1ZHVnpkQ0JQZDI1bGNpQXdNRElpTENKeWIyeGxJam9pY0hKdmNISnBaWFJoYVhKbEluMHNJbkp2YkdVaU9pSmhkWFJvWlc1MGFXTmhkR1ZrSWl3aVlXRnNJam9pWVdGc01TSXNJbUZ0Y2lJNlczc2liV1YwYUc5a0lqb2ljR0Z6YzNkdmNtUWlMQ0owYVcxbGMzUmhiWEFpT2pFM09EWTJNekl5TXpoOVhTd2ljMlZ6YzJsdmJsOXBaQ0k2SWpCaVpqZ3laVEV6TFRjek5UY3ROREUxTWkxaU1tSXhMVGcwT0RZd01HTXhabUV6TnlJc0ltbHpYMkZ1YjI1NWJXOTFjeUk2Wm1Gc2MyVjkudEhzNkJKSWRIaW02QkZyY2E1T1JfLVBlbndvSXloWUNCLTgwMkFLcEp0Rkx6U05pMFRIMFhLTnJ4Rkl1UkExTFNiM3RkWlFGS0x2WkVtcVlPbGg4LUEiLCJyZWZyZXNoX3Rva2VuIjoiYmZuenJxNDRtbzVmIiwic3VwYWJhc2VfZXhwaXJlc19hdCI6MTc4NjYzNTgzOCwiaWF0IjoxNzg2NjMyMjM4LCJleHAiOjE3ODcyMzcwMzh9.9bPpZn6Slw7MwYs30a7bhhNUmPhUwxLAqU0B6P8B1EQ; Max-Age=604800; Path=/; Expires=Thu, 20 Aug 2026 14:43:58 GMT; HttpOnly; SameSite=Lax
- **[P19-sec] forgot password (SMTP local)** — reçu 200 — Si cette adresse est enregistrée, un lien de réinitialisation a été envoyé.
- **[P19-sec] champs hors-schéma sur /biens** — reçu 201 — données: {"id":225,"user_id":"389df9be-71cc-41aa-b8b5-c7d0fd57ed46","nom":"Extra Field","type":"maison","adresse":null,"ville":null,"pays":null,"description":n

## Mesures de performance

- **[P8-admin] temps de réponse admin/stats à l'échelle 10k** — 53ms
- **[P16-charge] docker stats AVANT charge** — supabase_db_MIM cpu=0.26% mem=161.8MiB / 3.678GiB
supabase_auth_MIM cpu=0.03% mem=45.08MiB / 3.678GiB
- **[P16-charge] GET /stats/dashboard × 10** — total=169ms {"200":10}
- **[P16-charge] GET /stats/dashboard × 25** — total=334ms {"200":25}
- **[P16-charge] GET /stats/dashboard × 50** — total=1511ms {"200":50}
- **[P16-charge] GET /stats/dashboard × 100** — total=2020ms {"200":100}
- **[P16-charge] GET /stats/dashboard × 200** — total=5144ms {"200":200}
- **[P16-charge] GET /stats/dashboard × 500** — total=16730ms {"200":500}
- **[P16-charge] GET /notifications × 50** — total=193ms {"200":50}
- **[P16-charge] GET /notifications × 200** — total=651ms {"200":200}
- **[P16-charge] 1 connexions locataires simultanées** — total=722ms {"200":1}
- **[P16-charge] docker stats APRÈS charge** — supabase_db_MIM cpu=0.23% mem=168.9MiB / 3.678GiB
supabase_auth_MIM cpu=0.00% mem=45.01MiB / 3.678GiB
- **[P16-charge] burst 350 GET /stats/dashboard sur :3000 (rate limit ON)** — total=14664ms {"200":300,"429":50}
