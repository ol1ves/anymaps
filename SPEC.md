# Map + Widget Application — System Specification

This document is the single source of truth for the build. A new agent or team
member must be able to onboard by reading only this file. Every decision here is
settled; nothing is left to be recovered from chat history.

Status legend:

- ✅ **Decided** — locked. Build to this.
- **CONTRACTS.md** — the authoritative wire contract: message envelope,
  command and event payloads, the `anymaps` API, the manifest schema, and the
  HTTP route table. Build against it.

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
- **Geolocation**: browser geolocation works only in a secure context. Serve the
  client over HTTPS or `localhost` during the demo.

---

## 3. Demo success criteria

1. Three widgets enabled and running on one client at the same time: bathrooms,
   flights, and friends.
2. Publish a new widget, then have another user download and run it on their
   client.
3. A non-technical user prompts a widget in the wizard. The agent asks
   clarifying questions, tests the data source, generates a manifest and bundle,
   publishes them, and the client auto-installs and enables the result.

The wizard is general-purpose. It creates any widget the declarative model
supports, from any reachable data source. The water-fountains widget is one demo
instance, not the wizard's only output.

---

## 4. Architecture at a glance

```
Map Client (browser)
 ├─ WidgetManager (main thread)  ── owns map, DOM, registry, workers,
 │                                   geolocation, and the camera lease
 │    ├─ MapLibre GL JS           ── the map renderer
 │    ├─ SDK bridge               ── typed commands/events boundary
 │    └─ Wizard panel             ── built-in chat UI (not a widget)
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
Agent Service (Python + LLM, second Docker Compose service)
 ├─ Wizard API  ── receives user prompts, returns generated widgets
 ├─ Source test ── fetches a candidate source (SSRF rules) to verify shape
 └─ Generator   ── writes manifest + bundle, publishes via POST /widgets
        │
 External APIs / databases (e.g. ADSB.lol, OpenStreetMap Overpass)
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
5. The Agent Service may fetch, generate, and publish. It never runs widget code
   or touches the map. Its output is always a manifest plus a bundle.
6. The wizard builds any widget the manifest and SDK express. Its limit is the
   channel model: no pagination, no joins, no server transforms.

---

## 5. Component definitions

### 5.1 Map Client

The frontend wrapper around the map renderer. It owns the map, all DOM outside
the map (side panels, popups, badges, the wizard panel), and exposes rendering
capability to widgets exclusively through the SDK. No widget code runs here.

### 5.2 Widget

A self-contained extension: a JSON manifest plus a JS bundle. The bundle runs in
a Web Worker. It draws on the map only through the SDK. It contains no server
code.

### 5.3 Widget Runtime

The environment a widget's JS bundle executes in: a dedicated Web Worker per
enabled widget. Isolation means a misbehaving widget cannot freeze the map's
main thread. The worker has no direct map, DOM, or geolocation access.

### 5.4 SDK (the boundary)

The typed contract between a widget and the Map Client, in two directions:

- **Widget → Map**: render commands (draw, move, remove, popups, panels,
  camera, geolocation).
- **Map → Widget**: events (marker clicked, map clicked, camera, geolocation).

The SDK is the single owner of the map and DOM. It is the most important
interface in the system; its job is to define the breadth of what a widget can
express.

### 5.5 WidgetManager

The main-thread runtime. It owns the registry of installed widgets, spawns and
terminates workers, routes events to the correct widget, owns the map and DOM,
owns the geolocation watch, and enforces the camera lease. It is the only code
that talks to MapLibre directly.

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

### 5.10 Agent Service (wizard)

A second Docker Compose service (Python + LLM). It receives a natural-language
description, asks clarifying questions when the data source or behavior is
ambiguous, fetches the candidate source to verify its shape under the SSRF rules
(section 10.8), then generates a manifest and a JS bundle and publishes them via
`POST /widgets`. It holds the LLM key and the SDK documentation in context. It is
general-purpose: any widget the declarative model supports.

### 5.11 Wizard panel

A built-in chat panel in the Map Client, not a widget. It relays the user's
prompt to the Agent Service and, on success, auto-installs and enables the
returned widget.

---

## 6. Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Map renderer | MapLibre GL JS |
| 2 | Widget client execution | Web Worker, one per enabled widget |
| 3 | Server code model | Client-only code + declarative config (no server code) |
| 4 | Server role | Dumb pipe: fetch, cache, filter, broadcast; never transform |
| 5 | Publishing | Server-hosted registry; manifest + JS bundle |
| 6 | Deployment | Generic server: FastAPI + SQLite, one Compose service. Agent Service: a second Compose service |
| 7 | Transport | HTTP-only (writes POST, reads short-poll); WebSocket is upgrade path |
| 8 | Render command style | Imperative typed commands over postMessage |
| 9 | Lifecycle | One worker per widget; WidgetManager owns lifecycle |
| 10 | Camera | Lease gates continuous follow only; pans are last-writer-wins; last-request-wins preemption (section 7.7) |
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
| 22 | Auth types | Header, query param, none. OAuth2 client-credentials is out of scope |
| 23 | Pagination | None for MVP (single request per channel) |
| 24 | Failure handling | Keep last-good cache on error, retry next interval |
| 25 | SSRF safety | https-only, reject private and loopback ranges |
| 26 | Filtering | Indexed cache with declared record mapping + fixed filter surface |
| 27 | Mapping language | JMESPath |
| 28 | Accumulation | snapshot or series per channel, time-based retention |
| 29 | Client-origin unification | Write channel declares mapping; read references it |
| 30 | Smooth motion | Client-side interpolation, the widget's responsibility |
| 31 | Flights data source | ADSB.lol, free + no auth; fields: callsign, registration, type, altitude, speed, heading. No origin/destination |
| 32 | Dynamic viewport | Broad fixed cache + client `bounds` filter; no server-side viewport templating |
| 33 | Client-channel accumulation | `mode` + `retain` on client write channels; default series + 3600 |
| 34 | Server-stamped time | Reserved `@ingestedAt` in `record.time`; server stamps at fetch, returns records unchanged |
| 35 | Geolocation | Proxied through the SDK; WidgetManager draws a native user-location dot |
| 36 | Marker rotation | Optional `rotation` field, degrees clockwise from north |
| 37 | Camera follow | `jumpTo` command for instant follow moves; `flyTo` for animated pans |
| 38 | Wizard | Demo-required; general-purpose; second Compose service; auto-installs its output |

---

## 7. The SDK (client side)

### 7.1 Execution model

A widget's JS bundle runs in a dedicated Web Worker. The worker has no access to
the map, the DOM, `window`, `localStorage`, or `navigator.geolocation`.
Everything crosses the SDK boundary as messages over `postMessage`.

- **Widget → Map**: render commands.
- **Map → Widget**: events.

The SDK library is named **`anymaps`**. Widget authors and agents write against
`anymaps.addMarker(...)`, never against raw `postMessage`. The exact wire format
lives in `CONTRACTS.md`.

### 7.2 Message envelope

Every message is a discriminated object:

```json
{ "v": 1, "kind": "cmd", "id": "c1", "name": "addMarker", "payload": { } }
{ "v": 1, "kind": "event", "name": "markerClick", "payload": { "markerId": "m1" } }
{ "v": 1, "kind": "error", "id": "c1", "error": "marker missing position" }
```

- `kind` is `init`, `cmd`, `event`, or `error`.
- Commands are fire-and-forget. They carry an `id`; the main thread echoes it in
  an `error` message when a command is malformed. Errors never crash the widget.
- Events carry no `id`.

### 7.3 Bootstrap

On enable, WidgetManager provisions the widget's channels, then posts one `init`
message:

```json
{
  "kind": "init", "protocolVersion": 1, "widgetId": "find-my-friends",
  "baseUrl": "https://server.example",
  "channelRoutes": { "fmfW": "...", "fmfR": "..." },
  "state": { "iid": "x" }
}
```

- `channelRoutes` maps each channel ID to its route prefix.
- `state` is the persisted state object from `localStorage` (section 7.9). It is
  `{}` on first run.
- The worker fetches its own data with native `fetch` against those routes. The
  main thread never proxies HTTP.
- The widget creates its own room via `POST /widgets/{id}/instances` and appends
  `/instances/{token}` to private routes.
- The server sets CORS to allow the app origin.
- WidgetManager rejects a bundle whose `protocolVersion` it does not support.

### 7.4 Render commands — payloads

Coordinate order: the SDK uses `lat` and `lng` everywhere. MapLibre wants
`[lng, lat]` (GeoJSON order) internally; the SDK translates. Authors never see
MapLibre's ordering.

**Markers:**

```json
{ "id": "b42", "lat": 40.71, "lng": -74.0, "icon": "🚻", "color": "#0066ff", "label": "open", "title": "Public restroom", "rotation": 0 }
```

- `addMarker`: `id`, `lat`, `lng`, optional `icon` (emoji or image URL),
  `color`, `label` (badge text), `title` (hover tooltip), `rotation` (degrees,
  0–360, clockwise from north). Default `rotation` is 0.
- `updateMarker`: `id` plus any changed fields.
- `removeMarker`: `id` only.

**Polylines:**

```json
{ "id": "trail-1", "points": [[40.7, -74.0], [40.8, -74.1]], "color": "#ff0000", "width": 3 }
```

- `addPolyline`: `id`, `points`, optional `color`, `width`.
- `updatePolyline`: `id` plus `points` (replace the whole path) or `append` (add
  points to the end, for trails), plus optional `color`, `width`.
- `removePolyline`: `id` only.

**Popups:**

```json
{ "id": "p1", "content": "<a href='...'>Directions</a>", "lat": 40.71, "lng": -74.0 }
```

- `openPopup`: `id`, `content`, and either `lat`/`lng` (standalone) or
  `anchorMarkerId` (anchored to a marker).
- `closePopup`: `id`.
- `setPopupContent`: `id` + `content`.

**Panel** — one shared panel per widget:

```json
{ "title": "Nearby", "content": "<ul><li>3 restrooms open</li></ul>" }
```

- `setPanel`: `title` and `content`. `clearPanel`: nothing.
- `content` is raw HTML in popups and panels. No sanitization. Trust = the user
  installed the widget.

**Camera:**

```json
{ "name": "requestCameraControl", "payload": {} }
{ "name": "releaseCameraControl", "payload": {} }
{ "name": "flyTo", "payload": { "center": [40.71, -74.0], "zoom": 12, "bearing": 90 } }
{ "name": "jumpTo", "payload": { "center": [40.71, -74.0], "zoom": 12, "bearing": 90 } }
{ "name": "fitBounds", "payload": { "bounds": [[40.5, -74.3], [40.9, -73.7]] } }
```

- `flyTo.center` is `[lat, lng]`. `fitBounds.bounds` is
  `[[south, west], [north, east]]`.
- `flyTo` is animated. `jumpTo` is instant, with no animation; use it for
  follow loops.
- `flyTo`, `jumpTo`, and `fitBounds` need no camera lease (section 7.7). Any
  widget may issue them; the most recent command wins.

**Geolocation:**

```json
{ "name": "startGeolocation", "payload": { "highAccuracy": true } }
{ "name": "stopGeolocation", "payload": {} }
```

- `startGeolocation` asks WidgetManager to begin a `watchPosition` on the main
  thread. The worker cannot call `navigator.geolocation` itself.
- `stopGeolocation` ends the watch.
- While a watch is active, WidgetManager draws a native user-location dot on the
  map and updates it on each fix.

### 7.5 Events

```json
{ "name": "markerClick", "payload": { "markerId": "b42" } }
{ "name": "mapClick", "payload": { "lat": 40.71, "lng": -74.0 } }
{ "name": "cameraGranted", "payload": {} }
{ "name": "cameraDenied", "payload": {} }
{ "name": "cameraRevoked", "payload": { "reason": "ttl" } }
{ "name": "viewportChanged", "payload": { "bounds": [[40.5, -74.3], [40.9, -73.7]], "center": [40.71, -74.0], "zoom": 12 } }
{ "name": "geolocation", "payload": { "lat": 40.71, "lng": -74.0, "accuracy": 25 } }
{ "name": "geolocationError", "payload": { "code": 1, "message": "permission denied" } }
```

- `cameraRevoked.reason` is `ttl`, `userGesture`, `released`, or `preempted`.
- `cameraDenied` is reserved for a future strict-leasing mode. Under the current
  last-request-wins model, a control request always preempts, so it never fires.
- `viewportChanged` fires debounced on move-end, on user drag/zoom/scroll and on
  another widget's camera command. It is suppressed for the widget that issued
  the command. It is advisory: the receiving widget decides whether to refetch.
- `geolocation` fires on each position fix. `accuracy` is meters.
- `geolocationError` fires on denial, timeout, or unavailability. `code` mirrors
  the browser's `PositionError` code; `message` is human-readable.

### 7.6 Ownership and event routing

- Widgets assign their own unique string IDs to drawn items. The SDK uses these
  IDs for update, remove, and events.
- A click on any widget-owned item dispatches to that widget.
- The SDK records every drawn ID per widget for cleanup (section 7.10).

### 7.7 Camera model (consolidated)

Two concepts: **pan** (one-shot) and **follow** (continuous).

**Pan.** `flyTo`, `jumpTo`, and `fitBounds` are allowed to any widget at any
time. No lease is required. The most recent command wins. If another widget
holds the follow lease, a pan from a non-owner revokes that lease and the pan
wins.

**Follow.** `requestCameraControl()` acquires the follow lease. States: `FREE`
or `LOCKED(owner)`. One owner, never two.

- **Acquire**: `requestCameraControl()` grants if `FREE`. If `LOCKED`, it
  preempts (last-request-wins): the requester becomes owner and the displaced
  owner receives `cameraRevoked` with reason `preempted`.
- **Lease**: granted for 10 seconds. Any camera command (`flyTo`, `jumpTo`, or
  `fitBounds`) from the owner renews the lease automatically. No heartbeat
  message.
- **Release — any one of six triggers reclaims the map:**
  1. widget calls `releaseCameraControl()` → reason `released`;
  2. lease TTL expires (catches a hung widget) → reason `ttl`;
  3. worker dies, disables, or uninstalls (catches a crashed widget) — no
     notification possible;
  4. the user drags, zooms, or scrolls the map → reason `userGesture`;
  5. another widget calls `requestCameraControl()` → reason `preempted`;
  6. another widget issues `flyTo`, `jumpTo`, or `fitBounds` → reason
     `preempted`.
- **UI**: a "Camera: <widget name>" badge with a manual release button while
  locked.

### 7.8 CSS styling

`anymaps.setStyles(cssText)` injects the CSS into a per-widget `<style>` element
(the main thread does the DOM work). Containers carry `anymaps-panel`,
`anymaps-popup`, and `anymaps-widget-<id>` classes. Styles inject as-is, global
scope, because widgets are trusted. `setStyles` is the only styling channel a
worker has.

### 7.9 Persistence

WidgetManager owns `localStorage`. Two key families:

- `anymaps.registry` — `[{ "widgetId": "...", "version": "...", "enabled": true }]`.
- `anymaps.state.<widgetId>` — the widget's persisted state object.

Startup reads the registry and re-enables every `enabled` widget (fetch manifest
+ bundle, provision, spawn worker with `init.state`). `anymaps.persist(partial)`
merges into `anymaps.state.<widgetId>`; the main thread writes. The worker never
touches storage. An `iid` is just a key inside state: after creating a room the
widget calls `anymaps.persist({ iid: token })`; on reload it reads
`init.state.iid`. Joining a room is the same: the widget writes a token the user
entered into `state.iid`. Possession of the token is the access boundary.

### 7.10 Lifecycle and cleanup

- One dedicated Worker per enabled widget.
- States: `installed` → `enabled` ⇄ `disabled` → `uninstalled`.
- Disable terminates the worker; enable respawns it.
- On disable or uninstall, WidgetManager removes every marker, polyline, popup,
  and the panel that widget created, then terminates the worker. No widget
  cleanup command exists.
- Persisted state survives disable (re-enable resumes the same `iid`). Uninstall
  deletes the registry entry and the state key.
- No hard resource caps at demo scale.

### 7.11 UI arbitration

- **Popups**: one open globally. Opening a new popup closes the previous,
  across widgets.
- **Panels**: one collapsible section per widget, stacked vertically in a
  shared scrollable sidebar. No overlap.
- **Z-order**: default by enable order — later-enabled widgets draw on top. No
  click-to-front for the MVP.

### 7.12 Smooth motion

Client read cadence and interpolation are the widget's own responsibility.
HTTP short-polling plus client-side interpolation between the last two polled
positions gives smooth motion. Guidance: default 5 seconds, minimum 1 second.

Flights poll the ADSB.lol cache every 5 seconds and interpolate marker positions
between polls. A selected plane's trail comes from the server series cache via
`?ids=`; the widget draws the polyline in the order the server returns it
(ascending time).

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
2. Channel fields: `id`, `origin`, `direction`, `visibility`, and the
   accumulation fields `mode` and `retain` (client write channels only).
3. Direction × origin matrix:
   - `client` + `write` — clients POST data (post location).
   - `client` + `read` — clients GET data others wrote (fetch friends).
   - `external` + `read` — clients GET the server's cache of an external
     endpoint.
   - `external` + `write` — not allowed.
4. `visibility` is `public` (one shared address, no token) or `private`
   (instance-scoped). It is per-channel and independent on read and write.
5. Accumulation. `mode` is `snapshot` (each write or poll replaces) or `series`
   (each write or poll appends). `retain` is time-based retention in seconds,
   for `series` only. Placement depends on origin:
   - **client write channel**: top-level `mode` and `retain`. Default
     `mode: "series"`, `retain: 3600`.
   - **external read channel**: `mode` and `retain` live inside the `external`
     block (section 10.1). Default `mode: "snapshot"`, `retain: 3600`.
   - **client read channel**: no accumulation fields. It inherits from its
     `source` write channel.
6. External channels add an `external` block (section 10). A channel with a
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
        "mode": "series",
        "retain": 3600,
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

The write channel `fmfW` declares the record mapping and accumulates a series
with one hour of retention. The read channel `fmfR` declares no mapping of its
own; its `source` field references `fmfW`, so it serves `fmfW`'s data through
the same filter surface. Extra fields in a posted record (for example `name` and
`icon` for the member's display name and avatar) are stored and returned whole;
they do not need their own mapping.

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
"Joining" a room means entering an existing token into the widget; there is no
separate join flow. "Leaving" a room means clearing the token from state and
stopping writes. Old token data stays in SQLite until the server restarts; no
DELETE route exists for the MVP.

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
  "record": { "records": "states", "id": "[0]", "time": "@ingestedAt", "lon": "[5]", "lat": "[6]" }
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
  `secret` is the store ID. Omit for public sources. OAuth2 client-credentials
  is out of scope for the MVP.
- `interval`: refresh seconds. Default 60, minimum 5.
- `mode`: `snapshot` (replace each poll) or `series` (append each poll). Default
  `snapshot`.
- `retain`: for `series` only, time-based retention in seconds. Default 3600.
- `record`: optional record mapping (section 11). No mapping means the whole
  body is served as-is (for small single-object sources).

**Server-stamped time.** `record.time` accepts one reserved value:
`"@ingestedAt"`. It means the server's fetch timestamp, in epoch seconds. The
server stamps every cached record internally at fetch time and uses that stamp
for the `time` index (for `since`, `until`, `latest`, and retention pruning).
The returned record is unchanged; the stamp is index-only, so the server still
never transforms data. Use `@ingestedAt` when the source provides no per-record
epoch time of its own. Anywhere `record.time` is declared, `@ingestedAt` is
valid.

### 10.2 Cache-only reads

A client read on an external channel hits only the local cache. It never
triggers an external fetch. Only the poller touches the external API. The poller
is configured at provisioning from the manifest.

### 10.3 Worked example — ADSB.lol flights (flights_nyc)

ADSB.lol is free and needs no auth. `GET /v2/point/{lat}/{lon}/{radius}` returns
aircraft within a circle, radius in nautical miles, maximum 250. The response is
`{ "ac": [ { "hex": "...", "flight": "...", "r": "...", "t": "...", "lat": ...,
"lon": ..., "alt_baro": ..., "gs": ..., "track": ... }, ... ] }`. It has no
per-record epoch timestamp, so the channel uses `@ingestedAt`.

```json
{
  "id": "flights_nyc",
  "origin": "external",
  "direction": "read",
  "visibility": "public",
  "external": {
    "method": "GET",
    "url": "https://api.adsb.lol/v2/point/40.71/-74.0/250",
    "interval": 5,
    "mode": "series",
    "retain": 3600,
    "record": { "records": "ac", "id": "hex", "lat": "lat", "lon": "lon", "time": "@ingestedAt" }
  }
}
```

The widget reads `?bounds=...&latest=1` for current planes in the viewport and
`?ids=<hex>` for one plane's trail. Available fields for the info panel:
`flight` (callsign, usually the flight number), `r` (registration), `t`
(aircraft type), `alt_baro` (altitude), `gs` (ground speed), `track` (heading,
used for marker rotation). There is no origin or destination.

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
    "body": "[out:json];node[\"amenity\"=\"toilets\"](40.47,-74.26,40.92,-73.70);out;",
    "interval": 86400,
    "mode": "snapshot",
    "record": { "records": "elements", "id": "id", "lat": "lat", "lon": "lon" }
  }
}
```

