# CONTRACTS.md — anymaps build contract

Authoritative wire contract. Build against this file. `SPEC.md` explains why;
this file defines what. A field marked `?` is optional.

---

## 1. Protocol version

`protocolVersion` is `1`. A widget bundle whose version does not match is
rejected by the WidgetManager with a clear error.

---

## 2. Message envelope

Every `postMessage` payload is a discriminated object:

```json
{ "v": 1, "kind": "cmd", "id": "c1", "name": "addMarker", "payload": { } }
{ "v": 1, "kind": "event", "name": "markerClick", "payload": { "markerId": "m1" } }
{ "v": 1, "kind": "error", "id": "c1", "error": "marker missing position" }
```

- `kind`: `init` | `cmd` | `event` | `error`.
- `cmd` (widget → map): carries a widget-chosen `id` and a `name`. Fire and
  forget; there is no success acknowledgement.
- `event` (map → widget): carries a `name`. No `id`.
- `error` (map → widget): echoes the `id` of the command that failed and a
  human-readable `error` string. Errors never crash the widget.
- `v` is always `1`.

---

## 3. Init message

Sent by the WidgetManager to the worker exactly once, after provisioning.

```json
{
  "v": 1,
  "kind": "init",
  "protocolVersion": 1,
  "widgetId": "find-my-friends",
  "baseUrl": "https://server.example",
  "channelRoutes": { "fmfW": "https://server.example/widgets/find-my-friends/channels/fmfW", "fmfR": "https://server.example/widgets/find-my-friends/channels/fmfR" },
  "state": { "iid": "x" }
}
```

- `channelRoutes`: channel ID → full route prefix. The worker appends
  `/instances/{token}` for private channels once it has a token.
- `state`: the persisted state object from `localStorage`. `{}` on first run.
- `baseUrl`: the server origin, for the widget to build `POST .../instances` and
  other calls.

---

## 4. Commands (widget → map)

| name | payload fields | notes |
|------|----------------|-------|
| `addMarker` | `id`*, `lat`*, `lng`*, `icon`?, `color`?, `label`?, `title`?, `rotation`? | `icon` is an emoji or image URL; `rotation` is degrees 0–360 clockwise from north, default 0 |
| `updateMarker` | `id`*, then any of `lat`, `lng`, `icon`, `color`, `label`, `title`, `rotation` | only changed fields |
| `removeMarker` | `id`* | |
| `addPolyline` | `id`*, `points`*, `color`?, `width`? | `points` = `[[lat,lng],...]` |
| `updatePolyline` | `id`*, `points`? or `append`?, `color`?, `width`? | `points` replaces; `append` adds to the end |
| `removePolyline` | `id`* | |
| `openPopup` | `id`*, `content`*, and (`lat`* + `lng`*) or `anchorMarkerId`* | standalone or anchored |
| `closePopup` | `id`* | |
| `setPopupContent` | `id`*, `content`* | |
| `setPanel` | `title`?, `content`* | one panel per widget |
| `clearPanel` | — | |
| `setStyles` | `cssText`* | injected into a per-widget `<style>` |
| `persist` | a partial state object | merged into the widget's state key |
| `requestCameraControl` | — | acquire the follow lease; preempts the holder |
| `releaseCameraControl` | — | |
| `flyTo` | `center`* `[lat,lng]`, `zoom`?, `bearing`? | animated; no lease needed |
| `jumpTo` | `center`* `[lat,lng]`, `zoom`?, `bearing`? | instant, no animation; no lease needed |
| `fitBounds` | `bounds`* `[[south,west],[north,east]]` | no lease needed |
| `startGeolocation` | `highAccuracy`? (boolean) | main thread begins `watchPosition` |
| `stopGeolocation` | — | main thread ends the watch |

`*` = required.

---

## 5. Events (map → widget)

| name | payload fields | notes |
|------|----------------|-------|
| `markerClick` | `markerId`* | fired only for the owning widget |
| `mapClick` | `lat`*, `lng`* | |
| `cameraGranted` | — | follow lease acquired |
| `cameraDenied` | — | never fired under preemption; kept for protocol completeness |
| `cameraRevoked` | `reason`* | `ttl` \| `userGesture` \| `released` \| `preempted` |
| `viewportChanged` | `bounds`*, `center`*, `zoom`* | see below |
| `geolocation` | `lat`*, `lng`*, `accuracy`? | each position fix; `accuracy` in meters |
| `geolocationError` | `code`*, `message`* | denial, timeout, or unavailability |

