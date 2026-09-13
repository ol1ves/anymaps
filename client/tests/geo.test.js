// Unit tests for the geolocation proxy (Task 5). createGeoProxy is pure:
// watchPosition/clearWatch are injected, no DOM or navigator access.
// Contract: CONTRACTS.md section 4 (startGeolocation/stopGeolocation rows),
// section 5 (geolocation/geolocationError rows), section 12 (user dot rule).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createGeoProxy, makeDotHandler, register } from "../src/geo.js";

function makeHarness() {
  const events = [];
  let nextId = 1;
  const watches = []; // { success, error, options, id, cleared }
  const calls = { watch: 0, clear: 0 };
  return {
    events,
    watches,
    calls,
    watchPosition(success, error, options) {
      calls.watch++;
      const w = { success, error, options, id: nextId++, cleared: false };
      watches.push(w);
      return w.id;
    },
    clearWatch(id) {
      calls.clear++;
      const w = watches.find((w) => w.id === id);
      if (w) w.cleared = true;
    },
    onEvent(e) { events.push(e); },
  };
}

function fixEvt(payload) { return { type: "fix", payload }; }
function errEvt(payload) { return { type: "error", payload }; }
function dotOn(payload) { return { type: "dot", visible: true, payload }; }
function dotOff() { return { type: "dot", visible: false }; }

test("first start calls watchPosition once; second subscriber shares the watch", () => {
  const h = makeHarness();
  const proxy = createGeoProxy(h);
  proxy.start("a", { highAccuracy: true });
  proxy.start("b", {});
  assert.equal(h.calls.watch, 1);
  assert.deepEqual(h.watches[0].options, { enableHighAccuracy: true });
  assert.deepEqual(proxy.subscribers(), ["a", "b"]);
});

test("highAccuracy absent or false passes enableHighAccuracy: false", () => {
  const h1 = makeHarness();
  createGeoProxy(h1).start("a", {});
  assert.deepEqual(h1.watches[0].options, { enableHighAccuracy: false });

  const h2 = makeHarness();
  createGeoProxy(h2).start("a", { highAccuracy: false });
  assert.deepEqual(h2.watches[0].options, { enableHighAccuracy: false });
});

test("start emits dot visible with first fix; stop of one subscriber keeps the watch", () => {
  const h = makeHarness();
  const proxy = createGeoProxy(h);
  proxy.start("a", {});
  proxy.start("b", {});

  h.watches[0].success({ coords: { latitude: 40.71, longitude: -74.0, accuracy: 25 } });

  // First fix: dot on + fix event, in that order.
  assert.deepEqual(h.events[0], dotOn({ lat: 40.71, lng: -74.0, accuracy: 25 }));
  assert.deepEqual(h.events[1], fixEvt({ lat: 40.71, lng: -74.0, accuracy: 25 }));
  assert.equal(h.calls.clear, 0);

  proxy.stop("a");
  assert.equal(h.calls.watch, 1); // still one shared watch
  assert.equal(h.calls.clear, 0);
  assert.deepEqual(proxy.subscribers(), ["b"]);
});

test("stopping the last subscriber clears the watch once and emits dot off", () => {
  const h = makeHarness();
  const proxy = createGeoProxy(h);
  proxy.start("a", {});
  proxy.start("b", {});
  const watchId = h.watches[0].id;

  proxy.stop("a");
  proxy.stop("b");
  assert.equal(h.calls.clear, 1);
  assert.equal(h.watches[0].cleared, true);
  assert.deepEqual(h.events.at(-1), dotOff());
  assert.deepEqual(proxy.subscribers(), []);
});

test("dot off only fires once, on the transition to zero subscribers", () => {
  const h = makeHarness();
  const proxy = createGeoProxy(h);
  proxy.start("a", {});
  proxy.stop("a");
  proxy.stop("a"); // idempotent double stop
  const offs = h.events.filter((e) => e.type === "dot" && !e.visible);
  assert.equal(offs.length, 1);
});

test("fix updates latest payload for subsequent dot-on payloads", () => {
  const h = makeHarness();
  const proxy = createGeoProxy(h);
  proxy.start("a", {});
  h.watches[0].success({ coords: { latitude: 1, longitude: 2, accuracy: 10 } });
  proxy.stop("a");
  proxy.start("b", {});
  h.watches[0].success({ coords: { latitude: 3, longitude: 4, accuracy: 20 } });
  proxy.stop("b");

  const ons = h.events.filter((e) => e.type === "dot" && e.visible);
  assert.deepEqual(ons, [
    dotOn({ lat: 1, lng: 2, accuracy: 10 }),
    dotOn({ lat: 3, lng: 4, accuracy: 20 }),
  ]);
});

test("error passes code and message through", () => {
  const h = makeHarness();
  const proxy = createGeoProxy(h);
  proxy.start("a", {});
  h.watches[0].error({ code: 1, message: "permission denied" });

  assert.deepEqual(h.events[0], errEvt({ code: 1, message: "permission denied" }));
  // An error does not end the watch or remove the dot.
  assert.equal(h.calls.clear, 0);
  assert.deepEqual(proxy.subscribers(), ["a"]);
});

