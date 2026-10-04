/* MIM — rapport de gestion imprimable (espace propriétaire délégué)
   Assemble les données déjà exposées par l'espace délégué : aucune
   route dédiée, le rapport est une vue de synthèse en lecture seule. */
(function () {
    "use strict";

    var UI = window.MIMUI;
    var state = { loading: false };

    function table(cols, rows, foot) {
        var html =
            '<table class="rapport-table"><thead><tr>' +
            cols
                .map(function (c) {
                    return '<th' + (c.num ? ' class="num"' : "") + ">" + escapeHtml(c.label) + "</th>";
                })
                .join("") +
            "</tr></thead><tbody>" +
            rows
                .map(function (r) {
                    return (
                        "<tr>" +
                        r
                            .map(function (cell, i) {
                                return "<td" + (cols[i].num ? ' class="num"' : "") + ">" + cell + "</td>";
                            })
                            .join("") +
                        "</tr>"
                    );
                })
                .join("") +
            "</tbody>";
        if (foot) {
            html +=
                "<tfoot><tr>" +
                foot
                    .map(function (cell, i) {
                        return "<td" + (cols[i] && cols[i].num ? ' class="num"' : "") + ">" + cell + "</td>";
                    })
                    .join("") +
                "</tr></tfoot>";
        }
        return html + "</table>";
    }

    function kpis(cards) {
        return cards
            .map(function (c) {
                return (
                    '<article class="mim-kpi" data-tone="' + (c.tone || "") + '">' +
                    '<span class="kpi-label">' + escapeHtml(c.label) + "</span>" +
                    '<span class="kpi-value">' + escapeHtml(String(c.value)) + "</span>" +
                    '<span class="kpi-sub">' + escapeHtml(c.sub || "") + "</span>" +
                    "</article>"
                );
            })
            .join("");
    }

    function renderSynthese(dash, fin, dep) {
        var c = fin.courant;
        var net = Number(c.encaisse) - Number(dep.totaux.moisCourant);
        document.getElementById("syntheseMeta").textContent = "Mois " + fin.mois;
        document.getElementById("syntheseKpis").innerHTML = kpis([
            { label: "Attendu", value: UI.fmtFCFA(c.attendu) + " F", sub: "loyers occupés" },
            { label: "Encaissé", value: UI.fmtFCFA(c.encaisse) + " F", tone: "success", sub: (c.tauxEncaissement || 0) + " % de l'attendu" },
            { label: "Impayé", value: UI.fmtFCFA(c.impaye) + " F", tone: c.impaye > 0 ? "danger" : "success", sub: "en retard" },
            { label: "Dépenses du mois", value: UI.fmtFCFA(dep.totaux.moisCourant) + " F", tone: "warning", sub: dep.totaux.nb + " ligne(s) sur 6 mois" },
            { label: "Net du mois", value: UI.fmtFCFA(net) + " F", tone: net >= 0 ? "success" : "danger", sub: "encaissé − dépenses" },
            { label: "Versé par l'agence", value: UI.fmtFCFA(dash.totaux.verse) + " F", tone: "success", sub: UI.fmtFCFA(dash.totaux.verseAttente) + " F en attente" },
        ]);
    }

    function renderRevenus(fin) {
        var cols = [
            { label: "Mois" },
            { label: "Attendu", num: true },
            { label: "Encaissé", num: true },
            { label: "Impayé", num: true },
        ];
        var tot = { attendu: 0, paye: 0, retarde: 0 };
        var rows = fin.series.map(function (m) {
            tot.attendu += Number(m.attendu || 0);
            tot.paye += Number(m.paye || 0);
            tot.retarde += Number(m.retarde || 0);
            return [
                escapeHtml(m.mois),
                escapeHtml(UI.fmtFCFA(m.attendu) + " F"),
                escapeHtml(UI.fmtFCFA(m.paye) + " F"),
                escapeHtml(UI.fmtFCFA(m.retarde) + " F"),
            ];
        });
        document.getElementById("revenusMeta").textContent = "6 mois glissants";
        document.getElementById("revenusTable").innerHTML = table(
            cols,
            rows,
            ["Total", UI.fmtFCFA(tot.attendu) + " F", UI.fmtFCFA(tot.paye) + " F", UI.fmtFCFA(tot.retarde) + " F"]
        );
    }

    function renderDepenses(dep) {
        var moisCols = [{ label: "Mois" }, { label: "Lignes", num: true }, { label: "Total", num: true }];
        var totNb = 0;
        var totMontant = 0;
        var moisRows = dep.parMois.map(function (m) {
            totNb += Number(m.nb || 0);
            totMontant += Number(m.total || 0);
            return [escapeHtml(m.mois), escapeHtml(String(m.nb)), escapeHtml(UI.fmtFCFA(m.total) + " F")];
        });

        var detailCols = [
            { label: "Date" },
            { label: "Libellé" },
            { label: "Bien" },
            { label: "Catégorie" },
            { label: "Montant", num: true },
        ];
        var detailRows = dep.depenses.slice(0, 20).map(function (d) {
            return [
                escapeHtml(d.date_depense ? UI.formatDate(d.date_depense) : "—"),
                escapeHtml(d.libelle),
                escapeHtml(d.bien_nom || "—"),
                escapeHtml(d.categorie || "autre"),
                escapeHtml(UI.fmtFCFA(d.montant) + " F"),
            ];
        });

        document.getElementById("depensesMeta").textContent =
            UI.fmtFCFA(dep.totaux.sixMois) + " F sur 6 mois · " + UI.fmtFCFA(dep.totaux.moisCourant) + " F ce mois";
        document.getElementById("depensesTable").innerHTML =
            table(moisCols, moisRows, ["Total", String(totNb), UI.fmtFCFA(totMontant) + " F"]) +
            (detailRows.length
                ? '<div class="section-meta" style="margin-top:14px;">Dernières lignes enregistrées</div>' +
                  table(detailCols, detailRows, null)
                : '<div class="mim-empty">Aucune dépense enregistrée.</div>');
    }

    function renderParc(dash) {
        var t = dash.totaux;
        document.getElementById("parcMeta").textContent =
            t.biens + " bien(s) · " + t.logements + " logement(s) · " + t.occupes + " occupé(s)";
        if (!dash.biens.length) {
            document.getElementById("parcTable").innerHTML = '<div class="mim-empty">Aucun bien sous mandat.</div>';
            return;
        }
        var cols = [
            { label: "Bien" },
            { label: "Adresse" },
            { label: "Logements", num: true },
            { label: "Occupés", num: true },
            { label: "Loyer mensuel", num: true },
            { label: "Retards", num: true },
        ];
        var rows = dash.biens.map(function (b) {
            return [
                escapeHtml(b.nom),
                escapeHtml(b.adresse || "—"),
                escapeHtml(String(b.logements)),
                escapeHtml(String(b.logementsOccupes)),
                escapeHtml(UI.fmtFCFA(b.loyerTotal) + " F"),
                escapeHtml(String(b.paiementsEnRetard || 0)),
            ];
        });
        document.getElementById("parcTable").innerHTML = table(
            cols,
            rows,
            ["Total", "", String(t.logements), String(t.occupes), UI.fmtFCFA(t.loyerTotal) + " F", String(t.retards)]
        );
    }

    function renderEntretien(ent) {
        var t = ent.totaux;
        document.getElementById("entretienMeta").textContent =
            t.incidentsOuverts + " incident(s) ouvert(s) · " + t.interventionsPlanifiees + " intervention(s) planifiée(s)";
        var ouverts = ent.incidents.filter(function (i) { return i.statut !== "resolu"; });
        var cols = [
            { label: "Incident" },
            { label: "Logement" },
            { label: "Signalé le" },
            { label: "Statut" },
        ];
        var rows = ouverts.map(function (i) {
            return [
                escapeHtml(i.titre),
                escapeHtml((i.logement_nom || "—") + (i.bien_nom ? " · " + i.bien_nom : "")),
                escapeHtml(UI.formatDateTime(i.created_at)),
                UI.badgeHtml(i.statut === "resolu" ? "resolu" : i.statut === "en_cours" ? "en_cours" : "ouvert"),
            ];
        });
        document.getElementById("entretienTable").innerHTML = rows.length
            ? table(cols, rows, null)
            : '<div class="mim-empty">Aucun incident ouvert : parc en bon état.</div>';
    }

    function renderVersements(vers) {
        document.getElementById("versementsMeta").textContent = vers.length + " opération(s)";
        if (!vers.length) {
            document.getElementById("versementsTable").innerHTML = '<div class="mim-empty">Aucun versement enregistré.</div>';
            return;
        }
        var cols = [
            { label: "Période" },
            { label: "Montant", num: true },
            { label: "Statut" },
            { label: "Demandé le" },
        ];
        var rows = vers.slice(0, 20).map(function (v) {
            return [
                escapeHtml(v.periode || "—"),
                escapeHtml(UI.fmtFCFA(v.montant) + " F"),
                UI.badgeHtml(v.statut),
                escapeHtml(UI.formatDate(v.created_at)),
            ];
        });
        document.getElementById("versementsTable").innerHTML = table(cols, rows, null);
    }

    async function load() {
        if (state.loading) return;
        state.loading = true;
        try {
            var res = await Promise.all([
                window.MandatApi.dashboard(),
                window.MandatApi.finances(),
                window.MandatApi.depenses(),
                window.MandatApi.entretien(),
                window.MandatApi.versements(),
            ]);
            var dash = res[0];
            var fin = res[1];
            var dep = res[2];
            var ent = res[3];
            var vers = res[4];

            var edition = new Date();
            UI.setText(
                "rapportEdition",
                "Édité le " +
                    edition.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
            );
            document.getElementById("rapportPeriode").textContent =
                "Mois " +
                fin.mois +
                " · " +
                dash.totaux.biens +
                " bien(s) confié(s) à " +
                ((dash.agence && dash.agence.name) || "votre agence");
            document.getElementById("rapportPied").textContent =
                "Document généré par MIM — espace délégué, consultation seule. Les montants proviennent des données de l'agence.";

            renderSynthese(dash, fin, dep);
            renderRevenus(fin);
            renderDepenses(dep);
            renderParc(dash);
            renderEntretien(ent);
            renderVersements(vers);
        } catch (err) {
            if (err && err.code === "MANDAT_NOT_FOUND") {
                MIM.showError("Aucun mandat actif. Vous pouvez continuer dans votre espace propriétaire complet.");
                setTimeout(function () {
                    window.location.href = "/PartProprietaires/dashboard.html";
                }, 2500);
                return;
            }
            MIM.showError((err && err.message) || "Impossible de générer le rapport.");
        } finally {
            state.loading = false;
        }
    }

    document.addEventListener("DOMContentLoaded", function () {
        UI.initGreeting({});
        document.getElementById("revenusTable").innerHTML = UI.skeleton(4, 18);
        document.getElementById("depensesTable").innerHTML = UI.skeleton(4, 18);
        document.getElementById("printBtn").addEventListener("click", function () {
            window.print();
        });
        load();
        UI.live({ load: load, button: "refreshBtn" });

        // Temps réel remplace le polling 180 s.
        if (window.MIMRealtime) {
            MIMRealtime.onChange(function () { load(); }, 800);
        }
    });
})();
