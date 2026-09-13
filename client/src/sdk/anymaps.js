// anymaps SDK runtime (Column A).
//
// This file is prepended to every widget bundle before the blob worker is
// created, so `anymaps` is a global inside the worker. Widget authors and
// agents write against this surface, never against raw postMessage.
//
// Contract: CONTRACTS.md sections 2-6. Envelope kinds: init, cmd, event,
// error. The library assigns a unique id to each command it sends and routes
// incoming event and error messages to registered handlers.
//
// Plain script on purpose: no import/export. Task 2 concatenates this file
// as raw text in front of widget bundles.
(function () {
  "use strict";
  const PROTOCOL_VERSION = 1;
  let cmdSeq = 0;
  let config = null;
  let state = null;
  let initResolve, initReject;
  const readyPromise = new Promise((resolve, reject) => {
    initResolve = resolve;
    initReject = reject;
  });
  const handlers = new Map(); // name -> Set of fns

  function send(name, payload) {
    const id = "c" + ++cmdSeq;
    postMessage({ v: 1, kind: "cmd", id, name, payload });
  }

  function on(name, handler) {
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name).add(handler);
    return () => off(name, handler);
  }
  function off(name, handler) {
    handlers.get(name)?.delete(handler);
  }
  function dispatch(name, payload) {
    for (const h of handlers.get(name) ?? []) {
      try { h(payload); } catch (e) { /* handler errors never break the widget */ }
    }
  }

  self.onmessage = (msg) => {
    const m = msg.data;
    if (m.v !== 1) return;
    if (m.kind === "init") {
      if (m.protocolVersion !== PROTOCOL_VERSION) {
        const err = "protocolVersion " + m.protocolVersion +
          " not supported by this runtime";
        postMessage({ v: 1, kind: "error", error: err });
        initReject(new Error(err));
        return;
      }
      config = { widgetId: m.widgetId, baseUrl: m.baseUrl,
                 channelRoutes: m.channelRoutes };
      state = m.state ?? {};
      initResolve({ config, state });
      return;
    }
    if (m.kind === "event") { dispatch(m.name, m.payload); return; }
    if (m.kind === "error") { dispatch("error", { id: m.id, error: m.error }); return; }
  };

  const anymaps = {
    ready: () => readyPromise,
    get config() { return config; },
    get state() { return state; },
    on, off,

    addMarker: (p) => send("addMarker", p),
    updateMarker: (p) => send("updateMarker", p),
    removeMarker: (id) => send("removeMarker", { id }),
    addPolyline: (p) => send("addPolyline", p),
    updatePolyline: (p) => send("updatePolyline", p),
    removePolyline: (id) => send("removePolyline", { id }),
    openPopup: (p) => send("openPopup", p),
    closePopup: (id) => send("closePopup", { id }),
    setPopupContent: (p) => send("setPopupContent", p),
    setPanel: (p) => send("setPanel", p),
    clearPanel: () => send("clearPanel", {}),
    setStyles: (cssText) => send("setStyles", { cssText }),
    persist: (partial) => send("persist", partial),
    requestCameraControl: () => send("requestCameraControl", {}),
    releaseCameraControl: () => send("releaseCameraControl", {}),
    flyTo: (p) => send("flyTo", p),
    jumpTo: (p) => send("jumpTo", p),
    fitBounds: (p) => send("fitBounds", p),
    startGeolocation: (p) => send("startGeolocation", p),
    stopGeolocation: () => send("stopGeolocation", {}),
  };
  globalThis.anymaps = anymaps;
})();
