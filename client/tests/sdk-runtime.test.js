// Tests for the anymaps SDK runtime (client/src/sdk/anymaps.js).
//
// The runtime is a plain script (no imports/exports) because Task 2
// prepends it to widget bundles as raw text. The harness therefore runs
// it inside a worker-like sandbox instead of importing it as a module.
//
// Contract: CONTRACTS.md sections 2, 3, 5, 6. SPEC.md section 7.

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRuntime } from "./helpers/runtime-harness.js";

const INIT = {
  v: 1,
  kind: "init",
  protocolVersion: 1,
  widgetId: "find-my-friends",
  baseUrl: "https://server.example",
  channelRoutes: {
    fmfW: "https://server.example/widgets/find-my-friends/channels/fmfW",
  },
  state: { iid: "x" },
};

test("ready() does not resolve before init", () => {
  const { anymaps } = loadRuntime();
  let settled = false;
  anymaps.ready().then(
    () => { settled = true; },
    () => { settled = true; },
  );
  return new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
    assert.equal(settled, false);
  });
});

test("ready() resolves with { config, state } after init", async () => {
  const { anymaps, receive } = loadRuntime();
  const pending = anymaps.ready();
  receive(INIT);
  const resolved = await pending;
  assert.equal(resolved.config.widgetId, "find-my-friends");
  assert.equal(resolved.config.baseUrl, "https://server.example");
  assert.deepEqual(resolved.config.channelRoutes, INIT.channelRoutes);
  assert.equal(resolved.state.iid, "x");
  assert.equal(anymaps.config, resolved.config);
  assert.equal(anymaps.state, resolved.state);
});

// One row per command helper. `arg` is what the test calls the helper
// with; `payload` is the envelope payload the runtime must send.
const COMMANDS = [
  ["addMarker", { id: "b42", lat: 40.71, lng: -74.0, icon: "🚻", color: "#0066ff" }, { id: "b42", lat: 40.71, lng: -74.0, icon: "🚻", color: "#0066ff" }],
  ["updateMarker", { id: "b42", label: "open" }, { id: "b42", label: "open" }],
  ["removeMarker", "b42", { id: "b42" }],
  ["addPolyline", { id: "trail-1", points: [[40.7, -74.0], [40.8, -74.1]] }, { id: "trail-1", points: [[40.7, -74.0], [40.8, -74.1]] }],
  ["updatePolyline", { id: "trail-1", append: [[40.9, -74.2]] }, { id: "trail-1", append: [[40.9, -74.2]] }],
  ["removePolyline", "trail-1", { id: "trail-1" }],
  ["openPopup", { id: "p1", content: "<b>hi</b>", lat: 40.71, lng: -74.0 }, { id: "p1", content: "<b>hi</b>", lat: 40.71, lng: -74.0 }],
  ["closePopup", "p1", { id: "p1" }],
  ["setPopupContent", { id: "p1", content: "updated" }, { id: "p1", content: "updated" }],
  ["setPanel", { title: "Nearby", content: "<ul><li>3</li></ul>" }, { title: "Nearby", content: "<ul><li>3</li></ul>" }],
  ["clearPanel", undefined, {}],
  ["setStyles", ".foo { color: red; }", { cssText: ".foo { color: red; }" }],
  ["persist", { iid: "y" }, { iid: "y" }],
  ["requestCameraControl", undefined, {}],
  ["releaseCameraControl", undefined, {}],
  ["flyTo", { center: [40.71, -74.0], zoom: 12, bearing: 90 }, { center: [40.71, -74.0], zoom: 12, bearing: 90 }],
  ["jumpTo", { center: [40.71, -74.0], zoom: 12 }, { center: [40.71, -74.0], zoom: 12 }],
  ["fitBounds", { bounds: [[40.5, -74.3], [40.9, -73.7]] }, { bounds: [[40.5, -74.3], [40.9, -73.7]] }],
  ["startGeolocation", { highAccuracy: true }, { highAccuracy: true }],
  ["stopGeolocation", undefined, {}],
];

test("every helper posts exactly one cmd envelope with the right name and payload", () => {
  const { anymaps, posted } = loadRuntime();
  for (const [name, arg] of COMMANDS) {
    anymaps[name](arg);
  }
  assert.equal(posted.length, COMMANDS.length);
  const seenIds = new Set();
  COMMANDS.forEach(([name, , payload], i) => {
    const msg = posted[i];
    assert.deepEqual(
      { v: msg.v, kind: msg.kind, name: msg.name, payload: msg.payload },
      { v: 1, kind: "cmd", name, payload },
    );
    // id: string starting with "c", unique, monotonically increasing.
    assert.equal(typeof msg.id, "string");
    assert.ok(msg.id.startsWith("c"), `id ${msg.id} starts with c`);
    assert.ok(!seenIds.has(msg.id), `id ${msg.id} is unique`);
    seenIds.add(msg.id);
    const suffix = Number(msg.id.slice(1));
    assert.equal(suffix, i + 1, `id suffix increases monotonically: ${msg.id}`);
  });
});

test("on/off event routing", () => {
  const { anymaps, receive } = loadRuntime();
  const fired = [];
  const h = (payload) => fired.push(payload);
  anymaps.on("markerClick", h);
  receive({ v: 1, kind: "event", name: "markerClick", payload: { markerId: "m1" } });
  assert.deepEqual(fired, [{ markerId: "m1" }]);
  anymaps.off("markerClick", h);
  receive({ v: 1, kind: "event", name: "markerClick", payload: { markerId: "m2" } });
  assert.deepEqual(fired, [{ markerId: "m1" }]);
});

test("error routing fires the error handler with { id, error }", () => {
  const { anymaps, receive } = loadRuntime();
  const fired = [];
  anymaps.on("error", (payload) => fired.push(payload));
  receive({ v: 1, kind: "error", id: "c1", error: "marker missing position" });
  assert.deepEqual(fired, [{ id: "c1", error: "marker missing position" }]);
});

test("protocol mismatch posts an error envelope and rejects ready()", async () => {
  const { anymaps, posted, receive } = loadRuntime();
  const fired = [];
  anymaps.on("error", (payload) => fired.push(payload));
  const pending = assert.rejects(
    anymaps.ready(),
    { message: "protocolVersion 2 not supported by this runtime" },
  );
  receive({ ...INIT, protocolVersion: 2 });
  await pending;
  assert.equal(posted.length, 1);
  assert.equal(posted[0].v, 1);
  assert.equal(posted[0].kind, "error");
  assert.equal(posted[0].error, "protocolVersion 2 not supported by this runtime");
  assert.deepEqual(fired, [
    { id: undefined, error: "protocolVersion 2 not supported by this runtime" },
  ]);
});

test("persist payload is the partial object itself", () => {
  const { anymaps, posted } = loadRuntime();
  anymaps.persist({ iid: "y" });
  assert.deepEqual(posted, [
    { v: 1, kind: "cmd", id: "c1", name: "persist", payload: { iid: "y" } },
  ]);
});

test("handler exceptions never crash the widget", () => {
  const { anymaps, receive } = loadRuntime();
  anymaps.on("markerClick", () => { throw new Error("boom"); });
  const second = [];
  anymaps.on("markerClick", (p) => second.push(p));
  receive({ v: 1, kind: "event", name: "markerClick", payload: { markerId: "m1" } });
  assert.deepEqual(second, [{ markerId: "m1" }]);
});