`cameraDenied` is reserved for a future strict-leasing mode. Under the current
last-request-wins model, a control request always preempts, so the requester
gets `cameraGranted` and the displaced holder gets `cameraRevoked` with reason
`preempted`.

`viewportChanged` fires debounced on move-end (MapLibre `moveend`), on user
drag/zoom/scroll and on another widget's camera command. It is suppressed for
the widget that issued the command. It is advisory; the receiving widget decides
whether to refetch.

```json
{ "name": "viewportChanged", "payload": { "bounds": [[40.5, -74.3], [40.9, -73.7]], "center": [40.71, -74.0], "zoom": 12 } }
```

---

## 6. The `anymaps` library

WidgetManager prepends the `anymaps` runtime to the bundle before creating the
worker, so `anymaps` is a global inside the worker. The bundle registers
handlers and reads config after `anymaps.ready()`.

```js
anymaps.ready()                        // → Promise<{ config, state }>, resolves after init
anymaps.config                         // { widgetId, baseUrl, channelRoutes }
anymaps.state                          // persisted state object ({} first run)

anymaps.addMarker(payload)
anymaps.updateMarker(payload)
anymaps.removeMarker(id)
anymaps.addPolyline(payload)
anymaps.updatePolyline(payload)
anymaps.removePolyline(id)
anymaps.openPopup(payload)
anymaps.closePopup(id)
anymaps.setPopupContent({ id, content })
anymaps.setPanel({ title, content })
anymaps.clearPanel()
anymaps.setStyles(cssText)
anymaps.persist(partialState)          // deep-merged into state, persisted by main thread
anymaps.requestCameraControl()
anymaps.releaseCameraControl()
anymaps.flyTo({ center, zoom, bearing })
anymaps.jumpTo({ center, zoom, bearing })
anymaps.fitBounds({ bounds })
anymaps.startGeolocation({ highAccuracy })
anymaps.stopGeolocation()

anymaps.on(eventName, handler)         // eventName from section 5
anymaps.off(eventName, handler)
```

The library assigns a unique `id` to every command it sends and routes incoming
`event` and `error` messages to the right handlers.

Example widget bootstrap:

```js
const { config, state } = await anymaps.ready();
let iid = state.iid;
if (!iid) {
  iid = (await (await fetch(`${config.baseUrl}/widgets/${config.widgetId}/instances`, { method: "POST" })).json()).instanceToken;
  anymaps.persist({ iid });
}
anymaps.on("viewportChanged", ({ bounds }) => refetch(bounds));
anymaps.startGeolocation({ highAccuracy: true });
anymaps.on("geolocation", ({ lat, lng }) => postLocation(iid, lat, lng));
```

---

## 7. Manifest JSON schema

One manifest, two top-level sections: identity and server. Validated at publish;
invalid manifests are rejected.

```json
{
  "id": "find-my-friends",
  "name": "Find My Friends",
  "version": "0.1.0",
  "description": "Share live locations with friends",
  "icon": "https://cdn.discordapp.com/.../icon.png",
  "server": { "channels": [ ] }
}
```

Identity: `id` (unique slug), `name`, `version` (semver), `description`, optional
`icon` (URL string; the server does not host icons), `server`.

### 7.1 Channel object

| field | values | notes |
|-------|--------|-------|
| `id` | string | unique within the widget |
| `origin` | `client` \| `external` | |
| `direction` | `write` \| `read` | one channel = one handler |
| `visibility` | `public` \| `private` | private = instance-scoped |
| `source` | string | client read channels only: the write channel id |
| `record` | object | optional record mapping (section 7.2) |
| `external` | object | external read channels only (section 7.3) |
| `mode` | `snapshot` \| `series` | client write channels only. Default `series` |
| `retain` | seconds | client write channels only, `series` only. Default 3600 |

Direction × origin matrix:

- `client` + `write`: clients POST records.
- `client` + `read`: clients GET records; `source` references the write channel.
- `external` + `read`: clients GET the poller's cache; `external` block required.
- `external` + `write`: not allowed.

Accumulation placement:

- Client write channel: top-level `mode` and `retain` (default `series`, 3600).
- External read channel: `mode` and `retain` inside the `external` block
  (default `snapshot`, 3600).
- Client read channel: no accumulation fields; it inherits via `source`.

### 7.2 Record mapping

Declared where records are produced — on an external read channel or a client
write channel. A client read channel declares no mapping; it inherits via
`source`.

```json
"record": { "records": "states", "id": "[0]", "time": "@ingestedAt", "lon": "[5]", "lat": "[6]" }
```

