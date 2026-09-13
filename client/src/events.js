// Marker/map-click/viewportChanged events (Task 4). Contract: CONTRACTS.md
// section 5, SPEC.md section 7.5.
//
// register(ctx) wires map click -> mapClick broadcast and moveend ->
// debounced viewportChanged. markerClick is emitted by markers.js (verified);
// this module owns map-level events.
//
// `createViewportNotifier` is a pure debounced broadcaster exported for unit
// testing under Node with fake timers. register(ctx) builds the real notifier
// against the live MapLibre map and exposes it as `ctx.viewport` (additive
// ctx property; camera.js consumes it).

export const DEBOUNCE_MS = 100;

// Pure debounced broadcaster. `getViewport()` -> { bounds, center, zoom };
// `listWidgets()` -> widget id array; `emit(widgetId, name, payload)`.
//
// scheduleCameraCommand(issuer): suppress = issuer, arm the fallback timer.
// moveEnd(): if suppress set, broadcast the final viewport now to all except
// the issuer, clear suppress, cancel the fallback timer. If suppress is null,
// schedule a debounced broadcast to all.
//
// The fallback timer (100ms) is a safety net for a command that produces no
// moveEnd. It broadcasts to all except the issuer but KEEPS suppress sticky so
// the first real moveEnd still excludes the issuer. This closes the gap for
// animated pans (flyTo, fitBounds) whose moveEnd lands after the debounce:
// the timer fires mid-flight, but suppress survives so the moveEnd broadcast
// still skips the issuer instead of rebroadcasting to it. See CONTRACTS.md
// section 5.
export function createViewportNotifier({ getViewport, now, setTimeout,
  clearTimeout, emit, listWidgets }) {
  void now; // accepted for parity/tests; the notifier drives via setTimeout.
  let timer = null;
  let suppress = null;

  // Broadcast the current viewport to every widget except `suppress`.
  function broadcastToOthers() {
    const skip = suppress;
    const viewport = getViewport();
    for (const widgetId of listWidgets()) {
      if (widgetId === skip) continue;
      emit(widgetId, "viewportChanged", viewport);
    }
  }

  // Fallback for a camera command that produces no moveEnd within the window.
  // Broadcasts to all except the issuer but leaves suppress sticky so the
  // first moveEnd still excludes the issuer.
  function fallbackFire() {
    timer = null;
    broadcastToOthers();
  }

  function schedule() {
    if (timer !== null) return; // collapse within the window
    timer = setTimeout(fallbackFire, DEBOUNCE_MS);
  }

  return {
    scheduleCameraCommand(issuerWidgetId) {
      suppress = issuerWidgetId;
      schedule();
    },
    moveEnd() {
      if (suppress !== null) {
        // First moveEnd after a camera command: broadcast the final viewport
        // to all except the issuer, clear the sticky suppress, cancel any
        // pending fallback timer.
        if (timer !== null) { clearTimeout(timer); timer = null; }
        broadcastToOthers();
        suppress = null;
        return;
      }
      schedule();
    },
  };
}

export function register(ctx) {
  const { map, widgets, emit } = ctx;

  // mapClick: broadcast { lat, lng } to every enabled widget.
  map.on("click", (e) => {
    const { lat, lng } = e.lngLat;
    for (const { widgetId } of widgets()) {
      emit(widgetId, "mapClick", { lat, lng });
    }
  });

  // Viewport read at the MapLibre boundary: bounds [[s,w],[n,e]], center
  // [lat, lng], zoom rounded. Coordinate translation happens here only.
  function getViewport() {
    const b = map.getBounds();
    const c = map.getCenter();
    return {
      bounds: [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]],
      center: [c.lat, c.lng],
      zoom: Math.round(map.getZoom()),
    };
  }

  const notifier = createViewportNotifier({
    getViewport,
    now: () => Date.now(),
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (id) => clearTimeout(id),
    emit,
    listWidgets: () => widgets().map((w) => w.widgetId),
  });

  // Additive ctx property; camera.js calls scheduleCameraCommand.
  ctx.viewport = notifier;

  map.on("moveend", () => notifier.moveEnd());
}
