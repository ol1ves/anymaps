// Shared helpers for checklist check modules. Pure browser-side utilities;
// no Node imports. Each check module gets { manager, page } where `page`
// exposes the helpers below plus DOM references.

export function makeManifest(id, name, channels = []) {
  return { id, name, version: "0.1.0", server: { channels } };
}

// Fetch a fixture bundle as raw text (the manager prepends the anymaps
// runtime). Returns the source string.
export async function fetchBundle(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error("fixture fetch failed: " + path + " " + res.status);
  return res.text();
}

// Enable a fixture widget: fetch the bundle, build a manifest, provision +
// enable through the manager. Returns the widgetId.
export async function enableFixture(manager, opts) {
  const { id, name, bundlePath, baseUrl, bundlePrefix = "" } = opts;
  const bundleSource = bundlePrefix + await fetchBundle(bundlePath);
  const manifest = makeManifest(id, name, opts.channels ?? []);
  await manager.enable({ manifest, bundleSource, baseUrl });
  return id;
}

// Poll the widget's in-memory state until predicate(state) is true or the
// deadline passes. Resolves true on success, false on timeout.
export async function waitForState(manager, widgetId, predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(manager.ctx.getState(widgetId))) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return predicate(manager.ctx.getState(widgetId));
}

export function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Build a result entry.
// Publish a widget (manifest + bundle) to the server's /widgets store.
// Idempotent: a 409 (already published) is treated as success.
export async function publishWidget(baseUrl, manifest, bundle) {
  const res = await fetch(baseUrl + "/widgets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest, bundle }),
  });
  if (!res.ok && res.status !== 409) {
    throw new Error("publish failed " + res.status);
  }
}

export function ok(name, detail = "") {
  return { name, ok: true, detail };
}
export function fail(name, detail) {
  return { name, ok: false, detail };
}
