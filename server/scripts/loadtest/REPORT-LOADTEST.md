# RAPPORT LOADTEST — MIM 100 propriétaires × 100 locataires (10 000)

Généré : 2026-08-13T14:38:18.428Z

## Synthèse

- **Total vérifications : 166**
- ✅ PASS : **129**
- ❌ FAIL : **17**
- ⛔ BLOCKED/NOTE : **20**

## Résultats par phase

| Phase | PASS | FAIL | BLOCKED |
|---|---|---|---|
| P5-auth | 0 | 0 | 1 |
| owner002 | 8 | 1 | 0 |
| owner001 | 8 | 1 | 0 |
| owner003 | 8 | 1 | 0 |
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
| P20-db | 34 | 9 | 0 |
| P18-frontend | 9 | 5 | 0 |

## Échecs (bugs candidats)

| ID | Phase | Test | Détail |
|---|---|---|---|
| BUG-01 | owner002 | cycle CRUD | @supabase/auth-js: Expected parameter to be UUID but is not |
| BUG-02 | owner001 | cycle CRUD | @supabase/auth-js: Expected parameter to be UUID but is not |
| BUG-03 | owner003 | cycle CRUD | @supabase/auth-js: Expected parameter to be UUID but is not |
| BUG-04 | — | loadtest locataires = 10000 | reçu 9 |
| BUG-05 | — | loadtest logements = 10000 | reçu 12 |
| BUG-06 | — | loadtest paiements = 10000 | reçu 9 |
| BUG-07 | — | loadtest biens = 100 | reçu 6 |
| BUG-08 | — | loadtest incidents = 200 | reçu 6 |
| BUG-09 | — | loadtest prestataires = 100 | reçu 3 |
| BUG-10 | — | loadtest interventions = 100 | reçu 3 |
| BUG-11 | — | loadtest notifications (prévu ≥ 30 000) | reçu 20 |
| BUG-12 | — | must_change_password reset sur comptes testés | reçu 8 (attendu 9, 0 changés en phase 5) |
| BUG-13 | — | P18 propriétaire 100 logements | total='4' |
| BUG-14 | — | P18 propriétaire 100 occupés | occupés='3' |
| BUG-15 | — | P18 admin propriétaires ≥ 100 | n=10 |
| BUG-16 | — | P18 admin locataires ≥ 10000 | n=11 |
| BUG-17 | — | P18 aucune exception console | Failed to load resource: the server responded with a status of 404 (Not Found) |

## Notes (comportements observés)

