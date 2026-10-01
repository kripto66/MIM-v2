/* MIM — versements (espace propriétaire délégué) */
(function () {
    "use strict";

    var UI = window.MIMUI;

    function renderKpis(rows) {
        var verse = rows
            .filter(function (v) { return v.statut === "effectue"; })
            .reduce(function (s, v) { return s + Number(v.montant || 0); }, 0);
        var attente = rows
            .filter(function (v) { return v.statut === "attente" || v.statut === "en_cours"; })
            .reduce(function (s, v) { return s + Number(v.montant || 0); }, 0);

        document.getElementById("kpis").innerHTML = [
            { label: "Total versé", value: UI.fmtFCFA(verse), tone: "success" },
            { label: "En attente", value: UI.fmtFCFA(attente), tone: attente > 0 ? "warning" : "" },
            { label: "Nombre de versements", value: String(rows.length), tone: "accent" },
        ]
            .map(function (c) {
                return (
                    '<article class="mim-kpi" data-tone="' + c.tone + '">' +
                    '<span class="kpi-label">' + escapeHtml(c.label) + "</span>" +
                    '<span class="kpi-value">' + escapeHtml(c.value) + "</span></article>"
                );
            })
            .join("");
    }

    async function confirmer(id, reference, btn) {
        btn.disabled = true;
        try {
            await window.MandatApi.confirmerVersement(id, reference);
            MIM.showSuccess("Versement confirmé.");
            await load();
        } catch (err) {
            MIM.showError((err && err.message) || "Confirmation impossible.");
            btn.disabled = false;
        }
    }

    function render(rows) {
        var node = document.getElementById("versementsList");
        if (!rows.length) {
            node.innerHTML = '<div class="mim-empty">Aucun versement enregistré.</div>';
            return;
        }
        node.innerHTML =
            '<ul class="mim-list">' +
            rows
                .map(function (v) {
                    var action = "";
                    if (v.statut === "attente" || v.statut === "en_cours") {
                        action =
                            '<button class="btn btn-primary btn-sm" data-confirm="' +
                            v.id +
                            '" type="button">Confirmer la réception</button>';
                    }
                    return (
                        '<li class="mim-list-item">' +
                        '<div class="li-main">' +
                        '<span class="li-title">' + escapeHtml(UI.fmtFCFA(v.montant)) + "</span>" +
                        '<span class="li-meta">' +
                        escapeHtml(
                            [
                                v.periode ? "Période " + v.periode : null,
                                "Demandé le " + UI.formatDate(v.created_at),
                                v.methode_paiement ? v.methode_paiement : null,
                                v.reference ? "Réf. " + v.reference : null,
                                v.effectue_a ? "Confirmé le " + UI.formatDate(v.effectue_a) : null,
                            ]
                                .filter(Boolean)
                                .join(" · ")
                        ) +
                        "</span></div>" +
                        '<div class="li-right">' +
                        UI.badgeHtml(v.statut) +
                        action +
                        "</div></li>"
                    );
                })
                .join("") +
            "</ul>";

        node.querySelectorAll("[data-confirm]").forEach(function (btn) {
            btn.addEventListener("click", async function () {
                var id = Number(btn.getAttribute("data-confirm"));
                var values = {};
                var ok = await MIM.confirmPassword({
                    title: "Confirmer la réception ?",
                    message: "Le versement sera clôturé et comptabilisé comme reçu.",
                    confirmLabel: "Confirmer la réception",
                    extraField: {
                        name: "reference",
                        label: "Référence du virement (optionnel)",
                    },
                    values: values,
                });
                if (!ok) return;
                confirmer(id, values.reference, btn);
            });
        });
    }

    async function load() {
        try {
            var res = await window.MandatApi.versements();
            var rows = res.versements || [];
            renderKpis(rows);
            render(rows);
        } catch (err) {
            // Meme repli que les 4 autres pages de l'espace : sans mandat,
            // on bascule vers l'espace complet au lieu d'un cul-de-sac.
            if (err && err.code === "MANDAT_NOT_FOUND") {
                MIM.showError("Aucun mandat actif. Vous pouvez continuer dans votre espace propriétaire complet.");
                setTimeout(function () {
                    window.location.href = "/PartProprietaires/dashboard.html";
                }, 2500);
                return;
            }
            MIM.showError((err && err.message) || "Impossible de charger les versements.");
        }
    }

    /* ============================================================
     * Moyens de réception — par où l'agence vous verse.
     * Reuse le référentiel du serveur (CHAMPS_MOYEN).
     * ============================================================ */
    var TYPE_LABELS = {
        wave: "Wave",
        orange_money: "Orange Money",
        virement: "Virement bancaire",
        especes: "Espèces",
    };
    var TYPE_ICONS = { wave: "🟣", orange_money: "🟠", virement: "🏦", especes: "💵" };
    var FIELD_LABELS = {
        nom_titulaire: "Nom du titulaire",
        numero: "Numéro",
        lien_paiement: "Lien de paiement (HTTPS)",
        banque: "Banque",
        num_compte: "Numéro de compte",
        iban: "IBAN",
        bic: "BIC / SWIFT",
        instructions: "Instructions",
    };
    var FIELDS_BY_TYPE = {
        wave: ["nom_titulaire", "numero", "lien_paiement", "instructions"],
        orange_money: ["nom_titulaire", "numero", "lien_paiement", "instructions"],
        virement: ["banque", "nom_titulaire", "num_compte", "iban", "bic", "instructions"],
        especes: ["instructions"],
    };

    var moyensCache = [];
    var editingMoyen = null;

    function fieldsHtml(type) {
        return (FIELDS_BY_TYPE[type] || [])
            .map(function (k) {
                return (
                    '<div class="form-group" style="margin-top:12px;">' +
                    '<label for="mf_' + k + '">' + escapeHtml(FIELD_LABELS[k] || k) + "</label>" +
                    '<input type="text" id="mf_' + k + '" data-field="' + k + '" maxlength="200">' +
                    "</div>"
                );
            })
            .join("");
    }

    function renderMoyens(list) {
        moyensCache = list;
        var node = document.getElementById("moyensList");
        if (!list.length) {
            node.innerHTML =
                '<div class="mim-empty">Aucun moyen de réception. Ajoutez-en un pour préciser comment votre agence doit vous payer.</div>';
            return;
        }
        node.innerHTML =
            '<ul class="mim-list">' +
            list
                .map(function (m) {
                    var details = (FIELDS_BY_TYPE[m.type] || [])
                        .filter(function (k) { return m[k]; })
                        .map(function (k) {
                            return escapeHtml(FIELD_LABELS[k] || k) + " : " + escapeHtml(m[k]);
                        })
                        .join("<br>");
                    return (
                        '<li class="mim-list-item">' +
                        '<div class="li-main">' +
                        '<span class="li-title">' +
                        (TYPE_ICONS[m.type] || "") + " " + escapeHtml(TYPE_LABELS[m.type] || m.type) +
                        (m.actif === false ? ' <span class="mim-badge" data-tone="warning">Inactif</span>' : "") +
                        "</span>" +
                        '<span class="li-meta">' + (details || "—") + "</span>" +
                        "</div>" +
                        '<div class="li-right">' +
                        '<button class="btn btn-secondary btn-sm" type="button" data-edit="' + m.id + '">Modifier</button>' +
                        '<button class="btn btn-delete btn-sm" type="button" data-del="' + m.id + '">Supprimer</button>' +
                        "</div></li>"
                    );
                })
                .join("") +
            "</ul>";
    }

    async function loadMoyens() {
        try {
            var res = await window.MandatApi.moyensReception();
            renderMoyens(res.data || []);
        } catch (err) {
            document.getElementById("moyensList").innerHTML =
                '<div class="mim-empty">Impossible de charger vos moyens de réception.</div>';
        }
    }

    function openMoyenModal(m) {
        editingMoyen = m || null;
        var type = (m && m.type) || "wave";
        document.getElementById("moyenModalTitle").textContent = m
            ? "Modifier le moyen de réception"
            : "Ajouter un moyen de réception";
        document.getElementById("moyenType").value = type;
        document.getElementById("moyenType").disabled = !!m;
        document.getElementById("moyenActif").checked = !m || m.actif !== false;
        var wrap = document.getElementById("moyenFields");
        wrap.innerHTML = fieldsHtml(type);
        if (m) {
            (FIELDS_BY_TYPE[type] || []).forEach(function (k) {
                var input = wrap.querySelector('[data-field="' + k + '"]');
                if (input && m[k]) input.value = m[k];
            });
        }
        document.getElementById("moyenOverlay").style.display = "flex";
    }

    function closeMoyenModal() {
        document.getElementById("moyenOverlay").style.display = "none";
        editingMoyen = null;
    }

    function moyenPayload() {
        var type = document.getElementById("moyenType").value;
        var body = { type: type, actif: document.getElementById("moyenActif").checked };
        var wrap = document.getElementById("moyenFields");
        (FIELDS_BY_TYPE[type] || []).forEach(function (k) {
            var input = wrap.querySelector('[data-field="' + k + '"]');
            if (input) body[k] = input.value.trim();
        });
        return body;
    }

    async function saveMoyen() {
        var btn = document.getElementById("moyenSave");
        var body = moyenPayload();
        if (!body.numero && (body.type === "wave" || body.type === "orange_money") && !body.lien_paiement) {
            MIM.showError("Renseignez au moins le numéro ou le lien de paiement.");
            return;
        }
        btn.disabled = true;
        try {
            var res = editingMoyen
                ? await window.MandatApi.majMoyenReception(editingMoyen.id, body)
                : await window.MandatApi.ajouterMoyenReception(body);
            closeMoyenModal();
            MIM.showSuccess(res.message || "Moyen de réception enregistré.");
            await loadMoyens();
        } catch (err) {
            MIM.showError((err && err.message) || "Enregistrement impossible.");
        } finally {
            btn.disabled = false;
        }
    }

    async function deleteMoyen(id) {
        var ok = await MIM.confirmPassword({
            title: "Supprimer ce moyen de réception ?",
            message: "Votre agence ne pourra plus vous verser par ce moyen.",
            confirmLabel: "Supprimer",
        });
        if (!ok) return;
        try {
            var res = await window.MandatApi.supprimerMoyenReception(id);
            MIM.showSuccess(res.message || "Moyen de réception supprimé.");
            await loadMoyens();
        } catch (err) {
            MIM.showError((err && err.message) || "Suppression impossible.");
        }
    }

    document.addEventListener("DOMContentLoaded", function () {
        UI.initGreeting({});
        document.getElementById("versementsList").innerHTML = UI.skeleton(4, 20);
        load();
        loadMoyens();

        document.getElementById("moyenType").addEventListener("change", function (e) {
            document.getElementById("moyenFields").innerHTML = fieldsHtml(e.target.value);
        });
        document.getElementById("addMoyenBtn").addEventListener("click", function () {
            openMoyenModal(null);
        });
        document.getElementById("moyenCancel").addEventListener("click", closeMoyenModal);
        document.getElementById("moyenOverlay").addEventListener("click", function (e) {
            if (e.target.id === "moyenOverlay") closeMoyenModal();
        });
        document.getElementById("moyenSave").addEventListener("click", saveMoyen);
        document.getElementById("moyensList").addEventListener("click", function (e) {
            var edit = e.target.closest("[data-edit]");
            var del = e.target.closest("[data-del]");
            if (edit) {
                var m = moyensCache.find(function (x) { return String(x.id) === String(edit.dataset.edit); });
                if (m) openMoyenModal(m);
            } else if (del) {
                deleteMoyen(del.dataset.del);
            }
        });
    });
})();
