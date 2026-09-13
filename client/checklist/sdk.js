// sdk.js — envelope capture check group.
// A capture fixture posts every command shape; assert 21 distinct cmd
// envelopes (20 valid + 1 malformed) with correct names/payloads and unique
// ids, an error envelope for the malformed command, and the widget stays
// alive after the error.

import { enableFixture, waitForState, ok, fail } from "./lib.js";

const EXPECTED_NAMES = [
  "addMarker", "updateMarker", "removeMarker",
  "addPolyline", "updatePolyline", "removePolyline",
  "openPopup", "setPopupContent", "closePopup",
  "setPanel", "clearPanel", "setStyles", "persist",
  "requestCameraControl", "releaseCameraControl",
  "flyTo", "jumpTo", "fitBounds",
  "startGeolocation", "stopGeolocation",
  // 21st: the malformed addMarker (still gets a unique id + cmd envelope).
  "addMarker",
];

const BASE_URL = "http://localhost:8000";

export async function run({ manager, page }) {
  const results = [];
  const widgetId = "checklist-capture";

  try {
    await enableFixture(manager, {
      id: widgetId, name: "Capture",
      bundlePath: "/fixtures/capture-fixture.js", baseUrl: BASE_URL,
    });

    const captured = await waitForState(manager, widgetId,
      (s) => Array.isArray(s.capture) && s.capture.length === 21, 5000);
    if (!captured) {
      results.push(fail("capture collected 21 envelopes",
        "got " + (manager.ctx.getState(widgetId).capture?.length ?? "none")));
      return results;
    }
    results.push(ok("capture collected 21 envelopes"));

    const envelopes = manager.ctx.getState(widgetId).capture;

    // Every envelope: v:1, kind:"cmd", unique id, name, payload.
    const ids = new Set();
    let shapeOk = true;
    let shapeDetail = "";
    for (let i = 0; i < envelopes.length; i++) {
      const e = envelopes[i];
      if (!e || e.v !== 1 || e.kind !== "cmd") {
        shapeOk = false; shapeDetail = "envelope " + i + " bad shape"; break;
      }
      if (typeof e.id !== "string" || e.id.length === 0) {
        shapeOk = false; shapeDetail = "envelope " + i + " bad id"; break;
      }
      if (ids.has(e.id)) {
        shapeOk = false; shapeDetail = "duplicate id " + e.id; break;
      }
      ids.add(e.id);
      if (e.name !== EXPECTED_NAMES[i]) {
        shapeOk = false;
        shapeDetail = "envelope " + i + " name " + e.name + " expected " + EXPECTED_NAMES[i];
        break;
      }
      if (!e.payload || typeof e.payload !== "object") {
        shapeOk = false; shapeDetail = "envelope " + i + " missing payload"; break;
      }
    }
    results.push(shapeOk ? ok("envelopes have v:1 kind:cmd unique ids names payloads")
      : fail("envelopes have v:1 kind:cmd unique ids names payloads", shapeDetail));

    // Payload spot-checks: addMarker carries icon/color/label/title/rotation;
    // flyTo center is [lat,lng]; fitBounds bounds shape; startGeolocation
    // highAccuracy boolean.
    const byName = (i) => envelopes[i].payload;
    const p0 = byName(0); // addMarker m1
    const payloadChecks = [
      ["addMarker carries optional fields",
        p0.icon === "📍" && p0.color === "#ff0000" && p0.label === "L" &&
        p0.title === "T" && p0.rotation === 45],
      ["flyTo center is [lat,lng]",
        envelopes[15].payload.center[0] === 40.71 && envelopes[15].payload.center[1] === -74.0],
      ["fitBounds bounds [[s,w],[n,e]]",
        JSON.stringify(envelopes[17].payload.bounds) === "[[40.7,-74.1],[40.8,-74]]"],
      ["startGeolocation highAccuracy boolean",
        envelopes[18].payload.highAccuracy === true],
      ["closePopup payload is {id}",
        envelopes[8].payload.id === "pop1" && Object.keys(envelopes[8].payload).length === 1],
      ["clearPanel payload is empty object",
        JSON.stringify(envelopes[10].payload) === "{}"],
    ];
    for (const [name, pass] of payloadChecks) {
      results.push(pass ? ok(name) : fail(name, "payload mismatch"));
    }

    // Error envelope for the malformed command: echoes an id, has error str.
    const gotError = await waitForState(manager, widgetId,
      (s) => s.errorEnvelope != null, 4000);
    if (!gotError) {
      results.push(fail("error envelope for malformed command", "none received"));
    } else {
      const ee = manager.ctx.getState(widgetId).errorEnvelope;
      const pass = ee && typeof ee.id === "string" &&
        typeof ee.error === "string" && ee.error.length > 0;
      results.push(pass ? ok("error envelope echoes id and error string")
        : fail("error envelope echoes id and error string", JSON.stringify(ee)));
    }

    // Widget stays alive after the error: a real panel was set + alive flag.
    const alive = await waitForState(manager, widgetId, (s) => s.alive, 4000);
    let panelPresent = false;
    if (alive) {
      const host = page.panelHost;
      panelPresent = !!host.querySelector(".anymaps-widget-" + widgetId +
        " #cap-alive");
    }
    results.push(alive && panelPresent
      ? ok("widget alive after error (panel rendered)")
      : fail("widget alive after error (panel rendered)",
        "alive=" + alive + " panel=" + panelPresent));
  } finally {
    manager.uninstall(widgetId);
  }

  return results;
}
