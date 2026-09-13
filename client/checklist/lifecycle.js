// lifecycle.js — lifecycle/cleanup check group.
// disable removes every drawn item of that widget only; re-enable resumes
// with the same state; uninstall deletes registry entry + state key;
// re-enabled widget draws on top (z-order).

import { enableFixture, waitForState, wait, ok, fail } from "./lib.js";

const BASE_URL = "http://localhost:8000";

function markerZByLabel(doc, label) {
  const el = [...doc.querySelectorAll(".anymaps-marker")]
    .find((m) => m.querySelector(".anymaps-marker-label")?.textContent === label);
  return el ? Number(el.style.zIndex) : NaN;
}

export async function run({ manager, page }) {
  const results = [];
  const { doc, panelHost } = page;
  const lc = "lifecycle";
  const other = "lc-2";

  try {
    await enableFixture(manager, {
      id: lc, name: "Lifecycle",
      bundlePath: "/fixtures/lifecycle.js", baseUrl: BASE_URL,
    });
    await waitForState(manager, lc, (s) => s.lcDone, 4000);
    results.push(doc.querySelector(".anymaps-marker") && panelHost.querySelector(".anymaps-widget-" + lc)
      ? ok("enable draws marker + panel + style") : fail("enable draws marker + panel + style", "missing"));

    // Disable: every drawn item of this widget removed (markers, panel, style).
    manager.disable(lc);
    await wait(150);
    const lcMarkerGone = !markerZByLabel(doc, "LC");
    const lcPanelGone = !panelHost.querySelector(".anymaps-widget-" + lc);
    const lcStyleGone = !doc.querySelector('style[data-widget-id="' + lc + '"]');
    results.push(lcMarkerGone && lcPanelGone && lcStyleGone
      ? ok("disable removes marker, panel, and style (widget only)")
      : fail("disable removes marker, panel, and style (widget only)",
        "marker=" + !lcMarkerGone + " panel=" + !lcPanelGone + " style=" + !lcStyleGone));

    // State survives disable in localStorage (the persistence contract).
    let lcStateRaw = null;
    try { lcStateRaw = localStorage.getItem("anymaps.state." + lc); } catch (e) { /* */ }
    let lcState = null;
    try { lcState = JSON.parse(lcStateRaw); } catch (e) { /* */ }
    results.push(lcState && lcState.lcToken === "lc-1"
      ? ok("disable keeps state (lcToken survives)") : fail("disable keeps state (lcToken survives)", "lost"));

    // Re-enable: state resumes, items reappear, widget moves to top.
    // Enable a second widget first so z-order is observable.
    await enableFixture(manager, {
      id: other, name: "LC Two",
      bundlePath: "/fixtures/simple-fixture.js", baseUrl: BASE_URL,
    });
    await waitForState(manager, other, (s) => s.simpleDone, 4000);
    // Re-enable lifecycle (moves to top: higher order than `other`).
    await enableFixture(manager, {
      id: lc, name: "Lifecycle",
      bundlePath: "/fixtures/lifecycle.js", baseUrl: BASE_URL,
    });
    await waitForState(manager, lc, (s) => s.lcDone, 4000);
    results.push(manager.ctx.getState(lc).lcToken === "lc-1"
      ? ok("re-enable resumes with same state") : fail("re-enable resumes with same state", "lost"));
    // Wait for the panel DOM (state may already carry lcDone from before).
    let panelBack = false;
    const panelDeadline = Date.now() + 4000;
    while (Date.now() < panelDeadline) {
      if (panelHost.querySelector(".anymaps-widget-" + lc)) { panelBack = true; break; }
      await wait(50);
    }
    results.push(panelBack
      ? ok("re-enable re-draws panel") : fail("re-enable re-draws panel", "missing"));

    await wait(150);
    const lcZ = markerZByLabel(doc, "LC");
    const otherZ = markerZByLabel(doc, "S");
    results.push(lcZ > otherZ
      ? ok("re-enabled widget draws on top (z-order " + lcZ + " > " + otherZ + ")")
      : fail("re-enabled widget draws on top (z-order)", "lcZ=" + lcZ + " otherZ=" + otherZ));

    // Uninstall: registry entry + state key deleted.
    manager.uninstall(lc);
    await wait(150);
    const reg = manager.list();
    const regHas = reg.some((e) => e.widgetId === lc);
    const stateKey = localStorage.getItem("anymaps.state." + lc);
    results.push(!regHas && stateKey == null
      ? ok("uninstall deletes registry entry + state key")
      : fail("uninstall deletes registry entry + state key",
        "regHas=" + regHas + " stateKey=" + stateKey));
  } finally {
    try { manager.uninstall(lc); } catch (e) { /* */ }
    try { manager.uninstall(other); } catch (e) { /* */ }
  }

  // Group 9: three widgets enabled at once (SPEC.md section 3 demo 1).
  const three = ["three-a", "three-b", "three-c"];
  try {
    for (const id of three) {
      await enableFixture(manager, {
        id, name: id.toUpperCase(),
        bundlePath: "/fixtures/simple-fixture.js", baseUrl: BASE_URL,
      });
    }
    await waitForState(manager, "three-c", (s) => s.simpleDone, 4000);
    const sections = panelHost.querySelectorAll(".anymaps-panel");
    const markers = doc.querySelectorAll(".anymaps-marker");
    const live = manager.ctx.widgets()
      .filter((w) => three.includes(w.widgetId)).length;
    results.push(sections.length >= 3
      ? ok("three widgets at once -> three stacked panels")
      : fail("three widgets at once -> three stacked panels", "sections=" + sections.length));
    results.push(markers.length >= 3
      ? ok("three widgets at once -> all markers on map")
      : fail("three widgets at once -> all markers on map", "markers=" + markers.length));
    results.push(live === 3
      ? ok("three widgets at once -> all workers alive")
      : fail("three widgets at once -> all workers alive", "live=" + live));
  } finally {
    for (const id of three) {
      try { manager.uninstall(id); } catch (e) { /* */ }
    }
  }

  return results;
}
