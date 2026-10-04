/* MIM — entretien du parc (espace propriétaire délégué, lecture seule) */
(function () {
    "use strict";

    var UI = window.MIMUI;
    var state = { loading: false };

    function renderKpis(t) {
        var cards = [
            { label: "Incidents ouverts", value: t.incidentsOuverts, tone: t.incidentsOuverts > 0 ? "danger" : "success", sub: "sur " + t.incidents + " signalé(s)" },
            { label: "Interventions planifiées", value: t.interventionsPlanifiees, tone: t.interventionsPlanifiees > 0 ? "warning" : "", sub: "à venir" },
            { label: "Interventions en cours", value: t.interventions - t.interventionsPlanifiees - t.interventionsTerminees, tone: "accent", sub: "démarrées" },
            { label: "Interventions terminées", value: t.interventionsTerminees, tone: "success", sub: "clôturées" },
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

    function renderIncidents(data) {
        document.getElementById("incidentsMeta").textContent =
            data.totaux.incidents + " signalé(s) · " + data.totaux.incidentsOuverts + " ouvert(s)";
        var node = document.getElementById("incidentsList");
        if (!data.incidents.length) {
            node.innerHTML = '<div class="mim-empty">Aucun incident signalé sur vos biens confiés.</div>';
            return;
        }
        node.innerHTML =
            '<ul class="mim-list">' +
            data.incidents
                .map(function (inc) {
                    var meta = [
                        inc.logement_nom ? inc.logement_nom + (inc.bien_nom ? " (" + inc.bien_nom + ")" : "") : "Logement inconnu",
                        UI.formatDateTime(inc.created_at),
                        inc.interventions.length ? inc.interventions.length + " intervention(s)" : "sans intervention",
                    ]
                        .filter(Boolean)
                        .join(" · ");
                    var droit = "";
                    if (inc.interventions.length) {
                        droit += '<span class="mim-badge" data-tone="accent">' + inc.interventions.length + "</span>";
                    }
                    droit += UI.badgeHtml(inc.statut === "resolu" ? "resolu" : inc.statut === "en_cours" ? "en_cours" : "ouvert");
                    return UI.listItem({ title: inc.titre, meta: meta, right: droit });
                })
                .join("") +
            "</ul>";
    }

    function renderInterventions(data) {
        document.getElementById("interventionsMeta").textContent =
            data.totaux.interventions + " intervention(s)";
        var node = document.getElementById("interventionsList");
        if (!data.interventions.length) {
            node.innerHTML = '<div class="mim-empty">Aucune intervention prévue pour le moment.</div>';
            return;
        }
        node.innerHTML =
            '<ul class="mim-list">' +
            data.interventions
                .map(function (it) {
                    var meta = [
                        it.logement_nom ? it.logement_nom + (it.bien_nom ? " (" + it.bien_nom + ")" : "") : null,
                        it.date_prevue ? "Prévue le " + UI.formatDate(it.date_prevue) : "Date non fixée",
                        it.prestataire ? it.prestataire.nom + (it.prestataire.specialite ? " · " + it.prestataire.specialite : "") : "Prestataire non assigné",
                        it.incident ? "Incident : " + it.incident.titre : null,
                    ]
                        .filter(Boolean)
                        .join(" · ");
                    return UI.listItem({ title: it.titre, meta: meta, right: UI.badgeHtml(it.statut) });
                })
                .join("") +
            "</ul>";
    }

    async function load() {
        if (state.loading) return;
        state.loading = true;
        try {
            var data = await window.MandatApi.entretien();
            renderKpis(data.totaux);
            renderIncidents(data);
            renderInterventions(data);
        } catch (err) {
            if (err && err.code === "MANDAT_NOT_FOUND") {
                MIM.showError("Aucun mandat actif. Vous pouvez continuer dans votre espace propriétaire complet.");
                setTimeout(function () {
                    window.location.href = "/PartProprietaires/dashboard.html";
                }, 2500);
                return;
            }
            MIM.showError((err && err.message) || "Impossible de charger l'entretien de votre parc.");
        } finally {
            state.loading = false;
        }
    }

    document.addEventListener("DOMContentLoaded", function () {
        UI.initGreeting({});
        document.getElementById("incidentsList").innerHTML = UI.skeleton(4, 20);
        document.getElementById("interventionsList").innerHTML = UI.skeleton(4, 20);
        load();
        UI.live({ load: load, button: "refreshBtn" });

        // Temps réel remplace le polling 180 s.
        if (window.MIMRealtime) {
            MIMRealtime.onChange(function () { load(); }, 800);
        }
    });
})();
