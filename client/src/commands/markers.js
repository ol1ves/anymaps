// Marker commands (Task 2). Contract: CONTRACTS.md section 4 (marker rows),
// section 12 (z-order), section 13 (coordinate order).
//
// register(ctx) wires addMarker/updateMarker/removeMarker command handlers.
// Per widget: Map<id, { marker, element, iconEl, data }>. Coordinate
// translation [lng, lat] happens here, at the MapLibre boundary only.

import maplibregl from "maplibre-gl";
import { addMarker as validateAdd, updateMarker as validateUpdate,
  removeMarker as validateRemove } from "../validate.js";

// widgetId -> Map<markerId, { marker, element, iconEl, data }>
const stores = new Map();
const MARKER_MOVE_MS = 500;

function storeFor(widgetId) {
  let m = stores.get(widgetId);
  if (!m) { m = new Map(); stores.set(widgetId, m); }
  return m;
}

function cancelMove(rec) {
  if (rec.animationFrame != null) {
    cancelAnimationFrame(rec.animationFrame);
    rec.animationFrame = null;
  }
}

function animateMove(rec, lat, lng) {
  cancelMove(rec);
  const start = rec.data;
  const fromLat = Number(start.lat);
  const fromLng = Number(start.lng);
  const startTime = performance.now();

  if (!Number.isFinite(fromLat) || !Number.isFinite(fromLng)) {
    rec.marker.setLngLat([lng, lat]);
    return;
  }

  const step = (now) => {
    const progress = Math.min(1, (now - startTime) / MARKER_MOVE_MS);
    const eased = 1 - Math.pow(1 - progress, 3);
    rec.marker.setLngLat([
      fromLng + (lng - fromLng) * eased,
      fromLat + (lat - fromLat) * eased,
    ]);
    if (progress < 1) rec.animationFrame = requestAnimationFrame(step);
    else rec.animationFrame = null;
  };
  rec.animationFrame = requestAnimationFrame(step);
}

// Additive lookup exported for popups.js anchored-popup support (Task 3).
// Returns the maplibregl.Marker instance for a widget's marker id, or
// undefined if not found. Does not restructure markers.js.
export function getMarker(widgetId, id) {
  const rec = storeFor(widgetId).get(id);
  return rec ? rec.marker : undefined;
}

function isImageUrl(icon) {
  if (typeof icon !== "string") return false;
  return /^(https?:)?\/\//i.test(icon) || icon.startsWith("data:");
}

function makeIconEl(icon) {
  let el;
  if (icon != null && isImageUrl(icon)) {
    el = document.createElement("img");
    el.className = "anymaps-marker-icon";
    el.src = icon;
    el.alt = "";
  } else {
    el = document.createElement("span");
    el.className = "anymaps-marker-icon";
    if (icon != null) el.textContent = String(icon);
  }
  return el;
}

function applyColor(iconEl, color) {
  if (color == null) return;
  iconEl.style.background = String(color);
  iconEl.style.borderColor = String(color);
}

function applyRotation(iconEl, rotation) {
  if (rotation == null) return;
  iconEl.style.transform = `rotate(${rotation}deg)`;
}

function ensureLabel(element, label) {
  let labelEl = element.querySelector(".anymaps-marker-label");
  if (label == null) {
    if (labelEl) labelEl.remove();
    return;
  }
  if (!labelEl) {
    labelEl = document.createElement("span");
    labelEl.className = "anymaps-marker-label";
    element.appendChild(labelEl);
  }
  labelEl.textContent = String(label);
}

function buildElement(payload) {
  const element = document.createElement("div");
  element.className = "anymaps-marker";
  if (payload.title != null) element.title = String(payload.title);
  const iconEl = makeIconEl(payload.icon);
  applyColor(iconEl, payload.color);
  applyRotation(iconEl, payload.rotation);
  element.appendChild(iconEl);
  ensureLabel(element, payload.label);
  return { element, iconEl };
}

export function register(ctx) {
  ctx.registerCommand("addMarker", (payload, widgetId) => {
    const err = validateAdd(payload);
    if (err) throw new Error(err);

    const store = storeFor(widgetId);
    // Replace an existing marker with the same id rather than double-draw.
    const prev = store.get(payload.id);
    if (prev) {
      cancelMove(prev);
      prev.marker.remove();
    }

    const { element, iconEl } = buildElement(payload);
    const marker = new maplibregl.Marker({ element })
      .setLngLat([payload.lng, payload.lat])
      .addTo(ctx.map);

    element.addEventListener("click", () => {
      ctx.emit(widgetId, "markerClick", { markerId: payload.id });
    });

    const data = { ...payload };
    const rec = { marker, element, iconEl, data, animationFrame: null };
    store.set(payload.id, rec);

    ctx.track(widgetId, "marker", payload.id, () => {
      cancelMove(rec);
      marker.remove();
      store.delete(payload.id);
    });

    ctx.reorder(widgetId);
  });

  ctx.registerCommand("updateMarker", (payload, widgetId) => {
    const err = validateUpdate(payload);
    if (err) throw new Error(err);

    const store = storeFor(widgetId);
    const rec = store.get(payload.id);
    if (!rec) throw new Error("marker not found");

    const { marker, element, data } = rec;

    if ("lat" in payload || "lng" in payload) {
      const lat = "lat" in payload ? payload.lat : data.lat;
      const lng = "lng" in payload ? payload.lng : data.lng;
      animateMove(rec, lat, lng);
      if ("lat" in payload) data.lat = payload.lat;
      if ("lng" in payload) data.lng = payload.lng;
    }
    if ("icon" in payload) {
      const next = makeIconEl(payload.icon);
      applyColor(next, "color" in payload ? payload.color : data.color);
      applyRotation(next, "rotation" in payload ? payload.rotation : data.rotation);
      element.replaceChild(next, rec.iconEl);
      rec.iconEl = next;
      data.icon = payload.icon;
    } else if ("color" in payload) {
      applyColor(rec.iconEl, payload.color);
      data.color = payload.color;
    }
    if ("rotation" in payload) {
      applyRotation(rec.iconEl, payload.rotation);
      data.rotation = payload.rotation;
    }
    if ("title" in payload) {
      element.title = String(payload.title);
      data.title = payload.title;
    }
    if ("label" in payload) {
      ensureLabel(element, payload.label);
      data.label = payload.label;
    }
  });

  ctx.registerCommand("removeMarker", (payload, widgetId) => {
    const err = validateRemove(payload);
    if (err) throw new Error(err);

    const store = storeFor(widgetId);
    const rec = store.get(payload.id);
    // Unknown id: ignore silently (idempotent, fire-and-forget).
    if (!rec) return;
    cancelMove(rec);
    rec.marker.remove();
    store.delete(payload.id);
    // The tracked removeFn is idempotent; cleanup will no-op on this id.
  });

  // Re-apply z-order to all of this widget's markers. The manager owns the
  // enable-order counter; Task 3 wraps this further for polylines.
  const upstream = ctx.reorder;
  ctx.reorder = (widgetId) => {
    if (upstream) upstream(widgetId);
    const order = ctx.widgetOrder(widgetId);
    const z = String(1000 + 10 * order);
    for (const { element } of storeFor(widgetId).values()) {
      element.style.zIndex = z;
    }
  };
}
