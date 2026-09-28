// ============================================================
// MIM — PartAgence/second_Mode/scope.js (PHASE 6)
//
// FIXATION DU SCOPE d'un bien géré avant le JS métier réutilisé.
// - Lit ?bien=<id> (historique : ?id=) et le mémorise en sessionStorage.
// - En l'absence de paramètre, restaure le dernier bien mémorisé.
// - Pose MIM.agenceBien = { id, nom? } puis commute MIM.apiBase sur
//   `/api/agence/bien/<id>` : c'est là que api.js (PartProprietaires)
//   construit ensuite son préfixe `API`, permettant de réutiliser le JS
//   propriétaire APRÈS avoir changé simplement la base.
//
// Ordre d'inclusion dans chaque page MODE 2 :
//   scope.js → api.js → crud.js → <page réutilisée>.js
// ============================================================
(function () {
  "use strict";

  var KEY = "mim_agence_bien_v1";
  var params = new URLSearchParams(window.location.search);
  var idParam = params.get("bien") || params.get("id");

  window.MIM = window.MIM || {};

  var current = null;

  if (idParam) {
    var parsed = parseInt(idParam, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      current = { id: parsed };
      try {
        sessionStorage.setItem(KEY, JSON.stringify(current));
      } catch (e) {
        /* stockage indisponible : on continue sans persistance */
      }
    }
  } else {
    try {
      var saved = sessionStorage.getItem(KEY);
      if (saved) {
        var obj = JSON.parse(saved);
        if (obj && Number.isInteger(Number(obj.id)) && Number(obj.id) > 0) {
          current = { id: Number(obj.id), nom: obj.nom || undefined };
        }
      }
    } catch (e) {
      /* sessionStorage indisponible */
    }
  }

  window.MIM.agenceMode2 = true;
  window.MIM.mode2Global = false;
  window.MIM.mode2Blocked = false;
  window.MIM.redirectToAgenceFirstMode = function () {
    if (window.MIM.mode2Redirecting) return;
    window.MIM.mode2Redirecting = true;
    location.replace("/PartAgence/first_Mode/portefeuille.html");
  };

  window.agenceBack = function () {
    location.href = "/PartAgence/first_Mode/dashboard.html";
  };

  if (!current || !current.id) {
    window.MIM.mode2Blocked = true;
    delete window.MIM.apiBase;
    window.MIM.redirectToAgenceFirstMode();
    return;
  }

  if (typeof params.get("nom") === "string") {
    current.nom = params.get("nom");
  }
  window.MIM.agenceBien = current;
  window.MIM.apiBase = "/api/agence/bien/" + current.id;
  var apiHost = window.MIM.apiHost ? MIM.apiHost() : window.location.origin;
  window.MIM.mode2ContextPromise = fetch(apiHost + window.MIM.apiBase + "/contexte", {
    credentials: "include",
  }).then(function (res) {
    return MIM.parse(res).then(function (parsed) {
      if (!parsed.ok) throw parsed.error;
      if (!parsed.data || !parsed.data.data) {
        var error = new Error("Contexte du bien indisponible.");
        error.status = 502;
        throw error;
      }
      return parsed.data;
    });
  });
  window.MIM.mode2ContextPromise.catch(function (err) {
    console.warn("[agence] contexte du bien indisponible :", err);
  });
})();