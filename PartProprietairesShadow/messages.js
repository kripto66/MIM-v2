/* MIM — messagerie (espace propriétaire délégué) */
(function () {
    "use strict";

    var UI = window.MIMUI;
    var moi = null;

    function render(rows) {
        var node = document.getElementById("messagesList");
        UI.setText("messagesMeta", rows.length + " message(s)");
        if (!rows.length) {
            node.innerHTML = '<div class="mim-empty">Aucun message. Écrivez à votre agence ci-dessus.</div>';
            return;
        }
        node.innerHTML =
            '<ul class="mim-list">' +
            rows
                .map(function (m) {
                    var deMoi = moi && m.auteur_id === moi;
                    return (
                        '<li class="mim-list-item" style="flex-direction:column;align-items:stretch;gap:8px">' +
                        '<div class="li-main">' +
                        '<span class="li-title">' + escapeHtml(m.objet || (deMoi ? "Votre message" : "Message de l'agence")) + "</span>" +
                        '<span class="li-meta">' + escapeHtml(UI.formatDateTime(m.created_at)) + " · " + (deMoi ? "vous" : "agence") + "</span>" +
                        "</div>" +
                        '<div class="li-body" style="font-size:13.5px;color:var(--text-soft);white-space:pre-wrap;">' +
                        escapeHtml(m.corps || "") +
                        "</div></li>"
                    );
                })
                .join("") +
            "</ul>";
    }

    async function load() {
        try {
            var me = await fetch(
                (window.MIM && typeof MIM.apiHost === "function" ? MIM.apiHost() : window.location.origin) + "/api/auth/me",
                { credentials: "include", headers: { Accept: "application/json" } }
            ).then(function (r) {
                return r.json();
            });
            if (me && me.user) moi = me.user.id;

            var res = await window.MandatApi.messages();
            render(res.messages || []);
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
            MIM.showError((err && err.message) || "Impossible de charger la messagerie.");
        }
    }

    document.addEventListener("DOMContentLoaded", function () {
        document.getElementById("messagesList").innerHTML = UI.skeleton(3, 20);

        var form = document.getElementById("messageForm");
        form.addEventListener("submit", async function (e) {
            e.preventDefault();
            var corps = document.getElementById("corps").value.trim();
            if (!corps) {
                MIM.showError("Le message ne peut pas être vide.");
                return;
            }
            var btn = form.querySelector("button[type=submit]");
            btn.disabled = true;
            try {
                await window.MandatApi.envoyerMessage(document.getElementById("objet").value.trim(), corps);
                form.reset();
                MIM.showSuccess("Message envoyé à votre agence.");
                await load();
            } catch (err) {
                MIM.showError((err && err.message) || "Envoi impossible.");
            } finally {
                btn.disabled = false;
            }
        });

        load();
    });
})();
