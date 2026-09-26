/* MIM — messagerie (espace agence, mode 1) */
(function () {
    "use strict";

    var UI = window.MIMUI;
    var moi = null;

    function render(rows) {
        var node = document.getElementById("messagesList");
        UI.setText("messagesMeta", rows.length + " message(s)");
        if (!rows.length) {
            node.innerHTML = '<div class="mim-empty">Aucun message. Écrivez à un propriétaire ci-dessus.</div>';
            return;
        }
        node.innerHTML =
            '<ul class="mim-list">' +
            rows
                .map(function (m) {
                    var deMoi = moi && m.auteur_id === moi;
                    return (
                        '<li class="mim-list-item" style="flex-direction:column;align-items:stretch;gap:8px;">' +
                        '<div class="li-main">' +
                        '<span class="li-title">' +
                        escapeHtml(m.objet || (deMoi ? "Votre message" : "Message du propriétaire")) +
                        "</span>" +
                        '<span class="li-meta">' +
                        escapeHtml(
                            [
                                m.proprietaire ? m.proprietaire.name : "Propriétaire",
                                UI.formatDateTime(m.created_at),
                                deMoi ? "envoyé par vous" : m.lu_par_destinataire ? "lu" : "non lu",
                            ].join(" · ")
                        ) +
                        "</span></div>" +
                        '<div style="font-size:13.5px;color:var(--text-soft);white-space:pre-wrap;">' +
                        escapeHtml(m.corps || "") +
                        "</div></li>"
                    );
                })
                .join("") +
            "</ul>";
    }

    async function fillProprietaires() {
        try {
            var res = await apiRequest("/agence/proprietaires");
            var list = (res && res.data) || [];
            var select = document.getElementById("mProprietaire");
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
            var me = await fetch(
                (window.MIM && typeof MIM.apiHost === "function" ? MIM.apiHost() : window.location.origin) + "/api/auth/me",
                { credentials: "include", headers: { Accept: "application/json" } }
            ).then(function (r) {
                return r.json();
            });
            if (me && me.user) moi = me.user.id;

            var res = await apiRequest("/agence/messages");
            render(res.messages || []);
        } catch (err) {
            MIM.showError((err && err.message) || "Impossible de charger la messagerie.");
        }
    }

    document.addEventListener("DOMContentLoaded", function () {
        document.getElementById("messagesList").innerHTML = UI.skeleton(3, 20);
        fillProprietaires();
        load();

        var form = document.getElementById("messageForm");
        form.addEventListener("submit", async function (e) {
            e.preventDefault();
            var proprietaire = document.getElementById("mProprietaire").value;
            var corps = document.getElementById("mCorps").value.trim();
            if (!proprietaire) return MIM.showError("Choisissez un destinataire.");
            if (!corps) return MIM.showError("Le message ne peut pas être vide.");

            var btn = form.querySelector("button[type=submit]");
            btn.disabled = true;
            try {
                await apiRequest("/agence/messages", {
                    method: "POST",
                    body: JSON.stringify({
                        proprietaire_id: proprietaire,
                        objet: document.getElementById("mObjet").value.trim(),
                        corps: corps,
                    }),
                });
                form.reset();
                MIM.showSuccess("Message envoyé.");
                await load();
            } catch (err) {
                MIM.showError((err && err.message) || "Envoi impossible.");
            } finally {
                btn.disabled = false;
            }
        });
    });
})();
