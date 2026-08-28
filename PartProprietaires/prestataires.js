CrudPage.init({
    resource: "prestataires",
    listEl: "prestatairesList",
    addBtnEl: "addPrestataireBtn",
    modalId: "prestataireModal",
    modalTitleId: "modalTitle",
    formId: "prestataireForm",
    idFieldId: "prestataireId",
    cancelBtnId: "cancelModal",
    validate: (form) => validateFields(form, [
        {
            name: "nom",
            test: (i) => !i.value.trim(),
            message: "Le nom du prestataire est obligatoire.",
        },
    ]),
    renderItem: (p) => `
        <div class="crud-card">
            <div>
                <h3>${escapeHtml(p.nom)}</h3>
                <p>${escapeHtml(p.specialite || "")}</p>
                <p>${p.phone ? escapeHtml(p.phone) : ""}${p.email ? ' — ' + escapeHtml(p.email) : ""}</p>
            </div>
            <div class="card-actions">
                <button class="btn btn-edit" data-edit="${p.id}">Modifier</button>
                <button class="btn btn-delete" data-delete="${p.id}">Supprimer</button>
            </div>
        </div>`
});
