        const LOGEMENT_STATUS = {
            libre: ["Libre", "status-success"],
            occupe: ["Occupé", "status-warning"],
            maintenance: ["Maintenance", "status-danger"],
        };

        let logementsCache = [];

        function fmtFCFA(n) {
            return `${Number(n || 0).toLocaleString("fr-FR")} FCFA`;
        }

        function toggleChambres() {
            const group = document.getElementById("chambresGroup");
            if (document.getElementById("type").value === "appartement") group.style.display = "block";
            else {
                group.style.display = "none";
                document.getElementById("nombre_chambres").value = "";
            }
        }

        CrudPage.init({
            resource: "logements",
            listEl: "logementsList",
            addBtnEl: "addLogementBtn",
            modalId: "logementModal",
            modalTitleId: "modalTitle",
            formId: "logementForm",
            idFieldId: "logementId",
            cancelBtnId: "cancelModal",
            addTitle: "Ajouter un logement",
            onOpenAdd: () => {
                document.getElementById("type").value = "appartement";
                toggleChambres();
            },
            validate: (form) => validateFields(form, [
                {
                    name: "nom",
                    test: (i) => !i.value.trim(),
                    message: "Le nom du logement est obligatoire.",
                },
                {
                    name: "nombre_chambres",
                    test: (i) => form.type.value === "appartement" && (i.value === "" || Number(i.value) < 1),
                    message: "Indiquez le nombre de chambres.",
                },
                {
                    name: "loyer_mensuel",
                    test: (i) => i.value === "" || Number(i.value) <= 0,
                    message: "Saisissez un loyer mensuel valide.",
                },
            ]),
            afterInit: () => {
                document.getElementById("type").addEventListener("change", toggleChambres);
            },
            afterLoad: (data) => {
                logementsCache = data;
            },
            renderItem: (l) => {
                const [label, cls] = LOGEMENT_STATUS[l.statut] || [l.statut, "status-info"];
                return `
                    <div class="crud-card">
                        <div>
                            <h3>${escapeHtml(l.nom)}</h3>
                            <p>${l.type === "chambre" ? "Chambre" : "Appartement"}${l.nombre_chambres ? " · " + escapeHtml(l.nombre_chambres) + " chambre(s)" : ""} — <strong>${fmtFCFA(l.loyer_mensuel)}</strong> / mois</p>
                            ${l.adresse ? `<p class="muted">📍 ${escapeHtml(l.adresse)}</p>` : ""}
                            <p><span class="status ${cls}">${escapeHtml(label)}</span></p>
                        </div>
                        <div class="card-actions">
                            <button class="btn btn-edit" data-edit="${l.id}">Modifier</button>
                            <button class="btn btn-delete" data-delete="${l.id}">Supprimer</button>
                        </div>
                    </div>`;
            }
        });

    