// Dev-only mock of the CONTRACTS.md section 8-9 HTTP API. Plain Node http,
// no dependencies. Started with `npm run mock`.
//
// Limitations (documented): this mock exists to verify client behavior, not
// to replace the backend. External channels are served from a canned empty
// array (no real fetching, no poller). The record-mapping path subset
// supports dot-separated keys and [N] array indexes only; JMESPath pipes,
// slices, or functions are treated as undeclared. Orphaned data persists in
// memory until the process exits (no DELETE route, no retention pruning).
//
// Base port 8000. Wizard routes live on the same server under /wizard/.

import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT ?? 8000);
const BASE = `http://localhost:${PORT}`;

// In-memory stores.
const published = new Map();   // `${id}@${version}` -> { manifest, bundle }
const provisions = new Map();  // widgetId -> { manifest, channelRoutes }
const tokens = new Map();     // widgetId -> Set<token>
const records = new Map();    // `${widgetId}:${cid}:${token||""}` -> [storedRecord]

function key(id, version) { return `${id}@${version}`; }
function recKey(widgetId, cid, token) { return `${widgetId}:${cid}:${token ?? ""}`; }

function send(res, status, body, contentType = "application/json") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(text);
}

function sendError(res, status, message) {
  send(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); } catch { reject(new Error("malformed body")); }
    });
    req.on("error", reject);
  });
}

function findChannel(manifest, cid) {
  const channels = (manifest?.server?.channels) || [];
  return channels.find((c) => c.id === cid);
}

// ---- Record-mapping path resolution (subset: dot keys + [N] indexes) ----

const SUPPORTED_PATH = /^([^\.\[\]]+|\[\d+\])(\.[^\.\[\]]+|\[\d+\])*$/;

function isDeclared(path) {
  // A mapping field is declared if it is a non-empty string and uses only the
  // supported path subset. Pipes, slices, and functions are undeclared.
  return typeof path === "string" && path.length > 0 && SUPPORTED_PATH.test(path);
}

function resolvePath(obj, path) {
  if (path == null || obj == null) return undefined;
  const tokens = [];
  const re = /([^\.\[\]]+)|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(path)) !== null) {
    if (m[1] != null) tokens.push({ k: m[1] });
    else tokens.push({ i: Number(m[2]) });
  }
  let cur = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    if (t.k != null) cur = cur[t.k];
    else cur = Array.isArray(cur) ? cur[t.i] : undefined;
  }
  return cur;
}

function fieldOf(record, mapping, field) {
  if (!mapping) return undefined;
  if (field === "time" && mapping.time === "@ingestedAt") {
    return record["@ingestedAt"];
  }
  return resolvePath(record, mapping[field]);
}

// ---- Filter engine (composition: latest -> bounds -> ids -> since -> until) ----

function applyFilters(records, mapping, params) {
  let out = records.slice();

  if (params.latest !== undefined) {
    if (!isDeclared(mapping?.id) || !(isDeclared(mapping?.time) || mapping?.time === "@ingestedAt")) {
      throw { status: 400, error: "filter latest requires id+time" };
    }
    const best = new Map();
    for (const r of out) {
      const id = fieldOf(r, mapping, "id");
      const t = fieldOf(r, mapping, "time");
      if (id == null || t == null) continue;
      const prev = best.get(String(id));
      if (prev == null || t > prev.t) best.set(String(id), { t, r });
    }
    out = [...best.values()].map((e) => e.r);
  }

  if (params.bounds !== undefined) {
    if (!isDeclared(mapping?.lat) || !isDeclared(mapping?.lon)) {
      throw { status: 400, error: "filter bounds requires lat+lon" };
    }
    const parts = params.bounds.split(",");
    if (parts.length !== 4 || parts.some((p) => !Number.isFinite(Number(p)))) {
      throw { status: 400, error: "malformed bounds" };
    }
    const [south, west, north, east] = parts.map(Number);
    out = out.filter((r) => {
      const lat = fieldOf(r, mapping, "lat");
      const lon = fieldOf(r, mapping, "lon");
      return lat != null && lon != null &&
        lat >= south && lat <= north && lon >= west && lon <= east;
    });
  }

  if (params.ids !== undefined) {
    if (!isDeclared(mapping?.id)) {
      throw { status: 400, error: "filter ids requires id" };
    }
    const set = new Set(params.ids.split(",").map((s) => s.trim()));
    out = out.filter((r) => {
      const id = fieldOf(r, mapping, "id");
      return id != null && set.has(String(id));
    });
  }

  if (params.since !== undefined) {
    if (!isDeclared(mapping?.time) && mapping?.time !== "@ingestedAt") {
      throw { status: 400, error: "filter since requires time" };
    }
    const since = Number(params.since);
    out = out.filter((r) => {
      const t = fieldOf(r, mapping, "time");
      return t != null && t >= since;
    });
  }

  if (params.until !== undefined) {
    if (!isDeclared(mapping?.time) && mapping?.time !== "@ingestedAt") {
      throw { status: 400, error: "filter until requires time" };
    }
    const until = Number(params.until);
    out = out.filter((r) => {
      const t = fieldOf(r, mapping, "time");
      return t != null && t <= until;
    });
  }

  // Ascending by the channel's time mapping when present.
  if (isDeclared(mapping?.time) || mapping?.time === "@ingestedAt") {
    out.sort((a, b) => {
      const ta = fieldOf(a, mapping, "time");
      const tb = fieldOf(b, mapping, "time");
      if (ta == null && tb == null) return 0;
      if (ta == null) return 1;
      if (tb == null) return -1;
      return ta - tb;
    });
  }

  return out;
}

