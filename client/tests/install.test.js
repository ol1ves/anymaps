// Tests for install.js (Task 6). Pure helpers only: registry ops and URL
// resolution. Contract: CONTRACTS.md section 8 (routes), section 10
// (persistence keys), section 13 (install = fetch manifest + bundle).
// SPEC.md section 9.1 (idempotent provisioning), section 13.
//
// provision() and startupEnable() are exercised against the dev mock server
// in the Playwright checklist run; here we cover the pure exports plus a
// fetch-mocked provision call.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  serverUrl,
  agentUrl,
  upsertRegistry,
  removeRegistryEntry,
  provision,
  installWidget,
} from "../src/install.js";

function makeStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
}

// ---- upsertRegistry ----

test("upsertRegistry adds entry to empty registry", () => {
  const out = upsertRegistry([], { widgetId: "w", version: "1.0.0", enabled: true });
  assert.deepEqual(out, [{ widgetId: "w", version: "1.0.0", enabled: true }]);
});

test("upsertRegistry replaces same widgetId without duplicates", () => {
  const reg = [{ widgetId: "w", version: "1.0.0", enabled: false }];
  const out = upsertRegistry(reg, { widgetId: "w", version: "1.0.0", enabled: true });
  assert.equal(out.length, 1);
  assert.deepEqual(out, [{ widgetId: "w", version: "1.0.0", enabled: true }]);
});

test("upsertRegistry keeps other entries and appends new", () => {
  const reg = [{ widgetId: "a", version: "1", enabled: true }];
  const out = upsertRegistry(reg, { widgetId: "b", version: "2", enabled: true });
  assert.equal(out.length, 2);
  assert.deepEqual(out.find((e) => e.widgetId === "b"),
    { widgetId: "b", version: "2", enabled: true });
});

test("upsertRegistry does not mutate the input registry", () => {
  const reg = [{ widgetId: "w", version: "1.0.0", enabled: false }];
  upsertRegistry(reg, { widgetId: "w", version: "1.0.0", enabled: true });
  assert.deepEqual(reg, [{ widgetId: "w", version: "1.0.0", enabled: false }]);
});

// ---- removeRegistryEntry ----

test("removeRegistryEntry removes only the matching entry", () => {
  const reg = [
    { widgetId: "a", version: "1", enabled: true },
    { widgetId: "w", version: "1.0.0", enabled: true },
    { widgetId: "b", version: "2", enabled: false },
  ];
  const out = removeRegistryEntry(reg, "w");
  assert.equal(out.length, 2);
  assert.equal(out.find((e) => e.widgetId === "w"), undefined);
  assert.deepEqual(out.map((e) => e.widgetId), ["a", "b"]);
});

test("removeRegistryEntry on missing id is a no-op", () => {
  const reg = [{ widgetId: "a", version: "1", enabled: true }];
  const out = removeRegistryEntry(reg, "zzz");
  assert.deepEqual(out, [{ widgetId: "a", version: "1", enabled: true }]);
});

// ---- URL resolution ----

test("serverUrl defaults to localhost:8000", () => {
  const win = {};
  const storage = makeStorage();
  assert.equal(serverUrl(win, storage), "http://localhost:8000");
});

test("serverUrl reads anymaps.baseUrl from storage", () => {
  const win = {};
  const storage = makeStorage({ "anymaps.baseUrl": "https://widgets.example.com" });
  assert.equal(serverUrl(win, storage), "https://widgets.example.com");
});

test("agentUrl defaults to localhost:8001", () => {
  const win = {};
  const storage = makeStorage();
  assert.equal(agentUrl(win, storage), "http://localhost:8001");
});

test("agentUrl reads anymaps.agentUrl from storage", () => {
  const win = {};
  const storage = makeStorage({ "anymaps.agentUrl": "https://agent.example.com" });
  assert.equal(agentUrl(win, storage), "https://agent.example.com");
});

test("window.__ANYMAPS_CONFIG__.baseUrl wins over storage", () => {
  const win = { __ANYMAPS_CONFIG__: { baseUrl: "https://cfg.example.com", agentUrl: "https://cfg-agent.example.com" } };
  const storage = makeStorage({
    "anymaps.baseUrl": "https://storage.example.com",
    "anymaps.agentUrl": "https://storage-agent.example.com",
  });
  assert.equal(serverUrl(win, storage), "https://cfg.example.com");
  assert.equal(agentUrl(win, storage), "https://cfg-agent.example.com");
});

