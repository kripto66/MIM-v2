        // Menu mobile
        var burger = document.getElementById("navBurger");
        var links = document.getElementById("navLinks");
        if (burger && links) {
            burger.addEventListener("click", function () {
                var open = links.classList.toggle("open");
                burger.classList.toggle("open", open);
                burger.setAttribute("aria-expanded", open ? "true" : "false");
            });
            links.addEventListener("click", function (e) {
                if (e.target.tagName === "A") {
                    links.classList.remove("open");
                    burger.classList.remove("open");
                    burger.setAttribute("aria-expanded", "false");
                }
            });
        }

        // Ombre de la barre de navigation après défilement
        var nav = document.getElementById("siteNav");
        var onScroll = function () {
            if (nav) { nav.classList.toggle("scrolled", window.scrollY > 10); }
        };
        if (window.addEventListener) {
            window.addEventListener("scroll", onScroll, { passive: true });
            onScroll();
        }

        // Révélation au défilement
        var revealEls = document.querySelectorAll(".reveal");
        if ("IntersectionObserver" in window) {
            var io = new IntersectionObserver(function (entries) {
                entries.forEach(function (entry) {
                    if (entry.isIntersecting) {
                        entry.target.classList.add("visible");
                        io.unobserve(entry.target);
                    }
                });
            }, { threshold: 0.12 });
            revealEls.forEach(function (el) { io.observe(el); });
        } else {
            revealEls.forEach(function (el) { el.classList.add("visible"); });
        }

        // ============================================================
        // Onglets tarifaires : propriétaire / agence
        //
        // Les deux grilles coexistent dans le DOM (accessibilité :
        // aria-controls pointe vers le panneau affiché). On ne fait que
        // basculer l'attribut hidden, puis on réaffiche les cartes —
        // elles sont en .reveal et ne seront jamais vues sinon.
        // ============================================================
        var tabs = document.querySelectorAll(".ttab");
        var showPanel = function (btn) {
            tabs.forEach(function (t) {
                var on = (t === btn);
                t.classList.toggle("active", on);
                t.setAttribute("aria-selected", on ? "true" : "false");
                var panel = document.getElementById(t.getAttribute("aria-controls"));
                if (panel) {
                    panel.hidden = !on;
                    if (on) {
                        panel.querySelectorAll(".reveal").forEach(function (el) {
                            el.classList.add("visible");
                        });
                    }
                }
            });
        };
        tabs.forEach(function (btn) {
            btn.addEventListener("click", function () { showPanel(btn); });
        });

        // ============================================================
        // Tarifs servis EN DIRECT par /api/public/plans
        //
        // Le HTML contient une valeur de repli (la catalogue au moment
        // du déploiement) : si l'API tombe, la page reste affichable.
        // Mais au chargement normal, la base fait foi — c'est exactement
        // ce qui a été vérifié : une page figée finit toujours par
        // afficher des prix périmés.
        // ============================================================
        var fmt = function (n) { return Number(n).toLocaleString("fr-FR"); };

        var plural = function (n, mot) { return fmt(n) + " " + mot + (Number(n) > 1 ? "s" : ""); };

        // Un « bien » = l'actif géré (hôtel, immeuble, villa, résidence…).
        var capacityText = function (p) {
            var out = [];
            if (p.max_immeubles !== null && p.max_immeubles !== undefined) out.push(plural(p.max_immeubles, "bien"));
            if (p.max_logements !== null && p.max_logements !== undefined) out.push(plural(p.max_logements, "logement"));
            if (p.max_locataires !== null && p.max_locataires !== undefined) out.push(plural(p.max_locataires, "locataire"));
            return out.join(" · ");
        };

        // Plafond d'équipe : NULL en base = illimité (check_quota_for_plan).
        var teamText = function (max, mot) {
            var titre = mot.charAt(0).toUpperCase() + mot.slice(1);
            return (max === null || max === undefined) ? titre + "s illimités" : plural(max, mot);
        };

        var setPrice = function (el, prix) {
            var unite = el.querySelector("span");
            while (el.firstChild) { el.removeChild(el.firstChild); }
            el.appendChild(document.createTextNode(fmt(prix) + " "));
            if (unite) { el.appendChild(unite); }
        };

        var applyPlans = function (plans) {
            var byCode = {};
            plans.forEach(function (p) { if (p && p.code) { byCode[p.code] = p; } });

            document.querySelectorAll("[data-plan]").forEach(function (card) {
                var p = byCode[card.getAttribute("data-plan")];
                if (!p) { return; }
                var prix = card.querySelector("[data-price]");
                if (prix && typeof p.prix === "number") { setPrice(prix, p.prix); }
                var cap = card.querySelector("[data-capacity]");
                if (cap) {
                    var txt = capacityText(p);
                    if (txt) { cap.textContent = txt; }
                }
                // Équipe : renseignée seulement si le catalogue la renvoie,
                // sinon la valeur inscrite dans le HTML reste affichée.
                var emp = card.querySelector("[data-employes]");
                if (emp && "max_employes" in p) {
                    emp.textContent = teamText(p.max_employes, "employé") + " · tableau de bord";
                }
                var pre = card.querySelector("[data-prestataires]");
                if (pre && "max_prestataires" in p) {
                    pre.textContent = teamText(p.max_prestataires, "prestataire");
                }
            });
        };

        fetch("/api/public/plans", { headers: { Accept: "application/json" } })
            .then(function (res) {
                if (!res.ok) { throw new Error("HTTP " + res.status); }
                return res.json();
            })
            .then(function (data) {
                if (data && data.success && Array.isArray(data.plans)) {
                    applyPlans(data.plans);
                }
            })
            .catch(function (err) {
                // Repli silencieux : les valeurs inscrites dans le HTML
                // restent affichées, la page n'est jamais vide.
                if (window.console && console.warn) {
                    console.warn("[mim:index] catalogue tarifaire indisponible, valeurs HTML conservées", err);
                }
            });
