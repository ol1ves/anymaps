// WidgetManager (Task 2). Owns the registry, worker lifecycle, event routing,
// the map, the DOM, the geolocation watch, and the camera lease. Only code
// that talks to MapLibre directly. Contract: CONTRACTS.md sections 3, 6, 10,
// 12, 13, 14; SPEC.md sections 5.5, 7.2, 7.3, 7.6, 7.10, 7.11.

import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import anymapsRuntime from "./sdk/anymaps.js?raw";
import { provision, startupEnable } from "./install.js";
import { register as registerMarkers } from "./commands/markers.js";
import { register as registerPolylines } from "./commands/polylines.js";
import { register as registerPopups } from "./render/popups.js";
import { register as registerPanels } from "./render/panels.js";
import { register as registerStyles } from "./render/styles.js";
import { register as registerPersist } from "./persist.js";
import { register as registerEvents } from "./events.js";
import { register as registerCamera } from "./camera.js";
import { register as registerGeo } from "./geo.js";
import { register as registerInstall } from "./install.js";
import { register as registerGallery } from "./ui/gallery.js";
import { register as registerWizard } from "./ui/wizard.js";

// Basemap: OpenFreeMap "bright" (free, no key, vector, streets + labels).
const NYC = { lat: 40.71, lng: -74.0 };

// Compact attribution: a small ⓘ that expands to the required license links.
// Moved here unchanged from the Task 1 hello-world main.js.
class CompactAttribution {
  onAdd() {
    const details = document.createElement("details");
    details.className = "maplibregl-ctrl anymaps-attrib";
    const summary = document.createElement("summary");
    summary.textContent = "ⓘ";
    summary.setAttribute("aria-label", "Attribution and licenses");
    const inner = document.createElement("div");
    inner.className = "anymaps-attrib-inner";
    inner.innerHTML =
      '© <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' +
      '© <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ' +
      'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
    details.append(summary, inner);
    this._container = details;
    return details;
  }
  onRemove() {
    this._container.remove();
  }
}

function deepMerge(target, patch) {
  for (const k of Object.keys(patch)) {
    const tv = target[k];
    const pv = patch[k];
    if (pv && typeof pv === "object" && !Array.isArray(pv) &&
        tv && typeof tv === "object" && !Array.isArray(tv)) {
      deepMerge(tv, pv);
    } else {
      target[k] = pv;
    }
  }
  return target;
}