- **[P5-auth] échantillon** — aucun locataire trouvé
- **[P8-admin] temps de réponse admin/stats à l'échelle 10k** — 44ms
- **[P8-admin] suspension propriétaire** — owner 50 absent
- **[P9-idor] UUID malformé (/logements/abc)** — reçu 404 null
- **[P16-charge] docker stats AVANT charge** — supabase_db_MIM cpu=0.41% mem=149.2MiB / 3.678GiB
supabase_auth_MIM cpu=0.00% mem=46.07MiB / 3.678GiB
- **[P16-charge] GET /stats/dashboard × 10** — total=321ms {"200":10}
- **[P16-charge] GET /stats/dashboard × 25** — total=489ms {"200":25}
- **[P16-charge] GET /stats/dashboard × 50** — total=1692ms {"200":50}
- **[P16-charge] GET /stats/dashboard × 100** — total=2341ms {"200":100}
- **[P16-charge] GET /stats/dashboard × 200** — total=8958ms {"200":200}
- **[P16-charge] GET /stats/dashboard × 500** — total=26261ms {"200":500}
- **[P16-charge] GET /notifications × 50** — total=264ms {"200":50}
- **[P16-charge] GET /notifications × 200** — total=568ms {"200":200}
- **[P16-charge] 1 connexions locataires simultanées** — total=801ms {"200":1}
- **[P16-charge] docker stats APRÈS charge** — supabase_db_MIM cpu=0.70% mem=164.3MiB / 3.678GiB
supabase_auth_MIM cpu=0.22% mem=44.86MiB / 3.678GiB
- **[P16-charge] burst 350 GET /stats/dashboard sur :3000 (rate limit ON)** — total=20363ms {"200":300,"429":50}
- **[P19-sec] verify-2fa sans session pending** — reçu 401 — Session de vérification expirée.
- **[P19-sec] Set-Cookie mim_token** — mim_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImIzZDk2YzU1LTEzMzItNGQ0Zi05ODBlLWIzNDYyMjJkNDVhMSIsImFjY291bnRfdHlwZSI6InByb3ByaWV0YWlyZSIsInN1cGFiYXNlX3Rva2VuIjoiZXlKaGJHY2lPaUpGVXpJMU5pSXNJbXRwWkNJNkltSTRNVEkyT1dZeExUSXhaRGd0TkdZeVpTMWlOekU1TFdNeU1qUXdZVGcwTUdRNU1DSXNJblI1Y0NJNklrcFhWQ0o5LmV5SnBjM01pT2lKb2RIUndPaTh2TVRJM0xqQXVNQzR4T2pZME16SXhMMkYxZEdndmRqRWlMQ0p6ZFdJaU9pSmlNMlE1Tm1NMU5TMHhNek15TFRSa05HWXRPVGd3WlMxaU16UTJNakl5WkRRMVlURWlMQ0poZFdRaU9pSmhkWFJvWlc1MGFXTmhkR1ZrSWl3aVpYaHdJam94TnpnMk5qTTFORGMzTENKcFlYUWlPakUzT0RZMk16RTROemNzSW1WdFlXbHNJam9pYkc5aFpIUmxjM1F1YjNkdVpYSXVNREF5UUd4dllXUjBaWE4wTG0xcGJTSXNJbkJvYjI1bElqb2lJaXdpWVhCd1gyMWxkR0ZrWVhSaElqcDdJbkJ5YjNacFpHVnlJam9pWlcxaGFXd2lMQ0p3Y205MmFXUmxjbk1pT2xzaVpXMWhhV3dpWFgwc0luVnpaWEpmYldWMFlXUmhkR0VpT25zaVlXTmpiM1Z1ZEY5MGVYQmxJam9pY0hKdmNISnBaWFJoYVhKbElpd2laVzFoYVd4ZmRtVnlhV1pwWldRaU9uUnlkV1VzSW01aGJXVWlPaUpNYjJGa1ZHVnpkQ0JQZDI1bGNpQXdNRElpTENKeWIyeGxJam9pY0hKdmNISnBaWFJoYVhKbEluMHNJbkp2YkdVaU9pSmhkWFJvWlc1MGFXTmhkR1ZrSWl3aVlXRnNJam9pWVdGc01TSXNJbUZ0Y2lJNlczc2liV1YwYUc5a0lqb2ljR0Z6YzNkdmNtUWlMQ0owYVcxbGMzUmhiWEFpT2pFM09EWTJNekU0TnpkOVhTd2ljMlZ6YzJsdmJsOXBaQ0k2SW1WbE1qQXdNRE00TFRFMU5XSXROR1prTnkxaFpqaG1MV0pqWkdFMU1HVTNNRGxrTUNJc0ltbHpYMkZ1YjI1NWJXOTFjeUk2Wm1Gc2MyVjkubThkWGxRYlV5WVlMX0RYdjZNVThScUhPMld3c1E0ank4Q0ZVTXRjYThaMWZ3TXlIRjc3Vzd5V1Z6c0JQc3hnU1V0Mm1rUU9RdDhuYzZfeXNKWG1FWmciLCJyZWZyZXNoX3Rva2VuIjoiZWo3NnB4YmZ6bXhxIiwic3VwYWJhc2VfZXhwaXJlc19hdCI6MTc4NjYzNTQ3NywiaWF0IjoxNzg2NjMxODc3LCJleHAiOjE3ODcyMzY2Nzd9.ldswT3LHJH51GbVssbhB6ViEMFf-kIMD0BRyWL_6JQA; Max-Age=604800; Path=/; Expires=Thu, 20 Aug 2026 14:37:57 GMT; HttpOnly; SameSite=Lax
- **[P19-sec] forgot password (SMTP local)** — reçu 200 — Si cette adresse est enregistrée, un lien de réinitialisation a été envoyé.
- **[P19-sec] champs hors-schéma sur /biens** — reçu 201 — données: {"id":218,"user_id":"139faa29-37d2-4cdd-a831-c9e76e20f9bd","nom":"Extra Field","type":"maison","adresse":null,"ville":null,"pays":null,"description":n

## Mesures de performance

- **[P8-admin] temps de réponse admin/stats à l'échelle 10k** — 44ms
- **[P16-charge] docker stats AVANT charge** — supabase_db_MIM cpu=0.41% mem=149.2MiB / 3.678GiB
supabase_auth_MIM cpu=0.00% mem=46.07MiB / 3.678GiB
- **[P16-charge] GET /stats/dashboard × 10** — total=321ms {"200":10}
- **[P16-charge] GET /stats/dashboard × 25** — total=489ms {"200":25}
- **[P16-charge] GET /stats/dashboard × 50** — total=1692ms {"200":50}
- **[P16-charge] GET /stats/dashboard × 100** — total=2341ms {"200":100}
- **[P16-charge] GET /stats/dashboard × 200** — total=8958ms {"200":200}
- **[P16-charge] GET /stats/dashboard × 500** — total=26261ms {"200":500}
- **[P16-charge] GET /notifications × 50** — total=264ms {"200":50}
- **[P16-charge] GET /notifications × 200** — total=568ms {"200":200}
- **[P16-charge] 1 connexions locataires simultanées** — total=801ms {"200":1}
- **[P16-charge] docker stats APRÈS charge** — supabase_db_MIM cpu=0.70% mem=164.3MiB / 3.678GiB
supabase_auth_MIM cpu=0.22% mem=44.86MiB / 3.678GiB
- **[P16-charge] burst 350 GET /stats/dashboard sur :3000 (rate limit ON)** — total=20363ms {"200":300,"429":50}
