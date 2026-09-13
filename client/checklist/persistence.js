// persistence.js — persistence check group.
// Phase 1: persist deep-merge (iid + nested across two merges), then leave
// the widget enabled so a reload re-enables it. Phase 2 (after auto-reload):
// the widget is re-enabled by startup with the same state (iid survives).

import { enableFixture, waitForState, wait, ok, fail, makeManifest, fetchBundle, publishWidget } from "./lib.js";

const BASE_URL = "http://localhost:8000";
const WID = "persist-widget";

export async function run({ manager, page }) {
  const results = [];

  if (page.phase !== 2) {
    // Phase 1: enable, persist, verify the deep merge.
    try {
      // Publish so phase 2 startup can fetch manifest + bundle by id+version.
      const bundleSource = await fetchBundle("/fixtures/persist-fixture.js");
      await publishWidget(BASE_URL, makeManifest(WID, "Persist"), bundleSource);
      await enableFixture(manager, {
        id: WID, name: "Persist",
        bundlePath: "/fixtures/persist-fixture.js", baseUrl: BASE_URL,
      });
      const done = await waitForState(manager, WID, (s) => s.pDone, 4000);
      if (!done) {
        results.push(fail("persist widget enabled", "no pDone"));
        return results;
      }
      results.push(ok("persist widget enabled"));

      const s = manager.ctx.getState(WID);
      results.push(s.iid === "persist-survives"
        ? ok("persist stores iid") : fail("persist stores iid", String(s.iid)));
      const nested = s.nested;
      const merged = nested && nested.a === 1 && nested.b === 2;
      results.push(merged
        ? ok("persist deep-merges nested objects (a + b)")
        : fail("persist deep-merges nested objects (a + b)", JSON.stringify(nested)));

      // Leave the widget enabled in the registry so phase 2 (reload) can
      // verify startup re-enables it with the same state.
      results.push(ok("phase 1 complete; reload to phase 2 to verify survival"));
    } catch (e) {
      results.push(fail("persistence phase 1", e.message));
      try { manager.uninstall(WID); } catch (e2) { /* */ }
    }
    return results;
  }

  // Phase 2: startup() already re-enabled the widget from the registry.
  try {
    const started = await waitForState(manager, WID, (s) => s.pDone, 5000);
    if (!started) {
      results.push(fail("startup re-enables widget after reload", "not enabled"));
      return results;
    }
    results.push(ok("startup re-enables widget after reload"));

    const s = manager.ctx.getState(WID);
    results.push(s.iid === "persist-survives"
      ? ok("persisted state survives reload (iid intact)")
      : fail("persisted state survives reload (iid intact)", String(s.iid)));
    // The widget must not have re-persisted (guard held).
    results.push(s.nested && s.nested.a === 1 && s.nested.b === 2
      ? ok("merged nested state survives reload")
      : fail("merged nested state survives reload", JSON.stringify(s.nested)));
  } finally {
    try { manager.uninstall(WID); } catch (e) { /* */ }
  }

  return results;
}
