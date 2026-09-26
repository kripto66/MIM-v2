/* MIM — API client (espace propriétaire délégué) */
(function () {
    "use strict";

    var API =
        (window.MIM && typeof MIM.apiHost === "function" ? MIM.apiHost() : window.location.origin || "http://localhost:3000") +
        "/api/mandat";

    async function request(path, options) {
        var opts = options || {};
        if (window.MIM && MIM._csrfReady) await MIM._csrfReady;
        var res = await fetch(API + path, {
            method: opts.method || "GET",
            credentials: "include",
            headers: Object.assign(
                { "Content-Type": "application/json" },
                window.MIM && typeof MIM.csrfHeader === "function" ? MIM.csrfHeader() : {}
            ),
            body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
        var parsed = await MIM.parse(res);
        if (!parsed.ok) {
            MIM.handleAuthError(parsed.error);
            throw parsed.error;
        }
        return parsed.data;
    }

    window.MandatApi = {
        etat: function () {
            return request("/etat");
        },
        dashboard: function () {
            return request("/dashboard");
        },
        versements: function () {
            return request("/versements");
        },
        confirmerVersement: function (id, reference) {
            return request("/versements/" + id + "/confirmer", { method: "POST", body: { reference: reference || null } });
        },
        messages: function () {
            return request("/messages");
        },
        envoyerMessage: function (objet, corps) {
            return request("/messages", { method: "POST", body: { objet: objet, corps: corps } });
        },
        marquerMessagesLus: function () {
            return request("/messages/lus", { method: "POST" });
        },
    };
})();
