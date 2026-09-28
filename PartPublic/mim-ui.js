/* MIM — utilitaires d'interface partagés (tous dashboards) */
(function () {
    "use strict";

    var MOIS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

    var STATUTS = {
        attente: ["En attente", "warning"],
        retard: ["En retard", "danger"],
        paye: ["Payé", "success"],
        a_confirmer: ["À confirmer", "warning"],
        a_confirmer_agence: ["À confirmer", "warning"],
        en_validation: ["À valider", "accent"],
        refuse: ["Refusé", "danger"],
        non_recu: ["Non reçu", "danger"],
        actif: ["Actif", "success"],
        inactif: ["Inactif", "muted"],
        libre: ["Libre", "accent"],
        occupe: ["Occupé", "success"],
        maintenance: ["Maintenance", "warning"],
        planifie: ["Planifiée", "accent"],
        en_cours: ["En cours", "warning"],
        termine: ["Terminée", "success"],
        resolu: ["Résolu", "success"],
        ouvert: ["Ouvert", "danger"],
        en_attente: ["En attente", "warning"],
        effectue: ["Effectué", "success"],
        annule: ["Annulé", "muted"],
        publie: ["Publié", "success"],
        brouillon: ["Brouillon", "muted"]
    };

    function nf(nb, max) {
        try {
            return new Intl.NumberFormat("fr-FR", { maximumFractionDigits: max == null ? 0 : max }).format(Number(nb) || 0);
        } catch {
            return String(nb);
        }
    }

    function fmtFCFA(value) {
        return nf(value, 0) + " FCFA";
    }

    function fmtShortFCFA(value) {
        var n = Number(value) || 0;
        if (Math.abs(n) >= 1000000) return nf(n / 1000000, 1) + " M";
        if (Math.abs(n) >= 1000) return nf(n / 1000, n % 1000 === 0 ? 0 : 1) + " k";
        return nf(n, 0);
    }

    function toDate(value) {
        if (!value) return null;
        var d = value instanceof Date ? value : new Date(value);
        return isNaN(d.getTime()) ? null : d;
    }

    function formatDate(value) {
        var d = toDate(value);
        if (!d) return "—";
        return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
    }

    function formatDateTime(value) {
        var d = toDate(value);
        if (!d) return "—";
        return d.toLocaleString("fr-FR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    }

    function formatMois(ym) {
        var m = String(ym || "");
        // Ne peut renvoyer que du texte sûr : toute valeur hors AAAA-MM → "—".
        if (!/^\d{4}-\d{2}$/.test(m)) return "—";
        return ((MOIS[Number(m.slice(5, 7)) - 1] || "") + " " + m.slice(0, 4)).trim();
    }

    function badge(statut) {
        var key = String(statut || "").trim();
        var entry = STATUTS[key] || [key || "—", "muted"];
        return { label: entry[0], tone: entry[1] };
    }

    function badgeHtml(statut) {
        var b = badge(statut);
        return '<span class="mim-badge" data-tone="' + b.tone + '">' + escapeHtml(b.label) + "</span>";
    }

    function el(id) {
        return typeof id === "string" ? document.getElementById(id) : id;
    }

    function setText(target, value) {
        var node = el(target);
        if (node) node.textContent = value == null ? "—" : String(value);
    }

    function skeleton(count, height) {
        var out = "";
        for (var i = 0; i < (count || 3); i += 1) {
            out += '<div class="mim-skeleton" style="height:' + (height || 16) + 'px"></div>';
        }
        return out;
    }

    function setList(target, items, renderItem, emptyText) {
        var node = el(target);
        if (!node) return;
        var list = Array.isArray(items) ? items : [];
        if (!list.length) {
            node.innerHTML = '<div class="mim-empty">' + escapeHtml(emptyText || "Aucun élément à afficher.") + "</div>";
            return;
        }
        node.innerHTML = '<ul class="mim-list">' + list.map(renderItem).join("") + "</ul>";
    }

    function listItem(opts) {
        return (
            '<li class="mim-list-item">' +
            '<div class="li-main">' +
            '<span class="li-title">' + escapeHtml(opts.title || "—") + "</span>" +
            '<span class="li-meta">' + escapeHtml(opts.meta || "") + "</span>" +
            "</div>" +
            (opts.right || "") +
            "</li>"
        );
    }

    function greeting() {
        var h = new Date().getHours();
        if (h < 12) return "Bonjour";
        if (h < 18) return "Bon après-midi";
        return "Bonsoir";
    }

    function initGreeting(opts) {
        var options = opts || {};
        setText(options.word || "greetingWord", greeting());
        if (options.sub) {
            setText(
                options.sub,
                new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
            );
        }
    }

    function liveController(options) {
        var opts = options || {};
        var label = el(opts.label || "liveLabel");
        var wrap = el(opts.wrap || "liveIndicator");
        var timer = null;
        var running = false;

        function stamp() {
            if (!label) return;
            var d = new Date();
            label.textContent = "À jour à " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
        }

        function pause(text) {
            running = false;
            if (wrap) wrap.classList.add("paused");
            if (label) label.textContent = text || "En pause";
        }

        function resume() {
            running = true;
            if (wrap) wrap.classList.remove("paused");
        }

        async function refresh() {
            if (!running) return;
            try {
                await opts.load();
                stamp();
            } catch {
                if (label) label.textContent = "Erreur de rafraîchissement";
            }
        }

        document.addEventListener("visibilitychange", function () {
            if (document.hidden) pause("En pause");
            else {
                resume();
                refresh();
            }
        });

        resume();
        stamp();

        if (opts.button) {
            el(opts.button).addEventListener("click", function () {
                refresh();
            });
        }

        if (opts.intervalMs) {
            timer = setInterval(refresh, opts.intervalMs);
        }

        return {
            refresh: refresh,
            pause: pause,
            resume: resume,
            stop: function () {
                running = false;
                if (timer) clearInterval(timer);
            }
        };
    }

    function highlightTone(value, thresholds) {
        var t = thresholds || {};
        if (t.danger != null && value >= t.danger) return "danger";
        if (t.warning != null && value >= t.warning) return "warning";
        if (t.success != null && value >= t.success) return "success";
        return "accent";
    }

    window.MIMUI = {
        nf: nf,
        fmtFCFA: fmtFCFA,
        fmtShortFCFA: fmtShortFCFA,
        formatDate: formatDate,
        formatDateTime: formatDateTime,
        formatMois: formatMois,
        badge: badge,
        badgeHtml: badgeHtml,
        el: el,
        setText: setText,
        skeleton: skeleton,
        setList: setList,
        listItem: listItem,
        greeting: greeting,
        initGreeting: initGreeting,
        live: liveController,
        tone: highlightTone
    };
})();
