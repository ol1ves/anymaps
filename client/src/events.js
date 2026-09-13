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
// scheduleCameraCommand(issuer): suppress = issuer, schedule broadcast.
// moveEnd(): if suppress set, broadcast now to all except suppress, clear
// suppress, cancel timer. Else schedule a debounced broadcast to all.
export function createViewportNotifier({ getViewport, now, setTimeout,
  clearTimeout, emit, listWidgets }) {
  void now; // accepted for parity/tests; the notifier drives via setTimeout.
  let timer = null;
  let suppress = null;

  function broadcast() {
    timer = null;
    const skip = suppress;
    suppress = null;
    const viewport = getViewport();
    for (const widgetId of listWidgets()) {
      if (widgetId === skip) continue;
      emit(widgetId, "viewportChanged", viewport);
    }
  }

  function schedule() {
    if (timer !== null) return; // collapse within the window
    timer = setTimeout(broadcast, DEBOUNCE_MS);
  }

  return {
    scheduleCameraCommand(issuerWidgetId) {
      suppress = issuerWidgetId;
      schedule();
    },
    moveEnd() {
      if (suppress !== null) {
        // Broadcast immediately to all except suppress, cancel pending timer.
        if (timer !== null) { clearTimeout(timer); timer = null; }
        broadcast();
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
