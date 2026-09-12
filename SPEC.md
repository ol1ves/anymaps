# Map + Widget Application — System Specification

This document is the single source of truth for the build. A new agent or team
member must be able to onboard by reading only this file. Every decision here is
settled; nothing is left to be recovered from chat history.

Status legend:

- ✅ **Decided** — locked. Build to this.
- ⚠️ **To freeze at build start** — the shape is agreed, but exact field names or
  payload schemas are written in `CONTRACTS.md` in the first build session.

---

## 1. Purpose

A customizable map web application. Users add widgets — small, self-contained
extensions that draw live or static data on a shared map. The product is an SDK
that makes widget creation cheap and standardized, for human developers and AI
agents alike.

The demo proves the SDK makes adding a widget cheap. It does not prove that many
widgets exist.

---

## 2. Context and constraints

- **Event**: 24-hour hackathon, roughly 16 hours hands-on-keyboard.
- **Agents**: AI agents run in parallel for implementation, cost-reasonably.
- **Team**: three undergraduate CS students, generalist. Strong Python. No
  production JS/TS experience, but the team reviews agent-written code.
- **Repo**: greenfield.
- **Standing constraint — agent-friendliness**: every choice prefers the most
  common, best-documented path so agents emit working code on the first attempt.
- **Consequence**: the browser forces JavaScript/TypeScript on the client. Python
  stays for the backend.

---

## 3. Demo success criteria

1. Three to four widgets enabled and running on one client at the same time.
2. Publish a new widget, then have another user download and run it on their
   client.
3. Stretch: an AI assistant where a non-technical user prompts their own widget
   and publishes it.

---

## 4. Architecture at a glance

```
Map Client (browser)
 ├─ WidgetManager (main thread)  ── owns map, DOM, registry, worker lifecycle
 │    ├─ MapLibre GL JS           ── the map renderer
 │    └─ SDK bridge               ── typed commands/events boundary
 ├─ Widget A  ── Web Worker
 ├─ Widget B  ── Web Worker
 └─ Widget C  ── Web Worker
        │  postMessage (render commands ↑, events ↓)
        │
Generic Widget Server (FastAPI + SQLite, one Docker Compose service)
 ├─ HTTP REST  ── registry, publish, install, provision, channel reads/writes
 ├─ Poller      ── fetches external sources on their declared interval, caches
 ├─ Filter      ── serves filtered subsets of indexed cache
 └─ Secrets     ── server-side store of API keys, referenced by ID
        │
 External APIs / databases (e.g. flight data, OpenStreetMap)
```

**Rules that shape everything:**

1. A widget never touches the map or the DOM directly. It speaks only through
   the SDK.
2. The server never transforms data. It fetches, caches, filters, and
   broadcasts. All processing and aggregation happen in the widget (client
   worker).
3. One widget = one JSON manifest + one JS bundle + a declarative data config.
   No server code.
4. The server selects subsets of cached data (filtering). It never joins,
   aggregates, computes, or reshapes. Every record is returned whole.

---

## 5. Component definitions

### 5.1 Map Client

The frontend wrapper around the map renderer. It owns the map, all DOM outside
the map (side panels, popups, badges), and exposes rendering capability to
widgets exclusively through the SDK. No widget code runs here.

### 5.2 Widget

A self-contained extension: a JSON manifest plus a JS bundle. The bundle runs in
a Web Worker. It draws on the map only through the SDK. It contains no server
code.

### 5.3 Widget Runtime

The environment a widget's JS bundle executes in: a dedicated Web Worker per
enabled widget. Isolation means a misbehaving widget cannot freeze the map's
main thread. The worker has no direct map or DOM access.

### 5.4 SDK (the boundary)

The typed contract between a widget and the Map Client, in two directions:

- **Widget → Map**: render commands (draw, move, remove, popups, panels,
  camera).
- **Map → Widget**: events (marker clicked, map clicked).

The SDK is the single owner of the map and DOM. It is the most important
interface in the system; its job is to define the breadth of what a widget can
express.

### 5.5 WidgetManager

The main-thread runtime. It owns the registry of installed widgets, spawns and
terminates workers, routes events to the correct widget, and owns the map and
DOM. It is the only code that talks to MapLibre directly.

### 5.6 Generic Widget Server

One backend for all widgets. A dumb, config-driven pipe:

