# anymaps client (Column A)

Vite + vanilla JS. No TypeScript (PLAN.md hour-0 decision).

## Run

```sh
npm install
npm run dev   # http://localhost:5173
```

`localhost` is a secure context, so browser geolocation works.

## Environment

Set the base server URL with the `VITE_SERVER_URL` environment variable.
Copy `.env.example` to `.env` (or `.env.local`) and adjust it:

```sh
cp .env.example .env
```

```dotenv
VITE_SERVER_URL=http://localhost:8000
```

Vite reads `.env` files at dev and build time. The default is
`http://localhost:8000` when the variable is unset.

Runtime overrides win over the environment variable, in order:

1. `window.__ANYMAPS_CONFIG__.baseUrl`
2. `localStorage["anymaps.baseUrl"]`

## Structure

- `src/sdk/anymaps.js` — the SDK runtime, prepended to widget bundles.
- `src/manager.js` — WidgetManager.
- `src/camera.js` — camera lease.
- `src/geo.js` — geolocation proxy.
- `src/main.js` — bootstrap. The direct MapLibre calls here are hello-world
  placeholders and get replaced by the WidgetManager.

The client talks to the generic server at the `VITE_SERVER_URL` base URL
(default `http://localhost:8000`) and the Agent Service at
`http://localhost:8001`. CORS must allow `http://localhost:5173`.

## Tests

```sh
npm test   # node --test "tests/**/*.test.js"
```

## Contract verification checklist

`checklist.html` is a standalone page that builds its own manager and runs
the full CONTRACTS.md coverage as check groups (sdk, render, events, camera,
geo, lifecycle, gallery, wizard, persistence, three-widgets-at-once). It points
at the dev mock server for gallery and wizard flows.

```sh
npm run mock                    # dev mock server on :8000
npm run dev                     # vite, then open the URL below
```

Open `/checklist.html?auto=1` to auto-run every group. Phase 1 enables a
persist widget and reloads into `?auto=1&phase=2` to verify state survival
across a real re-enable cycle. Both phases must end with every check green.
Click `Run checks` to run manually without the reload.

## Widget authoring guide

A widget is a JavaScript bundle that runs in a Web Worker. The worker has no
DOM, no map, no `window`, no `localStorage`, no `navigator.geolocation`. A
bundle never touches the DOM, the map, `window`, or storage. Everything
crosses the SDK boundary through the global `anymaps` object, which the
WidgetManager prepends to the bundle before the worker starts.

### Bundle skeleton

The runtime is prepended as raw text, so the bundle is a classic script: no
`import` or `export` statements. Top-level `await` inside an async IIFE:

```js
// widget bundle — classic script, the anymaps runtime is already above you
(async () => {
  const { config, state } = await anymaps.ready();
  // ... your widget code ...
})();
```

### Bootstrap

`anymaps.ready()` resolves once the WidgetManager sends the init message. It
resolves with `{ config, state }`:

- `config.widgetId` — the installed widget's ID.
- `config.baseUrl` — the server origin for direct `fetch` calls.
- `config.channelRoutes` — channel ID → route prefix.
- `state` — the persisted state object, `{}` on first run.

### Channels, the manifest, and the server

Your manifest is the widget author's own: it declares the server channels and
defines how your bundle talks to the server. `config.channelRoutes` gives you
one route prefix per channel, keyed by the channel `id` declared in the
manifest. Build your requests on those routes.

Channel kinds (from the manifest's direction × origin matrix):

- `client` + `write` — your bundle POSTs records to the route.
- `client` + `read` — your bundle GETs records others wrote; the manifest's
  `source` field references the write channel, and the read serves that
  channel's data through the same filter surface.
- `external` + `read` — your bundle GETs the server's cache of an external
  source. Public-read only (SPEC decision 20): no token, no client writes, and
  reads never trigger a live fetch — they are cache-only (SPEC 10.2); only the
  server's poller touches the external API.

Each channel has a `visibility`, decided by you in the manifest:

- `public` — one shared address. Use the route as-is: no token, no room.
- `private` — instance-scoped. Create a room once with
  `POST /widgets/{id}/instances`, persist the token into `state.iid`, and
  append `/instances/{token}` to that channel's route only (CONTRACTS §3,
  SPEC 9.2–9.4). Possession of the token is the whole access boundary; an
  unknown token returns 404.

