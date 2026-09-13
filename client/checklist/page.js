// Checklist page orchestrator. Builds its own manager (so checks never
// depend on the app page), points the manager at the mock server, installs
// a controllable geolocation mock, runs every check group, renders results,
// and auto-runs on ?auto=1 with a phase=2 continuation for persistence.

import { createManager } from "../src/manager.js";
import * as sdk from "./sdk.js";
import * as render from "./render.js";
import * as events from "./events.js";
import * as camera from "./camera.js";
import * as geo from "./geo.js";
import * as lifecycle from "./lifecycle.js";
import * as gallery from "./gallery.js";
import * as wizard from "./wizard.js";
import * as persistence from "./persistence.js";

const BASE_URL = "http://localhost:8000";
const AGENT_URL = "http://localhost:8000";

// Both the generic server and the agent service point at the mock (one
// process serves /widgets and /wizard/*). Set before createManager so
// install.js + gallery + wizard read it.
window.__ANYMAPS_CONFIG__ = { baseUrl: BASE_URL, agentUrl: AGENT_URL };

// Controllable geolocation mock. geo.js register reads navigator.geolocation
// at manager construction, so install the mock before createManager.
let watchSuccess = null;
let watchError = null;
const mockGeo = {
  watchPosition(success, error) {
    watchSuccess = success;
    watchError = error;
    return 1;
  },
  clearWatch() { /* no-op for the mock */ },
};
// navigator.geolocation is a read-only getter on Navigator.prototype, so
// override on the instance via defineProperty. Fall back to the real API
// if the override is rejected (non-configurable) so the page still loads.
try {
  Object.defineProperty(navigator, "geolocation", {
    value: mockGeo, configurable: true, writable: true,
  });
} catch (e) { /* keep the real geolocation */ }

const params = new URLSearchParams(location.search);
const auto = params.get("auto") === "1";
const phase = params.get("phase") === "2" ? 2 : 1;

// Phase 1 starts clean so stale registry/state never leaks across runs.
// Phase 2 keeps the registry so startup re-enables the persist widget.
function clearStorage() {
  try {
    localStorage.removeItem("anymaps.registry");
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf("anymaps.state.") === 0) toRemove.push(k);
    }
    for (const k of toRemove) localStorage.removeItem(k);
  } catch (e) { /* */ }
}
if (phase !== 2) clearStorage();

const manager = createManager();
manager.startup();

const page = {
  doc: document,
  map: manager.ctx.map,
  panelHost: document.getElementById("panel-host"),
  gallery: document.getElementById("gallery"),
  wizard: document.getElementById("wizard"),
  phase,
  auto,
  geo: {
    triggerFix(lat, lng, accuracy) {
      if (watchSuccess) watchSuccess({ coords: { latitude: lat, longitude: lng, accuracy } });
    },
    triggerError(code, message) {
      if (watchError) watchError({ code, message });
    },
  },
};

const GROUPS = [
  ["sdk", sdk],
  ["render", render],
  ["events", events],
  ["camera", camera],
  ["geo", geo],
  ["lifecycle", lifecycle],
  ["gallery", gallery],
  ["wizard", wizard],
  ["persistence", persistence],
];

const resultsEl = document.getElementById("checklist-results");
const statusEl = document.getElementById("checklist-status");
const runBtn = document.getElementById("run-checks");

function renderResult(entry) {
  const li = document.createElement("li");
  li.textContent = (entry.ok ? "✅ " : "❌ ") + entry.name +
    (entry.detail ? " — " + entry.detail : "");
  li.style.color = entry.ok ? "#15803d" : "#b91c1c";
  resultsEl.appendChild(li);
}

async function runAll() {
  runBtn.disabled = true;
  resultsEl.replaceChildren();
  statusEl.textContent = "Running… (phase " + phase + ")";
  let total = 0;
  let passed = 0;
  for (const [label, mod] of GROUPS) {
    const header = document.createElement("li");
    header.textContent = "— " + label + " —";
    header.style.fontWeight = "600";
    header.style.marginTop = "6px";
    resultsEl.appendChild(header);
    let entries = [];
    try {
      entries = await mod.run({ manager, page });
    } catch (e) {
      entries = [{ name: label + " group", ok: false, detail: e.message }];
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      entries = [{ name: label + " group ran", ok: true, detail: "" }];
    }
    for (const e of entries) {
      total += 1;
      if (e.ok) passed += 1;
      renderResult(e);
    }
  }
  const allGreen = passed === total;
  statusEl.textContent = "Phase " + phase + ": " + passed + "/" + total +
    " checks passed." + (allGreen ? " All green." : " Failures above.");
  statusEl.style.color = allGreen ? "#15803d" : "#b91c1c";
  runBtn.disabled = false;

  // Phase 1 continuation: reload into phase 2 so persistence survival is
  // verified after a real re-enable cycle.
  if (auto && phase !== 2) {
    setTimeout(() => {
      location.href = location.pathname + "?auto=1&phase=2";
    }, 1500);
  }
}

runBtn.addEventListener("click", () => { runAll(); });

if (auto) {
  // Defer until the map style has loaded so map-dependent checks see a
  // ready map; fall back after a deadline so checks still run.
  const map = manager.ctx.map;
  const start = () => runAll();
  if (map.isStyleLoaded && map.isStyleLoaded()) {
    start();
  } else {
    let started = false;
    const begin = () => { if (started) return; started = true; start(); };
    map.once("load", begin);
    setTimeout(begin, 4000);
  }
}