function loadRegistry() {
  try {
    const parsed = JSON.parse(localStorage.getItem("anymaps.registry") ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRegistry(r) {
  localStorage.setItem("anymaps.registry", JSON.stringify(r));
}

function makeBus() {
  const handlers = new Map();
  return {
    on(name, cb) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(cb);
      return () => handlers.get(name)?.delete(cb);
    },
    off(name, cb) { handlers.get(name)?.delete(cb); },
    emit(name, data) {
      for (const h of handlers.get(name) ?? []) {
        try { h(data); } catch (e) { console.error(e); }
      }
    },
  };
}

export function createManager() {
  const map = new maplibregl.Map({
    container: "map",
    style: "https://tiles.openfreemap.org/styles/bright",
    center: [NYC.lng, NYC.lat],
    zoom: 12,
    pitch: 0,
    bearing: 0,
    attributionControl: false,
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
  map.addControl(new CompactAttribution(), "bottom-right");

  // Per-widget runtime state.
  const workers = new Map();      // widgetId -> Worker
  const pendingEnables = new Set(); // widgetIds with an enable in flight (race guard)
  const names = new Map();        // widgetId -> manifest.name
  const states = new Map();       // widgetId -> in-memory state object
  const commands = new Map();     // name -> fn(payload, widgetId)
  const tracked = new Map();      // widgetId -> Array<{ kind, id, removeFn }>
  const cleanups = new Map();     // widgetId -> Array<fn>
  let orderCounter = 0;
  const widgetOrders = new Map(); // widgetId -> enable-order number
  const bus = makeBus();

  const ctx = {
    map,

    registerCommand(name, fn) { commands.set(name, fn); },

    track(widgetId, kind, id, removeFn) {
      let list = tracked.get(widgetId);
      if (!list) { list = []; tracked.set(widgetId, list); }
      list.push({ kind, id, removeFn });
    },

    registerCleanup(widgetId, fn) {
      let list = cleanups.get(widgetId);
      if (!list) { list = []; cleanups.set(widgetId, list); }
      list.push(fn);
    },

    emit(widgetId, eventName, payload) {
      const worker = workers.get(widgetId);
      if (!worker) return;
      worker.postMessage({ v: 1, kind: "event", name: eventName, payload });
    },

    widgetName(widgetId) {
      return names.get(widgetId) ?? widgetId;
    },

    getState(widgetId) {
      return states.get(widgetId) ?? {};
    },

    // Baseline persistState: deep-merge + localStorage write + in-memory
    // update. Task 3's persist.js overrides this via register(ctx).
    persistState(widgetId, partial) {
      const cur = states.get(widgetId) ?? {};
      deepMerge(cur, partial);
      states.set(widgetId, cur);
      try {
        localStorage.setItem("anymaps.state." + widgetId, JSON.stringify(cur));
      } catch (e) { console.error(e); }
    },

    // Re-apply z-order for a widget's drawn items. Feature modules wrap this
    // (markers.js sets marker z-index; Task 3 adds polylines).
    reorder(widgetId) { /* markers.js wraps this */ },

    // Enable-order counter for z-order. Manager-owned. (The pinned seam did
    // not expose the counter; markers.js needs it to compute z-index.)
    widgetOrder(widgetId) {
      return widgetOrders.get(widgetId) ?? 0;
    },

    bus,

    widgets() {
      return [...names.entries()].map(([widgetId, name]) => ({ widgetId, name }));
    },
  };

  // Feature modules self-register command handlers and cleanup. Order is
  // pinned; later tasks fill the stubs. Do not change this list.
  registerMarkers(ctx);
  registerPolylines(ctx);
  registerPopups(ctx);
  registerPanels(ctx);
  registerStyles(ctx);
  registerPersist(ctx);
  registerEvents(ctx);
  registerCamera(ctx);
  registerGeo(ctx);
  registerInstall(ctx);
  registerGallery(ctx);
  registerWizard(ctx);

  function postError(worker, id, error) {
    worker.postMessage({ v: 1, kind: "error", id, error });
  }

  async function enable({ manifest, bundleSource, baseUrl }) {
    const widgetId = manifest.id;
    // No-op if already enabled or an enable is already in flight. The race
    // guard matters across the `await provision` window: without it a second
    // enable would spawn a second worker and leak the first.
    if (workers.has(widgetId) || pendingEnables.has(widgetId)) return;
    pendingEnables.add(widgetId);

    try {
      const channelRoutes = await provision(manifest, baseUrl);

      // Module worker: the brief's fixture bundle uses bare top-level await,
      // which is valid in module workers (not classic). The runtime is an IIFE
      // and the bundle has no import/export, so both run as module top-level.
      const blob = new Blob([anymapsRuntime + "\n;\n" + bundleSource],
        { type: "application/javascript" });
      const worker = new Worker(URL.createObjectURL(blob), { type: "module" });

      let state;
      try {
        state = JSON.parse(localStorage.getItem("anymaps.state." + widgetId) ?? "{}");
      } catch {
        state = {};
      }
      if (!state || typeof state !== "object") state = {};

      names.set(widgetId, manifest.name);
      states.set(widgetId, state);

      worker.onmessage = ({ data }) => {
        if (!data || data.v !== 1) return;
        if (data.kind !== "cmd") return;
        const { id, name, payload } = data;
        const handler = commands.get(name);
        if (!handler) {
          postError(worker, id, "unknown command " + name);
          return;
        }
        try {
          handler(payload, widgetId);
        } catch (e) {
          postError(worker, id, e.message);
          console.error(e);
        }
        // Errors never propagate into the worker; the widget keeps running.
      };

      // Bootstrap failure (e.g. a bundle that throws at top level): post an
      // error envelope with no id (per the Task 1 runtime precedent for init
      // errors) and log. Never throw on the main thread.
      worker.onerror = (e) => {
        worker.postMessage({ v: 1, kind: "error", error: e.message });
        console.error(e);
      };

      workers.set(widgetId, worker);

      // Post exactly one init message after provisioning.
      worker.postMessage({
        v: 1,
        kind: "init",
        protocolVersion: 1,
        widgetId,
        baseUrl,
        channelRoutes,
        state,
      });

      // Upsert registry entry, bump enable-order, reorder, announce.
      const reg = loadRegistry();
      const entry = reg.find((e) => e.widgetId === widgetId);
      if (entry) {
        entry.version = manifest.version;
        entry.enabled = true;
      } else {
        reg.push({ widgetId, version: manifest.version, enabled: true });
      }
      saveRegistry(reg);

      const order = ++orderCounter;
      widgetOrders.set(widgetId, order);
      ctx.reorder(widgetId);
      bus.emit("widget-enabled", { widgetId });
    } finally {
      // Worker is registered; the enabled guard now covers re-entry. Clear
      // the in-flight marker so a failed enable can be retried.
      pendingEnables.delete(widgetId);
    }
  }

  function disable(widgetId) {
    // Cleanup fns in registration order, then tracked removeFns.
    const cleanupList = cleanups.get(widgetId);
    if (cleanupList) {
      for (const fn of cleanupList) {
        try { fn(); } catch (e) { console.error(e); }
      }
      cleanups.delete(widgetId);
    }
    const trackedList = tracked.get(widgetId);
    if (trackedList) {
      for (const { removeFn } of trackedList) {
        try { removeFn(widgetId); } catch (e) { console.error(e); }
      }
      tracked.delete(widgetId);
    }

    const worker = workers.get(widgetId);
    if (worker) {
      worker.terminate();
      workers.delete(widgetId);
    }

    const reg = loadRegistry();
    const entry = reg.find((e) => e.widgetId === widgetId);
    if (entry) { entry.enabled = false; saveRegistry(reg); }

    names.delete(widgetId);
    states.delete(widgetId);
    widgetOrders.delete(widgetId);
    bus.emit("widget-disabled", { widgetId });
  }

  function uninstall(widgetId) {
    disable(widgetId);
    const reg = loadRegistry().filter((e) => e.widgetId !== widgetId);
    saveRegistry(reg);
    try {
      localStorage.removeItem("anymaps.state." + widgetId);
    } catch (e) { console.error(e); }
    bus.emit("widget-uninstalled", { widgetId });
  }

  function list() {
    return loadRegistry();
  }

  function widgetName(widgetId) {
    return ctx.widgetName(widgetId);
  }

  function startup() {
    return startupEnable(manager);
  }

  const manager = {
    enable, disable, uninstall, list, widgetName, startup,
    // Test/dev access. Not part of the public API contract.
    get ctx() { return ctx; },
  };
  return manager;
}
