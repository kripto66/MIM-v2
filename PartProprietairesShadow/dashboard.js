/* MIM — dashboard propriétaire délégué (mandat agence) */
(function () {
    "use strict";

    var UI = window.MIMUI;
    var state = { data: null, loading: false };

    function skeletonZone(id, lines) {
        var node = document.getElementById(id);
        if (node) node.innerHTML = '<div class="mim-list">' + UI.skeleton(lines || 3, 18) + "</div>";
    }

    function renderKpis(t) {
        var cards = [
            { label: "Biens confiés", value: t.biens, tone: "accent", sub: "sous mandat actif" },
            { label: "Logements", value: t.logements, tone: "", sub: t.occupes + " occupé(s)" },
            { label: "Loyers gérés", value: UI.fmtShortFCFA(t.loyerTotal) + " F", tone: "success", sub: "par mois" },
            { label: "En retard", value: t.retards, tone: t.retards > 0 ? "danger" : "success", sub: t.retards > 0 ? "à régulariser" : "aucun retard" },
            { label: "Versé par l'agence", value: UI.fmtShortFCFA(t.verse) + " F", tone: "success", sub: "cumul confirmé" },
            { label: "Versement en attente", value: UI.fmtShortFCFA(t.verseAttente) + " F", tone: t.verseAttente > 0 ? "warning" : "", sub: "à recevoir" },
            { label: "Incidents ouverts", value: t.incidentsOuverts, tone: t.incidentsOuverts > 0 ? "warning" : "success", sub: "sur vos biens" },
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

    function renderAgence(data) {
        var a = data.agence;
        document.getElementById("agenceInfos").innerHTML = [
            { l: "Agence", v: (a && a.name) || "—" },
            { l: "Contact", v: (a && (a.phone || a.email)) || "—" },
            { l: "Mandat", v: "Actif" },
        ]
            .map(function (x) {
                return (
                    '<div class="mim-list-item"><div class="li-main"><span class="li-title">' +
                    escapeHtml(String(x.v)) +
                    '</span><span class="li-meta">' +
                    escapeHtml(x.l) +
                    "</span></div></div>"
                );
            })
            .join("");
    }

    function renderActions(data) {
        var a = data.agence || {};
        var cards = [
            { count: data.versements.filter(function (v) { return v.statut === "attente" || v.statut === "en_cours"; }).length, label: "Versement(s) à confirmer", href: "versements.html" },
            { count: data.messages.filter(function (m) { return !m.lu_par_destinataire; }).length, label: "Message(s) non lu(s)", href: "messages.html" },
            { count: data.totaux.incidentsOuverts, label: "Incident(s) ouvert(s)", href: "#incidentsList" },
            { count: 0, label: "Contacter l'agence : " + (a.phone || a.email || "messagerie"), href: "messages.html" },
        ];

        document.getElementById("actionsGrid").innerHTML = cards
            .map(function (c) {
                return (
                    '<a class="mim-action" href="' + escapeHtml(c.href) + '">' +
                    '<span class="action-count">' + escapeHtml(String(c.count)) + "</span>" +
                    '<span class="action-label">' + escapeHtml(c.label) + "</span></a>"
                );
            })
            .join("");
    }

    function renderBiens(data) {
        document.getElementById("biensMeta").textContent = data.totaux.biens + " bien(s) sous mandat";
        if (!data.biens.length) {
            document.getElementById("biensList").innerHTML = '<div class="mim-empty">Aucun bien n\'est actuellement sous mandat.</div>';
            return;
        }
        document.getElementById("biensList").innerHTML =
            '<ul class="mim-list">' +
            data.biens
                .map(function (b) {
                    return UI.listItem({
                        title: b.nom,
                        meta:
                            (b.adresse || "Adresse inconnue") +
                            " · " +
                            b.logementsOccupes +
                            "/" +
                            b.logements +
                            " occupé(s) · " +
                            UI.fmtFCFA(b.loyerTotal) +
                            " · " +
                            b.paiementsEnRetard +
                            " retard(s)",
                        right: UI.badgeHtml(b.incidentsOuverts ? "ouvert" : "resolu"),
                    });
                })
                .join("") +
            "</ul>";
    }

    function renderVersements(data) {
        if (!data.versements.length) {
            document.getElementById("versementsList").innerHTML = '<div class="mim-empty">Aucun versement pour le moment.</div>';
            return;
        }
        document.getElementById("versementsList").innerHTML =
            '<ul class="mim-list">' +
            data.versements
                .slice(0, 6)
                .map(function (v) {
                    return UI.listItem({
                        title: UI.fmtFCFA(v.montant) + (v.periode ? " · " + v.periode : ""),
                        meta: UI.formatDate(v.created_at) + (v.methode_paiement ? " · " + v.methode_paiement : ""),
                        right: UI.badgeHtml(v.statut),
                    });
                })
                .join("") +
            "</ul>";
    }

    function renderMessages(data) {
        var badge = document.getElementById("msgBadge");
        var unread = data.messages.filter(function (m) { return !m.lu_par_destinataire; }).length;
        if (badge) badge.textContent = String(unread);

        if (!data.messages.length) {
            document.getElementById("messagesList").innerHTML = '<div class="mim-empty">Aucun message de votre agence.</div>';
            return;
        }
        document.getElementById("messagesList").innerHTML =
            '<ul class="mim-list">' +
            data.messages
                .slice(0, 5)
                .map(function (m) {
                    return UI.listItem({
                        title: m.objet || "Message",
                        meta: UI.formatDateTime(m.created_at),
                        right: m.lu_par_destinataire ? "" : '<span class="mim-badge" data-tone="accent">Nouveau</span>',
                    });
                })
                .join("") +
            "</ul>";
    }

    function renderIncidents(data) {
        var rows = [];
        data.biens.forEach(function (b) {
            if (b.incidents) rows.push({ bien: b.nom, count: b.incidents, ouverts: b.incidentsOuverts });
        });
        if (!rows.length) {
            document.getElementById("incidentsList").innerHTML = '<div class="mim-empty">Aucun incident signalé.</div>';
            return;
        }
        document.getElementById("incidentsList").innerHTML =
            '<ul class="mim-list">' +
            rows
                .map(function (r) {
                    return UI.listItem({
                        title: r.bien,
                        meta: r.ouverts + " incident(s) ouvert(s) sur " + r.count,
                        right: UI.badgeHtml(r.ouverts ? "ouvert" : "resolu"),
                    });
                })
                .join("") +
            "</ul>";
    }

    async function load() {
        if (state.loading) return;
        state.loading = true;
        try {
            var data = await window.MandatApi.dashboard();
            state.data = data;

            UI.setText("ownerName", state.ownerName || "Propriétaire");
            renderAgence(data);
            renderKpis(data.totaux);
            renderActions(data);
            renderBiens(data);
            renderVersements(data);
            renderMessages(data);
            renderIncidents(data);
        } catch (err) {
            if (err && err.code === "MANDAT_NOT_FOUND") {
                MIM.showError("Aucun mandat actif. Vous pouvez continuer dans votre espace propriétaire complet.");
                setTimeout(function () {
                    window.location.href = "/PartProprietaires/dashboard.html";
                }, 2500);
                return;
            }
            MIM.showError((err && err.message) || "Impossible de charger votre espace.");
        } finally {
            state.loading = false;
        }
    }

    document.addEventListener("DOMContentLoaded", function () {
        UI.initGreeting({ word: "greetingWord" });
        skeletonZone("kpis", 3);
        skeletonZone("biensList", 3);
        skeletonZone("versementsList", 2);
        skeletonZone("messagesList", 2);
        skeletonZone("incidentsList", 2);

        fetch(
            (window.MIM && typeof MIM.apiHost === "function" ? MIM.apiHost() : window.location.origin) + "/api/auth/me",
            { credentials: "include", headers: { Accept: "application/json" } }
        )
            .then(function (r) { return r.json(); })
            .then(function (me) {
                if (me && me.user && me.user.name) {
                    state.ownerName = me.user.name;
                    UI.setText("ownerName", me.user.name);
                }
            })
            .catch(function () {});

        window.MandatApi.etat()
            .then(function (res) {
                if (res && res.mandat && res.mandat.depuis) {
                    UI.setText("mandatDepuis", "Mandat depuis le " + UI.formatDate(res.mandat.depuis));
                }
            })
            .catch(function () {});

        window.MandatApi.marquerMessagesLus().catch(function () {});
        load();

        UI.live({ load: load, button: "refreshBtn", intervalMs: 180000 });
    });
})();
