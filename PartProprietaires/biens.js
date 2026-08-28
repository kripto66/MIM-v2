CrudPage.init({
    resource: "biens",
    listEl: "biensList",
    addBtnEl: "addBienBtn",
    modalId: "bienModal",
    modalTitleId: "modalTitle",
    formId: "bienForm",
    idFieldId: "bienId",
    cancelBtnId: "cancelModal",
    validate: (form) => validateFields(form, [
        {
            name: "nom",
            test: (i) => !i.value.trim(),
            message: "Le nom du bien est obligatoire.",
        },
    ]),
    renderItem: (b) => `
        <div class="crud-card">
            <div>
                <h3>${escapeHtml(b.nom)}</h3>
                <p>${escapeHtml(b.type || '')}${b.ville ? ' — ' + escapeHtml(b.ville) : ''}</p>
                ${b.adresse ? `<p>${escapeHtml(b.adresse)}</p>` : ''}
                ${b.description ? `<p class="muted">${escapeHtml(b.description)}</p>` : ''}
            </div>
            <div class="card-actions">
                <button class="btn btn-edit" data-edit="${b.id}">Modifier</button>
                <button class="btn btn-delete" data-delete="${b.id}">Supprimer</button>
            </div>
        </div>`
});
