const INCIDENT_STATUS = {
    nouveau: ["Nouveau", "status-danger"],
    en_cours: ["En cours", "status-warning"],
    intervention: ["Intervention", "status-warning"],
    resolu: ["Résolu", "status-success"],
};

let logementsCache = [];

async function loadLogements() {
    try {
        const { data } = await apiRequest("/logements");
        logementsCache = data;
        document.getElementById("logement_id").innerHTML =
            '<option value="">— Aucun —</option>' + data.map(
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

CrudPage.init({
    resource: "incidents",
    listEl: "incidentsList",
    addBtnEl: "addIncidentBtn",
    modalId: "incidentModal",
    modalTitleId: "modalTitle",
    formId: "incidentForm",
    idFieldId: "incidentId",
    cancelBtnId: "cancelModal",
    validate: (form) => validateFields(form, [
        {
            name: "titre",
            test: (i) => !i.value.trim(),
            message: "Le titre de l'incident est obligatoire.",
        },
        {
            name: "description",
            test: (i) => !i.value.trim(),
            message: "Décrivez l'incident.",
        },
        {
            name: "logement_id",
            test: (i) => !i.value,
            message: "Choisissez le logement concerné.",
        },
    ]),
    renderItem: (i) => {
        const [label, cls] = INCIDENT_STATUS[i.statut] || [i.statut, "status-info"];
        const logement = logementsCache.find((l) => String(l.id) === String(i.logement_id));
        return `
            <div class="crud-card">
                <div>
                    <h3>${escapeHtml(i.titre)}</h3>
                    <p>${logement ? "Logement : " + escapeHtml(logement.nom) : "Aucun logement"}</p>
                    ${i.description ? `<p class="muted">${escapeHtml(i.description)}</p>` : ''}
                    ${i.photo ? `<img class="incident-photo" src="${escapeHtml(i.photo)}" alt="Photo de l'incident">` : ''}
                    <p><span class="status ${cls}">${label}</span> <span class="muted">${formatDate(i.created_at)}</span></p>
                </div>
                <div class="card-actions">
                    <button class="btn btn-edit" data-edit="${i.id}">Modifier</button>
                    <button class="btn btn-delete" data-delete="${i.id}">Supprimer</button>
                </div>
            </div>`;
    }
});

loadLogements();
