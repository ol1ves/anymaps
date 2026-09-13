// Tests for the camera lease state machine (client/src/camera.js).
// Contract: CONTRACTS.md section 11, SPEC.md section 7.7.
// The machine is pure: injected now/setTimeout/clearTimeout and a manual
// clock. No DOM, no MapLibre.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCameraLease, TTL_MS } from "../src/camera.js";

// Manual clock + fake timers. now() returns ms; advance(t) moves it forward
// and fires any due setTimeout callbacks in order.
function makeClock() {
  let t = 0;
  const timers = new Map(); // id -> { fireAt, cb }
  let nextId = 1;
  return {
    now() { return t; },
    advance(dt) {
      const target = t + dt;
      // Fire timers due at or before target, in chronological order.
      while (true) {
        let due = null;
        for (const [id, tm] of timers) {
          if (tm.fireAt <= target && (due === null || tm.fireAt < due.fireAt)) {
            due = { id, ...tm };
          }
        }
        if (!due) break;
        timers.delete(due.id);
        // Advance wall time to the fire moment so onEvent sees a sane now().
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

function setup() {
  const clock = makeClock();
  const events = [];
  const lease = createCameraLease({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onEvent: (e) => events.push(e),
  });
  return { clock, events, lease };
}

test("TTL constant is 10000ms", () => {
  assert.equal(TTL_MS, 10000);
});

// Case 1: request on FREE -> LOCKED, granted.
test("request on FREE locks and grants", () => {
  const { lease, events } = setup();
  lease.request("a");
  assert.equal(lease.isLocked(), true);
  assert.equal(lease.owner(), "a");
  assert.deepEqual(events, [{ type: "granted", widgetId: "a" }]);
});

// Case 2: request while locked preempts, never two owners.
test("request while locked preempts the owner", () => {
  const { lease, events } = setup();
  lease.request("a");
  lease.request("b");
  assert.equal(lease.owner(), "b");
  assert.deepEqual(events, [
    { type: "granted", widgetId: "a" },
    { type: "revoked", widgetId: "a", reason: "preempted" },
    { type: "granted", widgetId: "b" },
  ]);
});

// Case 3: owner camera command renews the lease.
test("owner camera command renews the lease", () => {
  const { lease, events, clock } = setup();
  lease.request("a");
  events.length = 0;
  clock.advance(9000);
  lease.cameraCommand("a");
  clock.advance(9000);
  assert.equal(lease.isLocked(), true);
  assert.equal(lease.owner(), "a");
  assert.deepEqual(events, []);
});

// Case 4: TTL expiry after exactly 10s -> revoked ttl, FREE.
test("TTL expiry revokes with reason ttl", () => {
  const { lease, events, clock } = setup();
  lease.request("a");
  events.length = 0;
  clock.advance(10000);
  assert.equal(lease.isLocked(), false);
  assert.equal(lease.owner(), null);
  assert.deepEqual(events, [{ type: "revoked", widgetId: "a", reason: "ttl" }]);
});

// Case 5: release by owner -> revoked released, FREE.
test("release by owner revokes with reason released", () => {
  const { lease, events } = setup();
  lease.request("a");
  events.length = 0;
  lease.release("a");
  assert.equal(lease.isLocked(), false);
  assert.deepEqual(events, [{ type: "revoked", widgetId: "a", reason: "released" }]);
});

// Case 6: release by non-owner does nothing.
test("release by non-owner is a no-op", () => {
  const { lease, events } = setup();
  lease.request("b");
  events.length = 0;
  lease.release("a");
  assert.equal(lease.owner(), "b");
  assert.deepEqual(events, []);
});

// Case 7: userGesture while locked -> revoked userGesture; while FREE nothing.
test("userGesture revokes when locked and no-ops when free", () => {
  const { lease, events } = setup();
  lease.request("a");
  events.length = 0;
  lease.userGesture();
  assert.equal(lease.isLocked(), false);
  assert.deepEqual(events, [{ type: "revoked", widgetId: "a", reason: "userGesture" }]);
  // While FREE: nothing.
  lease.userGesture();
  assert.deepEqual(events, [{ type: "revoked", widgetId: "a", reason: "userGesture" }]);
});

// Case 8: cameraCommand by non-owner -> preempted, FREE after (pan wins).
test("cameraCommand by non-owner preempts and frees", () => {
  const { lease, events } = setup();
  lease.request("a");
  events.length = 0;
  lease.cameraCommand("b");
  assert.equal(lease.isLocked(), false);
  assert.equal(lease.owner(), null);
  assert.deepEqual(events, [{ type: "revoked", widgetId: "a", reason: "preempted" }]);
});

// Case 9: widgetGone by owner -> FREE with NO event.
test("widgetGone frees silently with no event", () => {
  const { lease, events } = setup();
  lease.request("a");
  events.length = 0;
  lease.widgetGone("a");
  assert.equal(lease.isLocked(), false);
  assert.deepEqual(events, []);
});

// Case 9b: widgetGone by non-owner does nothing.
test("widgetGone by non-owner is a no-op", () => {
  const { lease, events } = setup();
  lease.request("a");
  events.length = 0;
  lease.widgetGone("b");
  assert.equal(lease.owner(), "a");
  assert.deepEqual(events, []);
});

// Case 10: cameraDenied is never emitted across all scenarios.
test("cameraDenied is never emitted", () => {
  const { lease, events, clock } = setup();
  lease.request("a");
  lease.request("b");
  lease.cameraCommand("a");
  lease.userGesture();
  lease.request("c");
  lease.release("c");
  clock.advance(TTL_MS);
  lease.request("d");
  lease.widgetGone("d");
  for (const e of events) {
    assert.notEqual(e.type, "cameraDenied");
    assert.notEqual(e.reason, "cameraDenied");
  }
  assert.ok(events.every((e) => e.type === "granted" || e.type === "revoked"));
});

// Case 11: request twice in a row renews, single granted, no revocation.
test("request twice by same owner renews without extra events", () => {
  const { lease, events } = setup();
  lease.request("a");
  lease.request("a");
  assert.equal(lease.owner(), "a");
  assert.deepEqual(events, [{ type: "granted", widgetId: "a" }]);
});

// TTL after a renew resets to a fresh 10s window.
test("renewed lease expires 10s after the last command", () => {
  const { lease, events, clock } = setup();
  lease.request("a");
  clock.advance(9000);
  lease.cameraCommand("a");
  // 9s after renew: still locked.
  clock.advance(9000);
  assert.equal(lease.isLocked(), true);
  events.length = 0;
  // 1 more second (10s since renew): ttl.
  clock.advance(1000);
  assert.equal(lease.isLocked(), false);
  assert.deepEqual(events, [{ type: "revoked", widgetId: "a", reason: "ttl" }]);
});
