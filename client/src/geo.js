// Geolocation proxy + user dot (Task 5). Contract: CONTRACTS.md section 4
// (startGeolocation/stopGeolocation rows), section 5 (geolocation /
// geolocationError rows), section 12 (user location dot rule); SPEC.md
// sections 7.4, 7.5.
//
// createGeoProxy({ watchPosition, clearWatch, onEvent }) is pure refcount
// logic, importable under Node: watchPosition/clearWatch are injected and no
// DOM or navigator access happens at module top level. register(ctx) wires
// the proxy to navigator.geolocation, emits geolocation / geolocationError
// events to subscriber widgets, and draws a native maplibregl user dot while
// a watch is active. The dot is manager-owned: never tracked as a widget
// item, never counted in per-widget cleanup.

// ---------------------------------------------------------------------------
// Pure proxy (Node-testable)

// One shared browser watch backs any number of widget subscribers. The watch
// starts with the first subscriber and clears when the last one stops.
export function createGeoProxy({ watchPosition, clearWatch, onEvent }) {
  let watchId = null;
  let watchOptions = null;
  let latestFix = null;
  const subs = new Set();
  const hiddenDots = new Set();

  function dotVisible() {
    for (const widgetId of subs) {
      if (!hiddenDots.has(widgetId)) return true;
    }
    return false;
  }

  function ensureWatch(options) {
    // Keep the higher accuracy setting if subscribers disagree; starting a
    // new watch on every subscriber would defeat the shared-watch rule.
    if (watchId === null) {
      watchOptions = options;
      watchId = watchPosition(
        (pos) => {
          const coords = pos.coords;
          latestFix = {
            lat: coords.latitude,
            lng: coords.longitude,
            accuracy: coords.accuracy,
          };
          onEvent({ type: "dot", visible: dotVisible(), payload: latestFix });
          onEvent({ type: "fix", payload: latestFix });
        },
        (err) => {
          onEvent({ type: "error", payload: { code: err.code, message: err.message } });
        },
        watchOptions,
      );
    } else if (options?.enableHighAccuracy && !watchOptions?.enableHighAccuracy) {
      watchOptions = options;
      clearWatch(watchId);
      watchId = null;
      ensureWatch(options);
    }
  }

  function releaseWatch() {
    if (watchId !== null && subs.size === 0) {
      clearWatch(watchId);
      watchId = null;
      watchOptions = null;
      latestFix = null;
      hiddenDots.clear();
      onEvent({ type: "dot", visible: false });
    }
  }

  return {
    start(widgetId, { highAccuracy = false, showUserDot = true } = {}) {
      // Set dedupes the subscriber. A re-start by an already-subscribed
      // widget still reaches ensureWatch so a highAccuracy request can
      // upgrade the shared watch.
      subs.add(widgetId);
      if (showUserDot === false) hiddenDots.add(widgetId);
      else hiddenDots.delete(widgetId);
      ensureWatch({ enableHighAccuracy: !!highAccuracy });
    },

    stop(widgetId) {
      subs.delete(widgetId);
      hiddenDots.delete(widgetId);
      if (watchId !== null && subs.size > 0 && !dotVisible()) {
        onEvent({ type: "dot", visible: false });
      }
      releaseWatch();
    },

    unsubscribe(widgetId) {
      this.stop(widgetId);
    },

    subscribers() {
      return [...subs];
    },
  };
}

// ---------------------------------------------------------------------------
// Main-thread wiring

import maplibregl from "maplibre-gl";
import { startGeolocation as validateStart } from "./validate.js";

// Dot lifecycle: show(payload) positions the marker with setLngLat BEFORE
// addTo, then assigns it. MapLibre throws on addTo without a position, so
// ordering is pinned. hide() removes and clears. Injected createMarker keeps
// this testable without a DOM.
export function makeDotHandler({ map, createMarker }) {
  let dot = null;
  return {
    show(payload) {
      const pos = [payload.lng, payload.lat];
      if (!dot) {
        dot = createMarker();
        dot.setLngLat(pos);
        dot.addTo(map);
      } else {
        dot.setLngLat(pos);
      }
    },
    hide() {
      if (dot) {
        dot.remove();
        dot = null;
      }
    },
  };
}

export function register(ctx, deps = {}) {
  // Optional injected geolocation keeps register testable under Node; the
  // browser path reads navigator.geolocation.
  const geo = deps.geolocation ??
    (typeof navigator !== "undefined" ? navigator.geolocation : null);

  // Scoped to this register call so a manager re-construct cannot inherit
  // stale guards. The cleanup fn deletes its widgetId so disable/re-enable
  // cycles re-register (a module-level Set leaked across cycles: the second
  // disable never unsubscribed and the shared watch survived).
  const cleanupRegistered = new Set();

  const dots = makeDotHandler({
    map: ctx.map,
    createMarker() {
      const el = document.createElement("div");
      el.className = "anymaps-user-dot";
      return new maplibregl.Marker({ element: el });
    },
  });

  const proxy = createGeoProxy({
    watchPosition: geo ? geo.watchPosition.bind(geo) : null,
    clearWatch: geo ? geo.clearWatch.bind(geo) : null,
    onEvent(event) {
      for (const widgetId of proxy.subscribers()) {
        if (event.type === "fix") {
          ctx.emit(widgetId, "geolocation", event.payload);
        } else if (event.type === "error") {
          ctx.emit(widgetId, "geolocationError", event.payload);
        }
      }
      if (event.type === "dot") {
        if (event.visible) dots.show(event.payload);
        else dots.hide();
      }
    },
  });

  ctx.registerCommand("startGeolocation", (payload, widgetId) => {
    const verr = validateStart(payload);
    if (verr) throw new Error(verr);
    if (!geo) {
      ctx.emit(widgetId, "geolocationError", { code: 2, message: "geolocation unavailable" });
      return;
    }
    // Idempotent guard: register the cleanup fn once per enable cycle, no
    // matter how many times the widget starts/stops geolocation. The fn
    // clears its own guard so a re-enable registers a fresh cleanup.
    if (!cleanupRegistered.has(widgetId)) {
      cleanupRegistered.add(widgetId);
      ctx.registerCleanup(widgetId, () => {
        proxy.unsubscribe(widgetId);
        cleanupRegistered.delete(widgetId);
      });
    }
    proxy.start(widgetId, {
      highAccuracy: !!payload?.highAccuracy,
      showUserDot: payload?.showUserDot !== false,
    });
  });

  ctx.registerCommand("stopGeolocation", (_payload, widgetId) => {
    proxy.stop(widgetId);
  });
}
