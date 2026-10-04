/* MIM - client Realtime centralisé (Supabase Realtime, RLS appliqué).
 *
 * Chargé automatiquement par PartPublic/sidebar.js sur toutes les pages à
 * rail. Expose window.MIMRealtime :
 *
 *   MIMRealtime.ready(cb)        -> cb(client) une fois connecté
 *   MIMRealtime.onChange(fn, ms) -> fn({table, eventType}) à chaque changement
 *                                   sur tables métier, débouncé ms (défaut 400)
 *   MIMRealtime.onStatus(cb)     -> 'connected' | 'reconnecting' | 'offline'
 *   MIMRealtime.refresh()        -> rejoue l'authentification du channel
 *
 * Un seul channel pour tout le client : pas de multiplication de
 * connexions. Les callbacks sont débouncés pour éviter les refetch
 * en rafale, et tout est masqué/repris quand l'onglet change de
 * visibilité. */
(function () {
  'use strict';

  if (window.MIMRealtime) return;

  var TABLES = [
    'notifications',
    'paiements',
    'paiements_employes',
    'incidents',
    'interventions',
    'tasks',
    'messages',
    'employes',
    'locataires',
    'logements',
    'biens',
    'prestataires',
    'depenses',
  ];

  var client = null;
  var channel = null;
  var session = null;
  var connecting = null;
  var readyCbs = [];
  var statusCbs = [];
  var changeCbs = []; // {fn, ms, timer, pending}
  var visible = true;
  var retryTimer = null;
  var connected = false;

  function emitStatus(s) {
    for (var i = 0; i < statusCbs.length; i++) {
      try { statusCbs[i](s); } catch (e) { console.debug('[MIM-RT] status cb', e); }
    }
  }

  function emitReady() {
    var cbs = readyCbs.slice();
    readyCbs = [];
    for (var i = 0; i < cbs.length; i++) {
      try { cbs[i](client); } catch (e) { console.debug('[MIM-RT] ready cb', e); }
    }
  }

  function notifyChange(info) {
    for (var i = 0; i < changeCbs.length; i++) {
      (function (entry) {
        entry.pending = info;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(function () {
          entry.timer = null;
          try { entry.fn(entry.pending); } catch (e) { console.debug('[MIM-RT] change cb', e); }
        }, entry.ms);
      })(changeCbs[i]);
    }
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-mim-supabase]');
      if (existing) return resolve();
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.setAttribute('data-mim-supabase', '1');
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('supabase-js introuvable')); };
      document.head.appendChild(s);
    });
  }

  function fetchSession() {
    return fetch('/api/realtime/session', {
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    }).then(function (res) {
      if (res.status === 401 || res.status === 403) {
        var err = new Error('non authentifié');
        err.auth = true;
        throw err;
      }
      if (!res.ok) throw new Error('session realtime indisponible');
      return res.json();
    });
  }

  function teardown() {
    connected = false;
    if (channel && client) {
      try { client.removeChannel(channel); } catch (e) { console.debug('[MIM-RT] removeChannel', e); }
    }
    channel = null;
  }

  function join() {
    if (!client) return;
    teardown();
    var ch = client.channel('mim-global');
    TABLES.forEach(function (table) {
      ch.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: table },
        function (payload) {
          notifyChange({ table: table, eventType: payload.eventType });
        }
      );
    });
    ch.subscribe(function (status) {
      if (status === 'SUBSCRIBED') {
        connected = true;
        emitStatus('connected');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        connected = false;
        emitStatus('reconnecting');
        scheduleRetry();
      }
    });
    channel = ch;
  }

  function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      if (!visible) return;
      join();
    }, 5000);
  }

  function connect() {
    if (connecting) return connecting;
    connecting = (async function () {
      try {
        session = await fetchSession();
        if (!session || session.success !== true) throw new Error('session invalide');
        await loadScript('/vendor/supabase-js/supabase.js');
        client = window.supabase.createClient(session.url, session.anonKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
          realtime: { params: { eventsPerSecond: 10 } },
        });
        client.realtime.setAuth(session.token);
        join();
        emitReady();
        return client;
      } catch (err) {
        if (err && err.auth) emitStatus('offline');
        throw err;
      }
    })();
    return connecting.catch(function () {
      // échec : le polling existant prend le relais (mim-poll.js)
      try { emitStatus('offline'); } catch (e) { console.debug('[MIM-RT] emitStatus offline', e); }
      return null;
    });
  }

  // Renouvellement du token si l'expiration approche.
  setInterval(function () {
    if (!session || !session.expiresAt || !client) return;
    var expires = new Date(session.expiresAt).getTime();
    if (expires && expires - Date.now() < 120000) {
      fetchSession()
        .then(function (s) {
          session = s;
          if (s && s.token) {
            client.realtime.setAuth(s.token);
            join();
          }
        })
        .catch(function (e) {
          /* la reconnexion suivante réessaiera */
          console.debug('[MIM-RT] renouvellement de token en échec', e);
        });
    }
  }, 30000);

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      visible = false;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    } else if (!visible) {
      visible = true;
      if (client && !connected) join();
    }
  });

  window.MIMRealtime = {
    ready: function (cb) {
      if (client) return cb(client);
      readyCbs.push(cb);
      connect();
    },
    onStatus: function (cb) {
      statusCbs.push(cb);
      cb(connected ? 'connected' : 'reconnecting');
    },
    onChange: function (fn, ms) {
      changeCbs.push({ fn: fn, ms: typeof ms === 'number' ? ms : 400, timer: null, pending: null });
      if (!client) connect();
    },
    connected: function () { return connected; },
    refresh: function () {
      connecting = null;
      session = null;
      client = null;
      teardown();
      connect();
    },
  };
})();
