        const PAIEMENT_STATUS = {
            paye: ["Payé", "status-success"],
            attente: ["En attente", "status-warning"],
            retard: ["En retard", "status-danger"],
            a_confirmer: ["À confirmer", "status-info"],
            en_validation: ["En attente de validation", "status-warning"],
            refuse: ["Refusé", "status-danger"],
        };

        const METHODE_LABELS = {
            especes: "Espèces",
            mobile_money: "Mobile Money",
            virement: "Virement bancaire",
            carte: "Carte bancaire",
            wave: "Wave",
            orange_money: "Orange Money",
        };

        let locatairesCache = [];
        let logementsCache = [];
        let refusTargetId = null;

        function currentMonth() {
            const d = new Date();
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        }

        function formatDate(iso) {
            if (!iso) return "";
            return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
        }

        function fmtFCFA(n) {
            return `${Number(n || 0).toLocaleString("fr-FR")} FCFA`;
        }

        // ============================================================
        // Paiements locataires : déclarations à valider
        // ============================================================

        async function loadData() {
            try {
                const [loc, log] = await Promise.all([
                    apiRequest("/locataires"),
                    apiRequest("/logements"),
                ]);
                locatairesCache = loc.data;
                logementsCache = log.data;

                document.getElementById("locataire_id").innerHTML =
                    '<option value="">— Choisir —</option>' + loc.data.map(
                        (t) => `<option value="${t.id}">${escapeHtml(t.nom)}</option>`
                    ).join("");

                document.getElementById("logement_id").innerHTML =
                    '<option value="">— Aucun —</option>' + log.data.map(
                        (l) => `<option value="${l.id}">${escapeHtml(l.nom)}</option>`
                    ).join("");
            } catch (err) {
                console.error(err);
            }
        }

        async function loadPending() {
            const listEl = document.getElementById("pendingList");
            const countEl = document.getElementById("pendingCount");
            try {
                const res = await apiRequest("/paiements-validation/en-attente");
                const items = res.data || [];
                countEl.textContent = String(items.length);

                if (!items.length) {
                    listEl.innerHTML = '<div class="empty-state">Aucune déclaration en attente de validation.</div>';
                    return;
                }

                listEl.innerHTML = items.map((p) => `
                    <div class="crud-card pending-card">
                        <div>
                            <h3>${escapeHtml(p.locataire_nom || "Locataire")}</h3>
                            <p>${escapeHtml(formatMois(p.mois))} — ${escapeHtml(p.logement_nom || "")}</p>
                            <p><span class="status status-warning">En attente de validation</span></p>
                            <p class="pay-methode">${escapeHtml(METHODE_LABELS[p.methode_paiement] || p.methode_paiement || "—")}${p.reference ? ` — réf. déclarée : ${escapeHtml(p.reference)}` : ""}</p>
                        </div>
                        <div class="card-amount">
                            <strong>${fmtFCFA(p.montant)}</strong>
                            <div class="card-actions">
                                <button class="btn btn-pay" data-pvalidate="${p.id}">Valider le paiement</button>
                                <button class="btn btn-delete" data-prefuse="${p.id}">Refuser</button>
                            </div>
                        </div>
                    </div>`).join("");
            } catch (err) {
                listEl.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
            }
        }

        async function handlePendingAction(e) {
            const validateBtn = e.target.closest("[data-pvalidate]");
            const refuseBtn = e.target.closest("[data-prefuse]");
            if (!validateBtn && !refuseBtn) return;

            if (validateBtn) {
                const id = validateBtn.dataset.pvalidate;
                validateBtn.disabled = true;
                try {
                    const res = await apiRequest(`/paiements-validation/${id}/valider`, { method: "POST" });
                    alert(res.message || "Paiement validé.");
                    await Promise.all([loadPending(), CrudPage.load()]);
                } catch (err) {
                    validateBtn.disabled = false;
                    alert(err.message);
                }
                return;
            }

            if (refuseBtn) {
                refusTargetId = refuseBtn.dataset.prefuse;
                document.getElementById("refusMotifAutre").value = "";
                document.getElementById("refusMotif").value = "Paiement non reçu";
                document.getElementById("refusModal").style.display = "flex";
            }
        }

        async function confirmRefus() {
            if (!refusTargetId) return;
            const select = document.getElementById("refusMotif");
            const motif = select.value === "Autre"
                ? document.getElementById("refusMotifAutre").value.trim()
                : select.value;
            if (!motif) {
                alert("Indiquez le motif du refus.");
                return;
            }
            const btn = document.getElementById("refusConfirm");
            btn.disabled = true;
            try {
                const res = await apiRequest(`/paiements-validation/${refusTargetId}/refuser`, {
                    method: "POST",
                    body: JSON.stringify({ motif }),
                });
                document.getElementById("refusModal").style.display = "none";
                alert(res.message || "Déclaration refusée.");
                refusTargetId = null;
                await Promise.all([loadPending(), CrudPage.load()]);
            } catch (err) {
                alert(err.message);
            } finally {
                btn.disabled = false;
            }
        }

        document.getElementById("pendingList").addEventListener("click", handlePendingAction);
        document.getElementById("refusConfirm").addEventListener("click", confirmRefus);
        document.getElementById("refusCancel").addEventListener("click", () => {
            document.getElementById("refusModal").style.display = "none";
            refusTargetId = null;
        });
        document.getElementById("refusModal").addEventListener("click", (e) => {
            if (e.target.id === "refusModal") {
                document.getElementById("refusModal").style.display = "none";
                refusTargetId = null;
            }
        });
        document.getElementById("refusMotif").addEventListener("change", (e) => {
            document.getElementById("refusMotifAutre").style.display = e.target.value === "Autre" ? "block" : "none";
        });

        CrudPage.init({
            resource: "paiements",
            listEl: "paiementsList",
            addBtnEl: "addPaiementBtn",
            modalId: "paiementModal",
            modalTitleId: "modalTitle",
            formId: "paiementForm",
            idFieldId: "paiementId",
            cancelBtnId: "cancelModal",
            validate: (form) => validateFields(form, [
                {
                    name: "locataire_id",
                    test: (i) => !i.value,
                    message: "Choisissez le locataire.",
                },
                {
                    name: "logement_id",
                    test: (i) => !i.value,
                    message: "Choisissez le logement.",
                },
                {
                    name: "mois",
                    test: (i) => !i.value || i.value > currentMonth(),
                    message: "Indiquez le mois concerné (mois courant ou mois passé, jamais un mois futur).",
                },
                {
                    name: "montant",
                    test: (i) => i.value === "" || Number(i.value) <= 0,
                    message: "Saisissez un montant valide.",
                },
            ]),
            onOpenAdd: () => {
                document.getElementById("methode_paiement").value = "wave";
                document.getElementById("reference").value = "";
            },
            onOpenEdit: () => {
                // La méthode de paiement est déjà pré-remplie par
                // CrudPage.openEdit (crud.js) depuis l'enregistrement :
                // on ne doit PAS l'écraser (perte de donnée silencieuse).
            },
            renderItem: (p) => {
                const [label, cls] = PAIEMENT_STATUS[p.statut] || [p.statut, "status-info"];
                const locataire = locatairesCache.find((t) => String(t.id) === String(p.locataire_id));
                const logement = logementsCache.find((l) => String(l.id) === String(p.logement_id));
                const avatar = locataire && locataire.avatar_url
                    ? `<img src="${escapeAttr(locataire.avatar_url)}" alt="" class="avatar-sm-card">`
                    : "";
                return `
                    <div class="crud-card">
                        <div>
                            <h3>${avatar}${locataire ? escapeHtml(locataire.nom) : "Locataire"}</h3>
                            <p>${escapeHtml(formatMois(p.mois))} — ${logement ? escapeHtml(logement.nom) : ""}</p>
                            <p><span class="status ${cls}">${escapeHtml(label)}</span></p>
                        </div>
                        <div class="card-amount">
                            <strong>${fmtFCFA(p.montant)}</strong>
                            <div class="card-actions">
                                <button class="btn btn-edit" data-edit="${p.id}">Modifier</button>
                                <button class="btn btn-delete" data-delete="${p.id}">Supprimer</button>
                            </div>
                        </div>
                    </div>`;
            },
            // Les déclarations « en attente de validation » s'affichent dans
            // « Paiements à valider » uniquement — on ne les répète pas ici.
            filter: (p) => p.statut !== "en_validation"
        });

        // Validation / refus d'une déclaration (historique aussi).
        document.getElementById("paiementsList").addEventListener("click", handlePendingAction);

        loadData();
        loadPending();
    