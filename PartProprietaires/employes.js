

        const EMPLOYE_STATUS = {
            actif: ["Actif", "status-success"],
            inactif: ["Inactif", "status-danger"],
        };
        const TACHE_STATUS = {
            a_faire: ["À faire", "status-info"],
            en_cours: ["En cours", "status-warning"],
            termine: ["Terminée", "status-success"],
        };

        const state = { employes: [], taches: [], biens: [], tab: "employes", search: "" };
        let employeeEditId = null;
        let taskEditId = null;

        const el = (id) => document.getElementById(id);

        function usernameValid(u) {
            return /^[a-z0-9._-]{3,30}$/.test(u);
        }

        function formatFCFA(value) {
            const n = Number(value || 0);
            return n.toLocaleString("fr-FR") + " FCFA";
        }

        // Mois suivant (format YYYY-MM) pour pré-remplir un salaire mensuel.
        function nextMonthOf(mois) {
            if (!mois) return "";
            const [y, m] = String(mois).split("-").map(Number);
            const d = new Date(Date.UTC(y, m - 1, 1));
            d.setUTCMonth(d.getUTCMonth() + 1);
            return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
        }

        // ============================================================
        // Chargement + rendu
        // ============================================================

async function loadAll() {
            try {
                const [employes, taches, biens] = await Promise.all([
                    apiRequest("/employes"),
                    apiRequest("/tasks"),
                    apiRequest("/biens"),
                ]);
                state.employes = employes.data;
                state.taches = taches.data;
                state.biens = biens.data;
                renderEmployes();
                renderTaches();
            } catch (err) {
                el("employesList").innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
                el("tachesList").innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
            }
        }

        function renderBienOptions(selectedIds) {
            const selected = new Set((selectedIds || []).map((id) => String(id)));
            if (!state.biens.length) {
                return '<option value="" disabled>Aucun bien créé — créez d\'abord un bien.</option>';
            }
            return state.biens.map(
                (b) => `<option value="${b.id}"${selected.has(String(b.id)) ? " selected" : ""}>${escapeHtml(b.nom)}${b.adresse ? " — " + escapeHtml(b.adresse) : ""}</option>`
            ).join("");
        }

        function renderEmployes() {
            const list = el("employesList");
            const needle = (state.search || "").trim().toLowerCase();
            const filtered = needle
                ? state.employes.filter((e) => {
                    const hay = `${e.nom || ""} ${e.username || ""} ${e.poste || ""} ${e.phone || ""} ${e.email || ""}`.toLowerCase();
                    return hay.includes(needle);
                })
                : state.employes;
            if (!filtered.length) {
                list.innerHTML = state.employes.length
                    ? '<div class="empty-state">Aucun employé ne correspond à cette recherche.</div>'
                    : '<div class="empty-state">Aucun employé pour le moment. Créez le premier compte avec le bouton « + Ajouter un employé ».</div>';
                return;
            }
list.innerHTML = filtered.map((e) => {
                const [label, cls] = EMPLOYE_STATUS[e.statut] || [e.statut, "status-info"];
                const biens = (e.biens || []).map((b) => escapeHtml(b.nom)).filter(Boolean).join(", ");
                const avatar = e.avatar_url
                    ? `<img src="${escapeAttr(e.avatar_url)}" alt="" class="avatar-sm-card">`
                    : "";
                return `
                    <div class="crud-card">
                        <div>
                            <h3>${avatar}${escapeHtml(e.nom)}</h3>
                            <p>${e.poste ? escapeHtml(e.poste) + " · " : ""}${e.account_uid ? "Compte actif" : "Sans compte"}${e.phone ? " · " + escapeHtml(e.phone) : ""}${e.email ? " — " + escapeHtml(e.email) : ""}</p>
                            <p><strong>${formatFCFA(e.salaire)}</strong> / mois</p>
                            <p>${biens ? "<span class=\"logement-chip\">Biens : " + biens + "</span>" : ""}</p>
                            <p><span class="status ${cls}">${escapeHtml(label)}</span>${e.paiements_count ? " · " + e.paiements_count + " paiement(s) · " + formatFCFA(e.total_paye) + " versés" : ""}</p>
                        </div>
                        <div class="card-actions">
                            <button class="btn btn-edit" data-edit-e="${e.id}">Modifier</button>
                            <button class="btn btn-primary" data-pay-e="${e.id}">Payer</button>
                            <button class="btn btn-delete" data-delete-e="${e.id}">Supprimer</button>
                        </div>
                    </div>`;
            }).join("");
        }

        function renderTaches() {
            const list = el("tachesList");
            if (!state.taches.length) {
                list.innerHTML = '<div class="empty-state">Aucune tâche pour le moment. Créez-en une avec le bouton « + Ajouter une tâche ».</div>';
                return;
            }
            list.innerHTML = state.taches.map((t) => {
                const [label, cls] = TACHE_STATUS[t.statut] || [t.statut, "status-info"];
                return `
                    <div class="crud-card">
                        <div>
                            <h3>${escapeHtml(t.titre)}</h3>
                            <p>${escapeHtml(t.description || "")}</p>
                            <p>Assignée à : <strong>${escapeHtml(t.employe_nom || "Personne")}</strong>${t.echeance ? " · Échéance le " + escapeHtml(t.echeance) : ""}</p>
                            <p><span class="status ${cls}">${escapeHtml(label)}</span></p>
                        </div>
                        <div class="card-actions">
                            <button class="btn btn-edit" data-edit-task="${t.id}">Modifier</button>
                            <button class="btn btn-delete" data-delete-task="${t.id}">Supprimer</button>
                        </div>
                    </div>`;
            }).join("");
        }

        // ============================================================
        // Onglets
        // ============================================================

        function switchTab(tab) {
            state.tab = tab;
            document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
            el("employesSection").style.display = tab === "employes" ? "block" : "none";
            el("tachesSection").style.display = tab === "taches" ? "block" : "none";
            const btn = el("addBtn");
            btn.textContent = tab === "taches" ? "+ Ajouter une tâche" : "+ Ajouter un employé";
        }

        // ============================================================
        // Modal employé
        // ============================================================

