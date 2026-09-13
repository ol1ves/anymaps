// geo.js — geolocation check group.
// grant path (dot appears, geolocation event), stop removes dot, denial path
// (geolocationError code 1), multi-subscriber refcount. The page installs a
// controllable navigator.geolocation mock before the manager is built.

import { enableFixture, waitForState, ok, fail } from "./lib.js";

const BASE_URL = "http://localhost:8000";

export async function run({ manager, page }) {
  const results = [];
  const { doc, geo } = page;

  try {
    // Two subscribers share one watch (refcount 2).
    await enableFixture(manager, {
      id: "geo-a", name: "Geo A",
      bundlePath: "/fixtures/geo-a.js", baseUrl: BASE_URL,
    });
    await enableFixture(manager, {
      id: "geo-b", name: "Geo B",
      bundlePath: "/fixtures/geo-b.js", baseUrl: BASE_URL,
    });
    await waitForState(manager, "geo-a", (s) => s.aStarted, 3000);
    await waitForState(manager, "geo-b", (s) => s.bStarted, 3000);

    // Fix #1 -> both receive; geo-a stops after its first fix.
    geo.triggerFix(40.71, -74.0, 5);
    const aFix1 = await waitForState(manager, "geo-a",
      (s) => Array.isArray(s.aFixes) && s.aFixes.length === 1 && s.aStopped, 3000);
    const bFix1 = await waitForState(manager, "geo-b",
      (s) => Array.isArray(s.bFixes) && s.bFixes.length === 1, 3000);
    let dot = doc.querySelector(".anymaps-user-dot");
    results.push(aFix1 && bFix1
      ? ok("grant path: geolocation event fires to subscribers")
      : fail("grant path: geolocation event fires to subscribers",
        "aFix1=" + aFix1 + " bFix1=" + bFix1));
    results.push(!!dot
      ? ok("grant path: user dot appears on fix") : fail("grant path: user dot appears on fix", "no dot"));

    // Fix #2 -> only geo-b receives (geo-a unsubscribed); geo-b then stops.
    geo.triggerFix(40.72, -74.01, 8);
    const bFix2 = await waitForState(manager, "geo-b",
      (s) => Array.isArray(s.bFixes) && s.bFixes.length === 2 && s.bStopped, 3000);
    // geo-a must NOT have received the second fix.
    const aFixes = manager.ctx.getState("geo-a").aFixes ?? [];
    results.push(bFix2 && aFixes.length === 1
      ? ok("multi-subscriber refcount: stopped widget receives no further fixes")
      : fail("multi-subscriber refcount: stopped widget receives no further fixes",
        "bFix2=" + bFix2 + " aFixes=" + aFixes.length));
    // Last subscriber stopped -> dot removed.
    await new Promise((r) => setTimeout(r, 100));
    dot = doc.querySelector(".anymaps-user-dot");
    results.push(!dot
      ? ok("stop removes the user dot when last subscriber leaves")
      : fail("stop removes the user dot when last subscriber leaves", "dot still present"));

    // Denial path: a fresh subscriber gets geolocationError code 1.
    await enableFixture(manager, {
      id: "geo-c", name: "Geo C",
      bundlePath: "/fixtures/geo-c.js", baseUrl: BASE_URL,
    });
    await waitForState(manager, "geo-c", (s) => s.cStarted, 3000);
    geo.triggerError(1, "Permission denied");
    const cErr = await waitForState(manager, "geo-c",
      (s) => Array.isArray(s.cErrors) && s.cErrors.length >= 1, 3000);
    const err = manager.ctx.getState("geo-c").cErrors?.[0];
    results.push(cErr && err && err.code === 1
      ? ok("denial path: geolocationError fires with code 1")
      : fail("denial path: geolocationError fires with code 1", JSON.stringify(err)));
  } finally {
    try { manager.uninstall("geo-a"); } catch (e) { /* */ }
    try { manager.uninstall("geo-b"); } catch (e) { /* */ }
    try { manager.uninstall("geo-c"); } catch (e) { /* */ }
  }

  return results;
}