A widget whose channels are all public never creates a room and never uses a
token.

Read filters (query params on GETs, per CONTRACTS §9 and SPEC 11.4–11.6):

- `bounds=south,west,north,east` — geo box, needs a `lat`/`lon` mapping.
- `ids=a,b` — comma-separated identity list, needs an `id` mapping.
- `since` / `until` — unix seconds, needs a `time` mapping.
- `latest=1` — most recent record per identity, needs `id` + `time`.

Composition order: the server applies `latest` first, then `bounds`, `ids`,
`since`, and `until`. Current positions in a viewport is one call:
`?bounds=...&latest=1`.

#### Private-channel pattern (room token)

For a widget with a private channel, create the room on first boot and reuse
the persisted token after that:

```js
let iid = state.iid;
if (!iid) {
  iid = (await (await fetch(
    `${config.baseUrl}/widgets/${config.widgetId}/instances`,
    { method: "POST" },
  )).json()).instanceToken;
  anymaps.persist({ iid });
}
```

The token is available on the next boot via `state.iid`. Append
`/instances/{token}` to each private channel's route before fetching.

### Commands

All commands are fire and forget. Coordinates use `[lat, lng]` order; the SDK
and map handle the MapLibre `[lng, lat]` translation. `zoom` is 0–22,
`bearing` is degrees 0–360.

| command | payload fields |
|---------|----------------|
| `anymaps.addMarker(payload)` | `id`*, `lat`*, `lng`*, `icon`?, `color`?, `label`?, `title`?, `rotation`? |
| `anymaps.updateMarker(payload)` | `id`*, then any changed fields |
| `anymaps.removeMarker(id)` | `id`* |
| `anymaps.addPolyline(payload)` | `id`*, `points`* `[[lat,lng],...]`, `color`?, `width`? |
| `anymaps.updatePolyline(payload)` | `id`*, `points`? (replace) or `append`?, `color`?, `width`? |
| `anymaps.removePolyline(id)` | `id`* |
| `anymaps.openPopup(payload)` | `id`*, `content`*, and (`lat`* + `lng`*) or `anchorMarkerId`* |
| `anymaps.closePopup(id)` | `id`* |
| `anymaps.setPopupContent(payload)` | `id`*, `content`* |
| `anymaps.setPanel(payload)` | `title`?, `content`* — one panel per widget |
| `anymaps.clearPanel()` | — |
| `anymaps.setStyles(cssText)` | CSS text, injected into a per-widget `<style>` |
| `anymaps.persist(partial)` | a partial state object, deep-merged into state |
| `anymaps.requestCameraControl()` | — ; acquires the follow lease, preempts the holder |
| `anymaps.releaseCameraControl()` | — |
| `anymaps.flyTo(payload)` | `center`* `[lat,lng]`, `zoom`?, `bearing`? — animated |
| `anymaps.jumpTo(payload)` | `center`* `[lat,lng]`, `zoom`?, `bearing`? — instant |
| `anymaps.fitBounds(payload)` | `bounds`* `[[south,west],[north,east]]` |
| `anymaps.startGeolocation(payload)` | `highAccuracy`? (boolean) |
| `anymaps.stopGeolocation()` | — |

`*` = required. The runtime does no payload validation; the manager validates
and answers malformed commands with an error event. `flyTo`, `jumpTo`, and
`fitBounds` need no camera lease; the most recent command wins.

### Styling and dark mode

`setStyles` injects CSS globally, so a widget can target the shell theme. The
client sets `data-theme="light"` or `data-theme="dark"` on `<html>`. Author
widget CSS with `[data-theme="dark"]` selectors to opt into dark mode:

```css
.my-card { color: #1e293b; }
[data-theme="dark"] .my-card { color: #e2e8f0; }
```

The client themes its own chrome only. It never restyles widget content, so a
widget that wants dark colors must provide its own dark selectors.

### Events

Register with `anymaps.on(name, handler)`, remove with
`anymaps.off(name, handler)`. `on` returns an unsubscribe function. Handler
exceptions are caught and never crash the widget.