| field | meaning |
|-------|---------|
| `records` | JMESPath to the array. External channels only. |
| `id` | JMESPath within each element. Optional. Enables `ids` and `latest`. |
| `lat` | JMESPath within each element. Optional. Enables `bounds`. |
| `lon` | JMESPath within each element. Optional. Enables `bounds`. |
| `time` | JMESPath within each element, or the reserved value `@ingestedAt`. Optional. Enables `since`/`until` and `latest`. |

`"@ingestedAt"` is reserved. It means the server's fetch timestamp, in epoch
seconds. The server stamps every cached record internally at fetch time and uses
that stamp for the `time` index. The returned record is unchanged.

For client write channels there is no `records` array; the paths apply within
the single posted object. A channel with no `record` serves the whole body
unfiltered (for small sources). A field not declared means its filter is
unavailable on that channel.

### 7.3 External block

```json
"external": {
  "method": "GET",
  "url": "https://api.adsb.lol/v2/point/40.71/-74.0/250",
  "query": { "lamin": "40.0" },
  "headers": { "Accept": "application/json" },
  "body": "raw string",
  "auth": { "type": "header", "name": "Authorization", "scheme": "Bearer", "secret": "github-token" },
  "interval": 60,
  "mode": "snapshot",
  "retain": 3600,
  "record": { "records": "ac", "id": "hex", "time": "@ingestedAt", "lon": "lon", "lat": "lat" }
}
```

| field | values / default | notes |
|-------|------------------|-------|
| `method` | `GET` (default) \| `POST` | |
| `url` | string | |
| `query` | map of static strings | secrets never appear here |
| `headers` | map of static strings | secrets never appear here |
| `body` | string \| object | string sent raw; object sent as JSON. POST only |
| `auth` | `{ type, name, scheme?, secret }` | `type` = `header` \| `query`. `scheme` = optional `Bearer ` prefix. Omit for public sources |
| `interval` | seconds, default 60, min 5 | |
| `mode` | `snapshot` (default) \| `series` | |
| `retain` | seconds, default 3600 | `series` only |
| `record` | object (section 7.2) | optional; no mapping = whole body served |

`record.time` accepts `"@ingestedAt"` (section 7.2). OAuth2 client-credentials
auth is out of scope for the MVP. Pagination is not supported (single request
per channel).

---

## 8. HTTP API

Base: the server origin. All responses are JSON except the bundle (text).

| route | method | request | response |
|-------|--------|---------|----------|
| `/widgets` | POST | `{ "manifest": {...}, "bundle": "<js source>" }` | `201 { "id", "version" }` |
| `/widgets` | GET | — | `[ { "id", "name", "version", "description", "icon" } ]` |
| `/widgets/{id}/versions/{version}/manifest` | GET | — | manifest object |
| `/widgets/{id}/versions/{version}/bundle` | GET | — | JS source, `text/javascript` |
| `/widgets/{id}/provision` | POST | `{ "manifest": {...} }` | `200 { "channelRoutes": { "<id>": "<url>" } }` |
| `/widgets/{id}/instances` | POST | — | `201 { "instanceToken": "<32 hex>" }` |
| `/widgets/{id}/channels/{ch}` | POST | record object (client write) | `201` |
| `/widgets/{id}/channels/{ch}` | GET | filter params (section 9) | `200 { "records": [...] }` |
| `/widgets/{id}/channels/{ch}/instances/{token}` | POST | record object (private write) | `201` |
| `/widgets/{id}/channels/{ch}/instances/{token}` | GET | filter params | `200 { "records": [...] }` |
| `/secrets` | POST | `{ "value": "<secret>" }` | `201 { "secretId": "<id>" }` |

Rules:

- Provisioning is idempotent. The same widget gets the same routes every time.
- A private read/write requires a valid token. An unknown token returns `404`
  so a private instance's existence is not leaked.
- Client reads on external channels hit only the cache; they never trigger a
  fetch. Only the poller touches the external API.
- Publish with an existing `id + version` returns `409`.
- The server sets CORS to allow the app origin.
- There is no DELETE route. Leaving a room is client-side.

### 8.1 Record write body

For a client write channel, the POST body is the record object. The server
indexes it per the channel's record mapping and stores the full object. Extra
fields beyond `id`, `lat`, `lon`, and `time` (for example `name` and `icon`) are
stored and returned whole.

### 8.2 Read response

```json
{ "records": [ { "clientId": "alice", "lat": 40.71, "lng": -74.0, "ts": 1700000000 } ] }
```

