// Provisioning, install, registry ops, startup (Task 6).
// Contract: CONTRACTS.md section 8 (route table), section 10 (persistence
// keys), section 13 (install = fetch manifest + bundle by id + version);
// SPEC.md section 9.1 (idempotent provisioning), section 12.1, section 13,
// section 7.10 (lifecycle), section 7.11 (z-order).
//
// Exports:
//   serverUrl(win, storage)         — resolve the generic server base URL.
//   agentUrl(win, storage)         — resolve the Agent Service base URL.
//   upsertRegistry(registry, entry)  — pure: replace or add an entry by widgetId.
//   removeRegistryEntry(registry, widgetId) — pure: drop an entry by widgetId.
//   provision(manifest, baseUrl)   — POST /widgets/{id}/provision -> channelRoutes.
//   startupEnable(manager)         — re-enable registry entries flagged enabled.
//   installWidget(manager, id, version) — fetch manifest + bundle, upsert
//                                     registry, then manager.enable.
//   register(ctx)                  — kept for the manager's feature-module list;
//                                     install.js has no command handlers or
//                                     cleanup of its own, so this is a no-op.

// Read a Vite client env var. Vite exposes import.meta.env at runtime (and
// statically replaces import.meta.env.VITE_* at build time). Plain Node
// (unit tests) has no import.meta.env, so guard the access and treat a
// missing/empty value as unset.
function readEnvVar(name) {
  try {
    const value = import.meta.env[name];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

const DEFAULT_BASE_URL = readEnvVar("VITE_SERVER_URL") || "http://localhost:8000";
const DEFAULT_AGENT_URL = "http://localhost:8001";
const REGISTRY_KEY = "anymaps.registry";

// Resolve the generic widget server base URL. Precedence: __ANYMAPS_CONFIG__
// wins, then localStorage, then VITE_SERVER_URL (env), then the default.
// Injected win/storage keep it pure.
export function serverUrl(win, storage) {
  const cfg = win && win.__ANYMAPS_CONFIG__;
  if (cfg && typeof cfg.baseUrl === "string" && cfg.baseUrl) return cfg.baseUrl;
  const stored = storage && storage.getItem("anymaps.baseUrl");
  if (stored) return stored;
  return DEFAULT_BASE_URL;
}

// Resolve the Agent Service base URL. Same precedence as serverUrl.
export function agentUrl(win, storage) {
  const cfg = win && win.__ANYMAPS_CONFIG__;
  if (cfg && typeof cfg.agentUrl === "string" && cfg.agentUrl) return cfg.agentUrl;
  const stored = storage && storage.getItem("anymaps.agentUrl");
  if (stored) return stored;
  return DEFAULT_AGENT_URL;
}

// Pure registry upsert. Replaces any entry with the same widgetId (no
// duplicates), appends otherwise. Returns a new array; never mutates input.
export function upsertRegistry(registry, entry) {
  const out = registry.filter((e) => e.widgetId !== entry.widgetId);
  out.push({ widgetId: entry.widgetId, version: entry.version, enabled: entry.enabled });
  return out;
}

// Pure registry removal. Returns a new array without the matching widgetId.
export function removeRegistryEntry(registry, widgetId) {
  return registry.filter((e) => e.widgetId !== widgetId);
}

// POST /widgets/{id}/provision. Idempotent server-side; called on every
// enable. Non-2xx throws `provision failed: <status> <body.error>`.
export async function provision(manifest, baseUrl) {
  const url = baseUrl + "/widgets/" + manifest.id + "/provision";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest }),
  });
  if (!res.ok) {
    let msg = "";
    try {
      const body = await res.json();
      msg = (body && body.error) || "";
    } catch {
      try { msg = (await res.text()) || ""; } catch { /* keep empty */ }
    }
    throw new Error("provision failed: " + res.status + (msg ? " " + msg : ""));
  }
  const body = await res.json();
  return body.channelRoutes || {};
}

// Read the registry array from localStorage. Returns [] on miss/parse error.
function loadRegistry(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(REGISTRY_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRegistry(storage, registry) {
  storage.setItem(REGISTRY_KEY, JSON.stringify(registry));
}

// Install = fetch manifest + bundle by id + version (SPEC.md section 13),
// then upsert the registry entry enabled:true, then manager.enable. The
// registry entry is written before enable so the widget is recorded even
// if provisioning fails partway; manager.enable re-affirms it (idempotent).
export async function installWidget(manager, id, version) {
  const baseUrl = serverUrl(window, localStorage);
  const manifestRes = await fetch(
    baseUrl + "/widgets/" + id + "/versions/" + version + "/manifest",
  );
  if (!manifestRes.ok) {
    throw new Error("install failed: manifest " + manifestRes.status);
  }
  const manifest = await manifestRes.json();

  const bundleRes = await fetch(
    baseUrl + "/widgets/" + id + "/versions/" + version + "/bundle",
  );
  if (!bundleRes.ok) {
    throw new Error("install failed: bundle " + bundleRes.status);
  }
  const bundleSource = await bundleRes.text();

  const reg = loadRegistry(localStorage);
  const next = upsertRegistry(reg, { widgetId: id, version, enabled: true });
  saveRegistry(localStorage, next);

  try {
    await manager.enable({ manifest, bundleSource, baseUrl });
  } catch (e) {
    // manager.enable threw (e.g. provision non-2xx). The widget is installed
    // but not enabled; reflect that in the registry so startup does not
    // retry it and the gallery shows Enable rather than a dead Enabled.
    const regNow = loadRegistry(localStorage);
    const down = upsertRegistry(regNow, { widgetId: id, version, enabled: false });
    saveRegistry(localStorage, down);
    throw e;
  }
  return { manifest, bundleSource, baseUrl };
}

// On startup, re-enable every registry entry flagged enabled: fetch manifest
// + bundle by id + version, then manager.enable (which loads persisted state
// into init.state). A failure for one widget is logged and does not block the
// rest. Returns the list of widgetIds that started.
export async function startupEnable(manager) {
  const baseUrl = serverUrl(window, localStorage);
  const reg = loadRegistry(localStorage);
  const started = [];
  for (const entry of reg) {
    if (!entry.enabled) continue;
    try {
      const manifestRes = await fetch(
        baseUrl + "/widgets/" + entry.widgetId + "/versions/" + entry.version + "/manifest",
      );
      if (!manifestRes.ok) {
        console.error("startup: manifest", entry.widgetId, manifestRes.status);
        continue;
      }
      const manifest = await manifestRes.json();
      const bundleRes = await fetch(
        baseUrl + "/widgets/" + entry.widgetId + "/versions/" + entry.version + "/bundle",
      );
      if (!bundleRes.ok) {
        console.error("startup: bundle", entry.widgetId, bundleRes.status);
        continue;
      }
      const bundleSource = await bundleRes.text();
      await manager.enable({ manifest, bundleSource, baseUrl });
      started.push(entry.widgetId);
    } catch (e) {
      console.error("startup: failed for", entry.widgetId, e);
    }
  }
  return started;
}

// install.js has no command handlers and no drawn items to clean up. The
// manager calls register() for uniformity with the other feature modules.
export function register(_ctx) { /* no-op */ }
