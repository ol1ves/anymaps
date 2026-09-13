// render.js — render contract check group.
// markers (emoji + url, color, label, title, rotation), update (move/restyle,
// no duplicates), remove; polylines (replace vs append growth); popups (two
// widgets, one global open, setPopupContent, anchored popup handled in sdk);
// panels (two stacked sections, clearPanel); styles (injected, anymaps-*
// classes present).

import { enableFixture, waitForState, ok, fail } from "./lib.js";

const BASE_URL = "http://localhost:8000";

function markerLabels(doc) {
  return [...doc.querySelectorAll(".anymaps-marker")]
    .map((el) => el.querySelector(".anymaps-marker-label")?.textContent ?? "");
}

export async function run({ manager, page }) {
  const results = [];
  const { doc, map, panelHost } = page;
  const a = "render-a", b = "render-b";

  try {
    await enableFixture(manager, {
      id: a, name: "Render A",
      bundlePath: "/fixtures/render-a.js", baseUrl: BASE_URL,
    });
    await waitForState(manager, a, (s) => s.renderADone, 4000);

    // ra-m2 removed; only ra-m1 remains for widget A.
    let labels = markerLabels(doc);
    results.push(labels.includes("A1-moved")
      ? ok("marker added with label and updated (move/restyle)")
      : fail("marker added with label and updated (move/restyle)", labels.join(",")));

    // ra-m1 title + icon emoji + rotation + color.
    const aEl = [...doc.querySelectorAll(".anymaps-marker")]
      .find((el) => el.querySelector(".anymaps-marker-label")?.textContent === "A1-moved");
    if (!aEl) {
      results.push(fail("marker icon/title/rotation/color", "element not found"));
    } else {
      const icon = aEl.querySelector(".anymaps-marker-icon");
      results.push(aEl.title === "A1 title"
        ? ok("marker title attribute set") : fail("marker title attribute set", aEl.title));
      results.push(icon && icon.textContent === "🚻"
        ? ok("marker emoji icon") : fail("marker emoji icon", icon?.textContent));
      results.push(icon && /rotate\(45deg\)/.test(icon.style.transform)
        ? ok("marker rotation applied") : fail("marker rotation applied", icon?.style.transform));
      // #00ff00 -> rgb(0, 255, 0) in the computed style.
      results.push(icon && /0(,|, )\s*255/.test(icon.style.background)
        ? ok("marker color restyled") : fail("marker color restyled", icon?.style.background));
    }

    // ra-m2 (image url) was removed; no duplicate ra-m1.
    const aCount = markerLabels(doc).filter((l) => l === "A1-moved").length;
    results.push(aCount === 1
      ? ok("removeMarker removed marker (no duplicate)") : fail("removeMarker removed marker (no duplicate)", "count " + aCount));

    // Polyline append growth: 2 -> 3 coordinates.
    const srcId = "anymaps-polyline-src-" + a + "-ra-p1";
    const src = map.getSource(srcId);
    let coordsLen = -1;
    try { coordsLen = src.serialize().data.geometry.coordinates.length; } catch (e) { /* */ }
    results.push(coordsLen === 3
      ? ok("polyline append grew points 2 -> 3") : fail("polyline append grew points 2 -> 3", "coords " + coordsLen));

    // Styles: a <style data-widget-id="render-a"> exists.
    const styleEl = doc.querySelector('style[data-widget-id="' + a + '"]');
    results.push(styleEl && styleEl.textContent.includes("render-a style sentinel")
      ? ok("setStyles injected per-widget <style>") : fail("setStyles injected per-widget <style>", "missing"));

    // Now enable render-b: its popup closes render-a's popup (one global).
    await enableFixture(manager, {
      id: b, name: "Render B",
      bundlePath: "/fixtures/render-b.js", baseUrl: BASE_URL,
    });
    await waitForState(manager, b, (s) => s.renderBDone, 4000);

    const popups = doc.querySelectorAll(".maplibregl-popup.anymaps-popup");
    results.push(popups.length === 1
      ? ok("one popup open globally across widgets") : fail("one popup open globally across widgets", "count " + popups.length));
    if (popups.length === 1) {
      results.push(/popup-b/.test(popups[0].textContent)
        ? ok("newest popup content shown (prior closed)") : fail("newest popup content shown (prior closed)", popups[0].textContent));
    }

    // Panels: two stacked collapsible sections in the sidebar.
    const sections = panelHost.querySelectorAll(".anymaps-panel");
    results.push(sections.length >= 2
      ? ok("two stacked panel sections") : fail("two stacked panel sections", "count " + sections.length));
    const summaries = [...sections].map((s) => s.querySelector(".anymaps-panel-header")?.textContent ?? "");
    results.push(summaries.includes("Render A") && summaries.includes("Render B")
      ? ok("panels carry widget names as headers") : fail("panels carry widget names as headers", summaries.join(",")));
    // clearPanel: render-a has exactly one section (cleared then re-set).
    const aSections = panelHost.querySelectorAll(".anymaps-panel.anymaps-widget-" + a);
    results.push(aSections.length === 1 && /panel-a-final/.test(aSections[0].textContent)
      ? ok("clearPanel removed then re-set panel") : fail("clearPanel removed then re-set panel", "sections " + aSections.length));

    // anymaps-* classes present.
    results.push(doc.querySelector(".anymaps-marker") && doc.querySelector(".anymaps-panel") && doc.querySelector(".anymaps-popup")
      ? ok("anymaps-marker/panel/popup classes present") : fail("anymaps-marker/panel/popup classes present", "missing"));
    results.push(panelHost.querySelector(".anymaps-widget-" + a) && panelHost.querySelector(".anymaps-widget-" + b)
      ? ok("anymaps-widget-<id> classes present") : fail("anymaps-widget-<id> classes present", "missing"));
  } finally {
    manager.uninstall(a);
    manager.uninstall(b);
  }

  return results;
}