- reads each widget's channel config;
- for external channels: fetches on the declared interval, caches, serves
  filtered subsets;
- for client channels: stores client writes, serves filtered reads.

It never transforms data.

### 5.7 Widget Registry

Part of the Generic Widget Server (same FastAPI + SQLite, same single Compose
service). Stores published manifests and JS bundles. Backs a gallery page for
browse and install.

### 5.8 Channel

The unit of data flow. One channel is one endpoint, one direction, one FastAPI
handler. See section 8.

### 5.9 Instance

The unit of privacy. A private channel's data is scoped to an instance token
(a room). Possession of the token is the access boundary. See section 9.

---

## 6. Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Map renderer | MapLibre GL JS |
| 2 | Widget client execution | Web Worker, one per enabled widget |
| 3 | Server code model | Client-only code + declarative config (no server code) |
| 4 | Server role | Dumb pipe: fetch, cache, filter, broadcast; never transform |
| 5 | Publishing | Server-hosted registry; manifest + JS bundle |
| 6 | Deployment | FastAPI + SQLite, one Docker Compose service |
| 7 | Transport | HTTP-only (writes POST, reads short-poll); WebSocket is upgrade path |
| 8 | Render command style | Imperative typed commands over postMessage |
| 9 | Lifecycle | One worker per widget; WidgetManager owns lifecycle |
| 10 | Camera | Lease model with auto-release (section 7.4) |
| 11 | Manifest | One JSON: identity section + server config section |
| 12 | Channel model | One channel = one direction = one handler |
| 13 | Secrets | Server-side store referenced by ID; never in the manifest |
| 14 | Validation | JSON schema; publish fails if invalid |
| 15 | Privacy | Capability-only: instance token, possession is the boundary |
| 16 | Identity fields | id, name, version (semver), description, optional icon, server |
| 17 | Registry storage | Bundles in SQLite; icon is an external URL string |
| 18 | External fetch | HTTP GET/POST, static query/headers, body, auth block, interval |
| 19 | External scope | One endpoint = one channel = one shape; cache-only client reads |
| 20 | External visibility | Public-read only (one shared cache) |
| 21 | Poll intervals | External fetch default 60s, min 5s; client cadence is widget code |
| 22 | Auth types | Header, query param, none |
| 23 | Pagination | None for MVP (single request per channel) |
| 24 | Failure handling | Keep last-good cache on error, retry next interval |
| 25 | SSRF safety | https-only, reject private and loopback ranges |
| 26 | Filtering | Indexed cache with declared record mapping + fixed filter surface |
| 27 | Mapping language | JMESPath |
| 28 | Accumulation | snapshot or series per channel, time-based retention |
| 29 | Client-origin unification | Write channel declares mapping; read references it |
| 30 | Smooth motion | Client-side interpolation, the widget's responsibility |

---

## 7. The SDK (client side)

### 7.1 Execution model

A widget's JS bundle runs in a dedicated Web Worker. The worker has no access to
the map, the DOM, or `window`. Everything crosses the SDK boundary as messages.

- **Widget → Map**: render commands sent over `postMessage`.
- **Map → Widget**: events sent over `postMessage`.

### 7.2 Render command surface (MVP)

Imperative, typed commands. Each command maps one-to-one to a MapLibre
operation. ⚠️ Exact payload field names are frozen in `CONTRACTS.md` at build
start; the operations below are settled.

1. **Markers** — add, update, remove. Static points (bathrooms), moving points
   (friends, planes).
2. **Polylines** — add, update, remove. Flight paths and movement trails.
3. **Popups** — open, close, set content (text or HTML). The Google Maps
   directions link renders inside popup HTML.
4. **Events** — marker click and map click, dispatched to the owning widget.
5. **Info panel** — set the side-bar content a widget controls.
6. **Heatmap** — stretch goal only (bathroom density).

**Out of scope**: routing. Use a Google Maps directions link inside a popup.

### 7.3 Ownership and event routing

- Widgets assign their own unique string IDs to the things they draw. The SDK
  uses these IDs for update, remove, and events.
- A click on any widget-owned item automatically dispatches to that widget.

### 7.4 Camera control (lease model)

Camera control is a lease that expires. States: `FREE` or `LOCKED(owner)`. One
owner, never two.

- **Acquire**: `requestCameraControl()`. Granted if free, denied otherwise. No
  queue, no forced preemption.