function openEmployeeAdd() {
            employeeEditId = null;
            const form = el("employeeForm");
            form.reset();
            clearFormErrors(form);
            el("employeeId").value = "";
            el("employeeModalTitle").textContent = "Ajouter un employé";
            form.emp_username.disabled = false;
            form.emp_password.disabled = false;
            el("empUsernameStatus").textContent = "";
            form.emp_statut.value = "actif";
            el("emp_biens").innerHTML = renderBienOptions([]);
            el("employeeModal").style.display = "flex";
        }

        function openEmployeeEdit(item) {
            employeeEditId = item.id;
            const form = el("employeeForm");
            form.reset();
            clearFormErrors(form);
            el("employeeId").value = item.id;
            el("employeeModalTitle").textContent = "Modifier l'employé";
            form.emp_username.disabled = true;
            form.emp_password.disabled = true;
            el("empUsernameStatus").textContent = "Le username et le mot de passe ne se modifient pas ici.";
            form.emp_nom.value = item.nom || "";
            form.emp_poste.value = item.poste || "";
            form.emp_salaire.value = item.salaire ?? "";
            form.emp_email.value = item.email || "";
            form.emp_phone.value = item.phone || "";
            form.emp_date_embauche.value = item.date_embauche || "";
            form.emp_statut.value = item.statut || "actif";
            el("emp_biens").innerHTML = renderBienOptions((item.biens || []).map((b) => b.id));
            el("employeeModal").style.display = "flex";
        }

        async function submitEmployee(e) {
            e.preventDefault();
            const form = el("employeeForm");
            const btn = form.querySelector('button[type="submit"]');
            if (btn.disabled) return;
            clearFormErrors(form);

const editing = employeeEditId != null;

            const hasUsername = form.emp_username.value.trim() !== "";
            const hasPassword = form.emp_password.value !== "";

            const errors = validateFields(form, [
                { name: "emp_nom", test: (i) => !i.value.trim(), message: "Le nom complet est obligatoire." },
                ...(!editing && (hasUsername || hasPassword)
                    ? [
                        {
                            name: "emp_username",
                            test: (i) => !usernameValid(i.value.trim()),
                            message: "Username invalide : lettres minuscules, chiffres, . _ - (3 à 32 caractères).",
                        },
                        {
                            name: "emp_password",
                            test: (i) => mimPasswordRuleMessage(i.value) !== null,
                            message: mimPasswordRuleMessage(form.emp_password.value) || "Mot de passe trop faible.",
                        },
                    ]
                    : []),
                {
                    name: "emp_salaire",
                    test: (i) => i.value !== "" && (Number(i.value) < 0 || Number.isNaN(Number(i.value))),
                    message: "Le salaire doit être un nombre positif.",
                },
            ]);

            if (Object.keys(errors).length) {
                applyServerErrors(form, errors);
                return;
            }

            const payload = {
                nom: form.emp_nom.value.trim(),
                poste: form.emp_poste.value.trim(),
                salaire: form.emp_salaire.value === "" ? 0 : form.emp_salaire.value,
                email: form.emp_email.value.trim(),
                phone: form.emp_phone.value.trim(),
                date_embauche: form.emp_date_embauche.value,
                statut: form.emp_statut.value,
                biens: [...form.emp_biens.selectedOptions].map((o) => o.value),
            };
            if (!editing && (hasUsername || hasPassword)) {
                payload.username = form.emp_username.value.trim();
                payload.password = form.emp_password.value;
            }

            const originalLabel = btn.textContent;
            btn.disabled = true;
            btn.textContent = "Enregistrement...";

            try {
                let created = null;
                if (editing) {
                    await apiRequest(`/employes/${employeeEditId}`, { method: "PUT", body: JSON.stringify(payload) });
                } else {
                    created = await apiRequest("/employes", { method: "POST", body: JSON.stringify(payload) });
                }
                showToast(editing ? "Employé modifié avec succès." : "Compte employé créé avec succès.");
                el("employeeModal").style.display = "none";
                if (created && created.autoAccount && created.account) {
                    form.dataset.created = JSON.stringify(payload);
                    showEmployeeCredentials(created.account.username, created.account.password);
                }
                await loadAll();
            } catch (err) {
                applyServerErrors(form, err.errors);
                showToast(err.message, "error");
            } finally {
                btn.disabled = false;
                btn.textContent = originalLabel;
            }
        }

        function showEmployeeCredentials(username, password) {
            const data = JSON.parse(el("employeeForm").dataset.created || "{}");
            const rows = [
                ["Nom", escapeHtml(data.nom || "")],
                ["Poste", escapeHtml(data.poste || "—")],
                ["Compte", escapeHtml(username)],
                ["Mot de passe initial", escapeHtml(password)],
            ];
            el("empResultSummary").innerHTML = rows
                .map(([k, v]) => `<div class="result-row"><span>${k}</span><strong>${v}</strong></div>`)
                .join("");
            const creds = el("empAccountCredentials");
            creds.style.display = "block";
            creds.dataset.credentials = `Username : ${username}\nMot de passe : ${password}\nNom : ${data.nom || ""}`;
            el("empResultModal").style.display = "flex";
        }

        async function deleteEmployee(id) {
            const emp = state.employes.find((e) => String(e.id) === String(id));
            if (!emp) return;
            const okEmp = await MIM.confirmPassword({
                title: `Supprimer ${emp.nom} ?`,
                message: "Son compte d'accès (login) sera supprimé définitivement.",
                confirmLabel: "Supprimer",
            });
            if (!okEmp) return;
            try {
                const res = await apiRequest(`/employes/${id}`, { method: "DELETE" });
                showToast(res.message);
                await loadAll();
            } catch (err) {
                showToast(err.message, "error");
            }
        }

        // ============================================================
        // Modal paiement
        // ============================================================

        const METHODE_LABELS = {
            especes: "Espèces",
            mobile_money: "Mobile Money",
            virement: "Virement bancaire",
            carte: "Carte bancaire",
            wave: "Wave",
            orange_money: "Orange Money",
        };

        async function loadPayHistory(id) {
            try {
                const res = await apiRequest(`/employes/${id}/paiements`);
                const list = res.data || [];
                el("payHistory").innerHTML = list.length
                    ? list.map((p) => {
                        const cls = p.statut === "paye" ? "status-success" : "status-warning";
const lab = p.statut === "paye" ? "Payé" : "En attente";
                        const dateLisible = p.date_paiement ? new Date(p.date_paiement).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" }) : "";
                        return `<div class="pay-row"><span>${escapeHtml(p.mois)}</span><strong>${formatFCFA(p.montant)}</strong><span class="status ${cls}">${lab}</span>${dateLisible ? "<small>" + escapeHtml(dateLisible) + "</small>" : ""}${p.methode_paiement ? "<small>" + escapeHtml(METHODE_LABELS[p.methode_paiement] || p.methode_paiement) + (p.reference ? " — " + escapeHtml(p.reference) : "") + "</small>" : ""}</div>`;
                    }).join("")
                    : '<div class="empty-state">Aucun paiement enregistré.</div>';
            } catch (err) {
                el("payHistory").innerHTML = `<div class="empty-state">${escapeHtml(err.message)}</div>`;
            }
        }

        async function openPayModal(id) {
            const emp = state.employes.find((e) => String(e.id) === String(id));
            if (!emp) return;
            payEmployeeId = id;
            el("payEmployeeId").value = id;
            el("payModalTitle").textContent = `Payer le salaire de ${emp.nom}`;
            const form = el("payForm");
            form.reset();
            clearFormErrors(form);
            const now = new Date();
            form.pay_mois.value = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
            form.pay_montant.value = Number(emp.salaire || 0) || "";
            form.pay_statut.value = "paye";
            form.pay_date.value = now.toISOString().slice(0, 10);
            el("payHistory").innerHTML = '<div class="empty-state">Chargement...</div>';
            el("payModal").style.display = "flex";
            await loadPayHistory(id);
        }

        async function submitPayment(e) {
            e.preventDefault();
            const form = el("payForm");
            const btn = form.querySelector('button[type="submit"]');
            if (btn.disabled) return;
            clearFormErrors(form);

            const errors = validateFields(form, [
                { name: "pay_montant", test: (i) => i.value === "" || Number(i.value) <= 0, message: "Le montant doit être supérieur à 0." },
                { name: "pay_mois", test: (i) => !i.value, message: "Le mois est obligatoire." },
            ]);
            if (Object.keys(errors).length) {
                applyServerErrors(form, errors);
                return;
            }

            const payload = {
                montant: form.pay_montant.value,
                mois: form.pay_mois.value,
                statut: form.pay_statut.value || "paye",
                date_paiement: form.pay_date.value || null,
                methode_paiement: form.pay_methode.value || "especes",
                reference: form.pay_reference.value || null,
            };

            const originalLabel = btn.textContent;
            btn.disabled = true;
            btn.textContent = "Enregistrement...";

            try {
                const res = await apiRequest(`/employes/${payEmployeeId}/paiements`, { method: "POST", body: JSON.stringify(payload) });
                showToast(res.message);
                form.pay_mois.value = nextMonthOf(payload.mois);
                form.pay_reference.value = "";
                await loadAll();
                await loadPayHistory(payEmployeeId);
            } catch (err) {
                applyServerErrors(form, err.errors);
                showToast(err.message, "error");
            } finally {
                btn.disabled = false;
                btn.textContent = originalLabel;
            }
        }

        // ============================================================
        // Modal tâche
        // ============================================================

        function renderEmployeOptions(currentUid) {
            const actifs = state.employes.filter((e) => e.account_uid && e.statut === "actif");
            return '<option value="">— Aucun —</option>' + actifs.map(
                (e) => `<option value="${e.account_uid}"${currentUid === e.account_uid ? " selected" : ""}>${escapeHtml(e.nom)}${e.poste ? " (" + escapeHtml(e.poste) + ")" : ""}</option>`
            ).join("");
        }

        function openTaskAdd() {
            taskEditId = null;
            const form = el("taskForm");
            form.reset();
            clearFormErrors(form);
            el("taskId").value = "";
            el("taskModalTitle").textContent = "Ajouter une tâche";
            form.task_statut.value = "a_faire";
            el("task_employe").innerHTML = renderEmployeOptions(null);
            el("taskModal").style.display = "flex";
        }

        function openTaskEdit(item) {
            taskEditId = item.id;
            const form = el("taskForm");
            form.reset();
            clearFormErrors(form);
            el("taskId").value = item.id;
            el("taskModalTitle").textContent = "Modifier la tâche";
            form.task_titre.value = item.titre || "";
            form.task_description.value = item.description || "";
            form.task_echeance.value = item.echeance || "";
            form.task_statut.value = item.statut || "a_faire";
            el("task_employe").innerHTML = renderEmployeOptions(item.employe_uid);
            el("taskModal").style.display = "flex";
        }

        async function submitTask(e) {
            e.preventDefault();
            const form = el("taskForm");
            const btn = form.querySelector('button[type="submit"]');
            if (btn.disabled) return;
            clearFormErrors(form);

            const errors = validateFields(form, [
                { name: "task_titre", test: (i) => !i.value.trim(), message: "Le titre est obligatoire." },
            ]);
            if (Object.keys(errors).length) {
                applyServerErrors(form, errors);
                return;
            }

            const payload = {
                titre: form.task_titre.value.trim(),
                description: form.task_description.value.trim(),
                employe_uid: form.task_employe.value || null,
                statut: form.task_statut.value,
                echeance: form.task_echeance.value || null,
            };

            const originalLabel = btn.textContent;
            btn.disabled = true;
            btn.textContent = "Enregistrement...";

            try {
                if (taskEditId) {
                    await apiRequest(`/tasks/${taskEditId}`, { method: "PUT", body: JSON.stringify(payload) });
                } else {
                    await apiRequest("/tasks", { method: "POST", body: JSON.stringify(payload) });
                }
                showToast(taskEditId ? "Tâche modifiée avec succès." : "Tâche créée avec succès.");
                el("taskModal").style.display = "none";
                await loadAll();
            } catch (err) {
                applyServerErrors(form, err.errors);
                showToast(err.message, "error");
            } finally {
                btn.disabled = false;
                btn.textContent = originalLabel;
            }
        }

        async function deleteTask(id) {
            const okTask = await MIM.confirmPassword({
                title: "Supprimer cette tâche ?",
                message: "Cette action est définitive.",
                confirmLabel: "Supprimer",
            });
            if (!okTask) return;
            try {
                const res = await apiRequest(`/tasks/${id}`, { method: "DELETE" });
                showToast(res.message);
                await loadAll();
            } catch (err) {
                showToast(err.message, "error");
            }
        }

        // ============================================================
        // Initialisation
        // ============================================================

        let payEmployeeId = null;

        document.addEventListener("DOMContentLoaded", () => {
            document.querySelectorAll(".tab").forEach((t) =>
                t.addEventListener("click", () => switchTab(t.dataset.tab))
            );

            el("addBtn").addEventListener("click", () => {
                if (state.tab === "taches") openTaskAdd();
                else openEmployeeAdd();
            });

            el("cancelEmployeeModal").addEventListener("click", () => (el("employeeModal").style.display = "none"));
            el("cancelPayModal").addEventListener("click", () => (el("payModal").style.display = "none"));
            el("cancelTaskModal").addEventListener("click", () => (el("taskModal").style.display = "none"));
            el("employeeModal").addEventListener("click", (e) => { if (e.target === el("employeeModal")) el("employeeModal").style.display = "none"; });
            el("payModal").addEventListener("click", (e) => { if (e.target === el("payModal")) el("payModal").style.display = "none"; });
            el("taskModal").addEventListener("click", (e) => { if (e.target === el("taskModal")) el("taskModal").style.display = "none"; });

el("employeeForm").addEventListener("submit", submitEmployee);
            el("payForm").addEventListener("submit", submitPayment);
            el("taskForm").addEventListener("submit", submitTask);

            el("employeSearch").addEventListener("input", (e) => {
                state.search = e.target.value;
                renderEmployes();
            });

            el("emp_username").addEventListener("blur", async () => {
                const input = el("emp_username");
                const status = el("empUsernameStatus");
                const value = input.value.trim();
                if (!value) { status.textContent = ""; status.className = "username-status"; return; }
                if (!usernameValid(value)) {
                    status.textContent = "Lettres minuscules, chiffres, . _ - (3 à 30 caractères).";
                    status.className = "username-status username-taken";
                    return;
                }
                try {
                    const { available } = await apiRequest("/auth/username-available?username=" + encodeURIComponent(value));
                    if (available) {
                        status.textContent = "Disponible";
                        status.className = "username-status username-ok";
                    } else {
                        status.textContent = "Ce nom d'utilisateur est déjà utilisé.";
                        status.className = "username-status username-taken";
                    }
                } catch (err) {
                    status.textContent = "";
                }
            });

            el("employesList").addEventListener("click", (e) => {
                const editBtn = e.target.closest("[data-edit-e]");
                const payBtn = e.target.closest("[data-pay-e]");
                const delBtn = e.target.closest("[data-delete-e]");
                if (editBtn) {
                    const item = state.employes.find((x) => String(x.id) === String(editBtn.dataset.editE));
                    if (item) openEmployeeEdit(item);
                }
                if (payBtn) openPayModal(payBtn.dataset.payE);
                if (delBtn) deleteEmployee(delBtn.dataset.deleteE);
            });

            el("tachesList").addEventListener("click", (e) => {
                const editBtn = e.target.closest("[data-edit-task]");
                const delBtn = e.target.closest("[data-delete-task]");
                if (editBtn) {
                    const item = state.taches.find((x) => String(x.id) === String(editBtn.dataset.editTask));
                    if (item) openTaskEdit(item);
                }
if (delBtn) deleteTask(delBtn.dataset.deleteTask);
            });

            el("closeEmpResultModal").addEventListener("click", () => (el("empResultModal").style.display = "none"));
            el("empResultModal").addEventListener("click", (e) => {
                if (e.target === el("empResultModal")) el("empResultModal").style.display = "none";
            });
            el("empCopyCredentialsBtn").addEventListener("click", async () => {
                const creds = el("empAccountCredentials").dataset.credentials || "";
                try {
                    await navigator.clipboard.writeText(creds);
                    el("empCopyCredentialsBtn").textContent = "Copié ✓";
                    setTimeout(() => (el("empCopyCredentialsBtn").textContent = "Copier les identifiants"), 2000);
                } catch {
                    window.prompt("Copiez ces identifiants :", creds);
                }
            });

            loadAll();
        });
    