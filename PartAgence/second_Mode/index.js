        // PHASE 6 — Entrée MODE 2 : redirige vers le dernier bien mémorisé,
        // sinon vers le portefeuille (MODE 1) pour en choisir un.
        (function () {
            var params = new URLSearchParams(window.location.search);
            var id = params.get("bien") || params.get("id");
            if (!id) {
                try {
                    var saved = sessionStorage.getItem("mim_agence_bien_v1");
                    if (saved) {
                        var obj = JSON.parse(saved);
                        if (obj && obj.id) id = obj.id;
                    }
                } catch (e) {
                    /* sessionStorage corrompu : on part sans bien mémorisé */
                    console.debug("[MIM] mode2: sessionStorage illisible", e);
                }
            }
            if (id) {
                location.replace("/PartAgence/second_Mode/bien.html?bien=" + encodeURIComponent(id));
            } else {
                location.replace("/PartAgence/first_Mode/portefeuille.html");
            }
        })();
    