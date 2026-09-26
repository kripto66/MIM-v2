/* MIM — versements (espace agence, mode 1) */
(function () {
    "use strict";

    var UI = window.MIMUI;

    function renderKpis(rows) {
        var by = function (st) {
            return rows
                .filter(function (v) { return v.statut === st; })
                .reduce(function (s, v) { return s + Number(v.montant || 0); }, 0);
        };
        var cards = [
            { label: "Total reversé", value: UI.fmtFCFA(by("effectue")), tone: "success" },
            { label: "En attente de confirmation", value: UI.fmtFCFA(by("attente") + by("en_cours")), tone: by("attente") + by("en_cours") > 0 ? "warning" : "" },
            { label: "Annulés", value: UI.fmtFCFA(by("annule")), tone: "muted" },
            { label: "Versements", value: String(rows.length), tone: "accent" },
        ];
        document.getElementById("kpis").innerHTML = cards
            .map(function (c) {
                return (
                    '<article class="mim-kpi" data-tone="' + c.tone + '">' +
                    '<span class="kpi-label">' + escapeHtml(c.label) + "</span>" +
                    '<span class="kpi-value">' + escapeHtml(c.value) + "</span></article>"
                );
            })
            .join("");
    }

    async function setStatut(id, statut, btn) {
        btn.disabled = true;
        try {
            await apiRequest("/agence/versements/" + id + "/statut", { method: "POST", body: JSON.stringify({ statut: statut }) });
            MIM.showSuccess("Versement mis à jour.");
            await load();
        } catch (err) {
            MIM.showError((err && err.message) || "Mise à jour impossible.");
            btn.disabled = false;
        }
    }

    function render(rows) {
        var node = document.getElementById("versementsList");
        UI.setText("versementsMeta", rows.length + " versement(s)");
        if (!rows.length) {
            node.innerHTML = '<div class="mim-empty">Aucun versement enregistré.</div>';
            return;
        }
        node.innerHTML =
            '<ul class="mim-list">' +
            rows
                .map(function (v) {
                    var actions = "";
                    if (v.statut === "attente") {
                        actions =
                            '<button class="btn btn-secondary btn-sm" data-effectue="' + v.id + '" type="button">Marquer effectué</button> ' +
                            '<button class="btn btn-secondary btn-sm" data-annule="' + v.id + '" type="button">Annuler</button>';
                    } else if (v.statut === "en_cours") {
                        actions = '<button class="btn btn-secondary btn-sm" data-effectue="' + v.id + '" type="button">Marquer effectué</button>';
                    }
                    return (
                        '<li class="mim-list-item">' +
                        '<div class="li-main">' +
                        '<span class="li-title">' + escapeHtml(UI.fmtFCFA(v.montant)) + (v.periode ? " · " + escapeHtml(UI.formatMois(v.periode)) : "") + "</span>" +
                        '<span class="li-meta">' +
                        escapeHtml(
                            [
                                v.proprietaire ? v.proprietaire.name : "Propriétaire inconnu",
                                v.methode_paiement || null,
                                v.reference ? "Réf. " + v.reference : null,
                                "Demandé le " + UI.formatDate(v.created_at),
                                v.effectue_a ? "Effectué le " + UI.formatDate(v.effectue_a) : null,
                            ]
                                .filter(Boolean)
                                .join(" · ")
                        ) +
                        "</span></div>" +
                        '<div class="li-right" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
                        UI.badgeHtml(v.statut) +
                        actions +
                        "</div></li>"
                    );
                })
                .join("") +
            "</ul>";

        node.querySelectorAll("[data-effectue]").forEach(function (btn) {
            btn.addEventListener("click", function () {
                setStatut(Number(btn.getAttribute("data-effectue")), "effectue", btn);
            });
        });
        node.querySelectorAll("[data-annule]").forEach(function (btn) {
            btn.addEventListener("click", function () {
                if (!window.confirm("Annuler ce versement ?")) return;
                setStatut(Number(btn.getAttribute("data-annule")), "annule", btn);
            });
        });
    }

    async function fillProprietaires() {
        try {
            var res = await apiRequest("/agence/proprietaires");
            var list = (res && res.data) || [];
            var select = document.getElementById("vProprietaire");
            select.innerHTML = '<option value="">— Propriétaire —</option>' +
                list
                    .map(function (o) {
                        return '<option value="' + escapeHtml(o.proprietaire_id) + '">' + escapeHtml(o.nom || o.email || o.proprietaire_id) + "</option>";
                    })
                    .join("");
        } catch (err) {
            console.error(err);
        }
    }

    async function load() {
        try {
            var res = await apiRequest("/agence/versements");
            var rows = res.versements || [];
            renderKpis(rows);
            render(rows);
        } catch (err) {
            MIM.showError((err && err.message) || "Impossible de charger les versements.");
        }
    }

    document.addEventListener("DOMContentLoaded", function () {
        document.getElementById("versementsList").innerHTML = UI.skeleton(4, 20);
        fillProprietaires();
        load();

        var form = document.getElementById("versementForm");
        form.addEventListener("submit", async function (e) {
            e.preventDefault();
            var proprietaire = document.getElementById("vProprietaire").value;
            var montant = document.getElementById("vMontant").value;
            if (!proprietaire) return MIM.showError("Choisissez un propriétaire.");
            if (!montant || Number(montant) <= 0) return MIM.showError("Saisissez un montant valide.");

            var btn = form.querySelector("button[type=submit]");
            btn.disabled = true;
            try {
                await apiRequest("/agence/versements", {
                    method: "POST",
                    body: JSON.stringify({
                        proprietaire_id: proprietaire,
                        montant: Number(montant),
                        periode: document.getElementById("vPeriode").value || null,
                        methode_paiement: document.getElementById("vMethode").value,
                        reference: document.getElementById("vReference").value.trim(),
                        note: document.getElementById("vNote").value.trim(),
                    }),
                });
                form.reset();
                MIM.showSuccess("Versement envoyé : le propriétaire peut le confirmer.");
                await load();
            } catch (err) {
                MIM.showError((err && err.message) || "Envoi impossible.");
            } finally {
                btn.disabled = false;
            }
        });
    });
})();