test("window.__ANYMAPS_CONFIG__ partial falls back to storage for the other", () => {
  const win = { __ANYMAPS_CONFIG__: { baseUrl: "https://cfg.example.com" } };
  const storage = makeStorage({ "anymaps.agentUrl": "https://agent.example.com" });
  assert.equal(serverUrl(win, storage), "https://cfg.example.com");
  assert.equal(agentUrl(win, storage), "https://agent.example.com");
});

// ---- provision (fetch-mocked) ----

test("provision POSTs manifest and returns channelRoutes", async () => {
  const manifest = {
    id: "w",
    server: {
      channels: [
        { id: "cW", origin: "client", direction: "write" },
        { id: "cR", origin: "client", direction: "read" },
      ],
    },
  };
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      json: async () => ({ channelRoutes: { cW: "http://host/w/cW", cR: "http://host/w/cR" } }),
      text: async () => "",
    };
  };
  try {
    const routes = await provision(manifest, "http://host");
    assert.deepEqual(routes, { cW: "http://host/w/cW", cR: "http://host/w/cR" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://host/widgets/w/provision");
    assert.equal(calls[0].opts.method, "POST");
    const body = JSON.parse(calls[0].opts.body);
    assert.deepEqual(body.manifest, manifest);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("provision throws on non-2xx with body error", async () => {
  const manifest = { id: "w", server: { channels: [] } };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false, status: 500,
    json: async () => ({ error: "boom" }),
    text: async () => '{"error":"boom"}',
  });
  try {
    await assert.rejects(provision(manifest, "http://host"), /provision failed: 500 boom/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ---- installWidget: registry flips enabled:false on enable failure ----

function makeLocalStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem(k) {
      return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
    },
    setItem(k, v) { store[k] = String(v); },
    removeItem(k) { delete store[k]; },
  };
}

test("installWidget writes enabled:false when manager.enable throws", async () => {
  const origFetch = globalThis.fetch;
  const origWindow = globalThis.window;
  const origStorage = globalThis.localStorage;
  const storage = makeLocalStorage();
  globalThis.window = {};
  globalThis.localStorage = storage;
  globalThis.fetch = async (url) => {
    if (/\/manifest$/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ id: "w", version: "1.0.0" }) };
    }
    if (/\/bundle$/.test(url)) {
      return { ok: true, status: 200, text: async () => "bundle-src" };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  // manager.enable throws (e.g. provision non-2xx).
  const manager = {
    enable: async () => { throw new Error("enable failed"); },
  };
  try {
    await assert.rejects(installWidget(manager, "w", "1.0.0"), /enable failed/);
    const reg = JSON.parse(storage.getItem("anymaps.registry"));
    assert.deepEqual(reg, [{ widgetId: "w", version: "1.0.0", enabled: false }]);
  } finally {
    globalThis.fetch = origFetch;
    globalThis.window = origWindow;
    globalThis.localStorage = origStorage;
  }
});

test("installWidget leaves enabled:true on success", async () => {
  const origFetch = globalThis.fetch;
  const origWindow = globalThis.window;
  const origStorage = globalThis.localStorage;
  const storage = makeLocalStorage();
  globalThis.window = {};
  globalThis.localStorage = storage;
  let enabled = false;
  globalThis.fetch = async (url) => {
    if (/\/manifest$/.test(url)) {
      return { ok: true, status: 200, json: async () => ({ id: "w", version: "1.0.0" }) };
    }
    if (/\/bundle$/.test(url)) {
      return { ok: true, status: 200, text: async () => "bundle-src" };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
  };
  const manager = { enable: async () => { enabled = true; } };
  try {
    await installWidget(manager, "w", "1.0.0");
    assert.equal(enabled, true);
    const reg = JSON.parse(storage.getItem("anymaps.registry"));
    assert.deepEqual(reg, [{ widgetId: "w", version: "1.0.0", enabled: true }]);
  } finally {
    globalThis.fetch = origFetch;
    globalThis.window = origWindow;
    globalThis.localStorage = origStorage;
  }
});
