
const LOCATAIRE_STATUS = {
            actif: ["Actif", "status-success"],
            inactif: ["Inactif", "status-danger"],
        };

        const state = { tenants: [], logements: [], biens: [], search: "" };
        let tenantEditId = null;
        let _confirmPwdResolve = null;

        const el = (id) => document.getElementById(id);

        function confirmPassword(message) {
            return new Promise((resolve) => {
                const modal = el("confirmPwdModal");
                const form = el("confirmPwdForm");
                const input = el("confirmPassword");
                const errorBox = el("confirmPwdError");
                form.reset();
                errorBox.style.display = "none";
                modal.style.display = "flex";
                input.focus();
                _confirmPwdResolve = resolve;
            });
        }

        function closeConfirmPwd() {
            el("confirmPwdModal").style.display = "none";
            if (_confirmPwdResolve) { _confirmPwdResolve(null); _confirmPwdResolve = null; }
        }

        function renderBienOptions(currentId) {
            const currentIdStr = currentId == null ? null : String(currentId);
            let html = '<option value="">— Aucun —</option>';
            html += '<option value="__new_bien__">+ Créer un bien…</option>';
            for (const b of state.biens) {
                const selected = String(b.id) === currentIdStr ? " selected" : "";
                html += `<option value="${b.id}"${selected}>${escapeHtml(b.nom)}</option>`;
            }
            return html;
        }

        function renderLogementOptions(currentId, bienId) {
            const currentIdStr = currentId == null ? null : String(currentId);
            const occupied = new Set(state.tenants.filter((t) => t.logement_id).map((t) => String(t.logement_id)));
            const sorted = [...state.logements].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
            const inBien = bienId ? sorted.filter((l) => String(l.bien_id) === String(bienId)) : sorted;
            const current = sorted.find((l) => String(l.id) === currentIdStr);
            const freeInBien = inBien.filter((l) => !occupied.has(String(l.id)));

            let html = '<option value="__new__">+ Créer un logement…</option>';

            if (current) html += `<option value="${current.id}">${escapeHtml(current.nom)} (actuel)</option>`;

            for (const l of freeInBien) {
                if (current && String(l.id) === currentIdStr) continue;
                const note = l.statut === "occupe" ? " (occupé)" : l.statut === "maintenance" ? " (maintenance)" : " (libre)";
                html += `<option value="${l.id}">${escapeHtml(l.nom)}${note}</option>`;
            }
            if (freeInBien.length === 0 && !current) html += '<option value="" disabled>— Aucun logement libre dans ce bien —</option>';
            return html;
        }

function toggleChambresLg() {
            const type = el("lg_type").value;
            const group = el("lgChambresGroup");
            if (type === "appartement") group.style.display = "block";
            else {
                group.style.display = "none";
                el("lg_nombre_chambres").value = "";
            }
        }

        function lgPayload(form) {
            const payload = {
                nom: form.lg_nom.value.trim(),
                type: form.lg_type.value,
            };
            if (form.lg_type.value === "appartement") payload.nombre_chambres = form.lg_nombre_chambres.value || null;
            return payload;
        }

        function resetLgFields() {
            const form = el("tenantForm");
            form.lg_nom.value = "";
            form.lg_type.value = "appartement";
            form.lg_nombre_chambres.value = "";
            toggleChambresLg();
        }

        function logementModeFromSelect() {
            const val = el("logement_id").value;
            if (val === "__new__") return "new";
            if (val === "") return "none";
            return "existing";
        }

        function selectedLogement() {
            const val = el("logement_id").value;
            return state.logements.find((l) => String(l.id) === String(val)) || null;
        }

function onBienChange() {
            const val = el("bien_id").value;
            el("newBienFields").style.display = val === "__new_bien__" ? "block" : "none";
            el("logement_id").innerHTML = renderLogementOptions(null, val === "__new_bien__" ? null : val);
            el("logement_id").value = "__new__";
            onLogementSelectChange();
        }

        function onLogementSelectChange() {
            const fieldset = el("logementFields");
            const loyerInput = el("loyer_mensuel");
            const loyerHint = el("loyerHint");
            const mode = logementModeFromSelect();

            fieldset.style.display = mode === "new" ? "block" : "none";
            if (mode === "new") resetLgFields();

const lg = selectedLogement();
            if (lg) {
                loyerInput.value = lg.loyer_mensuel ?? "";
                loyerInput.disabled = true;
                loyerHint.textContent = "Loyer enregistré sur le logement (modifiable dans la fiche locataire).";
            } else {
                loyerInput.disabled = false;
                loyerHint.textContent = "";
            }
        }

        // ============================================================
        // Chargement + rendu
        // ============================================================