The body queries the whole 5-borough New York City box once. The cache is
broad; the widget re-reads with `?bounds=` on `viewportChanged` to show only the
visible bathrooms. Overpass returns `{ "elements": [ { "id": 123, "lat": 40.7,
"lon": -73.9, "tags": {...} }, ... ] }`. No `time` field, so this channel
supports `bounds` and `ids` filters only.

The water-fountains demo widget is structurally identical with one tag change:
`node["amenity"="drinking_water"](40.47,-74.26,40.92,-73.70);`. The wizard
resolves the exact tag by asking the user (drinking point vs decorative
fountain) at creation time.

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
proxy. Rules: https-only, and reject private and loopback IP ranges. The Agent
Service applies the same rules when it fetches a candidate source to test it.

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
  object for client write channels). All optional. `time` also accepts the
  reserved value `@ingestedAt` (section 10.1).
- A field not declared means the corresponding filter is unavailable on that
  channel.

The mapping language is JMESPath because positional arrays like some flight
sources use `[0]`-style paths that cannot be expressed with dot-paths.

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

**Composition order.** When multiple filters are present, the server applies
`latest` first (dedupe to the newest record per identity), then applies
`bounds`, `ids`, `since`, and `until` to that set. This makes "current positions
within a viewport" one call: `?bounds=...&latest=1`.

