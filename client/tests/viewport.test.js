// Tests for the viewport notifier (client/src/events.js).
// Contract: CONTRACTS.md section 5 (viewportChanged), SPEC.md section 7.5.
// The notifier is pure: injected getViewport/listWidgets/emit and a manual
// clock. No MapLibre.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createViewportNotifier, DEBOUNCE_MS } from "../src/events.js";

// Same manual clock shape as camera.test.js.
function makeClock() {
  let t = 0;
  const timers = new Map();
  let nextId = 1;
  return {
    now() { return t; },
    advance(dt) {
      const target = t + dt;
      while (true) {
        let due = null;
        for (const [id, tm] of timers) {
          if (tm.fireAt <= target && (due === null || tm.fireAt < due.fireAt)) {
            due = { id, ...tm };
          }
        }
        if (!due) break;
        timers.delete(due.id);
        t = due.fireAt;
        due.cb();
      }
      t = target;
    },
    setTimeout(cb, ms) {
      const id = nextId++;
      timers.set(id, { fireAt: t + ms, cb });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
}

const VIEWPORT = {
  bounds: [[40.5, -74.3], [40.9, -73.7]],
  center: [40.71, -74.0],
  zoom: 12,
};

function setup({ widgets = ["a", "b", "c"] } = {}) {
  const clock = makeClock();
  const sent = []; // { widgetId, payload }
  const notifier = createViewportNotifier({
    getViewport: () => VIEWPORT,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    emit: (widgetId, name, payload) => sent.push({ widgetId, name, payload }),
    listWidgets: () => widgets,
  });
  return { clock, sent, notifier };
}

test("DEBOUNCE_MS is 100", () => {
  assert.equal(DEBOUNCE_MS, 100);
});

// Case 1: moveEnd -> emits to all widgets with the viewport.
test("moveEnd broadcasts to all widgets", () => {
  const { clock, sent, notifier } = setup();
  notifier.moveEnd();
  clock.advance(DEBOUNCE_MS);
  assert.equal(sent.length, 3);
  for (const w of ["a", "b", "c"]) {
    assert.ok(sent.some((s) => s.widgetId === w), `missing ${w}`);
  }
  for (const s of sent) {
    assert.equal(s.name, "viewportChanged");
    assert.equal(s.payload, VIEWPORT);
  }
});

// Case 2: scheduleCameraCommand then timer fires -> emits to others, not issuer.
test("scheduleCameraCommand suppresses the issuer after timer fires", () => {
  const { clock, sent, notifier } = setup();
  notifier.scheduleCameraCommand("a");
  clock.advance(DEBOUNCE_MS);
  assert.equal(sent.length, 2);
  const targets = sent.map((s) => s.widgetId).sort();
  assert.deepEqual(targets, ["b", "c"]);
});

// Case 3: scheduleCameraCommand then moveEnd inside window -> single broadcast,
// issuer suppressed.
test("scheduleCameraCommand then moveEnd collapses to one suppressed broadcast", () => {
  const { clock, sent, notifier } = setup();
  notifier.scheduleCameraCommand("a");
  clock.advance(20);
  notifier.moveEnd();
  // moveEnd with suppress set broadcasts immediately; no pending timer.
  assert.equal(sent.length, 2);
  const targets = sent.map((s) => s.widgetId).sort();
  assert.deepEqual(targets, ["b", "c"]);
  // Advancing the debounce window must not fire a second broadcast.
  clock.advance(DEBOUNCE_MS);
  assert.equal(sent.length, 2);
});

// Case 4: two moveEnd calls inside 100ms -> one broadcast.
test("two moveEnd calls inside the window debounce to one broadcast", () => {
  const { clock, sent, notifier } = setup();
  notifier.moveEnd();
  clock.advance(40);
  notifier.moveEnd();
  clock.advance(DEBOUNCE_MS);
  assert.equal(sent.length, 3);
});

// Case 6 (gap): a camera command whose moveEnd lands AFTER the debounce
// window. The fallback timer fires mid-flight and broadcasts to the others
// with suppress still sticky, so the subsequent moveEnd still excludes the
// issuer and rebroadcasts the final viewport to the others. This is the
// flyTo/animated-fitBounds gap from the task-9 final review.
test("timer fallback then late moveEnd still excludes the issuer", () => {
  const { clock, sent, notifier } = setup();
  notifier.scheduleCameraCommand("a");
  // Advance past the debounce so the fallback timer fires mid-flight.
  clock.advance(DEBOUNCE_MS);
  // Fallback broadcast: issuer excluded, suppress stays sticky.
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((s) => s.widgetId).sort(), ["b", "c"]);
  // The animation's moveEnd now lands after the debounce.
  notifier.moveEnd();
  // Issuer still excluded; the others receive the final viewport again.
  assert.equal(sent.length, 4);
  const targets = sent.map((s) => s.widgetId).sort();
  assert.deepEqual(targets, ["b", "b", "c", "c"]);
  assert.ok(!targets.includes("a"), "issuer must stay excluded");
  for (const s of sent) {
    assert.equal(s.name, "viewportChanged");
    assert.equal(s.payload, VIEWPORT);
  }
});

// Case 5: after a suppressed broadcast, a later bare moveEnd emits to all.
test("bare moveEnd after a suppressed broadcast emits to all again", () => {
  const { clock, sent, notifier } = setup();
  notifier.scheduleCameraCommand("a");
  clock.advance(20);
  notifier.moveEnd();
  assert.equal(sent.length, 2);
  // Later bare moveEnd.
  clock.advance(20);
  notifier.moveEnd();
  clock.advance(DEBOUNCE_MS);
  // 2 (suppressed) + 3 (all) = 5.
  assert.equal(sent.length, 5);
  const lastBatch = sent.slice(2).map((s) => s.widgetId).sort();
  assert.deepEqual(lastBatch, ["a", "b", "c"]);
});