| event | payload fields |
|-------|----------------|
| `markerClick` | `markerId`* — fired only for the owning widget |
| `mapClick` | `lat`*, `lng`* |
| `cameraGranted` | — |
| `cameraDenied` | — |
| `cameraRevoked` | `reason`* — `ttl` \| `userGesture` \| `released` \| `preempted` |
| `viewportChanged` | `bounds`*, `center`*, `zoom`* — advisory, debounced on move-end |
| `geolocation` | `lat`*, `lng`*, `accuracy`? (meters) |
| `geolocationError` | `code`*, `message`* |

`cameraDenied` is reserved for a future strict-leasing mode; it is never fired
under preemption and is kept for protocol completeness.

`viewportChanged` is suppressed for the widget that issued the camera command.
Decide inside the handler whether to refetch.

### Interpolation

For moving data (vehicles, couriers, friends), the widget owns smoothing:
poll its channel at a fixed interval, then interpolate positions between
fixes on a timer (for example, `requestAnimationFrame` or `setInterval`),
calling `updateMarker` each frame. The server stores last-known positions
only. Do not wait for the server to animate.

### Complete example widget — private channels

Find-my-friends shape: `fmfW` is a private client write channel, `fmfR` is a
private client read channel with `source: "fmfW"`. Room token appended to
both routes.

```js
// friends-nearby bundle — classic script, runtime prepended above
(async () => {
  const { config, state } = await anymaps.ready();
  let iid = state.iid;
  if (!iid) {
    iid = (await (await fetch(
      `${config.baseUrl}/widgets/${config.widgetId}/instances`,
      { method: "POST" },
    )).json()).instanceToken;
    anymaps.persist({ iid });
  }
  // Each client persists its own friend identity. Every room member shares
  // the token, so the id must be per-client (SPEC 9.4) or latest=1 collapses
  // the whole room into one marker.
  let cid = state.cid;
  if (!cid) {
    cid = crypto.randomUUID().slice(0, 8);
    anymaps.persist({ cid });
  }
  anymaps.on("viewportChanged", ({ bounds }) => refetch(bounds));
  anymaps.startGeolocation({ highAccuracy: true });
  anymaps.on("geolocation", ({ lat, lng }) => postLocation(iid, lat, lng));
  anymaps.on("markerClick", ({ markerId }) =>
    anymaps.setPanel({ title: "Friend", content: `<p>${markerId}</p>` }));

  async function refetch(bounds) {
    const res = await fetch(
      `${config.channelRoutes.fmfR}/instances/${iid}?bounds=${bounds}&latest=1`);
    const { records } = await res.json();
    for (const f of records) {
      anymaps.addMarker({ id: f.clientId, lat: f.lat, lng: f.lng,
                          icon: "🧑", color: "#0066ff" });
    }
  }
  async function postLocation(iid, lat, lng) {
    await fetch(`${config.channelRoutes.fmfW}/instances/${iid}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: cid,
        lat, lng,
        ts: Math.floor(Date.now() / 1000), // unix seconds (CONTRACTS 13)
      }),
    });
  }
})();
```

### Counterexample — public external-read channel

A bathrooms-style widget with one `external` + `read` channel (`bathrooms`,
public) needs no room and no token. It GETs the route with filters and draws
markers from the returned cache records:

```js
// public-bathrooms bundle — classic script, runtime prepended above
(async () => {
  const { config } = await anymaps.ready();
  anymaps.on("viewportChanged", ({ bounds }) => refetch(bounds));

  async function refetch(bounds) {
    const res = await fetch(
      `${config.channelRoutes.bathrooms}?bounds=${bounds}`);
    const { records } = await res.json();
    for (const b of records) {
      anymaps.addMarker({ id: b.id, lat: b.lat, lng: b.lon, icon: "🚻" }); // GeoJSON: lon
    }
  }
})();
```

See `CONTRACTS.md` sections 2–6, 7 (manifest schema), 8 (HTTP API), and 9
(filter parameters) for the wire contract, and `SPEC.md` sections 7 (the
SDK), 8 (the manifest and channel model), 10 (external fetching), and 11
(filtering and caching) for the execution model, channel rules, the external
block, record mappings, and why some channels lack filters.