### 11.5 Accumulation

- `snapshot`: each write or poll replaces the cache. One record per entity. Good
  for current bathrooms.
- `series`: each write or poll appends. Multiple records per identity accumulate.
  Enables history and paths. Bounded by `retain` (default one hour).

`latest` dedupes a series cache to the current state. `since`/`until` slices
history. Reads on a channel with a `time` mapping return records in ascending
time order, so a widget can draw a trail by connecting points in the returned
order.

Client write channels carry top-level `mode` and `retain` (section 8.3).
External channels carry them inside the `external` block (section 10.1).

### 11.6 Worked example — filter queries

Flights channel (`flights_nyc`, series) from section 10.3:

- Current planes in a viewport: `?bounds=40.5,-74.3,40.9,-73.7&latest=1`
- One plane's full trail: `?ids=abc123`
- One plane's recent trail: `?ids=abc123&since=...`

Find My Friends channel from section 8.4:

- Current position of all friends: `?latest=1`
- History of one friend: `?ids=alice&since=...`

Overpass bathrooms from section 10.4:

- Bathrooms in bounds: `?bounds=40.5,-74.3,40.9,-73.7`

### 11.7 The line the server will not cross

The server selects subsets only: filter by identity, bounds, time, latest-per-id.
It never joins, aggregates, computes, or reshapes. Every record is returned
whole. Any aggregation a widget needs — counts, averages, projections — happens
in the client worker. The one exception is the internal `@ingestedAt` stamp,
which is index-only and never changes the returned record.

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

