// Camera lease machine + badge (Task 4). Contract: CONTRACTS.md section 11,
// SPEC.md section 7.7.
//
// This module owns two things:
//   1. `createCameraLease` — a pure state machine (no DOM, no MapLibre) with
//      injected timers so it runs under Node with fake clocks.
//   2. `register(ctx)` — wires requestCameraControl/releaseCameraControl and
//      the pan commands (flyTo/jumpTo/fitBounds), the user-gesture revocation,
//      the camera badge in #camera-badge, and per-widget cleanup.
//
// `cameraDenied` is reserved for a future strict-lease mode. Under the current
// last-request-wins model a control request always preempts, so it is never
// emitted. Do not post `cameraDenied` in any path.

import maplibregl from "maplibre-gl";

export const TTL_MS = 10000;
const CAMERA_PAN_MS = 1400;
const easeInOutCubic = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

// Pure camera lease state machine. FREE or LOCKED(owner). One owner, never
// two. `onEvent` is called synchronously for grant/revoke. The timer is
// cleared on every transition to FREE.
export function createCameraLease({ now, setTimeout, clearTimeout, onEvent }) {
  // `now` is accepted for tests that want to read wall time from the lease;
  // the machine itself drives expiry through the injected setTimeout.
  void now;

  let owner = null;
  let timer = null;

  function clearTimer() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  }

  function freeSilently() {
    clearTimer();
    owner = null;
  }

  function arm() {
    clearTimer();
    const current = owner;
    timer = setTimeout(() => {
      timer = null;
      owner = null;
      onEvent({ type: "revoked", widgetId: current, reason: "ttl" });
    }, TTL_MS);
  }

  return {
    // Acquire or preempt. Same owner renews (no extra granted event).
    request(widgetId) {
      if (owner === widgetId) {
        arm();
        return;
      }
      if (owner !== null) {
        const prev = owner;
        freeSilently();
        onEvent({ type: "revoked", widgetId: prev, reason: "preempted" });
      }
      owner = widgetId;
      arm();
      onEvent({ type: "granted", widgetId });
    },

    // Only the owner may release.
    release(widgetId) {
      if (owner !== widgetId) return;
      freeSilently();
      onEvent({ type: "revoked", widgetId, reason: "released" });
    },

    // Renew if owner; revoke preempted + free if another widget is owner
    // (the pan wins, no new lock). No-op when FREE.
    cameraCommand(widgetId) {
      if (owner === widgetId) {
        arm();
        return;
      }
      if (owner !== null) {
        const prev = owner;
        freeSilently();
        onEvent({ type: "revoked", widgetId: prev, reason: "preempted" });
      }
    },

    // User drag/zoom/scroll revokes when locked.
    userGesture() {
      if (owner === null) return;
      const prev = owner;
      freeSilently();
      onEvent({ type: "revoked", widgetId: prev, reason: "userGesture" });
    },

    // Worker death/disable/uninstall: free silently, no notification possible.
    widgetGone(widgetId) {
      if (owner === widgetId) freeSilently();
    },

    isLocked() { return owner !== null; },
    owner() { return owner; },
  };
}

// Validate a [lat, lng] finite pair.
function isLatLng(v) {
  return Array.isArray(v) && v.length === 2 &&
    Number.isFinite(v[0]) && Number.isFinite(v[1]);
}

