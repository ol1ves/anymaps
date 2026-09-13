// events.js — CONTRACTS section 5 event routing check group.
// markerClick fires only for the owning widget; mapClick broadcasts to all
// widgets with payload {lat,lng}; viewportChanged has shape
// {bounds,center,zoom} and is suppressed for the issuing widget.

import { enableFixture, waitForState, wait, ok, fail } from "./lib.js";

const BASE_URL = "http://localhost:8000";

function markerElByLabel(doc, label) {
  return [...doc.querySelectorAll(".anymaps-marker")]
    .find((m) => m.querySelector(".anymaps-marker-label")?.textContent === label);
}

function isShape(p) {
  if (!p || typeof p !== "object") return false;
  const b = p.bounds;
  if (!Array.isArray(b) || b.length !== 2 ||
      !Array.isArray(b[0]) || b[0].length !== 2 ||
      !Array.isArray(b[1]) || b[1].length !== 2) return false;
  if (!Number.isFinite(b[0][0]) || !Number.isFinite(b[0][1]) ||
      !Number.isFinite(b[1][0]) || !Number.isFinite(b[1][1])) return false;
  if (!Array.isArray(p.center) || p.center.length !== 2 ||
      !Number.isFinite(p.center[0]) || !Number.isFinite(p.center[1])) return false;
  if (!Number.isFinite(p.zoom)) return false;
  return true;
}

export async function run({ manager, page }) {
  const results = [];
  const { doc, map } = page;
  const a = "events-a", b = "events-b", c = "events-c";

  try {
    await enableFixture(manager, {
      id: a, name: "Events A",
      bundlePath: "/fixtures/events-a.js", baseUrl: BASE_URL,
    });
    await enableFixture(manager, {
      id: b, name: "Events B",
      bundlePath: "/fixtures/events-b.js", baseUrl: BASE_URL,
    });
    await waitForState(manager, a, (s) => s.aReady, 4000);
    await waitForState(manager, b, (s) => s.bReady, 4000);

    // markerClick: click the owner's marker -> A receives {markerId}, B does
    // not (owner-only routing).
    const el = markerElByLabel(doc, "EV1");
    if (!el) {
      results.push(fail("markerClick: owner marker present", "not found"));
    } else {
      // Non-bubbling click: fires the marker's own click listener
      // (markers.js -> ctx.emit markerClick) without reaching the map's
      // DOM click handler, which would throw on a synthetic event.
      el.dispatchEvent(new MouseEvent("click", { bubbles: false, cancelable: true }));
      const aClick = await waitForState(manager, a,
        (s) => Array.isArray(s.aMarkerClicks) && s.aMarkerClicks.length >= 1, 3000);
      // Give B a moment to (not) receive it.
      await wait(150);
      const aClicks = manager.ctx.getState(a).aMarkerClicks ?? [];
      const bClicks = manager.ctx.getState(b).bMarkerClicks ?? [];
      results.push(aClick && aClicks[0]?.markerId === "ev-m1" && bClicks.length === 0
        ? ok("markerClick fires only for the owning widget")
        : fail("markerClick fires only for the owning widget",
          "a=" + JSON.stringify(aClicks) + " b=" + JSON.stringify(bClicks)));
    }

    // mapClick: fire a synthetic map click -> all widgets receive {lat,lng}.
    // MapLibre's internal _onMapClick reads originalEvent.target, so the
    // fired event carries a minimal originalEvent + point to satisfy it.
    map.fire("click", {
      lngLat: { lat: 40.715, lng: -74.005 },
      point: { x: 100, y: 100 },
      originalEvent: {
        target: null, clientX: 0, clientY: 0,
        preventDefault() {}, stopPropagation() {},
      },
    });
    const aMap = await waitForState(manager, a,
      (s) => Array.isArray(s.aMapClicks) && s.aMapClicks.length >= 1, 3000);
    const bMap = await waitForState(manager, b,
      (s) => Array.isArray(s.bMapClicks) && s.bMapClicks.length >= 1, 3000);
    const am = manager.ctx.getState(a).aMapClicks?.[0];
    const bm = manager.ctx.getState(b).bMapClicks?.[0];
    results.push(aMap && bMap && am?.lat === 40.715 && am?.lng === -74.005 &&
      bm?.lat === 40.715 && bm?.lng === -74.005
      ? ok("mapClick broadcasts {lat,lng} to all widgets")
      : fail("mapClick broadcasts {lat,lng} to all widgets",
        "a=" + JSON.stringify(am) + " b=" + JSON.stringify(bm)));

    // viewportChanged + issuer suppression: enable C (issues flyTo after
    // 300ms). C is suppressed; A and B receive the broadcast.
    await enableFixture(manager, {
      id: c, name: "Events C",
      bundlePath: "/fixtures/events-c.js", baseUrl: BASE_URL,
    });
    await waitForState(manager, c, (s) => s.cReady, 4000);
    const issued = await waitForState(manager, c, (s) => s.cIssued, 4000);
    // moveend debounce is 100ms; allow the animation to settle.
    const aVp = await waitForState(manager, a,
      (s) => Array.isArray(s.aViewports) && s.aViewports.length >= 1, 5000);
    const bVp = await waitForState(manager, b,
      (s) => Array.isArray(s.bViewports) && s.bViewports.length >= 1, 5000);
    await wait(200);
    const cVps = manager.ctx.getState(c).cViewports ?? [];
    const aVp0 = manager.ctx.getState(a).aViewports?.[0];
    results.push(issued && aVp && bVp && isShape(aVp0)
      ? ok("viewportChanged has {bounds,center,zoom} shape")
      : fail("viewportChanged has {bounds,center,zoom} shape",
        "issued=" + issued + " aVp=" + aVp + " bVp=" + bVp + " shape=" + isShape(aVp0)));
    results.push(cVps.length === 0
      ? ok("viewportChanged suppressed for the issuing widget")
      : fail("viewportChanged suppressed for the issuing widget",
        "c received " + cVps.length));
  } finally {
    try { manager.uninstall(a); } catch (e) { /* */ }
    try { manager.uninstall(b); } catch (e) { /* */ }
    try { manager.uninstall(c); } catch (e) { /* */ }
  }

  return results;
}
