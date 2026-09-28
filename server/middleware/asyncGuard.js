// ============================================================
// MIM - Filet de sécurité asynchrone
//
// Express 4 ne rattrape PAS les promesses rejetées par un handler
// `async` : la rejection devient un `unhandledRejection`, que Node
// 15+ transforme en extinction du processus. Une simple micro-panne
// Supabase pendant une requête faisait donc tomber tout le SaaS.
//
// Ce module enveloppe TOUT handler de route / middleware pour :
//   - rattraper les exceptions synchrones  -> next(err)
//   - attacher un gestionnaire sur les promesses -> next(err)
// L'erreur est ensuite délivrée au middleware d'erreur final d'app.js,
// qui répond 500 sans jamais tuer le processus.
//
// L'ordre d'import est critique : ce module doit être évalué AVANT
// tous les fichiers de routes, sinon les Route/Router déjà construits
// conservent leurs méthodes d'origine. Il est donc importé tout en
// tête de server/app.js.
// ============================================================

import express from 'express';

const WRAPPED = Symbol.for('mim.asyncGuard.wrapped');
const PROBE_PATH = '/__mim_async_guard_probe__';

function wrapHandler(fn) {
  if (typeof fn !== 'function') return fn;
  if (fn.length === 4) return fn; // middleware d'erreur : signature (err, req, res, next)
  if (fn[WRAPPED]) return fn;

  const wrapped = function asyncGuardHandler() {
    const args = arguments;
    const next = args[args.length - 1];
    let result;
    try {
      result = fn.apply(this, args);
    } catch (err) {
      if (typeof next === 'function') next(err);
      else throw err;
      return undefined;
    }
    if (result && typeof result.then === 'function') {
      result.then(undefined, (err) => {
        if (typeof next === 'function') next(err);
        else console.error('[asyncGuard] rejection sans next :', err?.stack || err);
      });
    }
    return result;
  };

  Object.defineProperty(wrapped, 'length', { value: fn.length, configurable: true });
  Object.defineProperty(wrapped, 'name', { value: fn.name || 'anonymous', configurable: true });
  wrapped[WRAPPED] = true;
  return wrapped;
}

function wrapArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (Array.isArray(arg)) out.push(arg.map(wrapHandler));
    else out.push(wrapHandler(arg)); // les chemins (string) sont renvoyés tels quels
  }
  return out;
}

function patchMethods(proto, names) {
  if (!proto) return 0;
  let patched = 0;
  for (const name of names) {
    const original = proto[name];
    if (typeof original !== 'function') continue;
    if (original[WRAPPED]) continue;
    const replacement = function guardedMethod() {
      return original.apply(this, wrapArgs(arguments));
    };
    Object.defineProperty(replacement, 'length', { value: original.length, configurable: true });
    Object.defineProperty(replacement, 'name', { value: original.name, configurable: true });
    replacement[WRAPPED] = true;
    proto[name] = replacement;
    patched += 1;
  }
  return patched;
}

// Route.prototype porte router.get()/app.post() : tout handler de route y transite.
const probeRouter = express.Router();
const probeRoute = probeRouter.route(PROBE_PATH);
const routeProto = Object.getPrototypeOf(probeRoute);
const routerProto = express.Router.prototype;

const ROUTE_METHODS = ['all', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

const patched =
  patchMethods(routeProto, ROUTE_METHODS) + // handlers de route (app.get, router.post, ...)
  patchMethods(routerProto, ['use'].concat(ROUTE_METHODS)); // app.use / router.use

if (patched === 0) {
  console.warn('[asyncGuard] aucun middleware Express patché — filet de sécurité asynchrone inactif.');
}