// ---- Channel read context (resolves source for client read channels) ----

function readContext(widgetId, cid, token) {
  const prov = provisions.get(widgetId);
  if (!prov) return { status: 404, error: "unknown widget" };
  const manifest = prov.manifest;
  const ch = findChannel(manifest, cid);
  if (!ch) return { status: 404, error: "unknown channel" };

  let recordsOut;
  let mapping;

  if (ch.origin === "external" && ch.direction === "read") {
    // External: canned empty array (no real fetching).
    recordsOut = [];
    mapping = ch.external?.record;
  } else if (ch.origin === "client" && ch.direction === "read") {
    const sourceCh = findChannel(manifest, ch.source);
    recordsOut = records.get(recKey(widgetId, ch.source, token)) ?? [];
    mapping = sourceCh?.record;
  } else if (ch.origin === "client" && ch.direction === "write") {
    recordsOut = records.get(recKey(widgetId, cid, token)) ?? [];
    mapping = ch.record;
  } else {
    return { status: 404, error: "unknown channel" };
  }

  return { records: recordsOut, mapping };
}

// ---- Wizard canned widget ----

const WIZARD_BUNDLE = [
  "const { config, state } = await anymaps.ready();",
  "anymaps.addMarker({ id: 'w1', lat: 40.71, lng: -74.0, icon: '📍', color: '#d32f2f', label: 'A' });",
  "anymaps.addMarker({ id: 'w2', lat: 40.72, lng: -74.01, icon: '📍', color: '#1976d2', label: 'B' });",
  "anymaps.setPanel({ title: 'Wizard Widget', content: '<p>Two markers near NYC.</p>' });",
].join("\n");

const WIZARD_MANIFEST = {
  id: "mock-wizard-widget",
  name: "Mock Wizard Widget",
  version: "0.1.0",
  description: "Canned wizard output for demo and checklist.",
  server: {
    channels: [
      { id: "mockW", origin: "client", direction: "write", visibility: "public",
        mode: "series", retain: 3600,
        record: { id: "clientId", lat: "lat", lon: "lng", time: "ts" } },
      { id: "mockR", origin: "client", direction: "read", visibility: "public",
        source: "mockW" },
    ],
  },
};

function publishWizardWidget() {
  published.set(key(WIZARD_MANIFEST.id, WIZARD_MANIFEST.version),
    { manifest: WIZARD_MANIFEST, bundle: WIZARD_BUNDLE });
}

// ---- Request router ----

