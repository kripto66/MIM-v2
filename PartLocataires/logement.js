
        document.addEventListener("DOMContentLoaded", async () => {
            try {
                const data = await tenantRequest("/locataire/dashboard");

                if (!data.linked) {
                    document.getElementById("unlinkedMessage").style.display = "block";
                    return;
                }

                const l = data.logement;

                if (!l) {
                    showTenantError("Aucun logement associé à votre fiche locataire.");
                    return;
                }

                const b = data.bien;

                setText("detLoyer", fmtFCFA(l.loyer_mensuel));

                const statutEl = document.getElementById("detStatut");
                const map = {
                    libre: ["Libre", "info"],
                    occupe: ["Occupé", "success"],
                    maintenance: ["En maintenance", "warning"],
                };
                const [label, cls] = map[l.statut] || [l.statut, "warning"];
                statutEl.textContent = label;
                statutEl.className = `status ${cls}`;

                setText("detBien", b ? b.nom : "—");
                setText("detType", b ? (b.type || "—") : "—");

                const adresse = [b?.adresse, b?.ville, b?.pays].filter(Boolean).join(", ");
                setText("detAdresse", adresse || "—");
                setText("detEntree", data.locataire.date_entree ? formatDate(data.locataire.date_entree) : "—");

                const desc = l.description || b?.description || "";
                const descEl = document.getElementById("detDescription");
                if (desc) {
                    descEl.textContent = desc;
                    descEl.style.display = "block";
                }
            } catch (err) {
                showTenantError(err.message);
            }
        });
    