Each element is the full stored record (the posted object, or the full external
element). The server returns records whole; it never projects fields. On a
channel with a `time` mapping, records are returned in ascending time order.

---

## 9. Filter parameters

Query params on read GET requests.

| param | value | requires mapping |
|-------|-------|------------------|
| `bounds` | `south,west,north,east` (four floats) | `lat` + `lon` |
| `ids` | comma-separated list | `id` |
| `since` | unix seconds | `time` |
| `until` | unix seconds | `time` |
| `latest` | `1` | `id` + `time` |

`latest=1` returns the most recent record per identity. `bounds` is
`south,west,north,east` = `lat,lng,lat,lng`. A filter against an undeclared
field returns `400`.

**Composition order.** When multiple filters are present, the server applies
`latest` first (dedupe to the newest record per identity), then applies
`bounds`, `ids`, `since`, and `until` to that set. Example: current planes in a
viewport is `?bounds=40.5,-74.3,40.9,-73.7&latest=1`.

---

## 10. Persistence (localStorage, main thread)

| key | shape |
|-----|-------|
| `anymaps.registry` | `[{ "widgetId": "...", "version": "...", "enabled": true }]` |
| `anymaps.state.<widgetId>` | arbitrary JSON object (the widget's persisted state) |

- The worker never touches storage. `anymaps.persist(partial)` sends a command;
  the main thread deep-merges and writes.
- On startup the WidgetManager re-enables every `enabled` widget and passes its
  state via `init.state`.
- Disable keeps state. Uninstall deletes the registry entry and the state key.

---

## 11. Camera lease rules

Two concepts: **pan** and **follow**.

**Pan.** `flyTo`, `jumpTo`, and `fitBounds` are allowed to any widget at any
time. No lease is required. The most recent command wins. If another widget
holds the follow lease, a pan from a non-owner revokes that lease with reason
`preempted` and the pan wins.

**Follow.** `requestCameraControl()` acquires the follow lease. States: `FREE`
or `LOCKED(owner)`. One owner, never two.

- Acquire: granted if `FREE`. If `LOCKED`, it preempts (last-request-wins): the
  requester becomes owner and the displaced owner gets `cameraRevoked` reason
  `preempted`.
- Lease: TTL 10 seconds. Any camera command from the owner (`flyTo`, `jumpTo`,
  or `fitBounds`) renews it. No heartbeat.
- Revocation, any one of six triggers, owner gets `cameraRevoked` with reason:
  1. `releaseCameraControl()` → `released`
  2. TTL expiry → `ttl`
  3. worker death / disable / uninstall → no notification possible
  4. user map gesture (drag/zoom/scroll) → `userGesture`
  5. another widget's `requestCameraControl()` → `preempted`
  6. another widget's `flyTo` / `jumpTo` / `fitBounds` → `preempted`
- UI: a "Camera: <widget name>" badge with a manual release button while locked.

---

## 12. UI arbitration

- **Popups**: one open globally. Opening a new popup closes the previous,
  across widgets.
- **Panels**: one collapsible section per widget, stacked vertically in a shared
  scrollable sidebar.
- **Z-order**: default by enable order; later-enabled widgets draw on top. No
  click-to-front in the MVP.
- **CSS**: containers carry `anymaps-panel`, `anymaps-popup`, and
  `anymaps-widget-<id>` classes. Styles inject via `setStyles`, global scope.
- **User location dot**: WidgetManager draws and updates a native dot while a
  geolocation watch is active. It is not a widget marker.

---

## 13. Units and coordinate order

- Coordinates: the SDK uses `lat` and `lng` (degrees). MapLibre is `[lng, lat]`
  internally; the SDK translates. `bounds` strings are `south,west,north,east`.
- Time: unix seconds. `@ingestedAt` is the server's fetch timestamp, epoch
  seconds.
- `zoom`: integer 0–22. `bearing`: degrees 0–360. `color`: hex or CSS color.
  `width`: number, pixels.
- `rotation`: degrees 0–360, clockwise from north.
- `accuracy` (geolocation): meters.

---

## 14. Error responses

JSON body `{ "error": "message" }`.

| code | meaning |
|------|---------|
| `400` | malformed body, invalid filter, undeclared filter field |
| `404` | unknown channel, token, or instance (private token unknown → `404`) |
| `409` | `id + version` already published |
| `500` | server error |

Errors never crash a widget. An invalid render command returns an `error`
message on the SDK channel, not an exception.
