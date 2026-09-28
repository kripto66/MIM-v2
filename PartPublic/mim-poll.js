/* MIM - sondage des notifications du rail (badge + toast).
 *
 * Chargé par PartPublic/sidebar.js : toutes les pages à rail l'ont.
 * Interroge GET /api/notifications?unread=1 toutes les 20 s :
 *   - badge (compteur de non-lues) à la fin du lien « Notifications » ;
 *   - toast quand une notification inconnue apparaît (la première sonde
 *     d'une page amorce sans toast, pour ne pas ressortir l'historique).
 * La sonde s'interrompt quand l'onglet est masqué et rattrape au retour :
 * aucun appel réseau en arrière-plan inutile. */
(function () {
  'use strict';

  if (window.MIMNotif) return;

  var INTERVAL_MS = 20000;
  var SEEN_KEY = 'mim_notif_seen';
  var SEEN_MAX = 40;

  var link = null;
  var badge = null;
  var timer = null;
  var running = false;
  var inFlight = false;
  var primed = false;

  function findLink() {
    var anchors = document.querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length; i++) {
      var href = anchors[i].getAttribute('href') || '';
      if (/notifications\.html([?#]|$)/.test(href)) return anchors[i];
    }
    return null;
  }

  function injectStyle() {
    if (document.getElementById('mimNotifStyle')) return;
    var style = document.createElement('style');
    style.id = 'mimNotifStyle';
    style.textContent =
      '.mimNotifBadge{display:inline-block;margin-left:6px;min-width:17px;padding:0 5px;' +
      'border-radius:9px;background:#e11d48;color:#fff;font:700 10px/17px system-ui,-apple-system,sans-serif;' +
      'text-align:center;vertical-align:middle;pointer-events:none}';
    document.head.appendChild(style);
  }

  function setBadge(count) {
    if (!link) return;
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'mimNotifBadge';
      badge.setAttribute('aria-hidden', 'true');
      link.appendChild(badge);
    }
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }

  function readSeen() {
    try {
      var raw = JSON.parse(sessionStorage.getItem(SEEN_KEY) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch (e) {
      return [];
    }
  }

  function writeSeen(ids) {
    try {
      sessionStorage.setItem(SEEN_KEY, JSON.stringify(ids.slice(0, SEEN_MAX)));
    } catch (e) {
      /* quota dépassé : on perd l'historique des toasts, pas d'impact */
    }
  }

  function notify(message) {
    if (typeof MIM === 'undefined' || typeof MIM._notify !== 'function') return;
    MIM._notify(message, 'info');
  }

  async function poll() {
    if (inFlight || document.hidden) return;
    inFlight = true;
    try {
      var res = await fetch('/api/notifications?unread=1', {
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (res.status === 401 || res.status === 403) {
        stop();
        return;
      }
      if (!res.ok) return;

      var body = await res.json();
      if (!body || body.success !== true) return;

      setBadge(body.unread || 0);

      var latest = body.latest;
      if (latest && latest.id != null) {
        var seen = readSeen();
        if (seen.indexOf(latest.id) === -1) {
          if (primed && body.unread > 0) {
            notify(body.unread > 1 ? body.unread + ' nouvelles notifications' : 'Nouvelle notification');
          }
          seen.unshift(latest.id);
          writeSeen(seen);
        }
      }
      primed = true;
    } catch (err) {
      /* réseau coupé ou serveur absent : on retentera au prochain tick */
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (running) return;
    running = true;
    poll();
    schedule();
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(poll, INTERVAL_MS);
  }

  function stop() {
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (!running) return;
    if (document.hidden) {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    } else {
      poll();
      schedule();
    }
  });

  function boot() {
    link = findLink();
    if (!link) return; /* page sans rail : rien à sonder */
    injectStyle();
    start();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.MIMNotif = { refresh: poll, stop: stop };
})();
