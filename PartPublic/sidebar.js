(function () {
  'use strict';

  // bfcache : gere dans /mim-errors.js (charge par toutes les pages,
  // audit A7) ; ne pas le dupliquer ici (double location.reload()).


  var sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  var bp = parseInt(sidebar.getAttribute('data-breakpoint'), 10) || 800;
  var mq = window.matchMedia('(max-width: ' + bp + 'px)');

  var overlay = document.getElementById('sidebarOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    overlay.id = 'sidebarOverlay';
    sidebar.insertAdjacentElement('afterend', overlay);
  }

  // Déconnexion : câblage centralisé du bouton #logoutBtn (toutes les pages
  // propriétaire + admin l'ont dans la sidebar ; plusieurs pages ne le
  // câblaient pas du tout). La garde data-mim-logout évite un doublon avec
  // un éventuel handler déjà attaché par la page.
  var logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn && !logoutBtn.dataset.mimLogout) {
    logoutBtn.dataset.mimLogout = '1';
    logoutBtn.addEventListener('click', async function (e) {
      // #logoutBtn est une <a href="#"> dans PartProprietairesShadow :
      // sans preventDefault, le navigateur remonte en haut de page.
      if (e && typeof e.preventDefault === 'function') e.preventDefault();
      await MIM._csrfReady;
      var apiBase = typeof mimApiBase === 'function' ? mimApiBase() : '/api';
      fetch(apiBase + '/auth/logout', { method: 'POST', credentials: 'include', headers: MIM.csrfHeader() })
        .catch(function (err) {
          console.warn("[MIM] logout: appel /auth/logout en echec", err);
        })
        .finally(function () {
          window.location.href = '/PartPublic/connexion.html';
        });
    });
  }

  var TOGGLE_SELECTOR = '[data-sidebar-toggle], [data-sidebar-toggle-logo]';

  // Un logo simple (<div class="logo">) doit aussi ouvrir le menu sur mobile :
  // on le branche ici pour toutes les zones, sans dupliquer le handler.
  var bareLogos = document.querySelectorAll('#sidebar .logo:not([data-sidebar-toggle-logo])');
  for (var bl = 0; bl < bareLogos.length; bl++) {
    bareLogos[bl].addEventListener('click', function (e) {
      if (!mq.matches) return;
      e.preventDefault();
      e.stopPropagation();
      toggle();
    });
  }

  function isOpen() {
    return sidebar.classList.contains('open');
  }

  function sync() {
    var open = isOpen();
    var els = document.querySelectorAll(
      TOGGLE_SELECTOR + ', #menuBtn, #menu, #menuButton'
    );
    for (var i = 0; i < els.length; i++) {
      if (els[i].hasAttribute('aria-expanded')) {
        els[i].setAttribute('aria-expanded', String(open));
      }
    }
    if (sidebar.hasAttribute('aria-hidden')) {
      sidebar.setAttribute('aria-hidden', String(!open));
    }
  }

  function open() {
    sidebar.classList.add('open');
    overlay.classList.add('active');
    sync();
  }

  function close() {
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
    sync();
  }

  function toggle() {
    if (isOpen()) close();
    else open();
  }

  var toggles = document.querySelectorAll('[data-sidebar-toggle]');
  for (var t = 0; t < toggles.length; t++) {
    toggles[t].addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggle();
    });
  }

  var logos = document.querySelectorAll('[data-sidebar-toggle-logo]');
  for (var l = 0; l < logos.length; l++) {
    logos[l].addEventListener('click', function (e) {
      if (!mq.matches) return;
      e.preventDefault();
      e.stopPropagation();
      toggle();
    });
    logos[l].addEventListener('keydown', function (e) {
      if (!mq.matches) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
  }

  overlay.addEventListener('click', close);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') close();
  });

  var links = sidebar.querySelectorAll('a, .nav, .nav-item, .nav-link, button[data-view], .logout, .logout-button');
  for (var n = 0; n < links.length; n++) {
    links[n].addEventListener('click', function () {
      if (mq.matches) close();
    });
  }

  // Client Realtime partagé (badge + toast + dashboards) : chargé une
  // seule fois, avant mim-poll qui y greffe ses mises à jour.
  if (!document.querySelector('script[data-mim-rt]')) {
    var rtScript = document.createElement('script');
    rtScript.src = '/PartPublic/mim-realtime.js';
    rtScript.async = true;
    rtScript.setAttribute('data-mim-rt', '1');
    document.head.appendChild(rtScript);
  }

  // Sondage des notifications (badge + toast) : script partagé chargé une
  // seule fois, uniquement sur les pages qui ont un rail.
  if (!document.querySelector('script[data-mim-poll]')) {
    var pollScript = document.createElement('script');
    pollScript.src = '/PartPublic/mim-poll.js';
    pollScript.async = true;
    pollScript.setAttribute('data-mim-poll', '1');
    document.head.appendChild(pollScript);
  }

  // Prefetch des pages du rail : les pages HTML ne sont jamais mises en
  // cache (no-store, cf. server/app.js) mais leurs scripts et feuilles de
  // style le sont une heure. Au survol on récupère donc la page pour
  // précharger ses assets : le clic suivant n'attend plus leur
  // téléchargement.
  var prefetched = Object.create(null);
  var hoverTimer = null;

  function warmAssets(html, pageUrl) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var nodes = doc.querySelectorAll('script[src], link[rel="stylesheet"][href]');
    for (var i = 0; i < nodes.length; i++) {
      var ref = nodes[i].src || nodes[i].href;
      if (!ref) continue;
      try {
        var abs = new URL(ref, pageUrl);
        if (abs.origin !== window.location.origin) continue;
        fetch(abs.href, { credentials: 'include', cache: 'force-cache' }).catch(function (err) {
          /* asset injoignable : la navigation le demandera */
          console.debug('[MIM] prefetch: asset en echec', abs.href, err);
        });
      } catch (e) {
        /* URL invalide : on ignore */
        console.debug('[MIM] prefetch: href invalide', ref, e);
      }
    }
  }

  function prefetch(anchor) {
    if (!anchor) return;
    var href = anchor.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#' || !/\.html([?#]|$)/i.test(href)) return;
    if (prefetched[href]) return;
    var conn = navigator.connection;
    if (conn && (conn.saveData || /(^|-)2g/.test(conn.effectiveType || ''))) return;
    prefetched[href] = 1;
    var target = new URL(href, window.location.href).href;
    fetch(target, { credentials: 'include' })
      .then(function (res) {
        return res.ok ? res.text() : null;
      })
      .then(function (html) {
        if (html) warmAssets(html, target);
      })
      .catch(function () {
        delete prefetched[href];
      });
  }

  var railLinks = sidebar.querySelectorAll('a[href]');
  for (var r = 0; r < railLinks.length; r++) {
    (function (anchor) {
      anchor.addEventListener('pointerenter', function () {
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(function () {
          prefetch(anchor);
        }, 150);
      });
      anchor.addEventListener('pointerleave', function () {
        clearTimeout(hoverTimer);
      });
      anchor.addEventListener('pointerdown', function () {
        prefetch(anchor);
      });
      anchor.addEventListener('focus', function () {
        prefetch(anchor);
      });
    })(railLinks[r]);
  }

  mq.addEventListener('change', function (e) {
    if (!e.matches) close();
  });

  sync();
})();