There is no DELETE route. Leaving a room is client-side (clear the token from
state and stop writing). Orphaned rows persist until server restart.

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

The wizard publishes through the same `POST /widgets`. When the wizard returns a
new `id + version`, the client fetches the manifest and bundle and enables the
widget automatically.

---

## 14. Out of scope for the MVP

- Heatmap (stretch).
- Routing engine (use a Google Maps link instead).
- OAuth2 client-credentials auth for external sources. This is why the demo uses
  ADSB.lol instead of OpenSky.
- Anchored popups tracking a moving marker. The flights widget shows selected
  plane info in the side panel instead.
- Dynamic server-side viewport templating. The demo uses a broad fixed cache
  plus a client `bounds` filter.
- Pagination, cursor and Link-header variants.
- WebSocket transport.
- Per-widget server isolation — one generic server covers all widgets.
- Membership lists or ACLs beyond capability tokens.
- Private external caches (external channels are public-read only).
- Deleting instances or widget versions.

---

## 15. Build approach (guidance, not spec)

The historical failure mode is people waiting on interfaces and people inventing
interfaces separately. Fix both with one move: freeze the shape first.

### 15.1 Freeze contracts first (hour 0–2, together)

`CONTRACTS.md` is written and is the build target. Review it together in hour
0–2, then no signature changes without a 30-second group sync.

