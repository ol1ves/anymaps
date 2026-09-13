// camera.js — camera lease revocation matrix check group.
// preempt by request, preempt by pan, ttl (wait ~10.5s), released,
// userGesture (synthetic movestart), badge shows name + release button;
// cameraDenied never logged.

import { enableFixture, waitForState, wait, ok, fail } from "./lib.js";

const BASE_URL = "http://localhost:8000";

async function enableCam(manager, id, name, mode) {
  return enableFixture(manager, {
    id, name, bundlePath: "/fixtures/camera-fixture.js", baseUrl: BASE_URL,
    bundlePrefix: "var __MODE__ = " + JSON.stringify(mode) + ";\n",
  });
}

function badgeEl(page) { return page.doc.getElementById("camera-badge"); }
function badgeText(page) {
  return page.doc.getElementById("camera-badge-label")?.textContent ?? "";
}

export async function run({ manager, page }) {
  const results = [];
  const { map, doc } = page;
  const widgets = [];

  try {
    // 1. preempt by request: a owns, b requests -> a preempted, b granted.
    await enableCam(manager, "camera-a", "Camera A", "request");
    widgets.push("camera-a");
    let aGranted = await waitForState(manager, "camera-a", (s) => s.granted, 3000);
    results.push(aGranted ? ok("request on FREE locks and grants (a)")
      : fail("request on FREE locks and grants (a)", "no grant"));
    results.push(badgeText(page) === "Camera: Camera A" &&
      badgeEl(page).getAttribute("aria-hidden") === "false"
      ? ok("badge shows owner name while locked") : fail("badge shows owner name while locked", badgeText(page)));

    await enableCam(manager, "camera-b", "Camera B", "request-delayed");
    widgets.push("camera-b");
    let bGranted = await waitForState(manager, "camera-b", (s) => s.granted, 3000);
    let aRevoked = await waitForState(manager, "camera-a",
      (s) => Array.isArray(s.revokes) && s.revokes.includes("preempted"), 3000);
    results.push(bGranted && aRevoked
      ? ok("request while locked preempts owner (preempted by request)")
      : fail("request while locked preempts owner (preempted by request)",
        "bGranted=" + bGranted + " aRevokes=" + JSON.stringify(manager.ctx.getState("camera-a").revokes)));

    // 2. preempt by pan: b owns, c issues flyTo -> b preempted, no new lock.
    await enableCam(manager, "camera-c", "Camera C", "pan");
    widgets.push("camera-c");
    let bPanRevoked = await waitForState(manager, "camera-b",
      (s) => Array.isArray(s.revokes) && s.revokes.includes("preempted"), 3000);
    // c never gets granted (pan wins, no new lock).
    await wait(400);
    const cState = manager.ctx.getState("camera-c");
    results.push(bPanRevoked && !cState.granted
      ? ok("non-owner pan preempts owner (preempted by pan)")
      : fail("non-owner pan preempts owner (preempted by pan)",
        "bPanRevoked=" + bPanRevoked + " cGranted=" + !!cState.granted));
    results.push(badgeEl(page).getAttribute("aria-hidden") === "true"
      ? ok("badge hidden when lease free") : fail("badge hidden when lease free", badgeText(page)));

    // 3. userGesture: d owns; synthetic movestart revokes.
    await enableCam(manager, "camera-d", "Camera D", "request-only");
    widgets.push("camera-d");
    await waitForState(manager, "camera-d", (s) => s.granted, 3000);
    map.fire("movestart");
    let dGesture = await waitForState(manager, "camera-d",
      (s) => Array.isArray(s.revokes) && s.revokes.includes("userGesture"), 3000);
    results.push(dGesture
      ? ok("user gesture (drag/zoom/scroll) revokes with reason userGesture")
      : fail("user gesture (drag/zoom/scroll) revokes with reason userGesture",
        JSON.stringify(manager.ctx.getState("camera-d").revokes)));

    // 4. released: e owns; badge release button -> released.
    await enableCam(manager, "camera-e", "Camera E", "request-only");
    widgets.push("camera-e");
    await waitForState(manager, "camera-e", (s) => s.granted, 3000);
    const releaseBtn = doc.getElementById("camera-badge-release");
    results.push(releaseBtn && releaseBtn.textContent === "✕"
      ? ok("badge has a release button") : fail("badge has a release button", releaseBtn?.textContent));
    if (releaseBtn) releaseBtn.click();
    let eReleased = await waitForState(manager, "camera-e",
      (s) => Array.isArray(s.revokes) && s.revokes.includes("released"), 3000);
    results.push(eReleased
      ? ok("releaseCameraControl revokes with reason released")
      : fail("releaseCameraControl revokes with reason released",
        JSON.stringify(manager.ctx.getState("camera-e").revokes)));

    // 5. ttl: f owns; wait past the 10s TTL.
    await enableCam(manager, "camera-f", "Camera F", "request-only");
    widgets.push("camera-f");
    await waitForState(manager, "camera-f", (s) => s.granted, 3000);
    await wait(10500);
    let fTtl = await waitForState(manager, "camera-f",
      (s) => Array.isArray(s.revokes) && s.revokes.includes("ttl"), 1000);
    results.push(fTtl
      ? ok("TTL expiry revokes with reason ttl (10s)")
      : fail("TTL expiry revokes with reason ttl (10s)",
        JSON.stringify(manager.ctx.getState("camera-f").revokes)));

    // 6. cameraDenied is never emitted across every scenario.
    let denied = false;
    for (const w of widgets) {
      if (manager.ctx.getState(w).denied) denied = true;
    }
    results.push(!denied
      ? ok("cameraDenied is never emitted") : fail("cameraDenied is never emitted", "denied recorded"));
  } finally {
    for (const w of widgets) {
      try { manager.uninstall(w); } catch (e) { /* */ }
    }
  }

  return results;
}