async function loadAll() {
            try {
                const [tenants, logements, biens] = await Promise.all([
                    apiRequest("/locataires"),
                    apiRequest("/logements"),
                    apiRequest("/biens"),
                ]);
                state.tenants = tenants.data;
                state.logements = logements.data;
                state.biens = biens.data;
                renderLocataires();
            } catch (err) {
                el("locatairesList").innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
            }
        }

function renderLocataires() {
            const list = el("locatairesList");
            const needle = (state.search || "").trim().toLowerCase();
            const filtered = needle
                ? state.tenants.filter((t) => {
                    const hay = `${t.nom || ""} ${t.username || ""} ${t.phone || ""} ${t.email || ""}`.toLowerCase();
                    return hay.includes(needle);
                })
                : state.tenants;
            if (!filtered.length) {
                list.innerHTML = state.tenants.length
                    ? '<div class="empty-state">Aucun locataire ne correspond à cette recherche.</div>'
                    : '<div class="empty-state">Aucun locataire pour le moment.</div>';
                return;
            }
            list.innerHTML = filtered.map((t) => {
                const lg = state.logements.find((l) => String(l.id) === String(t.logement_id));
                const [label, cls] = LOCATAIRE_STATUS[t.statut] || [t.statut, "status-info"];
                const typeLabel = lg && lg.type === "chambre" ? "Chambre" : "Appartement";
                const avatar = t.avatar_url
                    ? `<img src="${escapeAttr(t.avatar_url)}" alt="" class="avatar-sm-card">`
                    : "";
                return `
                    <div class="crud-card">
                        <div>
                            <h3>${avatar}${escapeHtml(t.nom)}</h3>
                            <p>${t.username ? "Username : " + escapeHtml(t.username) + " · " : ""}${escapeHtml(t.phone || "")}${t.email ? " — " + escapeHtml(t.email) : ""}</p>
                            ${lg
                                ? `<p class="logement-chip"><strong>Logement :</strong> ${escapeHtml(lg.nom)} · ${typeLabel} · ${Number(lg.loyer_mensuel).toLocaleString("fr-FR")} FCFA/mois · ${escapeHtml(lg.adresse || "")}</p>`
                                : `<p class="logement-chip logement-none">Aucun logement associé.</p>`}
                            <p><span class="status ${cls}">${escapeHtml(label)}</span>${t.jour_echeance ? " · Échéance le " + escapeHtml(t.jour_echeance) : ""}${t.account_uid ? " · Compte actif" : ""}</p>
                        </div>
                        <div class="card-actions">
                            <button class="btn btn-edit" data-edit-t="${t.id}">Modifier</button>
                            <button class="btn btn-delete" data-delete-t="${t.id}">Supprimer</button>
                        </div>
                    </div>`;
}).join("");
        }

        // ============================================================
        // Modal locataire
        // ============================================================

        function openTenantAdd() {
            tenantEditId = null;
            const form = el("tenantForm");
            form.reset();
            clearFormErrors(form);
            el("tenantId").value = "";
            el("tenantModalTitle").textContent = "Ajouter un locataire";
            el("autoAccountHint").style.display = "block";
            el("newBienFields").style.display = "none";
            el("logementFields").style.display = "none";
            el("bien_id").innerHTML = renderBienOptions(null);
            el("bien_id").value = state.biens.length ? String(state.biens[0].id) : "__new_bien__";
            el("logement_id").innerHTML = renderLogementOptions(null, el("bien_id").value);
            el("logement_id").value = "__new__";
            el("loyer_mensuel").disabled = false;
            el("loyerHint").textContent = "";
            form.lg_type.value = "appartement";
            toggleChambresLg();
            onLogementSelectChange();
            el("tenantModal").style.display = "flex";
        }

        function openTenantEdit(item) {
            tenantEditId = item.id;
            const form = el("tenantForm");
            form.reset();
            clearFormErrors(form);
            el("tenantId").value = item.id;
            el("tenantModalTitle").textContent = "Modifier le locataire";
            el("autoAccountHint").style.display = "none";
            el("newBienFields").style.display = "none";
            form.nom.value = item.nom || "";
            form.email.value = item.email || "";
            form.phone.value = item.phone || "";
            form.jour_echeance.value = item.jour_echeance ?? "";
            form.date_entree.value = item.date_entree || "";
            form.statut.value = item.statut || "actif";

            const currentId = item.logement_id || null;
            const lg = currentId ? state.logements.find((l) => String(l.id) === String(currentId)) : null;
            el("bien_id").innerHTML = renderBienOptions(lg?.bien_id || null);
            el("bien_id").value = lg?.bien_id || "";
            el("logement_id").innerHTML = renderLogementOptions(currentId, lg?.bien_id || null);
            el("logement_id").value = currentId || "__new__";
            onLogementSelectChange();
            el("loyer_mensuel").value = lg?.loyer_mensuel ?? "";
            el("loyer_mensuel").disabled = false;
            el("loyerHint").textContent = currentId
                ? "Le loyer est enregistré sur le logement et sera mis à jour."
                : "";
            el("tenantModal").style.display = "flex";
        }

        async function submitTenant(e) {
            e.preventDefault();
            const form = el("tenantForm");
            const btn = form.querySelector('button[type="submit"]');
            if (btn.disabled) return;
            clearFormErrors(form);

            const editing = tenantEditId != null;
            const mode = logementModeFromSelect();
            const createNewBien = el("bien_id").value === "__new_bien__";
            const lgRules = [
                { name: "lg_nom", test: (i) => !i.value.trim(), message: "Le nom du logement est obligatoire." },
                {
                    name: "lg_nombre_chambres",
                    test: (i) => form.lg_type.value === "appartement" && (i.value === "" || Number(i.value) < 1),
                    message: "Indiquez le nombre de chambres.",
                },
            ];

            const errors = validateFields(form, [
                { name: "nom", test: (i) => !i.value.trim(), message: "Le nom complet est obligatoire." },
                { name: "bien_id", test: (i) => !i.value, message: "Choisissez le bien / résidence." },
                ...(createNewBien ? [
                    { name: "nb_nom", test: (i) => !i.value.trim(), message: "Le nom du bien est obligatoire." },
                ] : []),
                {
                    name: "jour_echeance",
                    test: (i) => i.value !== "" && (Number(i.value) < 1 || Number(i.value) > 31),
                    message: "Le jour d'échéance doit être entre 1 et 31.",
                },
                ...(mode === "new" ? [...lgRules, {
                    name: "loyer_mensuel",
                    test: (i) => i.value === "" || Number(i.value) <= 0,
                    message: "Saisissez un loyer mensuel valide.",
                }] : []),
            ]);

            if (Object.keys(errors).length) {
                applyServerErrors(form, errors);
                return;
            }

            const originalLabel = btn.textContent;
            btn.disabled = true;
            btn.textContent = "Enregistrement...";

            try {
                let bienId = el("bien_id").value;
                if (createNewBien) {
                    const bien = await apiRequest("/biens", {
                        method: "POST",
                        body: JSON.stringify({ nom: form.nb_nom.value.trim(), type: form.nb_type.value }),
                    });
                    bienId = bien.data.id;
                }

                const payload = {
                    nom: form.nom.value.trim(),
                    email: form.email.value.trim(),
                    phone: form.phone.value.trim(),
                    jour_echeance: form.jour_echeance.value,
                    date_entree: form.date_entree.value,
                    statut: form.statut.value,
                };

                if (mode === "new") {
                    const lg = { ...lgPayload(form), bien_id: bienId, loyer_mensuel: form.loyer_mensuel.value };
                    if (editing) payload.logement_new = lg;
                    else payload.logement = lg;
                } else if (mode === "existing") {
                    payload.logement_id = form.logement_id.value;
                    if (editing) {
                        payload.logement_update = {
                            id: form.logement_id.value,
                            loyer_mensuel: form.loyer_mensuel.value,
                        };
                    }
                } else {
                    payload.logement_id = "";
                }

                if (!editing) payload.autoAccount = true;

                if (editing) {
                    const pwd = await confirmPassword();
                    if (!pwd) return;
                }

                let res;
                if (editing) {
                    res = await apiRequest(`/locataires/${tenantEditId}`, { method: "PUT", body: JSON.stringify(payload) });
                } else {
                    res = await apiRequest("/locataires", { method: "POST", body: JSON.stringify(payload) });
                }

                el("tenantModal").style.display = "none";

                if (!editing && res.autoAccount && res.account) {
                    showResultSummary(res);
                } else {
                    showToast(editing ? "Locataire modifié avec succès." : "Locataire créé avec succès.");
                }
                await loadAll();
            } catch (err) {
                const mapped = {};
                for (const [k, v] of Object.entries(err.errors || {})) {
                    mapped[k.startsWith("logement_") ? k.replace("logement_", "lg_") : k] = v;
                }
                applyServerErrors(form, mapped);
                showToast(err.message, "error");
            } finally {
                btn.disabled = false;
                btn.textContent = originalLabel;
            }
        }

        function showResultSummary(res) {
            const data = res.data;
            const lg = res.logement || state.logements.find((l) => String(l.id) === String(data.logement_id));
            const bien = lg && state.biens.find((b) => String(b.id) === String(lg.bien_id));
            const loyer = Number(lg?.loyer_mensuel ?? data.loyer_mensuel ?? 0);

            const rows = [
                ["Nom", escapeHtml(data.nom)],
                ["Appartement", lg ? `${escapeHtml(lg.nom)}${bien ? ` · ${escapeHtml(bien.nom)}` : ""}` : "—"],
                ["Loyer", `${loyer.toLocaleString("fr-FR")} FCFA`],
                ["Échéance", data.jour_echeance ? `le ${escapeHtml(data.jour_echeance)} de chaque mois` : "—"],
                ["Compte", escapeHtml(res.account.username)],
                ["Mot de passe initial", escapeHtml(res.account.password)],
            ];
            el("resultSummary").innerHTML = rows
                .map(([k, v]) => `<div class="result-row"><span>${k}</span><strong>${v}</strong></div>`)
                .join("");
            if (res.echeance && res.echeance.mois) {
                el("resultSummary").innerHTML +=
                    `<div class="result-row"><span>Échéance créée</span><strong>${escapeHtml(res.echeance.mois)}</strong></div>`;
            }
            const creds = el("accountCredentials");
            creds.style.display = "block";
            creds.dataset.credentials = `Username : ${res.account.username}\nMot de passe : ${res.account.password}\nNom : ${data.nom}`;
            el("resultModal").style.display = "flex";
        }

