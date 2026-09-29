// ============================================================
// MIM — PartAgence/second_Mode/mode2.js (PHASE 7)
//
// Infra commune des SOUS-PAGES d'un bien géré (MODE 2). À inclure
// APRÈS scope.js et AVANT api.js, sur chaque page de gestion :
//     scope.js → mode2.js → api.js → crud.js → <page>.js
// Elle :
//   - injecte `?bien=<id>` sur les liens de la sidebar (navigation
//     perpétuant le scope sans dépendre du sessionStorage) ;
//   - renomme le lien « Le bien » avec le nom du bien courant ;
//   - affiche la bannière bien (propriétaire géré + nom du bien)
//     à partir de /contexte (endpoint scoped) ;
//   - redirige vers le dashboard agence si aucun bien n'est posé.
//
// Important : les pages MODE 2 utilisent le swapped base (KINDA)
// `/api/agence/bien/<id>` pour TOUT apiRequest(). Or certains appels
// sont GLOBAUX : /auth/* (verify-password, logout). Ce shim ré-aiguille
// ces chemins vers la base `/api` d'origine, avant l'exécution des
// handlers DOMContentLoaded des pages (listener enregistré en premier).
// ============================================================
(function () {
  "use strict";

  function installAuthShim() {
    if (window.MIM && MIM.mode2Blocked) return;
    if (!window.apiRequest || typeof window.apiRequest !== "function") return;
    var base = window.MIM && MIM.apiBase;
    if (!base || base === "/api") return;

    var globalApi = (window.MIM && MIM.apiHost ? MIM.apiHost() : window.location.origin || "http://localhost:3000") + "/api";

    var real = window.apiRequest;
    window.apiRequest = async function (path, options) {
      options = options || {};
      if (typeof path === "string" && path.startsWith("/auth/")) {
        if (MIM._csrfReady) await MIM._csrfReady;
        var headers = { "Content-Type": "application/json", ...(options.headers || {}), ...(typeof MIM.csrfHeader === "function" ? MIM.csrfHeader() : {}) };
        var res = await fetch(globalApi + path, {
          ...options,
          credentials: "include",
          headers: headers,
        });
        var parsed = await MIM.parse(res);
        if (!parsed.ok) {
          MIM.handleAuthError(parsed.error);
          throw parsed.error;
        }
        return parsed.data;
      }
      return real.call(this, path, options);
    };
  }

  function injectBienParam() {
    var bien = window.MIM && window.MIM.agenceBien;
    if (!bien || !bien.id) return;
    document.querySelectorAll("#sidebar a[href*='.html']").forEach(function (a) {
      var href = a.getAttribute("href");
      if (!href) return;
      var url;
      try {
        url = new URL(href, window.location.origin);
      } catch (e) {
        return;
      }
      if (url.origin !== window.location.origin || url.pathname.indexOf("/PartAgence/second_Mode/") !== 0) return;
      if (!url.searchParams.has("bien")) url.searchParams.set("bien", bien.id);
      a.setAttribute("href", url.pathname + url.search + url.hash);
    });
  }

  function setBienLabels() {
    var bien = window.MIM && window.MIM.agenceBien;
    if (!bien || !bien.id) return;
    var navBien = document.getElementById("navBien");
    if (navBien) {
      navBien.textContent = bien.nom ? "Le bien — " + bien.nom : "Le bien #" + bien.id;
      navBien.href = "/PartAgence/second_Mode/bien.html?bien=" + encodeURIComponent(bien.id);
    }
  }

  function fillBanner() {
    var banner = document.getElementById("bienBanner");
    var bien = window.MIM && window.MIM.agenceBien;
    if (window.MIM && (MIM.mode2Blocked || !MIM.mode2ContextPromise)) return;
    if (!banner || !bien || !bien.id) return;

    var done = false;
    var render = function (text) {
      if (done) return;
      done = true;
      banner.textContent = text;
      banner.hidden = false;
    };

    if (bien.nom) {
      render("Bien géré : " + bien.nom + (bien.proprietaireNom ? " · " + bien.proprietaireNom : ""));
      return;
    }

    (async function () {
      try {
        var data = window.MIM && MIM.mode2ContextPromise ? await MIM.mode2ContextPromise : null;
        if (!data) {
          var res = await fetch((window.API || "/api/agence/bien/" + bien.id) + "/contexte", {
            credentials: "include",
          });
          data = await res.json();
        }
        var d = data && data.data;
        var nom = (d && d.bien && d.bien.nom) || "Bien #" + bien.id;
        var prop = d && d.proprietaire ? d.proprietaire.name : "";
        window.MIM.agenceBien.nom = nom;
        if (prop) window.MIM.agenceBien.proprietaireNom = prop;
        try {
          sessionStorage.setItem("mim_agence_bien_v1", JSON.stringify(window.MIM.agenceBien));
        } catch (e2) {
          console.warn("[MIM] sessionStorage: contexte de bien non sauvegarde", e2);
        }
        setBienLabels();
        render("Bien géré : " + nom + (prop ? " · " + prop : ""));
      } catch (e) {
        render("Bien géré : " + (bien.nom || "Bien #" + bien.id));
      }
    })();
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (window.MIM && MIM.mode2Blocked) return;
    installAuthShim();
    injectBienParam();
    setBienLabels();
    fillBanner();
  });
})();