### 15.2 Three columns, one owner each

- **Column A — Client + SDK.** WidgetManager, worker lifecycle, MapLibre
  integration, camera lease, geolocation proxy, event routing. Owns the render
  contract. First deliverable: a mock SDK that answers the frozen signatures,
  then the real one.
- **Column B — Server + Registry.** FastAPI + SQLite, channels, poller, filter,
  secrets, publish and install. Owns the wire contract.
- **Column C — Widgets, wizard, and demo.** The three demo widgets, the gallery
  and install UI, the wizard panel, the second-user demo. Owns the data-config
  contract with B.

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
   → install → run demo. Simulate the second user in a second browser. Build the
   wizard: prompt, clarify, test source, generate, publish, auto-install.
4. **Hour 14–16** — rehearse, cut.

---

## 16. Glossary

- **Widget** — a self-contained map extension: manifest + JS bundle.
- **SDK** — the typed command/event boundary between widgets and the Map Client.
- **WidgetManager** — main-thread runtime that owns registry, workers, events,
  map, DOM, geolocation, and the camera lease.
- **Generic Widget Server** — the single, dumb, config-driven backend.
- **Agent Service** — the second Compose service that generates widgets from a
  prompt and publishes them.
- **Wizard panel** — the built-in client chat UI that talks to the Agent Service.
- **Registry** — the store and gallery for published widgets, inside the server.
- **Channel** — one endpoint, one direction, one handler.
- **Instance** — a room token scoping private channel data; possession = access.
- **External channel** — server fetches an outside source, caches, serves reads.
- **Client channel** — clients write; clients read what was written.
- **Record mapping** — the declared JMESPath locations of id, lat, lon, time.
- **Snapshot** — cache replaces each write or poll.
- **Series** — cache appends each write or poll, bounded by retention.
- **Camera lease** — time-boxed, auto-releasing follow control.
- **Pan** — a one-shot camera move (`flyTo`, `jumpTo`, `fitBounds`), no lease.
- **Follow** — continuous camera centering under the lease.
- **`@ingestedAt`** — the reserved `record.time` value for the server's fetch
  timestamp.
