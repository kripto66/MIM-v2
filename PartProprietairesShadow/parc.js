/* MIM — drill-down du parc (espace propriétaire délégué, lecture seule) */
(function () {
    "use strict";

    var UI = window.MIMUI;
    var state = { loading: false };

    function renderKpis(lg, loc) {
        var cards = [
            { label: "Logements", value: lg.totaux.logements, tone: "", sub: lg.totaux.occupes + " occupé(s)" },
            { label: "Loyer mensuel", value: UI.fmtShortFCFA(lg.totaux.loyerTotal) + " F", tone: "success", sub: "parc confié" },
            { label: "Loyers en retard", value: lg.totaux.retards, tone: lg.totaux.retards > 0 ? "danger" : "success", sub: "mois " + (lg.mois || "") },
            { label: "Sans locataire", value: lg.totaux.sansLocataire, tone: lg.totaux.sansLocataire > 0 ? "warning" : "", sub: "logement(s) libre(s)" },
            { label: "Locataires", value: loc.totaux.total, tone: "accent", sub: loc.totaux.actifs + " actif(s)" },
            { label: "Impayés du mois", value: loc.totaux.impayes, tone: loc.totaux.impayes > 0 ? "danger" : "success", sub: "locataire(s)" },
        ];

        document.getElementById("kpis").innerHTML = cards
            .map(function (c) {
                return (
                    '<article class="mim-kpi" data-tone="' + c.tone + '">' +
                    '<span class="kpi-label">' + escapeHtml(c.label) + "</span>" +
                    '<span class="kpi-value">' + escapeHtml(String(c.value)) + "</span>" +
                    '<span class="kpi-sub">' + escapeHtml(c.sub) + "</span>" +
                    "</article>"
                );
            })
            .join("");
    }

    function renderLogements(data) {
        document.getElementById("logementsMeta").textContent =
            data.totaux.logements + " logement(s) · " + data.totaux.occupes + " occupé(s)";
        var node = document.getElementById("logementsList");
        if (!data.logements.length) {
            node.innerHTML = '<div class="mim-empty">Aucun logement sous mandat.</div>';
            return;
        }
        node.innerHTML =
            '<ul class="mim-list">' +
            data.logements
                .map(function (l) {
                    var meta = [
                        l.bien_nom,
                        UI.fmtFCFA(l.loyer_mensuel),
                        l.locataire ? "Locataire : " + l.locataire.nom : "Sans locataire",
                        l.paiementMois ? "Mois " + data.mois : "Aucun échéancier ce mois",
                        l.incidentsOuverts ? l.incidentsOuverts + " incident(s)" : null,
                    ]
                        .filter(Boolean)
                        .join(" · ");
                    var droit = "";
                    if (l.paiementMois) droit += UI.badgeHtml(l.paiementMois.statut);
                    droit += UI.badgeHtml(l.statut);
                    return UI.listItem({ title: l.nom, meta: meta, right: droit });
                })
                .join("") +
            "</ul>";
    }

    function renderLocataires(data) {
        document.getElementById("locatairesMeta").textContent =
            data.totaux.total + " locataire(s) · " + data.totaux.actifs + " actif(s)";
        var node = document.getElementById("locatairesList");
        if (!data.locataires.length) {
            node.innerHTML = '<div class="mim-empty">Aucun locataire enregistré sur vos biens confiés.</div>';
            return;
        }
        node.innerHTML =
            '<ul class="mim-list">' +
            data.locataires
                .map(function (t) {
                    var meta = [
                        t.logement_nom ? t.logement_nom + (t.bien_nom ? " (" + t.bien_nom + ")" : "") : "Logement inconnu",
                        t.loyer_mensuel ? UI.fmtFCFA(t.loyer_mensuel) : null,
                        t.date_entree ? "Entrée le " + UI.formatDate(t.date_entree) : null,
                        t.phone || null,
                    ]
                        .filter(Boolean)
                        .join(" · ");
                    var droit = "";
                    if (t.paiementMois) droit += UI.badgeHtml(t.paiementMois.statut);
                    droit += UI.badgeHtml(t.statut);
                    return UI.listItem({ title: t.nom, meta: meta, right: droit });
                })
                .join("") +
            "</ul>";
    }

    function renderDepenses(data) {
        document.getElementById("depensesMeta").textContent =
            UI.fmtFCFA(data.totaux.moisCourant) + " F ce mois · " + UI.fmtFCFA(data.totaux.sixMois) + " F sur 6 mois";
        var node = document.getElementById("depensesList");
        if (!data.depenses.length) {
            node.innerHTML = '<div class="mim-empty">Aucune dépense enregistrée sur vos biens confiés.</div>';
            return;
        }
        node.innerHTML =
            '<ul class="mim-list">' +
            data.depenses
                .slice(0, 12)
                .map(function (d) {
                    var meta = [
                        d.bien_nom,
                        d.categorie,
                        d.date_depense ? "Le " + UI.formatDate(d.date_depense) : null,
                    ]
                        .filter(Boolean)
                        .join(" · ");
                    return UI.listItem({
                        title: d.libelle,
                        meta: meta,
                        right: '<span class="mim-badge" data-tone="accent">' + escapeHtml(UI.fmtFCFA(d.montant)) + " F</span>",
                    });
                })
                .join("") +
            "</ul>";
    }

    async function load() {
        if (state.loading) return;
        state.loading = true;
        try {
            var res = await Promise.all([
                window.MandatApi.logements(),
                window.MandatApi.locataires(),
                window.MandatApi.depenses(),
            ]);
            var lg = res[0];
            var loc = res[1];
            renderKpis(lg, loc);
            renderLogements(lg);
            renderLocataires(loc);
            renderDepenses(res[2]);
        } catch (err) {
            if (err && err.code === "MANDAT_NOT_FOUND") {
                MIM.showError("Aucun mandat actif. Vous pouvez continuer dans votre espace propriétaire complet.");
                setTimeout(function () {
                    window.location.href = "/PartProprietaires/dashboard.html";
                }, 2500);
                return;
            }
            MIM.showError((err && err.message) || "Impossible de charger votre parc.");
        } finally {
            state.loading = false;
        }
    }

    document.addEventListener("DOMContentLoaded", function () {
        UI.initGreeting({});
        document.getElementById("logementsList").innerHTML = UI.skeleton(4, 20);
        document.getElementById("locatairesList").innerHTML = UI.skeleton(4, 20);
        document.getElementById("depensesList").innerHTML = UI.skeleton(3, 20);
        load();
        UI.live({ load: load, button: "refreshBtn", intervalMs: 180000 });
    });
})();