- **Lease**: granted for 10 seconds. Any camera command from the owner renews
  the lease automatically. No heartbeat message.
- **Release — any one of four triggers reclaims the map:**
  1. widget calls `releaseCameraControl()`;
  2. lease TTL expires (catches a hung widget);
  3. worker dies, disables, or uninstalls (catches a crashed widget);
  4. the user drags, zooms, or scrolls the map (catches everything else).
- **UI**: a "Camera: <widget name>" badge with a manual release button while
  locked.
- **Camera commands (MVP)**:
  - `flyTo({center, zoom, bearing?})` — follow a moving plane.
  - `fitBounds([southWest, northEast])` — frame a cluster of points.

### 7.5 Lifecycle and concurrency

- One dedicated Worker per enabled widget.
- States: `installed` → `enabled` ⇄ `disabled` → `uninstalled`.
- Disable terminates the worker; enable respawns it.
- No hard resource caps at demo scale (three to four widgets).

### 7.6 Smooth motion

Client read cadence and interpolation are the widget's own responsibility, not
an SDK feature. HTTP short-polling plus client-side interpolation between the
last two polled positions gives smooth motion without push. Guidance: default 5
seconds, minimum 1 second for client reads and writes.

---

## 8. The manifest and channel model

### 8.1 Document split

One JSON manifest, two top-level sections:

- **identity**: who the widget is.
- **server**: the channels it needs.

### 8.2 Identity fields

`id`, `name`, `version` (semver), `description`, optional `icon` (external URL
string; the server does not host icons for the MVP), and `server`.

### 8.3 Channel model — concrete rules

1. One channel = one FastAPI handler = one direction. A write channel is a POST
   handler. A read channel is a GET handler. No channel does both.
2. Channel fields: `id`, `origin`, `direction`, `visibility`.
3. Direction × origin matrix:
   - `client` + `write` — clients POST data (post location).
   - `client` + `read` — clients GET data others wrote (fetch friends).
   - `external` + `read` — clients GET the server's cache of an external
     endpoint.
   - `external` + `write` — not allowed.
4. `visibility` is `public` (one shared address, no token) or `private`
   (instance-scoped). It is per-channel and independent on read and write.
5. External channels add an `external` block (section 10). A channel with a
   record mapping is filterable (section 11). A channel without a mapping serves
   the whole body.

### 8.4 Worked example — Find My Friends

```json
{
  "id": "find-my-friends",
  "name": "Find My Friends",
  "version": "0.1.0",
  "description": "Share live locations with friends",
  "icon": "https://cdn.discordapp.com/attachments/1234/5678/icon.png",
  "server": {
    "channels": [
      {
        "id": "fmfW",
        "origin": "client",
        "direction": "write",
        "visibility": "private",
        "record": { "id": "clientId", "lat": "lat", "lon": "lng", "time": "ts" }
      },
      {
        "id": "fmfR",
        "origin": "client",
        "direction": "read",
        "visibility": "private",
        "source": "fmfW"
      }
    ]
  }
}
```

The write channel `fmfW` declares the record mapping (what each posted payload
looks like). The read channel `fmfR` declares no mapping of its own; its
`source` field references `fmfW`, so it serves `fmfW`'s data through the same
filter surface.

---

## 9. Data flow, provisioning, and privacy

### 9.1 Provisioning (idempotent, per widget)

When a client enables a widget, it sends the manifest to the provision
endpoint. The server checks whether that widget is already provisioned:

- If not: it creates the channel handlers (and pollers for external channels),
  then returns the routes.
- If yes: it returns the same routes. No new handlers.

Provisioning happens once per widget, not once per client.

### 9.2 Instances (per room)

A client creates an instance ("room") to get an instance token. The token scopes
all private channels of that widget. Friends share the token out of band.

### 9.3 Worked example — C1, C2, C3

1. C1 sends the `find-my-friends` manifest. The server provisions the widget and
   returns two routes:
   - write: `POST /widgets/find-my-friends/channels/fmfW`
   - read: `GET /widgets/find-my-friends/channels/fmfR`
2. C1 creates a room: `POST /widgets/find-my-friends/instances` → token `x`. C1
   shares `x` with C2 out of band.
3. C2 sends the same manifest. The server sees the widget already provisioned
   and returns the same two routes. No new handlers.
