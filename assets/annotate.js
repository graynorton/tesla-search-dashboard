/*
 * annotate.js — the dashboard's intent client (User-intent track §6, U4).
 *
 * Mints user-intent commands ({id, kind, ...}) and POSTs them to /api/annotate.
 * Every action is OPTIMISTIC: it updates a localStorage view immediately (so the
 * page reflects the tap right away) and fires the network write in the background;
 * the authoritative set wins on the next dashboard publish (~20 min), at which
 * point reflected optimistic entries are cleared.
 *
 * This is the transport + envelope + optimistic-cache seam only. The DOM wiring
 * (star buttons, selection mode, the review queue) is U6 and lives in render.py's
 * generated page, which calls into the `Annotate` global exposed here.
 *
 * Config is injected by the page (render.py emits it at publish time):
 *   window.ANNOTATE_CONFIG = { endpoint: "/api/annotate", appSecret: "...", lsKey: "..." }
 * The app secret is intentionally public (low blast radius — see §6); the READ
 * secret never appears here. `lsKey` namespaces the optimistic localStorage cache
 * per site so two tenants on different origins never collide (optional — defaults
 * to the sf-rentals key for back-compat with caches written before it existed).
 */
(function (global) {
  "use strict";

  var CFG = global.ANNOTATE_CONFIG || {};
  var ENDPOINT = CFG.endpoint || "/api/annotate";
  var APP_SECRET = CFG.appSecret || "";
  var LS_KEY = CFG.lsKey || "sf-rentals-optimistic-v1";

  // --- intent id ---------------------------------------------------------- //
  function intentId() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return "i-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  // --- optimistic local view (localStorage) ------------------------------- //
  function loadLocal() {
    try {
      var v = JSON.parse(global.localStorage.getItem(LS_KEY)) ||
        { stars: {}, pairs: {}, intents: {}, views: {} };
      if (!v.views) v.views = {};   // back-fill for caches written before saved views
      return v;
    } catch (e) {
      return { stars: {}, pairs: {}, intents: {}, views: {} };
    }
  }

  function saveLocal(v) {
    try {
      global.localStorage.setItem(LS_KEY, JSON.stringify(v));
    } catch (e) { /* private mode / quota — optimistic view is best-effort */ }
  }

  function pairKey(a, b) {
    return [a, b].sort().join("|");
  }

  // --- transport ---------------------------------------------------------- //
  function send(intent) {
    var local = loadLocal();
    local.intents[intent.id] = { kind: intent.kind, ts: intent.ts, pending: true };
    saveLocal(local);
    return fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "x-app-secret": APP_SECRET },
      body: JSON.stringify(intent),
    }).then(function (r) {
      if (!r.ok) throw new Error("annotate failed: " + r.status);
      return intent.id;
    }).catch(function (err) {
      // keep the optimistic view; the next publish reconciles. Surface for retry UX.
      if (global.console) global.console.warn(err);
      throw err;
    });
  }

  // --- public actions ----------------------------------------------------- //
  function star(unitId, starred) {
    if (starred === undefined) starred = true;
    var local = loadLocal();
    if (starred) local.stars[unitId] = true; else delete local.stars[unitId];
    saveLocal(local);
    return send({ id: intentId(), kind: "star", unit: unitId, starred: starred, ts: nowIso() });
  }

  function assertSame(a, b, snapshot, opts) {
    opts = opts || {};
    var local = loadLocal();
    local.pairs[pairKey(a, b)] = "same";
    saveLocal(local);
    return send({
      id: intentId(), kind: "same", units: [a, b], snapshot: snapshot || {},
      ts: nowIso(), note: opts.note || null, from_queue: !!opts.fromQueue,
    });
  }

  function assertDistinct(a, b, snapshot, opts) {
    opts = opts || {};
    var local = loadLocal();
    local.pairs[pairKey(a, b)] = "distinct";
    saveLocal(local);
    return send({
      id: intentId(), kind: "distinct", units: [a, b], snapshot: snapshot || {},
      ts: nowIso(), note: opts.note || null, from_queue: !!opts.fromQueue,
    });
  }

  function dismiss(a, b, signature) {
    var local = loadLocal();
    local.pairs[pairKey(a, b)] = "dismissed";
    saveLocal(local);
    return send({
      id: intentId(), kind: "dismiss", pair: [a, b], signature: signature || {}, ts: nowIso(),
    });
  }

  function revoke(targetId) {
    return send({ id: intentId(), kind: "revoke", target: targetId, ts: nowIso() });
  }

  // Saved views (named filter/sort/search combos). Optimistic: the local cache
  // holds an upsert ({name,spec}) or a tombstone ({deleted:true}) so the saving
  // device reflects the change instantly; the next publish reconciles.
  function saveView(viewId, name, spec) {
    var local = loadLocal();
    local.views[viewId] = { name: name, spec: spec || {} };
    saveLocal(local);
    return send({ id: intentId(), kind: "view_save", view: viewId, name: name, spec: spec || {}, ts: nowIso() });
  }

  function deleteView(viewId) {
    var local = loadLocal();
    local.views[viewId] = { deleted: true };
    saveLocal(local);
    return send({ id: intentId(), kind: "view_delete", view: viewId, ts: nowIso() });
  }

  // The optimistic view overlay, keyed by view id (entries are {name,spec} or
  // {deleted:true}). Render merges this over the authoritative USER_STATE.views.
  function optimisticViews() {
    return loadLocal().views;
  }

  // --- optimistic read helpers (for render's hydration) ------------------- //
  function optimisticStars() {
    return Object.keys(loadLocal().stars);
  }

  function optimisticPairState(a, b) {
    return loadLocal().pairs[pairKey(a, b)] || null;
  }

  // Drop optimistic entries the authoritative publish now reflects (§6).
  function reconcile(authoritative) {
    authoritative = authoritative || {};
    var local = loadLocal();
    var authStars = authoritative.stars || [];
    authStars.forEach(function (u) { delete local.stars[u]; });
    (authoritative.pairs || []).forEach(function (k) { delete local.pairs[k]; });
    (authoritative.intents || []).forEach(function (id) { delete local.intents[id]; });
    // A saved-view upsert is reflected once its id appears authoritatively; a
    // tombstone once its id is gone. Drop reflected optimistic entries.
    var authViews = {};
    (authoritative.views || []).forEach(function (id) { authViews[id] = true; });
    Object.keys(local.views).forEach(function (id) {
      var reflected = local.views[id].deleted ? !authViews[id] : !!authViews[id];
      if (reflected) delete local.views[id];
    });
    saveLocal(local);
    return local;
  }

  global.Annotate = {
    star: star,
    assertSame: assertSame,
    assertDistinct: assertDistinct,
    dismiss: dismiss,
    revoke: revoke,
    saveView: saveView,
    deleteView: deleteView,
    optimisticStars: optimisticStars,
    optimisticPairState: optimisticPairState,
    optimisticViews: optimisticViews,
    reconcile: reconcile,
    _intentId: intentId,
  };
})(typeof window !== "undefined" ? window : this);
