// Popup arbitration (Task 3). Contract: CONTRACTS.md section 4 (popup rows),
// section 12 (one popup open globally), section 13 (coordinate order).
//
// register(ctx) wires openPopup/closePopup/setPopupContent. One popup open
// globally across all widgets; opening a new popup closes the previous.
// Standalone popups use lat/lng; anchored popups attach to a marker via
// markers.js getMarker(widgetId, id) (additive export).

import maplibregl from "maplibre-gl";
import { getMarker } from "../commands/markers.js";
import {
  openPopup as validateOpen,
  closePopup as validateClose,
  setPopupContent as validateSetContent,
} from "../validate.js";

// Module-level: the single open popup. { popup, widgetId, id } or null.
let current = null;

function closeCurrent() {
  if (!current) return;
  try { current.popup.remove(); } catch { /* idempotent */ }
  current = null;
}

export function register(ctx) {
  ctx.registerCommand("openPopup", (payload, widgetId) => {
    const err = validateOpen(payload);
    if (err) throw new Error(err);

    // Resolve the anchor BEFORE closing the current popup so a failed
    // openPopup (missing anchor) does not destroy another widget's popup.
    let anchored = false;
    let anchorMarker = null;
    if (payload.anchorMarkerId != null) {
      anchorMarker = getMarker(widgetId, payload.anchorMarkerId);
      if (!anchorMarker) throw new Error("popup anchor marker not found");
      anchored = true;
    }

    // One popup globally: close the previous (any widget) only once the
    // new popup is certain to open.
    closeCurrent();

    const popup = new maplibregl.Popup({ className: "anymaps-popup" })
      .setHTML(payload.content);

    if (anchored) {
      anchorMarker.setPopup(popup);
      anchorMarker.togglePopup(); // opens (popup starts closed)
    } else {
      popup.setLngLat([payload.lng, payload.lat]).addTo(ctx.map);
    }

    current = { popup, widgetId, id: payload.id, anchored };

    // Track so manager cleanup removes this widget's open popup. Idempotent:
    // popup.remove() is safe to call twice; clearing `current` only when it
    // still points at this popup keeps the global pointer consistent.
    ctx.track(widgetId, "popup", payload.id, () => {
      if (current && current.id === payload.id && current.widgetId === widgetId) {
        current = null;
      }
      try { popup.remove(); } catch { /* idempotent */ }
    });
  });

  ctx.registerCommand("closePopup", (payload, widgetId) => {
    const err = validateClose(payload);
    if (err) throw new Error(err);

    // Fire-and-forget: only act if the current popup matches this id.
    if (!current || current.id !== payload.id) return;
    closeCurrent();
  });

  ctx.registerCommand("setPopupContent", (payload, widgetId) => {
    const err = validateSetContent(payload);
    if (err) throw new Error(err);

    if (!current || current.id !== payload.id) {
      throw new Error("popup not open");
    }
    current.popup.setHTML(payload.content);
  });
}
