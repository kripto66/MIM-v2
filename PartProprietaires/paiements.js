
        const PAIEMENT_STATUS = {
            paye: ["Payé", "status-success"],
            attente: ["En attente", "status-warning"],
            retard: ["En retard", "status-danger"],
            a_confirmer: ["À confirmer", "status-info"],
            en_validation: ["En attente de validation", "status-warning"],
            refuse: ["Refusé", "status-danger"],
        };

        const SALAIRE_STATUS = {
            paye: ["🟢 Confirmé", "status-success"],
            attente: ["🟡 En attente de confirmation", "status-warning"],
            non_recu: ["🔴 Non reçu", "status-danger"],
        };

        const METHODE_LABELS = {
            especes: "Espèces",
            mobile_money: "Mobile Money",
            virement: "Virement bancaire",
            carte: "Carte bancaire",
            wave: "Wave",
            orange_money: "Orange Money",
        };

        const TYPE_ICONS = { wave: "🟣", orange_money: "🟠", virement: "🏦", especes: "💵" };
        const TYPE_LABELS = { wave: "Wave", orange_money: "Orange Money", virement: "Virement bancaire", especes: "Espèces" };

        const TYPE_FIELDS = {
            wave: ["nom_titulaire", "numero", "lien_paiement", "instructions"],
            orange_money: ["nom_titulaire", "numero", "lien_paiement", "instructions"],
            virement: ["banque", "nom_titulaire", "num_compte", "lien_paiement", "instructions"],
            especes: ["instructions"],
        };

        let locatairesCache = [];
        let logementsCache = [];
        let refusTargetId = null;
        let employesCache = [];
        let payEmpTarget = null;

        function currentMonth() {
            const d = new Date();
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        }

        function formatDate(iso) {
            if (!iso) return "";
            return new Date(iso).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
        }

        function formatDateTime(iso) {
            if (!iso) return "";
            return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
        }

        function fmtFCFA(n) {
            return `${Number(n || 0).toLocaleString("fr-FR")} FCFA`;
        }

        // ============================================================
        // Onglets
        // ============================================================

        function switchTab(name) {
            document.querySelectorAll("#payTabs .tab-btn").forEach((b) => {
                b.classList.toggle("active", b.dataset.paytab === name);
            });
            document.getElementById("paytab-locataires").style.display = name === "locataires" ? "" : "none";
            document.getElementById("paytab-employes").style.display = name === "employes" ? "" : "none";
        }

        document.getElementById("payTabs").addEventListener("click", (e) => {
            const btn = e.target.closest("[data-paytab]");
            if (btn) switchTab(btn.dataset.paytab);
        });

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

        // ============================================================
        // Moyens de réception du propriétaire
        // ============================================================

        function moyenFields(type) {
            const fields = TYPE_FIELDS[type] || [];
            document.querySelectorAll("#moyenForm [data-mfield]").forEach((el) => {
                const name = el.dataset.mfield;
                el.style.display = fields.includes(name) ? "" : "none";
            });
        }

        function moyenPayload(form) {
            const type = form.moyen_type.value;
            const payload = { type };
            for (const field of TYPE_FIELDS[type] || []) {
                const el = form[field];
                payload[field] = el ? String(el.value || "").trim() : "";
            }
            return payload;
        }

        async function loadMoyens() {
            const listEl = document.getElementById("moyensList");
            try {
                const res = await apiRequest("/moyens-paiement");
                const items = res.data || [];
                if (!items.length) {
                    listEl.innerHTML = '<div class="empty-state">Aucun moyen de réception. Ajoutez-en pour que vos locataires sachent où payer.</div>';
                    return;
                }
                listEl.innerHTML = items.map((m) => {
                    const lines = [];
                    if (m.nom_titulaire) lines.push(`<p><span>Nom complet :</span> <strong>${escapeHtml(m.nom_titulaire)}</strong></p>`);
                    if (m.numero) lines.push(`<p><span>Numéro :</span> <strong>${escapeHtml(m.numero)}</strong></p>`);
                    if (m.banque) lines.push(`<p><span>Banque :</span> <strong>${escapeHtml(m.banque)}</strong></p>`);
                    if (m.num_compte) lines.push(`<p><span>Compte :</span> <strong>${escapeHtml(m.num_compte)}</strong></p>`);
                    if (m.lien_paiement) lines.push(`<p><span>Lien :</span> <a href="${escapeAttr(m.lien_paiement)}" target="_blank" rel="noopener">ouvrir</a></p>`);
                    if (m.instructions) lines.push(`<p class="moyen-instructions">${escapeHtml(m.instructions)}</p>`);
                    return `
                        <div class="moyen-card ${m.actif ? "" : "moyen-inactif"}">
                            <div class="moyen-head">
                                <span>${escapeHtml(TYPE_ICONS[m.type] || "💰")} ${escapeHtml(TYPE_LABELS[m.type] || m.type)}</span>
                                ${m.actif ? '<span class="status status-success">Actif</span>' : '<span class="status status-info">Inactif</span>'}
                            </div>
                            <div class="moyen-body">${lines.join("") || '<p class="pay-hint">Aucun détail renseigné.</p>'}</div>
                            <div class="moyen-actions">
                                <button type="button" class="btn btn-edit" data-medit="${m.id}">Modifier</button>
                                <button type="button" class="btn btn-secondary" data-mtoggle="${m.id}">${m.actif ? "Désactiver" : "Activer"}</button>
                                <button type="button" class="btn btn-delete" data-mdelete="${m.id}">Supprimer</button>
                            </div>
                        </div>`;
                }).join("");
            } catch (err) {
                listEl.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
            }
        }

        function openMoyenModal(id) {
            const form = document.getElementById("moyenForm");
            form.reset();
            document.getElementById("moyenId").value = id || "";
            document.getElementById("moyenModalTitle").textContent = id ? "Modifier le moyen de paiement" : "Ajouter un moyen de paiement";
            moyenFields(form.moyen_type.value);
            document.getElementById("moyenModal").style.display = "flex";
        }

        async function submitMoyen(e) {
            e.preventDefault();
            const form = document.getElementById("moyenForm");
            const id = document.getElementById("moyenId").value;
            const payload = moyenPayload(form);
            const btn = form.querySelector('button[type="submit"]');
            btn.disabled = true;
            try {
                if (id) {
                    await apiRequest(`/moyens-paiement/${id}`, { method: "PUT", body: JSON.stringify(payload) });
                } else {
                    await apiRequest("/moyens-paiement", { method: "POST", body: JSON.stringify(payload) });
                }
                document.getElementById("moyenModal").style.display = "none";
                await loadMoyens();
            } catch (err) {
                alert(err.message);
            } finally {
                btn.disabled = false;
            }
        }

        async function handleMoyensAction(e) {
            const edit = e.target.closest("[data-medit]");
            const toggle = e.target.closest("[data-mtoggle]");
            const del = e.target.closest("[data-mdelete]");
            if (!edit && !toggle && !del) return;

            if (edit) {
                try {
                    const res = await apiRequest("/moyens-paiement");
                    const m = (res.data || []).find((x) => String(x.id) === String(edit.dataset.medit));
                    if (!m) return;
                    const form = document.getElementById("moyenForm");
                    form.reset();
                    document.getElementById("moyenId").value = m.id;
                    document.getElementById("moyenModalTitle").textContent = "Modifier le moyen de paiement";
                    form.moyen_type.value = m.type;
                    moyenFields(m.type);
                    for (const field of TYPE_FIELDS[m.type] || []) {
                        if (form[field]) form[field].value = m[field] || "";
                    }
                    document.getElementById("moyenModal").style.display = "flex";
                } catch (err) {
                    alert(err.message);
                }
                return;
            }

            if (toggle) {
                try {
                    const res = await apiRequest("/moyens-paiement");
                    const m = (res.data || []).find((x) => String(x.id) === String(toggle.dataset.mtoggle));
                    if (!m) return;
                    await apiRequest(`/moyens-paiement/${m.id}`, {
                        method: "PUT",
                        body: JSON.stringify({ actif: !m.actif }),
                    });
                    await loadMoyens();
                } catch (err) {
                    alert(err.message);
                }
                return;
            }

            if (del) {
                if (!confirm("Supprimer ce moyen de paiement ?")) return;
                try {
                    await apiRequest(`/moyens-paiement/${del.dataset.mdelete}`, { method: "DELETE" });
                    await loadMoyens();
                } catch (err) {
                    alert(err.message);
                }
            }
        }

        document.getElementById("addMoyenBtn").addEventListener("click", () => openMoyenModal(null));
        document.getElementById("moyensList").addEventListener("click", handleMoyensAction);
        document.getElementById("moyenForm").addEventListener("submit", submitMoyen);
        document.getElementById("moyenCancel").addEventListener("click", () => {
            document.getElementById("moyenModal").style.display = "none";
        });
        document.getElementById("moyenModal").addEventListener("click", (e) => {
            if (e.target.id === "moyenModal") document.getElementById("moyenModal").style.display = "none";
        });
        document.getElementById("moyen_type").addEventListener("change", (e) => moyenFields(e.target.value));

        // ============================================================
        // Payer mes employés
        // ============================================================

        async function loadEmployes() {
            const listEl = document.getElementById("employesPayList");
            const countEl = document.getElementById("empPayCount");
            try {
                const res = await apiRequest("/employes");
                employesCache = res.data || [];
                countEl.textContent = `${employesCache.length} employé(s)`;
                renderEmployes("");
                await loadSalairesHistory();
            } catch (err) {
                listEl.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
            }
        }

        function renderEmployes(q) {
            const listEl = document.getElementById("employesPayList");
            const needle = (q || "").trim().toLowerCase();
            const filtered = employesCache.filter((e) => {
                if (!needle) return true;
                const hay = `${e.nom || ""} ${e.poste || ""}`.toLowerCase();
                return hay.includes(needle);
            });

            if (!filtered.length) {
                listEl.innerHTML = employesCache.length
                    ? '<div class="empty-state">Aucun employé ne correspond à cette recherche.</div>'
                    : '<div class="empty-state">Vous n\'avez encore aucun employé. Ajoutez-en depuis la page « Mes employés ».</div>';
                return;
            }

            listEl.innerHTML = filtered.map((e) => {
                const dernier = e.dernier_paiement;
                const [sLabel, sCls] = dernier
                    ? (SALAIRE_STATUS[dernier.statut] || [dernier.statut, "status-info"])
                    : ["Aucun versement", "status-info"];
                return `
                    <div class="crud-card pay-emp-card">
                        <div>
                            <h3>${escapeHtml(e.nom)}</h3>
                            <p>${escapeHtml(e.poste || "Employé")} — <strong>${fmtFCFA(e.salaire)}</strong> / mois</p>
                            <p><span class="status ${sCls}">${escapeHtml(sLabel)}</span>${dernier ? ` <span class="pay-hint">(${escapeHtml(formatMois(dernier.mois))})</span>` : ""}</p>
                            ${e.en_attente_confirmation ? `<p class="pay-hint">🟡 ${e.en_attente_confirmation} versement(s) en attente de confirmation de l'employé.</p>` : ""}
                        </div>
                        <div class="card-amount">
                            <div class="card-actions">
                                <button class="btn btn-edit" data-emp-hist="${e.id}" data-emp-nom="${escapeAttr(e.nom)}">Historique</button>
                                <button class="btn btn-pay" data-emp-pay="${e.id}">Payer</button>
                            </div>
                        </div>
                    </div>`;
            }).join("");
        }

        async function openPayEmpModal(id) {
            const emp = employesCache.find((e) => String(e.id) === String(id));
            if (!emp) return;
            payEmpTarget = emp;

            let moyens = [];
            try {
                const res = await apiRequest(`/employes/${emp.id}/moyens-paiement`);
                moyens = res.data || [];
            } catch (err) {
                moyens = [];
            }

            const moyensOptions = moyens.length
                ? moyens.map((m) => {
                    const detail = [m.nom_titulaire, m.numero, m.banque, m.num_compte].filter(Boolean).join(" — ");
                    return `<option value="${m.id}">${escapeHtml(TYPE_LABELS[m.type] || m.type)}${detail ? ` — ${escapeHtml(detail)}` : ""}</option>`;
                }).join("")
                : '<option value="">— Aucun moyen configuré —</option>';

            document.getElementById("payEmpTitle").textContent = `Payer ${emp.nom}`;
            document.getElementById("payEmpBody").innerHTML = `
                <div class="pay-emp-summary">
                    <p>${escapeHtml(emp.poste || "Employé")} · Salaire : <strong>${fmtFCFA(emp.salaire)}</strong> / mois</p>
                </div>
                ${moyens.length
                    ? `
                    <form id="payEmpForm">
                        <div class="form-group">
                            <label for="payemp_moyen">Moyen de paiement de l'employé</label>
                            <select id="payemp_moyen" required>${moyensOptions}</select>
                        </div>
                        <div class="form-row">
                            <div class="form-group">
                                <label for="payemp_montant">Montant (FCFA)</label>
                                <input type="number" id="payemp_montant" min="0" step="0.01" value="${escapeAttr(emp.salaire || "")}" required>
                            </div>
                            <div class="form-group">
                                <label for="payemp_mois">Mois</label>
                                <input type="month" id="payemp_mois" value="${currentMonth()}" required>
                            </div>
                        </div>
                        <div class="form-group">
                            <label for="payemp_ref">Référence (optionnel)</label>
                            <input type="text" id="payemp_ref" maxlength="80" placeholder="N° de transaction…">
                        </div>
                        <p class="pay-note-ok">Vous indiquez avoir effectué ce paiement directement à l'employé (hors MIM). L'employé recevra une notification et devra <strong>confirmer la réception</strong>.</p>
                        <div class="modal-actions">
                            <button type="button" class="btn btn-secondary" id="payEmpCancel">Annuler</button>
                            <button type="submit" class="btn btn-primary">Paiement versé</button>
                        </div>
                    </form>`
                    : `
                    <div class="empty-state">
                        <p>Cet employé n'a pas encore configuré de moyen de paiement.</p>
                        <p class="pay-hint">Demandez-lui d'ajouter son moyen depuis son espace employé (Wave, Orange Money, virement…).</p>
                    </div>
                    <div class="modal-actions">
                        <button type="button" class="btn btn-secondary" id="payEmpClose">Fermer</button>
                    </div>`}
            `;

            document.getElementById("payEmpModal").style.display = "flex";

            const form = document.getElementById("payEmpForm");
            if (form) {
                form.addEventListener("submit", submitPayEmp);
            }
            // Les deux branches du modal n'ont pas le même bouton de
            // sortie (Annuler / Fermer) : chacun garde son id propre —
            // un id unique par page, même dans les gabarits (dette D2).
            for (const id of ["payEmpCancel", "payEmpClose"]) {
                const btn = document.getElementById(id);
                if (btn) btn.addEventListener("click", () => (document.getElementById("payEmpModal").style.display = "none"));
            }
        }

        async function submitPayEmp(e) {
            e.preventDefault();
            if (!payEmpTarget) return;
            const form = document.getElementById("payEmpForm");
            const btn = form.querySelector('button[type="submit"]');
            btn.disabled = true;
            try {
                const res = await apiRequest(`/employes/${payEmpTarget.id}/paiements`, {
                    method: "POST",
                    body: JSON.stringify({
                        montant: Number(form.payemp_montant.value),
                        mois: form.payemp_mois.value,
                        moyen_employe_id: Number(form.payemp_moyen.value),
                        reference: form.payemp_ref.value.trim() || null,
                        statut: "attente",
                    }),
                });
                document.getElementById("payEmpModal").style.display = "none";
                alert(res.message || "Versement déclaré.");
                await Promise.all([loadEmployes()]);
            } catch (err) {
                alert(err.message);
                btn.disabled = false;
            }
        }

        async function loadSalairesHistory() {
            const listEl = document.getElementById("salairesHistory");
            try {
                const rows = [];
                for (const emp of employesCache) {
                    const res = await apiRequest(`/employes/${emp.id}/paiements`);
                    for (const p of res.data || []) rows.push({ ...p, emp_nom: emp.nom, emp_poste: emp.poste || "" });
                }
                if (!rows.length) {
                    listEl.innerHTML = '<div class="empty-state">Aucun versement de salaire pour le moment.</div>';
                    return;
                }
                rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
                listEl.innerHTML = rows.slice(0, 20).map((p) => {
                    const [sLabel, sCls] = SALAIRE_STATUS[p.statut] || [p.statut, "status-info"];
                    const confirmInfo = p.confirmed_at
                        ? ` · Confirmé le ${formatDate(p.confirmed_at)}`
                        : p.rejected_at
                            ? ` · Refusé le ${formatDate(p.rejected_at)}`
                            : "";
                    return `
                        <div class="crud-card">
                            <div>
                                <h3>${escapeHtml(p.emp_nom)} <span class="pay-hint">${escapeHtml(p.emp_poste)}</span></h3>
                                <p>${escapeHtml(formatMois(p.mois))} · ${p.moyen ? escapeHtml(p.moyen.label) : p.methode_paiement ? escapeHtml(METHODE_LABELS[p.methode_paiement] || p.methode_paiement) : "—"}${p.reference ? ` — réf. ${escapeHtml(p.reference)}` : ""}</p>
                                <p><span class="status ${sCls}">${escapeHtml(sLabel)}</span>${confirmInfo}</p>
                                ${p.rejection_reason ? `<p class="pay-hint">Motif : ${escapeHtml(p.rejection_reason)}</p>` : ""}
                            </div>
                            <div class="card-amount">
                                <strong>${fmtFCFA(p.montant)}</strong>
                            </div>
                        </div>`;
                }).join("");
            } catch (err) {
                listEl.innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
            }
        }

        async function openHistModal(id, nom) {
            try {
                const res = await apiRequest(`/employes/${id}/paiements`);
                const rows = res.data || [];
                document.getElementById("histTitle").textContent = `Historique — ${nom}`;
                document.getElementById("histBody").innerHTML = rows.length
                    ? rows.map((p) => {
                        const [sLabel, sCls] = SALAIRE_STATUS[p.statut] || [p.statut, "status-info"];
                        return `
                            <div class="crud-card">
                                <div>
                                    <p><strong>${escapeHtml(formatMois(p.mois))}</strong> · ${p.moyen ? escapeHtml(p.moyen.label) : p.methode_paiement ? escapeHtml(METHODE_LABELS[p.methode_paiement] || p.methode_paiement) : "—"}</p>
                                    <p><span class="status ${sCls}">${escapeHtml(sLabel)}</span>${p.confirmed_at ? ` <span class="pay-hint">Confirmé le ${formatDate(p.confirmed_at)}</span>` : ""}${p.rejected_at ? ` <span class="pay-hint">Refusé le ${formatDate(p.rejected_at)}</span>` : ""}</p>
                                    ${p.rejection_reason ? `<p class="pay-hint">Motif : ${escapeHtml(p.rejection_reason)}</p>` : ""}
                                </div>
                                <div class="card-amount"><strong>${fmtFCFA(p.montant)}</strong></div>
                            </div>`;
                    }).join("")
                    : '<div class="empty-state">Aucun versement pour cet employé.</div>';
                document.getElementById("histModal").style.display = "flex";
            } catch (err) {
                alert(err.message);
            }
        }

        document.getElementById("employesPayList").addEventListener("click", (e) => {
            const pay = e.target.closest("[data-emp-pay]");
            const hist = e.target.closest("[data-emp-hist]");
            if (pay) openPayEmpModal(pay.dataset.empPay);
            if (hist) openHistModal(hist.dataset.empHist, hist.dataset.empNom);
        });

        document.getElementById("histClose").addEventListener("click", () => {
            document.getElementById("histModal").style.display = "none";
        });
        document.getElementById("histModal").addEventListener("click", (e) => {
            if (e.target.id === "histModal") document.getElementById("histModal").style.display = "none";
        });
        document.getElementById("payEmpModal").addEventListener("click", (e) => {
            if (e.target.id === "payEmpModal") document.getElementById("payEmpModal").style.display = "none";
        });

        let searchTimer = null;
        document.getElementById("employeSearch").addEventListener("input", (e) => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => renderEmployes(e.target.value), 150);
        });

        loadData();
        loadPending();
        loadMoyens();
        loadEmployes();
    