async function handle(req, res, url) {
  const method = req.method;
  const path = url.pathname;
  const params = Object.fromEntries(url.searchParams.entries());

  // /widgets collection
  if (path === "/widgets") {
    if (method === "GET") {
      const list = [...published.values()].map(({ manifest }) => ({
        id: manifest.id, name: manifest.name, version: manifest.version,
        description: manifest.description ?? "", icon: manifest.icon ?? null,
      }));
      return send(res, 200, list);
    }
    if (method === "POST") {
      let body;
      try { body = await readBody(req); } catch { return sendError(res, 400, "malformed body"); }
      if (!body || !body.manifest) return sendError(res, 400, "manifest required");
      const { manifest, bundle } = body;
      if (typeof manifest.id !== "string" || !manifest.id ||
          typeof manifest.version !== "string" || !manifest.version) {
        return sendError(res, 400, "manifest id and version required");
      }
      const k = key(manifest.id, manifest.version);
      if (published.has(k)) {
        return sendError(res, 409, "id + version already published");
      }
      published.set(k, { manifest, bundle: typeof bundle === "string" ? bundle : "" });
      return send(res, 201, { id: manifest.id, version: manifest.version });
    }
    return sendError(res, 404, "unknown route");
  }

  // /widgets/{id}/versions/{version}/manifest|bundle
  let m = path.match(/^\/widgets\/([^/]+)\/versions\/([^/]+)\/(manifest|bundle)$/);
  if (m) {
    const [, id, version, kind] = m;
    const entry = published.get(key(id, version));
    if (!entry) return sendError(res, 404, "not found");
    if (kind === "manifest") return send(res, 200, entry.manifest);
    return send(res, 200, entry.bundle, "text/javascript");
  }

  // /widgets/{id}/provision
  m = path.match(/^\/widgets\/([^/]+)\/provision$/);
  if (m && method === "POST") {
    const [, id] = m;
    let body;
    try { body = await readBody(req); } catch { return sendError(res, 400, "malformed body"); }
    if (!body || !body.manifest) return sendError(res, 400, "manifest required");
    const manifest = body.manifest;
    if (manifest.id !== id) return sendError(res, 400, "manifest id mismatch");
    let prov = provisions.get(id);
    if (!prov) {
      const channels = manifest.server?.channels ?? [];
      const channelRoutes = {};
      for (const ch of channels) {
        channelRoutes[ch.id] = `${BASE}/widgets/${id}/channels/${ch.id}`;
      }
      prov = { manifest, channelRoutes };
      provisions.set(id, prov);
    }
    return send(res, 200, { channelRoutes: prov.channelRoutes });
  }

  // /widgets/{id}/instances
  m = path.match(/^\/widgets\/([^/]+)\/instances$/);
  if (m && method === "POST") {
    const [, id] = m;
    if (!provisions.has(id)) return sendError(res, 404, "unknown widget");
    const token = crypto.randomBytes(16).toString("hex");
    if (!tokens.has(id)) tokens.set(id, new Set());
    tokens.get(id).add(token);
    return send(res, 201, { instanceToken: token });
  }

  // /widgets/{id}/channels/{cid}[/instances/{token}]
  m = path.match(/^\/widgets\/([^/]+)\/channels\/([^/]+)(?:\/instances\/([^/]+))?$/);
  if (m) {
    const [, id, cid, token] = m;
    if (!provisions.has(id)) return sendError(res, 404, "unknown widget");

    if (token !== undefined) {
      const set = tokens.get(id);
      if (!set || !set.has(token)) return sendError(res, 404, "unknown token");
    }

    if (method === "POST") {
      let body;
      try { body = await readBody(req); } catch { return sendError(res, 400, "malformed body"); }
      if (body == null || typeof body !== "object") {
        return sendError(res, 400, "record body required");
      }
      const ctx2 = readContext(id, cid, token ?? "");
      if (ctx2.status) return sendError(res, ctx2.status, ctx2.error);
      const stored = { ...body, "@ingestedAt": Math.floor(Date.now() / 1000) };
      const rk = recKey(id, cid, token ?? "");
      if (!records.has(rk)) records.set(rk, []);
      records.get(rk).push(stored);
      return send(res, 201, {});
    }

    if (method === "GET") {
      const ctx2 = readContext(id, cid, token ?? "");
      if (ctx2.status) return sendError(res, ctx2.status, ctx2.error);
      try {
        const filtered = applyFilters(ctx2.records, ctx2.mapping, params);
        return send(res, 200, { records: filtered });
      } catch (e) {
        if (e && e.status) return sendError(res, e.status, e.error);
        throw e;
      }
    }
    return sendError(res, 404, "unknown route");
  }

  // /wizard/generate
  m = path.match(/^\/wizard\/generate$/);
  if (m && method === "POST") {
    let body;
    try { body = await readBody(req); } catch { return sendError(res, 400, "malformed body"); }
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      return sendError(res, 400, "messages required");
    }
    if (body.messages.length === 1) {
      return send(res, 200, {
        done: false,
        questions: ["Drinking water (amenity=drinking_water) or decorative fountains (amenity=fountain)?"],
      });
    }
    publishWizardWidget();
    return send(res, 200, {
      done: true,
      widgetId: WIZARD_MANIFEST.id,
      version: WIZARD_MANIFEST.version,
      manifest: WIZARD_MANIFEST,
    });
  }

  return sendError(res, 404, "unknown route");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  if (req.method === "OPTIONS") {
    return send(res, 204, "");
  }
  try {
    await handle(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendError(res, 500, "server error");
  }
});

server.listen(PORT, () => {
  console.log(`anymaps mock server on ${BASE}`);
});
