# anymaps client (Column A)

Vite + vanilla JS. No TypeScript (PLAN.md hour-0 decision).

## Run

```sh
npm install
npm run dev   # http://localhost:5173
```

`localhost` is a secure context, so browser geolocation works.

## Structure

- `src/sdk/anymaps.js` — the SDK runtime, prepended to widget bundles.
- `src/manager.js` — WidgetManager.
- `src/camera.js` — camera lease.
- `src/geo.js` — geolocation proxy.
- `src/main.js` — bootstrap. The direct MapLibre calls here are hello-world
  placeholders and get replaced by the WidgetManager.

The client talks to the generic server at `http://localhost:8000` and the
Agent Service at `http://localhost:8001`. CORS must allow `http://localhost:5173`.

## Tests

```sh
npm test   # node --test "tests/**/*.test.js"
```

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

### Room-token flow

Each widget instance joins a room it creates itself. On boot, read
`state.iid`; if it is missing, create the room and persist the token:

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
`/instances/{token}` to private channel routes before fetching.

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

### Events

Register with `anymaps.on(name, handler)`, remove with
`anymaps.off(name, handler)`. `on` returns an unsubscribe function. Handler
exceptions are caught and never crash the widget.

| event | payload fields |
|-------|----------------|
| `markerClick` | `markerId`* — fired only for the owning widget |
| `mapClick` | `lat`*, `lng`* |
| `cameraGranted` | — |
| `cameraRevoked` | `reason`* — `ttl` \| `userGesture` \| `released` \| `preempted` |
| `viewportChanged` | `bounds`*, `center`*, `zoom`* — advisory, debounced on move-end |
| `geolocation` | `lat`*, `lng`*, `accuracy`? (meters) |
| `geolocationError` | `code`*, `message`* |

`viewportChanged` is suppressed for the widget that issued the camera command.
Decide inside the handler whether to refetch.

### Interpolation

For moving data (vehicles, couriers, friends), the widget owns smoothing:
poll its channel at a fixed interval, then interpolate positions between
fixes on a timer (for example, `requestAnimationFrame` or `setInterval`),
calling `updateMarker` each frame. The server stores last-known positions
only. Do not wait for the server to animate.

### Complete example widget

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
  anymaps.on("viewportChanged", ({ bounds }) => refetch(bounds));
  anymaps.startGeolocation({ highAccuracy: true });
  anymaps.on("geolocation", ({ lat, lng }) => postLocation(iid, lat, lng));
  anymaps.on("markerClick", ({ markerId }) =>
    anymaps.setPanel({ title: "Friend", content: `<p>${markerId}</p>` }));

  async function refetch(bounds) {
    const res = await fetch(
      `${config.channelRoutes.fmfR}/instances/${iid}?bounds=${bounds}`);
    const friends = await res.json();
    for (const f of friends) {
      anymaps.addMarker({ id: f.id, lat: f.lat, lng: f.lng,
                          icon: "🧑", color: "#0066ff" });
    }
  }
  async function postLocation(iid, lat, lng) {
    await fetch(`${config.channelRoutes.fmfW}/instances/${iid}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lat, lng }),
    });
  }
})();
```

See `CONTRACTS.md` sections 2–6 for the wire format and `SPEC.md` section 7
for the execution model.
