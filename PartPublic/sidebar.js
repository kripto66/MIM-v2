(function () {
  'use strict';

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

  var TOGGLE_SELECTOR = '[data-sidebar-toggle], [data-sidebar-toggle-logo]';

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

  mq.addEventListener('change', function (e) {
    if (!e.matches) close();
  });

  sync();
})();