export function register(ctx) {
  const { map, bus } = ctx;

  // Real timers for the runtime machine; onEvent routes to the widget and
  // updates the badge + bus.
  const lease = createCameraLease({
    now: () => Date.now(),
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (id) => clearTimeout(id),
    onEvent(event) {
      if (event.type === "granted") {
        ctx.emit(event.widgetId, "cameraGranted", {});
        lockBadge(event.widgetId);
        bus.emit("camera-locked", {
          widgetId: event.widgetId,
          name: ctx.widgetName(event.widgetId),
        });
      } else if (event.type === "revoked") {
        ctx.emit(event.widgetId, "cameraRevoked", { reason: event.reason });
        // Only clear the badge if the revoked widget still owns it (a
        // preemption grants a new owner in the same turn, so the badge shows
        // the new owner instead).
        if (currentOwner === event.widgetId) freeBadge();
        bus.emit("camera-free", {});
      }
    },
  });

  // Badge DOM. #camera-badge is created by index.html and hidden by default
  // (aria-hidden="true"). The brief pins a "✕" release button label.
  const badge = document.getElementById("camera-badge");
  const badgeLabel = document.getElementById("camera-badge-label");
  const badgeRelease = document.getElementById("camera-badge-release");
  let currentOwner = null;

  if (badgeRelease) {
    badgeRelease.textContent = "✕";
    badgeRelease.addEventListener("click", () => {
      if (currentOwner !== null) lease.release(currentOwner);
    });
  }

  function lockBadge(widgetId) {
    currentOwner = widgetId;
    if (badgeLabel) badgeLabel.textContent = "Camera: " + ctx.widgetName(widgetId);
    if (badge) badge.setAttribute("aria-hidden", "false");
  }

  function freeBadge() {
    currentOwner = null;
    if (badge) badge.setAttribute("aria-hidden", "true");
    if (badgeLabel) badgeLabel.textContent = "Camera";
  }

  // Programmatic-move guard. Set true immediately before our own flyTo/
  // jumpTo/fitBounds so the movestart listener treats it as ours and does
  // not revoke the lease. The first programmatic movestart clears it.
  let programmatic = false;
  map.on("movestart", () => {
    if (programmatic) { programmatic = false; return; }
    lease.userGesture();
  });

  // Pan commands: suppress the issuer on the next viewportChanged broadcast,
  // revoke/preempt the lease, then move the map. Order is pinned by the
  // brief: schedule, lease, map move.
  function pan(widgetId, fn) {
    const notifier = ctx.viewport;
    if (notifier) notifier.scheduleCameraCommand(widgetId);
    lease.cameraCommand(widgetId);
    programmatic = true;
    fn();
  }

  ctx.registerCommand("requestCameraControl", (_payload, widgetId) => {
    lease.request(widgetId);
  });

  ctx.registerCommand("releaseCameraControl", (_payload, widgetId) => {
    lease.release(widgetId);
  });

  ctx.registerCommand("flyTo", (payload, widgetId) => {
    if (!isLatLng(payload?.center)) {
      throw new Error("flyTo center must be [lat, lng]");
    }
    const [lat, lng] = payload.center;
    const opts = {
      center: [lng, lat],
      duration: CAMERA_PAN_MS,
      // Marker selection is an explicit user action. MapLibre otherwise
      // turns flyTo into jumpTo when prefers-reduced-motion is enabled.
      essential: true,
      easing: easeInOutCubic,
    };
    if (payload.zoom != null) opts.zoom = payload.zoom;
    if (payload.bearing != null) opts.bearing = payload.bearing;
    pan(widgetId, () => map.flyTo(opts));
  });

  ctx.registerCommand("jumpTo", (payload, widgetId) => {
    if (!isLatLng(payload?.center)) {
      throw new Error("jumpTo center must be [lat, lng]");
    }
    const [lat, lng] = payload.center;
    const opts = { center: [lng, lat] };
    if (payload.zoom != null) opts.zoom = payload.zoom;
    if (payload.bearing != null) opts.bearing = payload.bearing;
    pan(widgetId, () => map.jumpTo(opts));
  });

  ctx.registerCommand("fitBounds", (payload, widgetId) => {
    const b = payload?.bounds;
    if (!Array.isArray(b) || b.length !== 2 ||
        !isLatLng(b[0]) || !isLatLng(b[1])) {
      throw new Error("fitBounds bounds must be [[south,west],[north,east]]");
    }
    const [[south, west], [north, east]] = b;
    pan(widgetId, () =>
      map.fitBounds(new maplibregl.LngLatBounds([west, south], [east, north])));
  });

  // Trigger 3: worker death/disable/uninstall. register(ctx) runs once at
  // manager construction, before any widget exists, so the per-widget
  // cleanup is hooked off the bus-enabled event (emitted at the end of
  // manager.enable). The manager's disable loop runs every registered fn
  // for that widgetId. widgetGone is an idempotent guard: it only acts when
  // the gone widget is the current owner.
  bus.on("widget-enabled", ({ widgetId }) => {
    ctx.registerCleanup(widgetId, () => lease.widgetGone(widgetId));
  });
}
