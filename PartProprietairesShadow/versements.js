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
            btn.addEventListener("click", function () {
                var id = Number(btn.getAttribute("data-confirm"));
                var ref = window.prompt("Référence du virement (optionnel) :", "");
                if (ref === null) return;
                confirmer(id, ref, btn);
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
            MIM.showError((err && err.message) || "Impossible de charger les versements.");
        }
    }

    document.addEventListener("DOMContentLoaded", function () {
        UI.initGreeting({});
        document.getElementById("versementsList").innerHTML = UI.skeleton(4, 20);
        load();
    });
})();