4. C2 writes: `POST /widgets/find-my-friends/channels/fmfW/instances/x`. C2
   reads: `GET /widgets/find-my-friends/channels/fmfR/instances/x`.
5. C3 sends the same manifest, gets the same routes, creates its own room →
   token `y`. C3 writes and reads with `y`. `x` and `y` are isolated: `y` never
   sees `x`'s data.

The server stores payloads per `(channel, instanceToken)` in SQLite. A read
returns only the caller's token's payloads.

### 9.4 Privacy rules

- Privacy is capability-only. An instance token is a 128-bit random hex string
  (32 characters), generated server-side on create-instance. Possession is the
  whole boundary. No membership lists, no ACL, no join flow.
- Public channels resolve to a well-known address of `widgetId + channelId`, no
  token.
- Private channels are addressed at `widgetId + channelId + token`.
- An unknown token returns 404, so a private instance's existence is not leaked.
- The server tracks no client identity. Client-generated IDs live inside posted
  data payloads (each friend includes its own client ID).

---

## 10. External fetching

### 10.1 The external block

```json
"external": {
  "method": "GET",
  "url": "https://...",
  "query": { "lamin": "40.0" },
  "headers": { "Accept": "application/json" },
  "body": "raw string",
  "auth": { "type": "header", "name": "Authorization", "scheme": "Bearer", "secret": "github-token" },
  "interval": 60,
  "mode": "snapshot",
  "retain": 3600,
  "record": { "records": "states", "id": "[0]", "time": "[3]", "lon": "[5]", "lat": "[6]" }
}
```

Field rules:

- `method`: `GET` or `POST`. Default `GET`.
- `url`: fixed URL.
- `query` and `headers`: static values only. Secrets never appear here.
- `body`: a string (sent raw, covers OverpassQL and GraphQL) or an object (sent
  as JSON). POST only.
- `auth`: the single secret entry point. `type` is `header` or `query`. `name`
  is the header or query-param name. `scheme` is the optional `Bearer ` prefix.
  `secret` is the store ID. Omit for public sources.
- `interval`: refresh seconds. Default 60, minimum 5.
- `mode`: `snapshot` (replace each poll) or `series` (append each poll). Default
  `snapshot`.
- `retain`: for `series` only, time-based retention in seconds. Default 3600.
- `record`: optional record mapping (section 11). No mapping means the whole
  body is served as-is (for small single-object sources).

### 10.2 Cache-only reads

A client read on an external channel hits only the local cache. It never
triggers an external fetch. Only the poller touches the external API. The poller
is configured at provisioning from the manifest.

### 10.3 Worked example — OpenSky flight positions (array of arrays)

OpenSky returns `{ "time": ..., "states": [ [icao24, callsign, country,
time_position, last_contact, lon, lat, ...], ... ] }`. Fields are positional,
so JMESPath uses indices: `0` = icao24, `3` = time_position, `5` = longitude,
`6` = latitude.

```json
{
  "id": "flights_position",
  "origin": "external",
  "direction": "read",
  "visibility": "public",
  "external": {
    "method": "GET",
    "url": "https://opensky-network.org/api/states/all",
    "query": { "lamin": "40.0", "lomin": "-75.0", "lamax": "41.0", "lomax": "-73.0" },
    "interval": 15,
    "mode": "series",
    "retain": 3600,
    "record": { "records": "states", "id": "[0]", "time": "[3]", "lon": "[5]", "lat": "[6]" }
  }
}
```

### 10.4 Worked example — Overpass bathrooms (POST, raw body, GeoJSON)

```json
{
  "id": "nyc_bathrooms",
  "origin": "external",
  "direction": "read",
  "visibility": "public",
  "external": {
    "method": "POST",
    "url": "https://overpass-api.de/api/interpreter",
    "body": "[out:json];node[\"amenity\"=\"toilets\"](40.5,-74.3,40.9,-73.7);out;",
    "interval": 86400,
    "mode": "snapshot",
    "record": { "records": "elements", "id": "id", "lat": "lat", "lon": "lon" }
  }
}
```

Overpass returns `{ "elements": [ { "id": 123, "lat": 40.7, "lon": -73.9,
"tags": {...} }, ... ] }`. No `time` field, so this channel supports `bounds`
and `ids` filters only.

### 10.5 Worked example — OpenWeatherMap (GET, query auth, no mapping)

