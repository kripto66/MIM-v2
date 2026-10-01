// ============================================================
// MIM - Suite frontend (dette D7) : chaque page se rend sans
// exception. Le HTML est exécuté dans jsdom avec :
//   * les <script src> résolus depuis le disque (même ordre que
//     le navigateur, aucun réseau) ;
//   * un fetch qui répond 200 { success:true, data:[] } (session
//     authentifiée simulée) ;
//   * des shims pour les API absentes de jsdom (matchMedia,
//     IntersectionObserver, canvas…) ;
// toute exception non catchée pendant le chargement ou l'init
// (DOMContentLoaded) est un échec — c'est la classe de bugs qui a
// motivé l'audit frontend (ReferenceError au clic, page blanche).
// ============================================================

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const S = 'frontend';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

function collectPages() {
  const pages = [];
  for (const name of readdirSync(ROOT)) {
    const dir = path.join(ROOT, name);
    if (!name.startsWith('Part') || !statSync(dir).isDirectory()) continue;
    const walk = (current) => {
      for (const entry of readdirSync(current)) {
        const p = path.join(current, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.html')) pages.push(p);
      }
    };
    walk(dir);
  }
  return pages.sort();
}

// Résolution d'un src : express.static sert PartPublic à la racine,
// les autres dossiers via /PartXxx/… ; sinon relatif à la page.
function resolveScriptSrc(src, pageDir) {
  if (src.startsWith('/')) {
    if (/^\/Part[A-Za-z0-9_]+\//.test(src)) return path.join(ROOT, src);
    return path.join(ROOT, 'PartPublic', src);
  }
  return path.resolve(pageDir, src);
}

// Inline le contenu des scripts externes (le harness ne charge pas
// les ressources réseau) en conservant l'ordre et les attributs.
function inlineScripts(html, pageDir, missing) {
  return html.replace(
    /<script([^>]*)\ssrc="([^"]+)"([^>]*)><\/script>/gi,
    (full, pre, src, post) => {
      const file = resolveScriptSrc(src, pageDir);
      if (!file.endsWith('.js') || !existsSync(file)) {
        missing.push(src);
        return full;
      }
      return `<script${pre}${post}>${readFileSync(file, 'utf8')}</script>`;
    },
  );
}

// Réponse unique : 200 + payload vide — le même format que l'API
// ({ success, data }) que les pages consomment déjà.
function mockResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const MOCK_BODY = { success: true, data: [], csrfToken: 'jsdom-csrf' };

function installShims(window) {
  window.fetch = async () => mockResponse(MOCK_BODY);

  window.matchMedia = window.matchMedia || ((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  }));

  window.scrollTo = () => {};
  window.alert = () => {};
  window.confirm = () => true;
  window.prompt = () => '';
  window.print = () => {};

  for (const name of ['IntersectionObserver', 'ResizeObserver']) {
    window[name] = class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    };
  }

  window.EventSource = class {
    constructor() { this.readyState = 0; }
    close() {}
    addEventListener() {}
    removeEventListener() {}
  };

  window.HTMLCanvasElement.prototype.getContext = function getContext() {
    const noop = () => undefined;
    return new Proxy({ canvas: this }, {
      get: (target, prop) => (prop in target ? target[prop] : noop),
      set: (target, prop, value) => { target[prop] = value; return true; },
    });
  };

  if (navigator.clipboard === undefined) {
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: async () => {}, readText: async () => '' },
      configurable: true,
    });
  }
}

// Bruit attendu d'un rendu sans navigateur : navigations de session
// (redirections login/abonnement) et feuilles de style non chargées.
const NOISE = [
  /Not implemented: navigation/i,
  /Could not parse CSS stylesheet/i,
  /Could not load .* stylesheet/i,
  /Not implemented: window\.scrollTo/i,
];

function isNoise(message) {
  return NOISE.some((pattern) => pattern.test(message));
}

export async function runFrontend(r) {
  await r.section('chaque page se rend sans exception (D7)', async () => {
    for (const page of collectPages()) {
      const rel = path.relative(ROOT, page).split(path.sep).join('/');
      const missing = [];
      const html = inlineScripts(readFileSync(page, 'utf8'), path.dirname(page), missing);

      if (missing.length) {
        r.fail(S, `${rel} : scripts src résolus`, `introuvable(s) : ${missing.join(', ')}`);
        continue;
      }

      const errors = [];
      const virtualConsole = new VirtualConsole();
      virtualConsole.on('jsdomError', (err) => {
        const detail = err.detail && err.detail.stack ? err.detail.stack : '';
        const message = `${err.message}\n${detail}`.trim();
        if (!isNoise(message)) errors.push(message);
      });

      const urlPath = '/' + path.relative(ROOT, page).split(path.sep).join('/');
      const dom = new JSDOM(html, {
        url: `http://127.0.0.1:3100${urlPath}`,
        runScripts: 'dangerously',
        pretendToBeVisual: true,
        virtualConsole,
        beforeParse: installShims,
      });

      // Laisse DOMContentLoaded + init (promesses fetch mockées) se
      // terminer : c'est là que les pages branchent leurs listeners.
      await new Promise((resolve) => setTimeout(resolve, 150));
      dom.window.close();

      if (errors.length === 0) r.pass(S, `${rel} : rendu sans exception`);
      else r.fail(S, `${rel} : rendu sans exception`, errors.slice(0, 3).join(' | ').replace(/\s+/g, ' ').slice(0, 500));
    }
  });
}
