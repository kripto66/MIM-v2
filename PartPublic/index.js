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
    