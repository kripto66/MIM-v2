        const INTERVENTION_STATUS = {
            planifie: ["Planifiée", "status-info"],
            en_cours: ["En cours", "status-warning"],
            termine: ["Terminée", "status-success"],
        };

        let incidentsCache = [];
        let prestatairesCache = [];
        let logementsCache = [];

        async function loadData() {
            try {
                const [inc, pre, log] = await Promise.all([
                    apiRequest("/incidents"),
                    apiRequest("/prestataires"),
                    apiRequest("/logements"),
                ]);
                incidentsCache = inc.data;
                prestatairesCache = pre.data;
                logementsCache = log.data;

                document.getElementById("incident_id").innerHTML =
                    '<option value="">— Aucun —</option>' + inc.data.map(
                        (i) => `<option value="${i.id}">${escapeHtml(i.titre)}</option>`
                    ).join("");

                document.getElementById("prestataire_id").innerHTML =
                    '<option value="">— Aucun —</option>' + pre.data.map(
                        (p) => `<option value="${p.id}">${escapeHtml(p.nom)}</option>`
                    ).join("");

                document.getElementById("logement_id").innerHTML =
                    '<option value="">— Aucun —</option>' + log.data.map(
                        (l) => `<option value="${l.id}">${escapeHtml(l.nom)}</option>`
                    ).join("");
            } catch (err) {
                console.error(err);
            }
        }

        function formatDate(d) {
            if (!d) return "";
            const dt = new Date(d);
            return dt.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
        }

        const requestedPrestataire = new URLSearchParams(window.location.search).get("prestataire");
        loadData().then(() => {
            if (requestedPrestataire) document.getElementById("prestataire_id").value = requestedPrestataire;
            CrudPage.init({
            resource: "interventions",
            listEl: "interventionsList",
            addBtnEl: "addInterventionBtn",
            modalId: "interventionModal",
            modalTitleId: "modalTitle",
            formId: "interventionForm",
            idFieldId: "interventionId",
            cancelBtnId: "cancelModal",
            validate: (form) => validateFields(form, [
                {
                    name: "titre",
                    test: (i) => !i.value.trim(),
                    message: "Le titre de l'intervention est obligatoire.",
                },
                {
                    name: "incident_id",
                    test: (i) => !i.value,
                    message: "Choisissez l'incident concerné.",
                },
            ]),
            renderItem: (i) => {
                const [label, cls] = INTERVENTION_STATUS[i.statut] || [i.statut, "status-info"];
                const incident = incidentsCache.find((x) => String(x.id) === String(i.incident_id));
                const prestataire = prestatairesCache.find((x) => String(x.id) === String(i.prestataire_id));
                const logement = logementsCache.find((x) => String(x.id) === String(i.logement_id));
                return `
                    <div class="crud-card">
                        <div>
                            <h3>${escapeHtml(i.titre)}</h3>
                            <p>${prestataire ? "Prestataire : " + escapeHtml(prestataire.nom) : ""}</p>
                            <p>${logement ? "Logement : " + escapeHtml(logement.nom) : ""}</p>
                            ${i.date_prevue ? `<p>Prévue le ${formatDate(i.date_prevue)}</p>` : ''}
                            <p><span class="status ${cls}">${escapeHtml(label)}</span></p>
                        </div>
                        <div class="card-actions">
                            <button class="btn btn-edit" data-edit="${i.id}">Modifier</button>
                            <button class="btn btn-delete" data-delete="${i.id}">Supprimer</button>
                        </div>
                    </div>`;
            }
            });
        });
    