```json
{
  "id": "nyc_weather",
  "origin": "external",
  "direction": "read",
  "visibility": "public",
  "external": {
    "method": "GET",
    "url": "https://api.openweathermap.org/data/2.5/weather",
    "query": { "q": "New York" },
    "auth": { "type": "query", "name": "appid", "secret": "openweather-key" },
    "interval": 300
  }
}
```

A single-city response is small, so there is no record mapping and no filtering.
The client reads the whole cached body.

### 10.6 Pagination

None for the MVP. Single request per channel. Pick sources that return what you
need in one call, or raise their `limit` param. Page/offset with a hard max-pages
cap is the first extension; cursor and Link-header pagination stay deferred.

### 10.7 Failure handling

On a non-2xx or timeout, the poller keeps the last-good cache and retries the
next interval. It never blanks the cache on an upstream error.

### 10.8 SSRF safety

The manifest controls the fetch URL, so the server must not become an open
proxy. Rules: https-only, and reject private and loopback IP ranges.

---

## 11. Filtering and caching

### 11.1 The conflict this resolves

Filtering a cache requires the server to know the data's shape. A shape-blind
server cannot filter. Therefore the server does not cache an opaque raw body; it
caches an **indexed** set of records.

### 11.2 Record mapping

The manifest declares, per channel, where the queryable fields live. The server
extracts exactly four fields for indexing — identity, latitude, longitude, time
— and keeps the full record as an opaque payload. Filters return full records.

- `records`: JMESPath to the array, external channels only.
- `id`, `lat`, `lon`, `time`: JMESPath within each element (or within the posted
  object for client write channels). All optional.
- A field not declared means the corresponding filter is unavailable on that
  channel.

The mapping language is JMESPath because positional arrays like OpenSky's
(`[0]`, `[6]`) cannot be expressed with dot-paths.

### 11.3 Where the mapping lives

- **External read channel**: declares its own `record` mapping (the poller uses
  it to index the fetched response). There is no write channel.
- **Client write channel**: declares the `record` mapping (the server indexes
  each POST).
- **Client read channel**: declares no mapping; its `source` references the
  write channel by ID.

### 11.4 Filter surface

Query parameters on read GET requests:

- `bounds` — geo box: `south,west,north,east`.
- `ids` — comma-separated identity list.
- `since` / `until` — time range.
- `latest=1` — most recent record per identity. Requires `id` and `time`.

Field requirements: `bounds` needs `lat` + `lon`; `ids` needs `id`;
`since`/`until` need `time`; `latest` needs `id` + `time`.

### 11.5 Accumulation

- `snapshot`: each poll replaces the cache. One record per entity. Good for
  current flights, bathrooms.
- `series`: each poll appends. Multiple records per identity accumulate. Enables
  history and paths. Bounded by `retain` (default one hour).

`latest` dedupes a series cache to the current state. `since`/`until` slices
history.

### 11.6 Worked example — filter queries

OpenSky channel from section 10.3:

- All flights in a box, current: `?bounds=40.0,-75.0,41.0,-73.0`
- One flight's history: `?ids=abc123`

Find My Friends channel from section 8.4:

- Current position of all friends: `?latest=1`
- History of one friend: `?ids=alice&since=...`

Overpass bathrooms from section 10.4:

- Bathrooms in bounds: `?bounds=40.5,-74.3,40.9,-73.7`

### 11.7 The line the server will not cross

The server selects subsets only: filter by identity, bounds, time, latest-per-id.
It never joins, aggregates, computes, or reshapes. Every record is returned
whole. Any aggregation a widget needs — counts, averages, projections — happens
in the client worker.

---

## 12. Transport and routes

HTTP-only for the MVP. Writes are POST, reads are short-poll GET with
client-side interpolation. WebSocket is the single upgrade path if the live
feel underwhelms; the manifest does not change.

### 12.1 Route table

| Route | Method | Purpose |
|-------|--------|---------|
| `/widgets` | POST | Publish: manifest + bundle, validated and stored |
| `/widgets` | GET | Gallery: list published manifests |
| `/widgets/{id}/versions/{version}/manifest` | GET | Install: fetch manifest |
| `/widgets/{id}/versions/{version}/bundle` | GET | Install: fetch JS bundle |
| `/widgets/{id}/provision` | POST | Provision channels; idempotent |
| `/widgets/{id}/instances` | POST | Create room → instance token |
| `/widgets/{id}/channels/{channelId}` | GET/POST | Public channel read/write |
| `/widgets/{id}/channels/{channelId}/instances/{token}` | GET/POST | Private channel read/write |
| `/secrets` | POST | Store a secret → secret ID |

