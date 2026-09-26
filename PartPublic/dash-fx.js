/* ============================================================
   MIM — dash-fx.js  (effets dynamiques partagés)
   Compteurs animés + micro-interactions.
   S'exécute sans dépendre des autres scripts.
============================================================ */
(function () {
  "use strict";

  if (window.__dashFxLoaded) return;
  window.__dashFxLoaded = true;

  const REDUCED =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  function animate(el, from, to, dur, fmt) {
    if (REDUCED) {
      el.textContent = fmt ? fmt(to) : to;
      return;
    }
    const start = performance.now();
    function tick(now) {
      const p = Math.min((now - start) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      const val = Math.round(from + (to - from) * eased);
      el.textContent = fmt ? fmt(val) : val.toLocaleString("fr-FR");
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function countUp(el) {
    if (!el || el.dataset.countUpDone === "1") return;
    const raw = (el.textContent || "").trim();
    if (raw === "—" || raw === "") return;
    const digits = raw.replace(/[^0-9]/g, "");
    if (!digits) return;

    const n = parseInt(digits, 10);
    const money = /\bFCFA\b/i.test(raw);

    el.dataset.countUpDone = "1";
    el.textContent = "0";
    animate(
      el,
      0,
      n,
      900,
      (v) => (money ? v.toLocaleString("fr-FR") + " FCFA" : v.toLocaleString("fr-FR"))
    );
  }

  function scan() {
    document.querySelectorAll("[data-count]").forEach(countUp);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan);
  } else {
    scan();
  }

  // Détecte les re-rendus (values chargées en JS après coup)
  const mo = new MutationObserver(() => {
    document.querySelectorAll("[data-count]:not([data-count-up-done])").forEach(countUp);
  });
  if (document.body) mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  else {
    document.addEventListener("DOMContentLoaded", () => {
      mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    });
  }

  // Titres de page : transition fluide du h1 quand il change (sidebar partie gauche)
  const titles = document.querySelectorAll("h1, .topbar-title h1");
  titles.forEach((t) => {
    new MutationObserver(() => {
      t.classList.remove("fx-title");
      void t.offsetWidth;
      t.classList.add("fx-title");
    }).observe(t, { childList: true, subtree: true, characterData: true });
  });
})();