test("unsubscribe behaves like stop and is idempotent", () => {
  const h = makeHarness();
  const proxy = createGeoProxy(h);
  proxy.start("a", {});
  proxy.start("b", {});

  proxy.unsubscribe("a");
  assert.deepEqual(proxy.subscribers(), ["b"]);
  assert.equal(h.calls.clear, 0);

  proxy.unsubscribe("a"); // double call safe
  assert.deepEqual(proxy.subscribers(), ["b"]);

  proxy.unsubscribe("b");
  assert.equal(h.calls.clear, 1);
  assert.deepEqual(h.events.at(-1), dotOff());
});

test("stop of an unknown widget is a no-op", () => {
  const h = makeHarness();
  const proxy = createGeoProxy(h);
  proxy.start("a", {});
  proxy.stop("ghost");
  assert.equal(h.calls.clear, 0);
  assert.deepEqual(proxy.subscribers(), ["a"]);
});

// --- dot wiring (regression: MapLibre throws on addTo without a position) ---

function fakeMarker(log) {
  return {
    setLngLat(pos) { log.push(["setLngLat", pos]); return this; },
    addTo(map) { log.push(["addTo", map]); return this; },
    remove() { log.push(["remove"]); },
  };
}

test("dot handler positions the marker before adding it to the map", () => {
  const log = [];
  let created = 0;
  const dots = makeDotHandler({
    map: "MAP",
    createMarker() { created++; return fakeMarker(log); },
  });

  dots.show({ lat: 40.71, lng: -74.0 });
  assert.deepEqual(log, [
    ["setLngLat", [-74.0, 40.71]],
    ["addTo", "MAP"],
  ]);

  // Later fixes reposition without re-adding.
  dots.show({ lat: 41, lng: -73 });
  assert.deepEqual(log, [
    ["setLngLat", [-74.0, 40.71]],
    ["addTo", "MAP"],
    ["setLngLat", [-73, 41]],
  ]);

  // Hide removes and clears; the next show builds a fresh marker.
  dots.hide();
  assert.deepEqual(log.at(-1), ["remove"]);
  dots.show({ lat: 42, lng: -72 });
  assert.deepEqual(log.slice(-2), [
    ["setLngLat", [-72, 42]],
    ["addTo", "MAP"],
  ]);
  assert.equal(created, 2);
});

test("dot handler hide without a show is a no-op", () => {
  const log = [];
  const dots = makeDotHandler({ map: "MAP", createMarker: () => fakeMarker(log) });
  dots.hide();
  assert.deepEqual(log, []);
});

// --- accuracy upgrade on re-start ---

test("re-start by a subscribed widget upgrades the shared watch accuracy", () => {
  const h = makeHarness();
  const proxy = createGeoProxy(h);
  proxy.start("a", {});
  proxy.start("a", { highAccuracy: true });

  // One subscriber, but the watch restarted at high accuracy.
  assert.deepEqual(proxy.subscribers(), ["a"]);
  assert.equal(h.calls.watch, 2);
  assert.equal(h.calls.clear, 1);
  assert.equal(h.watches[0].cleared, true);
  assert.deepEqual(h.watches[1].options, { enableHighAccuracy: true });

  // Fixes flow from the new watch; stop still releases it cleanly.
  h.watches[1].success({ coords: { latitude: 5, longitude: 6, accuracy: 1 } });
  assert.deepEqual(h.events.at(-1), fixEvt({ lat: 5, lng: 6, accuracy: 1 }));
  proxy.stop("a");
  assert.equal(h.calls.clear, 2);
  assert.deepEqual(h.events.at(-1), dotOff());
});

// --- register wiring: cleanup guard across disable/re-enable cycles ---

function makeWiringHarness() {
  const h = makeHarness();
  const commands = new Map();
  const cleanups = [];
  const emitted = [];
  const ctx = {
    map: {},
    registerCommand(name, fn) { commands.set(name, fn); },
    registerCleanup(_widgetId, fn) { cleanups.push(fn); },
    emit(widgetId, name, payload) { emitted.push({ widgetId, name, payload }); },
  };
  register(ctx, {
    geolocation: { watchPosition: h.watchPosition, clearWatch: h.clearWatch },
  });
  return { h, commands, cleanups, emitted };
}

test("cleanup fn clears the guard: re-enable cycle re-registers and unsubscribes", () => {
  const { h, commands, cleanups } = makeWiringHarness();
  const start = commands.get("startGeolocation");

  // First enable cycle: start, then disable runs the registered cleanup.
  start({}, "w1");
  assert.equal(h.calls.watch, 1);
  assert.equal(cleanups.length, 1);
  cleanups[0]();
  assert.equal(h.calls.clear, 1);

  // Re-enable: the stale guard must not skip registration. A fresh cleanup
  // fn exists and unsubscribes the resubscribed widget.
  start({}, "w1");
  assert.equal(h.calls.watch, 2, "widget resubscribes after re-enable");
  assert.equal(cleanups.length, 2, "cleanup re-registered after re-enable");
  cleanups[1]();
  assert.equal(h.calls.clear, 2, "second disable stops the shared watch");
});

test("cleanup registers once per enable cycle across repeated starts", () => {
  const { commands, cleanups } = makeWiringHarness();
  const start = commands.get("startGeolocation");

  start({}, "w1");
  start({ highAccuracy: true }, "w1");
  start({}, "w1");
  assert.equal(cleanups.length, 1);
});