async function deleteTenant(id) {
            const pwd = await confirmPassword();
            if (!pwd) return;
            try {
                const res = await apiRequest(`/locataires/${id}`, { method: "DELETE" });
                showToast(res.message);
                await loadAll();
            } catch (err) {
                showToast(err.message, "error");
            }
        }

        // ============================================================
        // Initialisation
        // ============================================================

        document.addEventListener("DOMContentLoaded", () => {
            el("addBtn").addEventListener("click", openTenantAdd);

            el("cancelTenantModal").addEventListener("click", () => (el("tenantModal").style.display = "none"));
            el("tenantModal").addEventListener("click", (e) => { if (e.target === el("tenantModal")) el("tenantModal").style.display = "none"; });
            el("closeResultModal").addEventListener("click", () => (el("resultModal").style.display = "none"));
            el("resultModal").addEventListener("click", (e) => { if (e.target === el("resultModal")) el("resultModal").style.display = "none"; });
            el("copyCredentialsBtn").addEventListener("click", async () => {
                const creds = el("accountCredentials").dataset.credentials || "";
                try {
                    await navigator.clipboard.writeText(creds);
                    const b = el("copyCredentialsBtn");
                    b.textContent = "Identifiants copiés ✓";
                    setTimeout(() => (b.textContent = "Copier les identifiants"), 2000);
                } catch (err) {
                    showToast("Impossible de copier les identifiants.", "error");
                }
            });

            el("cancelConfirmPwd").addEventListener("click", closeConfirmPwd);
            el("confirmPwdModal").addEventListener("click", (e) => { if (e.target === el("confirmPwdModal")) closeConfirmPwd(); });
            el("confirmPwdForm").addEventListener("submit", async (e) => {
                e.preventDefault();
                const password = el("confirmPassword").value;
                if (!password) return;
                try {
                    await apiRequest("/auth/verify-password", { method: "POST", body: JSON.stringify({ password }) });
                    el("confirmPwdModal").style.display = "none";
                    if (_confirmPwdResolve) { _confirmPwdResolve(password); _confirmPwdResolve = null; }
                } catch (err) {
                    const errorBox = el("confirmPwdError");
                    errorBox.textContent = err.message;
                    errorBox.style.display = "block";
                }
            });

            el("tenantForm").addEventListener("submit", submitTenant);
            el("logement_id").addEventListener("change", onLogementSelectChange);
            el("bien_id").addEventListener("change", onBienChange);
            el("lg_type").addEventListener("change", toggleChambresLg);
            el("tenantSearch").addEventListener("input", (e) => {
                state.search = e.target.value;
                renderLocataires();
            });

            el("locatairesList").addEventListener("click", (e) => {
                const editBtn = e.target.closest("[data-edit-t]");
                const delBtn = e.target.closest("[data-delete-t]");
                if (editBtn) {
                    const item = state.tenants.find((t) => String(t.id) === String(editBtn.dataset.editT));
                    if (item) openTenantEdit(item);
                }
                if (delBtn) deleteTenant(delBtn.dataset.deleteT);
            });

            loadAll();
        });
    