### 12.2 Secrets

An author uploads a secret value to `/secrets`; the server stores it and returns
a secret ID. The manifest references the ID in `auth.secret`. Secret values
never appear in manifests and are never returned after upload. A raw key inline
in a manifest would ship to every installing client, so it is forbidden.

---

## 13. Registry, publishing, install

The registry is the Generic Widget Server itself — the same FastAPI + SQLite,
the same single Docker Compose service. No second service.

- **Publish**: author POSTs manifest + bundle. The server validates the manifest
  against one JSON schema (section 6, decision 14) and stores both in SQLite
  keyed by `id + version`. Invalid manifests are rejected at publish, not at
  runtime.
- **Gallery**: lists published manifests (id, name, version, description, icon).
- **Install**: client fetches manifest + bundle by `id + version`.
- **Bundle storage**: SQLite bytes, served by the server. No file volumes.
- **Icon storage**: external URL string in the manifest. The server does not
  host icons.

---

## 14. Out of scope for the MVP

- Heatmap (stretch).
- Routing engine (use a Google Maps link instead).
- AI assistant (stretch).
- Pagination, cursor and Link-header variants.
- WebSocket transport.
- Per-widget server isolation — one generic server covers all widgets.
- Membership lists or ACLs beyond capability tokens.
- Private external caches (external channels are public-read only).

---

## 15. Build approach (guidance, not spec)

The historical failure mode is people waiting on interfaces and people inventing
interfaces separately. Fix both with one move: freeze the shape first.

### 15.1 Freeze contracts first (hour 0–2, together)

Resolve the ⚠️ items into one `CONTRACTS.md`:

1. SDK command and event signatures — markers, polylines, popups, panels,
   camera, events.
2. Exact render-command payload field names.
3. Wire protocol message shapes and the route table from section 12.

After hour 2, no signature changes without a 30-second group sync.

### 15.2 Three columns, one owner each

- **Column A — Client + SDK.** WidgetManager, worker lifecycle, MapLibre
  integration, camera lease, event routing. Owns the render contract. First
  deliverable: a mock SDK that answers the frozen signatures, then the real one.
- **Column B — Server + Registry.** FastAPI + SQLite, channels, poller, filter,
  secrets, publish and install. Owns the wire contract.
- **Column C — Widgets + demo.** The three to four demo widgets, gallery and
  install UI, the second-user demo. Owns the data-config contract with B.

### 15.3 Dependencies, and why no one idles

- C codes against the frozen SDK signatures using A's mock SDK; C never waits
  for A's real code.
- C codes against the frozen wire contract; B delivers the real server later.
- A and B are fully independent after hour 2.
- Rule: build against signatures, never against each other's live code. Swap the
  mock for the real thing when it lands.

### 15.4 Phases

1. **Hour 0–2** — freeze contracts.
2. **Hour 2–8** — build in parallel. Walking skeleton by hour 3: one widget
   draws on the map, with the server behind it.
3. **Hour 8–14** — integrate. Wire realtime and polled flows. Build the publish
   → install → run demo. Simulate the second user in a second browser.
4. **Hour 14–16** — rehearse, cut.
5. **Stretch, only if ahead** — AI assistant. Column C leads; it generates
   manifest + config + bundle, which the declarative design makes LLM-friendly.

---

## 16. Glossary

- **Widget** — a self-contained map extension: manifest + JS bundle.
- **SDK** — the typed command/event boundary between widgets and the Map Client.
- **WidgetManager** — main-thread runtime that owns registry, workers, events,
  map, and DOM.
- **Generic Widget Server** — the single, dumb, config-driven backend.
- **Registry** — the store and gallery for published widgets, inside the server.
- **Channel** — one endpoint, one direction, one handler.
- **Instance** — a room token scoping private channel data; possession = access.
- **External channel** — server fetches an outside source, caches, serves reads.
- **Client channel** — clients write; clients read what was written.
- **Record mapping** — the declared JMESPath locations of id, lat, lon, time.
- **Snapshot** — cache replaces each poll.
- **Series** — cache appends each poll, bounded by retention.
- **Camera lease** — time-boxed, auto-releasing camera control.
