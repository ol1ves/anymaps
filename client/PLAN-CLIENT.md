# Column A Implementation Plan — Map Client + SDK

> **For agentic workers:** Each task below is extracted into a brief by the
> orchestrator (`task-brief`). Read your brief. Implement exactly what it
> says. The Line: decide only implementation detail, internal naming,
> formatting. Ask up for anything else. When in doubt, ask the orchestrator.

**Goal:** Build the full Map Client and `anymaps` SDK per CONTRACTS.md
sections 2–13 and 15, so the three demo widgets and the wizard run against it.

**Reading rule (bind every task):** each task's "Spec/contract requirements"
list names exact CONTRACTS.md and SPEC.md sections. Workers and reviewers
read those sections from the repo checkout before starting — the files are
the authority, the brief only points at them. The repo checkout always
contains CONTRACTS.md and SPEC.md at the root.

**Architecture:** Vite + vanilla JS, no TypeScript, no new npm dependencies.
One Web Worker per enabled widget runs the widget bundle with the `anymaps`
runtime prepended. The WidgetManager (main thread) owns the MapLibre map, all
DOM outside the map, worker lifecycle, event routing, geolocation, and the
camera lease. Widgets speak only through the SDK.

**Tech stack:** Vite 7, MapLibre GL JS 5, Node built-in `node:test` runner,
Playwright MCP for orchestrator browser verification, plain ES modules.

## Global Constraints

Every task inherits these. They bind every file a worker touches.

1. Envelope: every `postMessage` payload is `{ v: 1, kind, ... }` with `kind`
   in `init | cmd | event | error`. `cmd` carries a widget-chosen `id`, a
   `name`, and a `payload`. `event` carries `name` and `payload`, no `id`.
   `error` echoes the failed command's `id` (omit for bootstrap errors) and a
   human-readable `error` string. Errors never crash the widget.
2. Coordinates: the SDK uses `lat` and `lng` (degrees) everywhere. MapLibre
   wants `[lng, lat]`. Translate at the boundary only, never in widget code.
   `bounds` in SDK space is `[[south, west], [north, east]]`.
3. A worker has no DOM, map, storage, or geolocation access. The main thread
   does all DOM and map work. Workers fetch their own data with native
   `fetch`. The main thread never proxies HTTP.
4. `protocolVersion` is `1`. A bundle whose protocol the runtime does not
   support is rejected with a clear error and no working widget.
5. Init message, posted exactly once after provisioning:
   `{ v:1, kind:"init", protocolVersion:1, widgetId, baseUrl, channelRoutes, state }`.
   `channelRoutes` maps channel ID to full route prefix URL. The worker
   appends `/instances/{token}` for private channels. `state` is the persisted
   object, `{}` on first run.
6. Command payloads per CONTRACTS.md section 4 table, exact field names:
   - `addMarker`: `id`*, `lat`*, `lng`*, `icon`?, `color`?, `label`?,
     `title`?, `rotation`? (degrees 0–360 clockwise from north, default 0).
   - `updateMarker`: `id`* plus any changed fields.
   - `removeMarker`: `id`*.
   - `addPolyline`: `id`*, `points`* (`[[lat,lng],...]`), `color`?, `width`?.
   - `updatePolyline`: `id`*, `points`? or `append`?, `color`?, `width`?.
     `points` replaces the whole path; `append` adds to the end.
   - `removePolyline`: `id`*.
   - `openPopup`: `id`*, `content`*, and (`lat`* + `lng`*) or `anchorMarkerId`*.
   - `closePopup`: `id`*.
   - `setPopupContent`: `id`*, `content`*.
   - `setPanel`: `title`?, `content`* (one panel per widget).
   - `clearPanel`: no payload.
   - `setStyles`: `cssText`* (injected as-is, global scope, per-widget
     `<style>`).
   - `persist`: a partial state object (merged into the widget's state key).
   - `requestCameraControl`, `releaseCameraControl`: no payload.
   - `flyTo`, `jumpTo`: `center`* `[lat,lng]`, `zoom`?, `bearing`?.
   - `fitBounds`: `bounds`* `[[south,west],[north,east]]`.
   - `startGeolocation`: `highAccuracy`? (boolean).
   - `stopGeolocation`: no payload.
   `*` = required. A malformed command gets an `error` envelope echoing the
   command `id`; the widget keeps running.
7. Events per CONTRACTS.md section 5: `markerClick {markerId}*` (owner only),
   `mapClick {lat,lng}*` (all widgets), `cameraGranted {}`, `cameraDenied {}`
   (never fires under preemption — keep it defined but never emitted),
   `cameraRevoked {reason}*` with reason in `ttl | userGesture | released |
   preempted`, `viewportChanged {bounds,center,zoom}*`, `geolocation
   {lat,lng,accuracy?}*`, `geolocationError {code,message}*`.
   `viewportChanged` fires debounced on move-end, on user drag/zoom/scroll and
   on another widget's camera command; suppressed for the issuing widget.
8. Camera lease per CONTRACTS.md section 11:
   - Pan (`flyTo`, `jumpTo`, `fitBounds`): allowed to any widget at any time,
     no lease, most recent command wins. A pan from a non-owner while the
     lease is locked revokes the lease (reason `preempted`) and the pan wins.
   - Follow: `requestCameraControl()` acquires the lease. States `FREE` or
     `LOCKED(owner)`. One owner, never two. If locked, the requester preempts
     (last-request-wins): requester gets `cameraGranted`, displaced owner gets
     `cameraRevoked` reason `preempted`.
   - Lease TTL 10 seconds. Any camera command from the owner renews it. No
     heartbeat message.
   - Six revocation triggers: `releaseCameraControl()` → `released`; TTL
     expiry → `ttl`; worker death/disable/uninstall → no notification
     possible; user map gesture (drag/zoom/scroll) → `userGesture`; another
     widget's `requestCameraControl()` → `preempted`; another widget's pan
     command → `preempted`.
   - UI: a "Camera: <widget name>" badge with a manual release button while
     locked.
9. Persistence: main thread owns `localStorage`. Keys:
   `anymaps.registry` = `[{ widgetId, version, enabled }]`;
   `anymaps.state.<widgetId>` = arbitrary JSON object. `persist` deep-merges a
   partial into the state key. Startup re-enables every `enabled` widget with
   its state in `init.state`. Disable keeps state. Uninstall deletes the
   registry entry and the state key.
10. Lifecycle/cleanup: one dedicated Worker per enabled widget. Enabling an
    already-enabled widget is a no-op. On disable or uninstall, remove every
    marker, polyline, popup, panel section, and style element that widget
    created, then terminate the worker. State survives disable.
11. UI arbitration: one popup open globally — opening a new popup closes the
    previous, across widgets. Panels: one collapsible section per widget,
    stacked vertically in a shared scrollable sidebar. Z-order: enable order,
    later-enabled widgets draw on top; re-enabling a widget moves it to the
    top. No click-to-front. Containers carry classes `anymaps-panel`,
    `anymaps-popup`, `anymaps-widget-<id>`.
12. The `anymaps` runtime is prepended to the bundle source before the blob
    worker starts; `anymaps` is a global inside the worker. Its API is
    CONTRACTS.md section 6: `ready()` → `Promise<{config, state}>`,
    `config`/`state` properties, all 21 command helpers, `on(name, handler)`,
    `off(name, handler)`. The runtime assigns a unique `id` to every command.
13. HTTP API per CONTRACTS.md sections 8–9 and 15 (routes, response shapes,
    filter params, composition order `latest` → `bounds` → `ids` → `since` →
    `until`, `400` on undeclared filter field, `404` unknown token, `409`
    duplicate publish, error body `{ "error": "message" }`). The wizard panel
    resends the full transcript on every turn.
14. Column boundaries: change only files under `client/`. Never touch
    `server/`, `shared/`, `agent/`, `widgets/`, `contracts/`, `docs/`,
    `docker-compose.yml`, or files outside `client/`. Never commit `.sdd/`,
    `node_modules/`, or `dist/`. Never push. Never merge branches.
15. No new npm dependencies. Plain JS, ES modules. Unit tests with
    `node --test`. No DOM, `window`, `localStorage`, or `document` access at
    module top level — only inside functions — so pure modules import cleanly
    under Node.
16. Commit guidance: commit on your task branch as you work, imperative
    messages, ~12 words max, lowercase first letter. Only ever stage files
    under `client/`.

## File ownership map (final state)

Each task owns its files. A file listed for a later task exists as a
registering stub after Task 2. No task edits another task's files. The only
shared files are `client/src/validate.js` (Task 2 creates, Task 3 extends —
sequential waves, no overlap) and `client/package.json` (Task 1 adds the test
script, Task 2 adds the mock script — sequential waves).

```
client/src/sdk/anymaps.js        Task 1  SDK runtime, plain script (no imports/exports)
client/src/manager.js            Task 2  WidgetManager: map, workers, registry, ctx, cleanup
client/src/main.js               Task 2  bootstrap: createManager + mount
client/src/validate.js           Task 2  pure payload validators (Task 3 extends)
client/src/commands/markers.js   Task 2  marker commands
client/src/commands/polylines.js Task 3  polyline commands (stub after Task 2)
client/src/render/popups.js      Task 3  popup arbitration (stub after Task 2)
client/src/render/panels.js      Task 3  sidebar panel sections (stub after Task 2)
client/src/render/styles.js      Task 3  per-widget <style> (stub after Task 2)
client/src/persist.js            Task 3  persist command + deep merge (stub after Task 2)
client/src/events.js             Task 4  markerClick/mapClick/viewportChanged (stub after Task 2)
client/src/camera.js             Task 4  camera lease machine + badge (stub after Task 2)
client/src/geo.js                Task 5  geolocation proxy + user dot (stub after Task 2)
client/src/install.js            Task 6  provision, install, registry ops, startup (stub after Task 2)
client/src/ui/gallery.js         Task 6  gallery UI (stub after Task 2)
client/src/ui/wizard.js          Task 7  wizard chat panel (stub after Task 2)
client/index.html                Task 2  app shell: map, sidebar, containers, baseline CSS
client/fixtures.html             Task 2  dev harness page for fixture widgets
client/fixtures/marker-fixture.js Task 2  fixture bundle: markers, errors, panel log
client/dev/mock-server.mjs       Task 2  dev-only mock of the CONTRACTS HTTP API
client/tests/                    Task N  unit tests per task (node --test)
client/checklist.html            Task 8  full-contract verification page
client/checklist/                Task 8  checklist check modules
client/README.md                 Task 1  SDK authoring guide (Task 8 touch-ups allowed)
```

## The ctx seam (Task 2 defines; all later tasks consume)

`manager.js` builds one `ctx` object and calls `register(ctx)` on every
feature module at manager construction. Feature modules self-register command
handlers and cleanup. Later tasks only fill their own module files.

```js
ctx = {
  // MapLibre instance. Only manager.js and registered feature modules
  // (which together are the WidgetManager) ever touch it. Widgets never do.
  map,

  // fn(payload, widgetId) => void. Throw an Error to send an error envelope
  // to that widget with the thrown message. Manager catches.
  registerCommand(name, fn),

  // Record a drawn item so manager cleanup can remove it.
  // kind: 'marker' | 'polyline' | 'popup'. removeFn(widgetId) must remove
  // the item from the map/DOM.
  track(widgetId, kind, id, removeFn),

  // One-shot cleanup fn per widget, run on disable/uninstall.
  registerCleanup(widgetId, fn),

  // Post an event envelope to that widget's worker.
  emit(widgetId, eventName, payload),

  // Manifest name of a widget (for the camera badge, panels fallback).
  widgetName(widgetId),

  // Current in-memory state object for a widget.
  getState(widgetId),

  // Deep-merge partial into the widget's state, write localStorage key,
  // update in-memory state. Implemented by persist.js; manager delegates.
  persistState(widgetId, partial),

  // Re-apply z-order for a widget's drawn items (called on enable and
  // re-enable so later-enabled widgets draw on top).
  reorder(widgetId),

  // Current z-order index of a widget (markers.js uses it for element
  // zIndex = 1000 + 10 * order). Added by Task 2 as a ratified seam
  // addition; tasks 3+ may consume it.
  widgetOrder(widgetId),

  // Tiny internal event bus: bus.on(name, cb), bus.emit(name, data).
  bus,

  // Currently enabled widgets: () => [{ widgetId, name }]. Used by events.js
  // for broadcasts (mapClick, viewportChanged).
  widgets,
}
```

Bus events (pinned names, used by gallery and camera badge):
`widget-enabled {widgetId}`, `widget-disabled {widgetId}`,
`widget-uninstalled {widgetId}`, `camera-locked {widgetId, name}`,
`camera-free {}`.

Manager public API (used by main.js, gallery, wizard, checklist):

```js
const manager = createManager(); // constructs the map, sidebar wiring, feature modules
manager.enable({ manifest, bundleSource, baseUrl }) // -> Promise, no-op if enabled
manager.disable(widgetId)
manager.uninstall(widgetId)      // disable + remove registry entry + delete state key
manager.list()                   // -> registry array from localStorage
manager.widgetName(widgetId)     // -> manifest name string
manager.startup()                // re-enable registry entries flagged enabled
                                 // (delegates to install.js startupEnable)
```

Provisioning seam: `manager.enable` calls `provision(manifest, baseUrl)`
exported by `install.js`. Task 2's stub derives `channelRoutes` locally
without HTTP: for each channel `cid`, route =
`` `${baseUrl}/widgets/${manifest.id}/channels/${cid}` ``. Task 6 replaces it
with the real `POST /widgets/{id}/provision` call. The seam signature never
changes: `provision(manifest, baseUrl) -> Promise<channelRoutes>`.

Base URLs (pinned, used by install.js and ui/wizard.js):
- generic server: `localStorage.getItem('anymaps.baseUrl')` or
  `'http://localhost:8000'`.
- agent service: `localStorage.getItem('anymaps.agentUrl')` or
  `'http://localhost:8001'`.
`window.__ANYMAPS_CONFIG__ = { baseUrl, agentUrl }` overrides both (used by
checklist.html to point at the mock server).

Startup: `manager.startup()` → for each registry entry with `enabled`,
fetch `GET /widgets/{id}/versions/{version}/manifest` and `/bundle`, then
`manager.enable`. Task 2's install.js stub implements `startupEnable()` as a
no-op returning `[]`; Task 6 implements it.

## The dev mock server (Task 2 delivers)

`client/dev/mock-server.mjs`. Plain Node `http`, no dependencies. Started with
`npm run mock` (script added in Task 2). Serves the CONTRACTS.md section 8–9
API from an in-memory store so every browser check runs without the real
backend. Base port 8000; wizard routes on the same server under `/wizard/`
(wizard URL override points there too, so checklist runs against one process).

Routes and pinned behavior:

- `POST /widgets` — body `{ manifest, bundle }`. Validate `manifest.id` and
  `manifest.version` are non-empty strings. Duplicate `id + version` → `409
  { error: "id + version already published" }`. Else store and `201
  { id, version }`.
- `GET /widgets` — `[ { id, name, version, description, icon } ]` from stored
  manifests.
- `GET /widgets/{id}/versions/{version}/manifest` — stored manifest, or `404`.
- `GET /widgets/{id}/versions/{version}/bundle` — bundle JS source as
  `text/javascript`, or `404`.
- `POST /widgets/{id}/provision` — body `{ manifest }`. Idempotent: build and
  cache routes from `manifest.server.channels`; every channel route is
  `/widgets/{id}/channels/{cid}`. Return `200 { channelRoutes: { cid: url } }`.
  `url` is absolute: `http://localhost:<port>/widgets/...`.
- `POST /widgets/{id}/instances` — `201 { instanceToken }`, token = 32 hex
  chars (`crypto.randomBytes(16).toString('hex')`).
- `POST /widgets/{id}/channels/{cid}` and
  `.../instances/{token}` — store the posted record object under
  `(widgetId, cid, token|null)` with an internal `@ingestedAt` epoch-seconds
  stamp appended per poll/write batch. `201`. Unknown token → `404`.
  Unknown widget/channel → `404`.
- `GET` same two routes — `200 { records: [...] }` after applying filters
  (below). Records are returned whole (the stored objects), ascending by the
  channel's time mapping when present.
- `GET /wizard/generate`-equivalent `POST /wizard/generate` — body
  `{ messages: [{ role, content }] }`. If `messages.length === 1`:
  `{ done: false, questions: ["Drinking water (amenity=drinking_water) or decorative fountains (amenity=fountain)?"] }`.
  Else: publish a canned widget into the store (manifest
  `mock-wizard-widget` v0.1.0 with a public client write channel `mockW` +
  read channel `mockR`, bundle source drawing two markers near NYC on
  `ready()` and calling `setPanel`), then return
  `{ done: true, widgetId: "mock-wizard-widget", version: "0.1.0", manifest }`.
  Malformed body → `400 { error }`.

Filter engine (GET channels), pinned semantics per CONTRACTS.md section 9:

- Channel filter capabilities come from the channel's `record` mapping in the
  manifest stored at provision. Path subset supported by the mock (enough for
  demo + checklist): dot-separated single keys and `[N]` array indexes, e.g.
  `"ac"`, `"hex"`, `"[0]"`, `"a.b"`. No pipes, slices, or functions — if a
  mapping uses them, the mock logs a warning and treats that field as
  undeclared. `record.time === "@ingestedAt"` uses the internal stamp.
- `bounds=south,west,north,east` (four floats): requires `lat` + `lon`
  mappings; keep records with `lat` between south and north and `lon` between
  west and east. Malformed string → `400`.
- `ids=a,b,c`: requires `id` mapping; keep records whose id value is in the
  list (compare as strings).
- `since` / `until` (unix seconds): require `time` mapping; keep records with
  time >= since / time <= until.
- `latest=1`: requires `id` + `time`; dedupe to the newest record per id.
- Composition: apply `latest` first, then `bounds`, `ids`, `since`, `until`.
- A filter param against an undeclared mapping → `400
  { error: "filter <name> requires <mapping>" }`.
- Unknown route → `404`. CORS headers: `Access-Control-Allow-Origin: *`,
  handle OPTIONS preflight with `204`.

Mock limitations (documented in the file header): external channels are
served from a canned empty array (no real fetching, no poller — that is B's
server). The mock exists to verify client behavior, not to replace the
backend.

## Coordinate translation (pinned, all tasks)

- Into MapLibre: `[lng, lat]` arrays. `bounds [[south,west],[north,east]]` →
  `new maplibregl.LngLatBounds([west, south], [east, north])`.
- Out of MapLibre: `{ lat, lng }` objects; bounds →
  `[[south, west], [north, east]]` from
  `getBounds().getSouth()/getWest()/getNorth()/getEast()`.
- Never apply either translation in widget-visible code (`anymaps.js`,
  widget bundles, README examples).

---

## Task 1: SDK runtime `anymaps.js` + README

**Files:**
- Create: `client/src/sdk/anymaps.js`
- Create: `client/tests/sdk-runtime.test.js`
- Create: `client/tests/helpers/runtime-harness.js`
- Modify: `client/package.json` (add `"test": "node --test tests/"`)
- Modify: `client/README.md` (SDK authoring guide)

**Interfaces:**
- Produces: the runtime source text. Task 2 imports it with
  `import anymapsRuntime from './sdk/anymaps.js?raw'` and prepends it to
  bundles. The runtime is a plain script: no `import`/`export` statements,
  self-contained, defines a global `anymaps` via
  `globalThis.anymaps = anymaps`. It must not crash in a Node sandbox (see
  tests).

**Spec/contract requirements (reviewers check each against CONTRACTS.md):**
- CONTRACTS.md §2 envelope (v=1, kinds, cmd id/name/payload).
- CONTRACTS.md §6 the exact `anymaps` API surface and bootstrap example.
- CONTRACTS.md §3 init fields (what `ready()` must resolve).
- SPEC.md §7.1 (runtime prepended, worker context), §7.2 (envelope),
  §7.3 (bootstrap), §7.4 (command names).

### Steps

- [ ] **Step 1: Write the failing test harness**

`client/tests/helpers/runtime-harness.js` — loads the runtime source and runs
it in a worker-like sandbox:

```js
import { readFileSync } from "node:fs";

export function loadRuntime() {
  const src = readFileSync(
    new URL("../src/sdk/anymaps.js", import.meta.url), "utf8");
  const fakeSelf = {};
  const posted = [];
  const postMessage = (msg) => posted.push(msg);
  const fn = new Function("self", "postMessage", src);
  fn(fakeSelf, postMessage);
  // fakeSelf.onmessage is set by the runtime; simulate a message:
  const receive = (data) => fakeSelf.onmessage({ data });
  return { anymaps: fakeSelf.anymaps, posted, receive, postMessage };
}
```

- [ ] **Step 2: Write the failing tests**

`client/tests/sdk-runtime.test.js`, all cases first, expect failures:

1. `ready()` does not resolve before init: after `loadRuntime()`, assert the
   promise is pending (track with a `settled` flag).
2. `ready()` resolves with `{ config, state }` after init: `receive({ v:1,
   kind:"init", protocolVersion:1, widgetId:"find-my-friends", baseUrl:
   "https://server.example", channelRoutes:{ fmfW:"https://server.example/widgets/find-my-friends/channels/fmfW" }, state:{ iid:"x" } })`.
   Assert `config.widgetId === "find-my-friends"`,
   `config.baseUrl`, `config.channelRoutes` deep-equal, `state.iid === "x"`,
   and `anymaps.config === config`, `anymaps.state === state`.
3. Every helper posts exactly one envelope
   `{ v:1, kind:"cmd", id, name, payload }` with the right name and payload.
   Table-driven over all 21 helpers with pinned payloads (see Step 3 list).
   Assert `id` is a string starting with `c` and unique across calls, and
   monotonically increasing (numeric suffix).
4. `on`/`off` event routing: `on("markerClick", h)` → `receive({ v:1,
   kind:"event", name:"markerClick", payload:{ markerId:"m1" } })` fires `h`
   with `{ markerId:"m1" }`; after `off("markerClick", h)`, no fire.
5. Error routing: `on("error", h)` → `receive({ v:1, kind:"error", id:"c1",
   error:"marker missing position" })` fires `h` with
   `{ id:"c1", error:"marker missing position" }`.
6. Protocol mismatch: `receive` init with `protocolVersion: 2` → an error
   envelope posted with the string `protocolVersion 2 not supported by this
   runtime`, and `ready()` rejects with the same message.
7. `persist` payload is the partial object itself: `anymaps.persist({ iid:
   "y" })` posts `{ v:1, kind:"cmd", id, name:"persist", payload:{ iid:"y" } }`.

- [ ] **Step 3: Write the runtime**

`client/src/sdk/anymaps.js`. Plain script. Pinned internals:

```js
(function () {
  "use strict";
  const PROTOCOL_VERSION = 1;
  let cmdSeq = 0;
  let config = null;
  let state = null;
  let initResolve, initReject;
  const readyPromise = new Promise((resolve, reject) => {
    initResolve = resolve;
    initReject = reject;
  });
  const handlers = new Map(); // name -> Set of fns

  function send(name, payload) {
    const id = "c" + ++cmdSeq;
    postMessage({ v: 1, kind: "cmd", id, name, payload });
  }

  function on(name, handler) {
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name).add(handler);
    return () => off(name, handler);
  }
  function off(name, handler) {
    handlers.get(name)?.delete(handler);
  }
  function dispatch(name, payload) {
    for (const h of handlers.get(name) ?? []) {
      try { h(payload); } catch (e) { /* handler errors never break the widget */ }
    }
  }

  self.onmessage = (msg) => {
    const m = msg.data;
    if (m.v !== 1) return;
    if (m.kind === "init") {
      if (m.protocolVersion !== PROTOCOL_VERSION) {
        const err = "protocolVersion " + m.protocolVersion +
          " not supported by this runtime";
        postMessage({ v: 1, kind: "error", error: err });
        initReject(new Error(err));
        return;
      }
      config = { widgetId: m.widgetId, baseUrl: m.baseUrl,
                 channelRoutes: m.channelRoutes };
      state = m.state ?? {};
      initResolve({ config, state });
      return;
    }
    if (m.kind === "event") { dispatch(m.name, m.payload); return; }
    if (m.kind === "error") { dispatch("error", { id: m.id, error: m.error }); return; }
  };

  const anymaps = {
    ready: () => readyPromise,
    get config() { return config; },
    get state() { return state; },
    on, off,

    addMarker: (p) => send("addMarker", p),
    updateMarker: (p) => send("updateMarker", p),
    removeMarker: (id) => send("removeMarker", { id }),
    addPolyline: (p) => send("addPolyline", p),
    updatePolyline: (p) => send("updatePolyline", p),
    removePolyline: (id) => send("removePolyline", { id }),
    openPopup: (p) => send("openPopup", p),
    closePopup: (id) => send("closePopup", { id }),
    setPopupContent: (p) => send("setPopupContent", p),
    setPanel: (p) => send("setPanel", p),
    clearPanel: () => send("clearPanel", {}),
    setStyles: (cssText) => send("setStyles", { cssText }),
    persist: (partial) => send("persist", partial),
    requestCameraControl: () => send("requestCameraControl", {}),
    releaseCameraControl: () => send("releaseCameraControl", {}),
    flyTo: (p) => send("flyTo", p),
    jumpTo: (p) => send("jumpTo", p),
    fitBounds: (p) => send("fitBounds", p),
    startGeolocation: (p) => send("startGeolocation", p),
    stopGeolocation: () => send("stopGeolocation", {}),
  };
  globalThis.anymaps = anymaps;
})();
```

Rules: command `id`s are `c1, c2, ...`. `persist` sends the partial object as
the payload (not wrapped). Empty-payload commands send `{}`. Runtime performs
no payload validation — the manager validates and replies with error
envelopes. Handler exceptions are caught so events never crash the widget.
Use `self` and `postMessage` bare, never `window`.

- [ ] **Step 4: Run tests until green**

```sh
cd client && npm test
```
Expected: all `tests/sdk-runtime.test.js` cases pass, output pristine.

- [ ] **Step 5: README authoring guide**

Extend `client/README.md` with: bundle skeleton (no imports — the runtime is
prepended; classic script), the `ready()` bootstrap, full command list with
payload field tables, full event list, the room-token flow
(`POST {baseUrl}/widgets/{id}/instances` → `anymaps.persist({ iid })`, read
`state.iid` on boot), interpolation guidance (poll + client-side interpolation
is the widget's job), and the rule that a bundle never touches DOM, map,
`window`, or storage. Include one complete example widget (~40 lines) matching
CONTRACTS.md §6's bootstrap example exactly in shape.

- [ ] **Step 6: Verify and commit**

```sh
cd client && npm test && npm run build
```
Commit: `feat: add anymaps sdk runtime with tests and authoring guide`.

---

## Task 2: Manager core — map, workers, init, markers, seams

**Files:**
- Modify: `client/src/manager.js` (full implementation)
- Modify: `client/src/main.js` (thin bootstrap)
- Modify: `client/index.html` (app shell)
- Create: `client/src/validate.js`
- Create: `client/src/commands/markers.js`
- Create: `client/tests/validate.test.js`
- Create registering stubs (one function each, header comment naming the
  implementing task): `client/src/commands/polylines.js` (Task 3),
  `client/src/render/popups.js` (Task 3), `client/src/render/panels.js`
  (Task 3), `client/src/render/styles.js` (Task 3), `client/src/persist.js`
  (Task 3), `client/src/events.js` (Task 4), `client/src/camera.js` (Task 4),
  `client/src/geo.js` (Task 5), `client/src/install.js` (Task 6),
  `client/src/ui/gallery.js` (Task 6), `client/src/ui/wizard.js` (Task 7).
  Stub shape: `export function register(ctx) { /* Task N implements this */ }`.
  `install.js` additionally exports the provision stub and `startupEnable`
  no-op per the seam section above.
- Create: `client/fixtures.html`, `client/fixtures/fixture-main.js`,
  `client/fixtures/marker-fixture.js`
- Create: `client/dev/mock-server.mjs` per the pinned mock server section
- Modify: `client/package.json` (add `"mock": "node dev/mock-server.mjs"`)

**Interfaces:**
- Consumes: `client/src/sdk/anymaps.js?raw` (Task 1 runtime source).
- Produces: `createManager()`, `ctx` seam, manager API, `validate.js`
  exports, feature-module stub contract. All pinned in the sections above.

**Spec/contract requirements (reviewers check each against CONTRACTS.md):**
- CONTRACTS.md §3 init (fields, once, after provisioning), §4 command table
  (marker rows only this task), §6 prepend rule, §10 persistence keys
  (registry shape only — state keys are Task 3), §12 z-order/classes, §13
  coordinate order, §14 error responses on the SDK channel (envelope, not
  exceptions).
- SPEC.md §5.5 (manager owns map/DOM/geolocation/camera lease), §7.2
  (envelope), §7.3 (bootstrap + protocol rejection), §7.6 (ownership/ID
  tracking), §7.10 (lifecycle: enable/disable/terminate, no widget cleanup
  command), §7.11 (z-order default).

### Steps

- [ ] **Step 1: Validators + failing tests**

`client/src/validate.js` — pure functions, no DOM, each returns `null` when
valid or a human-readable error string. Exports pinned:

```js
export function addMarker(p)      // error strings: "marker missing id",
                                  // "marker missing position" (missing or
                                  // non-finite lat/lng); rotation, if
                                  // present, must be a finite number
export function updateMarker(p)   // id required ("marker missing id"), at
                                  // least one other field required
                                  // ("updateMarker needs a changed field")
export function removeMarker(p)   // "marker missing id"
```

Error strings are exact — the SPEC.md §7.2 example uses
`"marker missing position"`; tests assert these strings. `id` must be a
non-empty string. `lat`/`lng` must be finite numbers.

`client/tests/validate.test.js`: a table of valid and invalid payloads per
function asserting the exact error strings. Write tests first, watch them
fail, then implement.

- [ ] **Step 2: markers.js**

`client/src/commands/markers.js` exports `register(ctx)`:

- Registers `addMarker`, `updateMarker`, `removeMarker` via
  `ctx.registerCommand`; each handler runs the validator and throws the error
  string on failure (manager converts throws to error envelopes).
- Per widget: `Map<id, { marker, element, iconEl, data }>`.
- `addMarker`: build the marker element: a div `anymaps-marker`
  containing an icon element (image URL → `<img>`; anything else → text
  node), optional label element (badge text), `title` → element `title`
  attribute, `color` → CSS background/border color of the icon element,
  `rotation` → `iconEl.style.transform = rotate(${rotation}deg)`. Then
  `new maplibregl.Marker({ element }).setLngLat([lng, lat]).addTo(ctx.map)`
  (translate here, nowhere else). Element click →
  `ctx.emit(widgetId, "markerClick", { markerId: id })`. Track with
  `ctx.track(widgetId, "marker", id, removeFn)` where removeFn calls
  `marker.remove()` and deletes the map entry.
- `updateMarker`: apply only present fields; `lat`/`lng` → `setLngLat`;
  icon/color/label/title/rotation → rebuild the affected element parts
  (no duplicate markers). Unknown id → throw `marker not found`.
- `removeMarker`: unknown id → ignore silently (idempotent, fire-and-forget
  per contract). Known id → remove + untrack.
- `ctx.reorder(widgetId)`: re-apply z-order (see manager Step 4) to all of
  that widget's markers.

- [ ] **Step 3: manager.js**

Full implementation per the seams section. Pinned details:

- `createManager()` constructs the MapLibre map with the existing basemap
  config (OpenFreeMap bright, NYC center, zoom 12, NavigationControl,
  ScaleControl, compact attribution — move the `CompactAttribution` class
  from the current main.js into manager.js unchanged). `#map` container is
  created by index.html.
- Envelope handling: `worker.onmessage = ({data}) =>`: ignore `v !== 1`; for
  `kind === "cmd"`: look up registered handler; missing name → error envelope
  `{ v:1, kind:"error", id, error: "unknown command <name>" }`; handler
  throw → error envelope `{ v:1, kind:"error", id, error: message }` and
  `console.error`. Never propagate into the worker. Also wire
  `worker.onerror` (bundle top-level throw) → error envelope without an
  `id` (bootstrap failure; no command to echo) plus `console.error`, so a
  throwing bundle still produces a clear error per the envelope contract.
- `enable({ manifest, bundleSource, baseUrl })`: no-op if already enabled
  AND no-op if an enable for that widget is already in flight (pending set
  cleared in `finally`, so a second call inside the provision await window
  cannot spawn a second worker). Await `provision(manifest, baseUrl)`
  (install.js stub). Build blob:
  `new Blob([anymapsRuntime + "\n;\n" + bundleSource], { type: "application/javascript" })`
  → `new Worker(URL.createObjectURL(blob), { type: "module" })` — module
  workers are a compatible superset: classic bundles without imports run
  unchanged, and the fixture's bare top-level await is valid (ratified
  deviation from the bare-`new Worker` pin). Load state:
  `JSON.parse(localStorage.getItem("anymaps.state." + manifest.id) ?? "{}")`
  (parse failure → `{}`). Post exactly one init message with the pinned
  fields. Upsert registry entry `{ widgetId, version, enabled: true }` and
  save. Bump enable-order counter for the widget, call `ctx.reorder(widgetId)`
  after creation, emit `widget-enabled` on the bus.
- `disable(widgetId)`: run every tracked removeFn and registered cleanup fn
  for the widget, terminate the worker, set registry `enabled: false`, save,
  emit `widget-disabled`.
- `uninstall(widgetId)`: disable, then remove the registry entry and
  `localStorage.removeItem("anymaps.state." + widgetId)`, emit
  `widget-uninstalled`.
- `cleanup` runs cleanup fns in registration order, then tracked removeFns.
  Cleanup fns must be idempotent (re-enable must not double-register).
- Registry helpers: `loadRegistry()`/`saveRegistry()` with the pinned key and
  shape; corrupted JSON or a non-array value → `[]`.
- Z-order: enable-order counter starting at 1; marker element
  `style.zIndex = 1000 + 10 * order`. `ctx.reorder(widgetId)` re-applies the
  current order to that widget's markers (Task 3 extends the idea to
  polylines via `ctx.reorder` implementations in each module).
- Widget name map: store `manifest.name` per enabled widget;
  `widgetName(widgetId)` returns it or the widgetId.
- Build `ctx` (pinned shape), then for each feature module call
  `register(ctx)` in a pinned list:
  markers, polylines, popups, panels, styles, persist, events, camera, geo,
  install, gallery, wizard. Later tasks fill the stubs; do not change this
  list.
- `manager.startup()` → `startupEnable(manager)` from install.js (stub no-op).

- [ ] **Step 4: main.js + index.html**

`main.js` becomes thin: import `createManager`, construct, call
`manager.startup()` (re-enables registry entries; no-op until Task 6), and
expose for dev on `window.__ANYMAPS_DEV__` (`{ manager }`) — used by fixture
page and checklist. No direct MapLibre imports remain in main.js.

`index.html` shell: `#map` + `#sidebar` with three stacked sections and
baseline CSS:

- `#panel-host` — widget panel sections stack here (Task 3).
- `#gallery` — gallery UI mounts here (Task 6).
- `#wizard` — wizard panel mounts here (Task 7).
- `#camera-badge` — inside the map container wrapper, hidden by default
  (Task 4).
- Baseline CSS for `.anymaps-panel` (section + collapsible header), the
  sidebar layout (keep the current 320px sidebar style), `.anymaps-marker`
  (round icon dot, label badge), `.anymaps-user-dot` (Task 5 fills), camera
  badge styles, and the existing attribution styles moved here from main.js.
  Keep it functional, not polished — demo widgets bring their own styles via
  `setStyles`.

- [ ] **Step 5: Fixture page + fixture bundle**

`client/fixtures.html` — standalone dev page: its own `#map` + minimal
sidebar, imports `client/fixtures/fixture-main.js`, which imports
`createManager`, fetches `marker-fixture.js` as text (Vite `?raw`), enables
it as `enable({ manifest, bundleSource, baseUrl })` with a small local
manifest `{ id: "fixture-marker", name: "Fixture Marker", version: "0.1.0",
description: "", server: { channels: [] } }` and baseUrl
`http://localhost:8000`.

`client/fixtures/marker-fixture.js` — a bundle exercising the contract
(receives the runtime prepended, so it calls `anymaps` directly):

```js
const { config, state } = await anymaps.ready();
const log = [];
anymaps.setPanel({ title: "Fixture", content: "<ul id='fixture-log'></ul>" });
const append = (line) => {
  log.push(line);
  anymaps.setPanel({ content: "<ul id='fixture-log'>" +
    log.map((l) => "<li>" + l + "</li>").join("") + "</ul>" });
};
anymaps.on("markerClick", ({ markerId }) => append("click:" + markerId));
anymaps.on("error", ({ id, error }) => append("err:" + id + ":" + error));
anymaps.addMarker({ id: "m1", lat: 40.71, lng: -74.0, icon: "🚻",
  color: "#0066ff", label: "open", title: "Public restroom", rotation: 0 });
append("added");
setInterval(() => {
  anymaps.updateMarker({ id: "m1", lat: 40.71 + 0.001 * Math.random(),
    lng: -74.0 + 0.001 * Math.random() });
  append("moved");
}, 2000);
setTimeout(() => anymaps.removeMarker("m2"), 3000);
anymaps.addMarker({ id: "bad", lat: "nope", lng: -74.0 });
```

The `bad` marker must produce an `err:` log line with the exact
`marker missing position` string and the widget must keep moving `m1` — this
is the malformed-command survival check. The orchestrator verifies with
Playwright: marker present on the map, `err:cN:marker missing position` in
the panel, updates continuing.

- [ ] **Step 6: Mock server**

Implement `client/dev/mock-server.mjs` per the pinned mock server section,
including the filter engine, wizard route, CORS, and the file-header
limitations note. Verify manually:

```sh
cd client && node dev/mock-server.mjs &
curl -s localhost:8000/widgets
curl -s -X POST localhost:8000/widgets -H 'content-type: application/json' \
  -d '{"manifest":{"id":"t","version":"0.1.0","name":"T","description":"","server":{"channels":[]}},"bundle":"x"}'
```

- [ ] **Step 7: Verify and commit**

```sh
cd client && npm test && npm run build
```
Orchestrator additionally runs the Playwright fixture check. Commit:
`feat: add widget manager core with markers and fixture harness`.

---

## Task 3: Full render surface — polylines, popups, panels, styles, persist

**Files (own them all; they are stubs today):**
- `client/src/commands/polylines.js`
- `client/src/render/popups.js`
- `client/src/render/panels.js`
- `client/src/render/styles.js`
- `client/src/persist.js`
- Extend: `client/src/validate.js` (polylines/popups/panels validators)
- Create: `client/tests/validate-extra.test.js`, `client/tests/persist.test.js`

**Interfaces:**
- Consumes: `ctx` seam exactly as pinned (registerCommand, track,
  registerCleanup, emit, widgetName, getState, persistState, reorder, map,
  bus). `persist.js` implements `ctx.persistState` — it exports
  `installPersist(ctx)` (returns the persistState function) and pure
  `deepMerge(target, partial)`.
- Produces: `deepMerge` (Task 4+ may use), polyline/popup/panel behavior.

**Spec/contract requirements (reviewers check each against CONTRACTS.md):**
- CONTRACTS.md §4 rows: `addPolyline`/`updatePolyline`/`removePolyline`
  (`points` replaces, `append` adds to the end), `openPopup` (standalone or
  `anchorMarkerId`), `closePopup`, `setPopupContent`, `setPanel`/`clearPanel`,
  `setStyles`, `persist` (deep-merged).
- CONTRACTS.md §10 persistence keys and merge semantics.
- CONTRACTS.md §12 UI arbitration (one popup globally; panels stacked
  collapsible per widget; classes `anymaps-panel`, `anymaps-popup`,
  `anymaps-widget-<id>`).
- SPEC.md §7.4 payloads, §7.8 CSS styling (as-is, global scope, per-widget
  `<style>`), §7.9 persistence, §7.11 UI arbitration.
- Out of scope, do NOT build: anchored popups tracking a moving marker.

### Steps

- [ ] **Step 1: Validators + failing tests**

Extend `client/src/validate.js`:

```js
export function addPolyline(p)     // "polyline missing id",
                                   // "polyline missing points",
                                   // points must be an array of [lat,lng]
                                   // pairs of finite numbers:
                                   // "polyline points must be [lat,lng] pairs"
export function updatePolyline(p)  // id required; exactly one of points|append
                                   // must be an array of valid pairs:
                                   // "updatePolyline needs points or append"
export function removePolyline(p)  // "polyline missing id"
export function openPopup(p)       // "popup missing id", "popup missing content",
                                   // "popup needs lat/lng or anchorMarkerId"
export function closePopup(p)      // "popup missing id"
export function setPopupContent(p) // "popup missing id", "popup missing content"
export function setPanel(p)        // "panel missing content"
```

`client/tests/validate-extra.test.js` — table-driven valid/invalid with exact
error strings. Write first, watch fail, implement.

- [ ] **Step 2: polylines.js**

- Register `addPolyline`, `updatePolyline`, `removePolyline`.
- Per widget `Map<id, { sourceId, layerId, points }>`.
- `addPolyline`: GeoJSON source
  `{ type:"Feature", geometry:{ type:"LineString", coordinates: [[lng,lat],...] } }`,
  `map.addSource(sourceId, { type:"geojson", data })`, then
  `map.addLayer({ id: layerId, type:"line", source: sourceId, layout:{ "line-cap":"round", "line-join":"round" }, paint:{ "line-color": color ?? "#3b82f6", "line-width": width ?? 3 } })`
  with no beforeId (adds on top). `layerId = "anymaps-polyline-" + id`.
  Track with `ctx.track(widgetId, "polyline", id, removeFn)`; removeFn
  removes layer then source.
- `updatePolyline`: `points` replaces the coordinate array; `append` extends
  it (append is an array of points). Then `setData` with the new GeoJSON.
  `color`/`width` update the paint properties via `map.setPaintProperty`.
- `ctx.reorder(widgetId)`: for each of the widget's layers,
  `map.moveLayer(layerId)` (moves to top). Manager already calls
  `ctx.reorder` on enable.
- Translation `[[lat,lng],...]` → `[[lng,lat],...]` happens here only.

- [ ] **Step 3: popups.js**

- Global current-popup state `{ popup, widgetId, id }` (module-level, one
  process).
- `openPopup`: close the current popup if any (any widget). Standalone
  (`lat`+`lng`): `new maplibregl.Popup({ className: "anymaps-popup" })
  .setLngLat([lng, lat]).setHTML(content).addTo(ctx.map)`.
  Anchored (`anchorMarkerId`): get the owning widget's marker instance (via a
  lookup exported by markers.js: `getMarker(widgetId, id)` — add that export
  in this task, it is an additive change to a Task 2 file and allowed since
  Task 2 is already merged; if the marker does not exist, throw
  `popup anchor marker not found`), then `marker.setPopup(popup)` and
  `marker.togglePopup()` to open. The popup content is raw HTML, no
  sanitization. Track with `ctx.track(widgetId, "popup", id, removeFn)`.
- `closePopup(id)`: if the current popup has that id, `popup.remove()` and
  untrack; otherwise ignore (fire-and-forget).
- `setPopupContent`: if the popup with that id is currently open →
  `popup.setHTML(content)`; else throw `popup not open`.
- Any open popup of a widget is closed on that widget's cleanup (manager
  runs tracked removeFns).

- [ ] **Step 4: panels.js**

- `setPanel`: per widget one collapsible `<details class="anymaps-panel
  anymaps-widget-<id>">` with `<summary>` (title) and a content div
  (`innerHTML = content`, raw). Title precedence: `payload.title` if
  present, else the existing title if the section exists, else
  `ctx.widgetName(widgetId)`. Sections stack in `#panel-host` in creation
  order. Register `ctx.registerCleanup(widgetId, () => section.remove())`
  once per widget (idempotent — guard against double registration on
  re-enable).
- `clearPanel`: remove the section and re-register a no-op cleanup guard.
- `open` attribute default: leave collapsed unless the widget sets nothing —
  pin: new sections start open (`<details open>`); user collapse is native.

- [ ] **Step 5: styles.js**

- `setStyles`: per widget a `<style data-widget-id="<id>">` in
  `document.head`; `styleEl.textContent = cssText` (replaces prior content).
  Injected as-is, global scope. Register idempotent cleanup removing the
  element.

- [ ] **Step 6: persist.js + failing tests**

`client/tests/persist.test.js` first (pure, no DOM):

1. `deepMerge({a:1, n:{x:1}}, {n:{y:2}})` → `{a:1, n:{x:1, y:2}}` (nested
   merge, no clobber).
2. `deepMerge({arr:[1,2]}, {arr:[3]})` → `{arr:[3]}` (arrays replace).
3. `deepMerge({}, {iid:"x"})` → `{iid:"x"}`; merging into missing keys adds
   them.
4. Merging `null`/primitives replaces: `deepMerge({n:{x:1}}, {n:5})` →
   `{n:5}`.

`persist.js`:

```js
export function deepMerge(target, partial) { /* recursive; plain objects
  merge, everything else replaces */ }

export function installPersist(ctx) {
  // registers the "persist" command: deepMerge(getState(widgetId), partial),
  // update in-memory state, write
  // localStorage.setItem("anymaps.state." + widgetId, JSON.stringify(state))
  // returns the persistState function; manager binds it onto ctx.
}
```

The command handler never throws for valid JSON-safe partials. State reads on
enable happen in manager (already pinned in Task 2).

- [ ] **Step 7: Verify and commit**

```sh
cd client && npm test && npm run build
```
Orchestrator Playwright checks on the fixture page: two widgets (second one
temporary via console `__ANYMAPS_DEV__`) with panels → two stacked sections;
two openPopup calls → only newest visible; polyline append grows a trail
without flicker (assert coordinates); persist → localStorage key updated and
a reload re-enables with the same state. Commit:
`feat: add polylines popups panels styles and persist`.

---

## Task 4: Events and the camera lease

**Files (own them):**
- `client/src/events.js`
- `client/src/camera.js`
- Create: `client/tests/camera.test.js`, `client/tests/viewport.test.js`

**Interfaces:**
- Consumes: `ctx` seam; `ctx.map`; `ctx.emit`; `ctx.bus`; `ctx.widgetName`;
  `ctx.registerCommand`; `ctx.registerCleanup`.
- Produces:
  - `createCameraLease({ now, setTimeout, clearTimeout, onEvent })` — pure
    state machine (no DOM), `onEvent(event)` where event is
    `{ type: "granted", widgetId }` or
    `{ type: "revoked", widgetId, reason }`.
  - `createViewportNotifier({ getViewport, now, setTimeout, clearTimeout,
    emit, listWidgets })` — pure debounced broadcaster (see Step 2).
  - `camera.js` also registers the camera command handlers, the badge, and
    the user-gesture listeners.

**Spec/contract requirements (reviewers check each against CONTRACTS.md):**
- CONTRACTS.md §5 events table (markerClick routing is Task 2's markers.js;
  verify wiring only), §11 camera lease rules (all of it).
- SPEC.md §7.5 event semantics (viewportChanged suppression, debounce,
  advisory), §7.7 camera model (consolidated).

### Steps

- [ ] **Step 1: Camera state machine + failing tests**

`client/tests/camera.test.js` — write first, expect failures. Cases (fake
timers via injected `setTimeout`/`clearTimeout` and a manual clock):

1. `request("a")` on FREE → LOCKED(a), `granted {widgetId:"a"}` event.
2. `request("b")` while LOCKED(a) → a gets `revoked reason preempted`, b gets
   `granted`. Never two owners.
3. Owner camera command renews: `request("a")`, advance clock 9s,
   `cameraCommand("a")`, advance 9s → still LOCKED(a), no revocation.
4. No commands → after exactly 10s the lease expires → `revoked reason ttl`,
   state FREE.
5. `release("a")` while LOCKED(a) → `revoked reason released`, FREE.
6. `release("a")` while LOCKED(b) → nothing happens (only the owner can
   release).
7. `userGesture()` while LOCKED → `revoked reason userGesture`, FREE; while
   FREE → nothing.
8. `cameraCommand("b")` while LOCKED(a) → a `revoked reason preempted`,
   FREE after (pan wins, no new lock).
9. `widgetGone("a")` while LOCKED(a) → FREE with NO event (no notification
   possible).
10. `cameraDenied` is never emitted in any scenario (assert over the full
    event log of cases 1–9).
11. `request("a")` twice in a row → renews, single `granted` for a, no
    revocation.

`createCameraLease` pinned behavior:

```js
export function createCameraLease({ now, setTimeout, clearTimeout, onEvent }) {
  // FREE | { owner, timer }
  const api = {
    request(widgetId),        // acquire or preempt; renew if same owner
    release(widgetId),        // only owner; reason "released"
    cameraCommand(widgetId),  // renew if owner; revoke preempted + free if
                              // another widget is owner
    userGesture(),            // revoke "userGesture" if locked
    widgetGone(widgetId),     // free silently if owner
    isLocked(),               // boolean
    owner(),                  // widgetId | null
  };
  return api;
}
```

Constants: `TTL_MS = 10000`. `onEvent` is called synchronously for
grant/revoke. Timer management uses the injected `setTimeout`/`clearTimeout`;
the timer is cleared on every state change to FREE.

- [ ] **Step 2: Viewport notifier + failing tests**

`client/tests/viewport.test.js` — write first. The notifier is pure: no
MapLibre, injected `getViewport()` returning `{ bounds, center, zoom }` and
`listWidgets()` returning widget ids.

```js
export function createViewportNotifier({ getViewport, now, setTimeout,
  clearTimeout, emit, listWidgets }) {
  // api: scheduleCameraCommand(issuerWidgetId), moveEnd()
  // Debounce DEBOUNCE_MS = 100: both scheduleCameraCommand and moveEnd
  // collapse into one broadcast within the window.
  // scheduleCameraCommand(issuer): suppress = issuer; schedule broadcast.
  // moveEnd(): if suppress is set -> broadcast to all widgets except
  //   suppress, clear suppress, cancel timer. Else broadcast to all.
  // broadcast(): viewport = getViewport(); for each widget in
  //   listWidgets(): emit(widgetId, "viewportChanged", viewport)
}
```

Test cases:

1. `moveEnd()` → emits to all widgets with `{bounds, center, zoom}` from
   `getViewport`.
2. `scheduleCameraCommand("a")` then timer fires → emits to b, c, not a.
3. `scheduleCameraCommand("a")` followed by `moveEnd()` inside the window →
   single broadcast, a suppressed.
4. Two `moveEnd()` calls inside 100ms → one broadcast (debounced).
5. After a suppressed broadcast, a later bare `moveEnd()` emits to all
   again.

- [ ] **Step 3: events.js**

Register against `ctx`:

- `mapClick`: `ctx.map.on("click", (e) => { for each enabled widget:
  ctx.emit(widgetId, "mapClick", { lat: e.lngLat.lat, lng: e.lngLat.lng }) })`.
  Needs the enabled-widget list: manager exposes it on ctx as
  `ctx.widgets()` returning `[{ widgetId }]` (additive to Task 2; allowed —
  Task 2 is merged before this task runs).
- `viewportChanged`: build the notifier with `getViewport` reading the real
  map: bounds `[[south, west], [north, east]]`, center `[lat, lng]`, zoom
  `Math.round(map.getZoom())`. Wire `map.on("moveend", () => notifier.moveEnd())`.
  Expose the notifier on the seam as `ctx.viewport = notifier` so camera.js
  can call `scheduleCameraCommand` (additive ctx property, added in this
  task).
- Suppression wiring: camera command handlers call
  `notifier.scheduleCameraCommand(widgetId)` after issuing the map move (see
  Step 4). This satisfies "suppressed for the widget that issued the command"
  and "fires on another widget's camera command".
- `markerClick` needs no new wiring — markers.js emits to the owner already.
  Verify by reading markers.js and the fixture behavior.

- [ ] **Step 4: camera.js**

Register against `ctx`:

- Build the lease with real timers; map `onEvent` → `ctx.emit(widgetId,
  "cameraGranted", {})` / `ctx.emit(widgetId, "cameraRevoked", { reason })`;
  also update the badge and emit bus events
  (`camera-locked {widgetId, name: ctx.widgetName(widgetId)}`,
  `camera-free {}`).
- Command handlers, all validated (throw exact strings on bad payload):
  - `requestCameraControl` → `lease.request(widgetId)`.
  - `releaseCameraControl` → `lease.release(widgetId)`.
  - `flyTo {center*, zoom?, bearing?}` — validate center is `[lat,lng]`
    finite pair: `"flyTo center must be [lat, lng]"`. Call
    `notifier.scheduleCameraCommand(widgetId)` FIRST (so the issuer is
    suppressed), then `lease.cameraCommand(widgetId)` (preempts a foreign
    owner), then `ctx.map.flyTo({ center: [lng, lat], zoom, bearing })`.
  - `jumpTo` — same, with `ctx.map.jumpTo`.
  - `fitBounds {bounds*}` — validate two `[lat,lng]` pairs:
    `"fitBounds bounds must be [[south,west],[north,east]]"`. Same order:
    schedule, lease, `ctx.map.fitBounds(new maplibregl.LngLatBounds([west,
    south], [east, north]))`.
- User gesture revocation, robust form: keep a module flag
  `programmatic = false`. Set it `true` immediately before each
  `map.flyTo`/`jumpTo`/`fitBounds` call in our handlers. Then
  `map.on("movestart", () => { if (programmatic) { programmatic = false;
  return; } lease.userGesture(); })`. This catches every user gesture —
  drag, wheel, pinch, keyboard, navigation-control buttons — and excludes
  programmatic moves, so the owner keeps the lease across its own jumps
  (verified by checklist).
- Badge: `#camera-badge` div (created by index.html, hidden by default).
  On lock: show `"Camera: " + name`, store `currentOwner`; button "✕" →
  `lease.release(currentOwner)`. On free: hide, clear. Badge is manager-side
  DOM (camera.js is part of the WidgetManager, so this respects the
  ownership rule).
- Cleanup: `ctx.registerCleanup(widgetId, () => lease.widgetGone(widgetId))`
  (idempotent guard), covering trigger 3 (worker death/disable/uninstall).
- Never emit `cameraDenied` anywhere. Add a code comment saying it is
  reserved for a future strict-lease mode.

- [ ] **Step 5: Verify and commit**

```sh
cd client && npm test && npm run build
```
Orchestrator Playwright checks: two fixture widgets fight for the lease (a
requests, b preempts, a's panel logs `revoked:preempted`); owner jumps every
5s → badge stays; owner quiet → badge hides after ~10s with `revoked:ttl`
logged; user drags map → `revoked:userGesture`; issuer-suppression check
(widget a `flyTo` → b logs `viewportChanged`, a does not). Commit:
`feat: add event routing and camera lease with badge`.

---

## Task 5: Geolocation proxy

**Files (own them):**
- `client/src/geo.js`
- Create: `client/tests/geo.test.js`

**Interfaces:**
- Consumes: `ctx` seam; `ctx.map`; `ctx.emit`; `ctx.registerCommand`;
  `ctx.registerCleanup`.
- Produces: `createGeoProxy({ watchPosition, clearWatch, onEvent })` — pure,
  testable refcount logic (see Step 1). `geo.js` wires it to
  `navigator.geolocation` and the map dot.

**Spec/contract requirements (reviewers check each against CONTRACTS.md):**
- CONTRACTS.md §4 `startGeolocation`/`stopGeolocation` rows; §5 `geolocation`
  and `geolocationError` rows; §12 user location dot rule (manager-drawn,
  not a widget marker).
- SPEC.md §7.4 geolocation commands, §7.5 geolocation events (code mirrors
  the browser PositionError code).

### Steps

- [ ] **Step 1: Geo proxy + failing tests**

`client/tests/geo.test.js` first. `createGeoProxy`:

```js
export function createGeoProxy({ watchPosition, clearWatch, onEvent }) {
  // watchPosition(success, error, options) -> watchId  (injected)
  // clearWatch(watchId) -> void                        (injected)
  // onEvent({ type: "fix", payload: { lat, lng, accuracy } }) |
  //        ({ type: "error", payload: { code, message } }) |
  //        ({ type: "dot", visible: true, payload }) |
  //        ({ type: "dot", visible: false })
  // api: start(widgetId, { highAccuracy }), stop(widgetId),
  //      unsubscribe(widgetId)
}
```

Pinned behavior and test cases:

1. First `start` calls `watchPosition` once with
   `{ enableHighAccuracy: true }` when `highAccuracy` is true; second
   subscriber does not call it again (one shared watch).
2. `stop` of one subscriber keeps the watch alive; stopping the last one
   calls `clearWatch` once and emits `dot visible:false`.
3. A fix → `onEvent fix` for the latest payload; `geo.js` broadcasts the
   `geolocation` event to every subscriber (test the subscriber list logic:
   proxy exposes `subscribers()`).
4. An error → `onEvent error` with code/message passed through.
5. `unsubscribe(widgetId)` (called from cleanup) behaves like `stop` and is
   idempotent (double-call safe).
6. Options when `highAccuracy` absent/false → `enableHighAccuracy: false`.

- [ ] **Step 2: geo.js**

- Register `startGeolocation` and `stopGeolocation`.
- Wire `watchPosition: navigator.geolocation.watchPosition.bind(navigator.geolocation)`
  and `clearWatch: navigator.geolocation.clearWatch.bind(navigator.geolocation)`.
  If `navigator.geolocation` is missing: on `startGeolocation`, emit
  `geolocationError { code: 2, message: "geolocation unavailable" }` to the
  requester and return.
- Fix handler: emit `geolocation { lat: coords.latitude, lng:
  coords.longitude, accuracy: coords.accuracy }` to every subscriber.
  Update the dot position (`dot.setLngLat([lng, lat])`).
- Error handler: emit `geolocationError { code: err.code, message:
  err.message }` to every subscriber. The code mirrors the browser's
  PositionError code as-is.
- Dot: a `maplibregl.Marker` with a `div.anymaps-user-dot` element (pulsing
  blue dot, CSS already in index.html), added to `ctx.map` when the watch
  starts, removed when it stops. The dot is never tracked as a widget item
  and never counted in cleanup — it is the manager's native indicator.
- Cleanup: `ctx.registerCleanup(widgetId, () => proxy.unsubscribe(widgetId))`
  (idempotent guard), so disable/uninstall stops that widget's subscription.

- [ ] **Step 3: Verify and commit**

```sh
cd client && npm test && npm run build
```
Orchestrator Playwright check: fixture calls `startGeolocation` (grant
permission via the browser context), the dot appears, the fixture logs a
`geolocation` event with lat/lng; `stopGeolocation` removes the dot; denial
path logs `geolocationError` with code 1. Commit:
`feat: add geolocation proxy with native user dot`.

---

## Task 6: Install path, gallery, lifecycle completion

**Files (own them):**
- `client/src/install.js` (replace stub)
- `client/src/ui/gallery.js` (replace stub)
- Create: `client/tests/install.test.js`

**Interfaces:**
- Consumes: `ctx` seam; `manager` API (`enable`, `disable`, `uninstall`,
  `list`); the pinned `provision(manifest, baseUrl)` and
  `startupEnable(manager)` seam signatures; base-URL resolution rules pinned
  in the seam section; the mock server.
- Produces: registry ops and URL helpers as pure exports (tested):
  `serverUrl()`, `agentUrl()`, `upsertRegistry(registry, entry)`,
  `removeRegistryEntry(registry, widgetId)`.

**Spec/contract requirements (reviewers check each against CONTRACTS.md):**
- CONTRACTS.md §8 route table (provision, instances, manifest/bundle
  fetches, gallery list), §10 persistence keys, §13 units.
- SPEC.md §9.1 (idempotent provisioning, call on every enable), §12.1 route
  table, §13 (install = fetch manifest + bundle by id + version), §7.10
  lifecycle (states installed/enabled/disabled/uninstalled; re-enable resumes
  same state), §7.11 z-order (re-enable moves to top).

### Steps

- [ ] **Step 1: Pure helpers + failing tests**

`client/tests/install.test.js` first:

1. `upsertRegistry([], { widgetId: "w", version: "1.0.0", enabled: true })`
   → one entry with those fields.
2. Upserting the same widgetId replaces the entry (no duplicates).
3. `removeRegistryEntry([...], "w")` removes only that entry.
4. `serverUrl()` returns `localStorage.getItem("anymaps.baseUrl")` when set,
   else `"http://localhost:8000"`; `agentUrl()` likewise with
   `"anymaps.agentUrl"` / `"http://localhost:8001"`; when
   `window.__ANYMAPS_CONFIG__` is set its fields win. (Inject `storage` and
   `win` objects into the helpers so they stay pure: signatures
   `serverUrl(win, storage)`.)

- [ ] **Step 2: install.js**

- `provision(manifest, baseUrl)`: real implementation —
  `fetch(baseUrl + "/widgets/" + manifest.id + "/provision", { method:
  "POST", headers: { "content-type": "application/json" }, body:
  JSON.stringify({ manifest }) })`; non-2xx → throw
  `provision failed: <status> <body.error>`; parse `channelRoutes` and
  return it. Called on every enable (idempotent server-side).
- `startupEnable(manager)`: read registry; for each entry with
  `enabled: true`, fetch
  `GET {baseUrl}/widgets/{id}/versions/{version}/manifest` then `/bundle`
  (bundle as text), then `manager.enable({ manifest, bundleSource,
  baseUrl })`. Failures: `console.error`, keep the other widgets starting.
  Return the list of ids that started.
- Registry writes on install: after fetching manifest + bundle,
  `upsertRegistry` with `enabled: true`, save, then `manager.enable`.
  Disable/uninstall registry writes already live in manager (Task 2) —
  verify and fix only if they deviate from the pinned key/shape.
- `manager.startup()` is already wired to `startupEnable` by Task 2.

- [ ] **Step 3: gallery.js**

- Mount into `#gallery`: a "Widgets" heading, a Refresh button, and a list.
- Load: `fetch(serverUrl() + "/widgets")` → array of
  `{ id, name, version, description, icon }`. Network errors render a
  readable error line in the list.
- Each item: name, description, version, optional icon (render `<img>` only
  when present and non-empty), and controls by state:
  - not installed → Install button → `manager.install(id, version)`; on
    failure render the error message inline.
  - installed + enabled → "Enabled" badge, Disable button, Uninstall
    button.
  - installed + disabled → Enable button (re-installs via install path with
    the stored version — this is the re-enable path that restores the same
    state), Uninstall button.
- Subscribe to `ctx.bus` events `widget-enabled`/`widget-disabled`/
  `widget-uninstalled` → re-render the list from `manager.list()` + server
  data.
- After a successful install, enable happens inside `manager.install` (the
  registry entry is written before enable, per Step 2).

- [ ] **Step 4: Z-order and cleanup completion**

- Verify the manager's enable-order counter and `ctx.reorder` calls happen
  on every enable (including re-enable via gallery) — fix in manager.js only
  if Task 2 deviated (small additive fixes allowed; do not restructure).
- Verify cleanup on disable/uninstall removes markers, polylines, popups,
  panel sections, style elements, geolocation subscription, and camera
  lease, then terminates the worker — against the fixture page by checking
  the map has no leftover layers/sources and the sidebar has no leftover
  sections after disabling.

- [ ] **Step 5: Verify and commit**

```sh
cd client && npm test && npm run build
```
Orchestrator Playwright check against the mock server: publish a widget via
curl, refresh gallery → listed, Install → markers appear, Disable → all
drawn items gone, Enable → markers back with the same persisted state,
Uninstall → registry entry and state key gone; startup re-enable across
reload; second install path from the wizard (Task 7) still pending. Commit:
`feat: add install provisioning and gallery ui`.

---

## Task 7: Wizard panel

**Files (own them):**
- `client/src/ui/wizard.js` (replace stub)
- Create: `client/tests/wizard.test.js`

**Interfaces:**
- Consumes: `ctx` seam; `manager.install`; `agentUrl()` from install.js;
  `#wizard` container from index.html.
- Produces: pure `appendTurn(transcript, message)` and
  `handleWizardResponse(transcript, response)` helpers (tested).

**Spec/contract requirements (reviewers check each against CONTRACTS.md):**
- CONTRACTS.md §15 wizard API (request/response shapes, full-transcript
  resend, clarifying `done:false` with exactly one question, done response
  with `widgetId`/`version`/`manifest`, error bodies `{ error }`, busy state
  under 60s).
- SPEC.md §5.10–5.11 (Agent Service roles; panel relays, auto-installs on
  success).

### Steps

- [ ] **Step 1: Pure helpers + failing tests**

`client/tests/wizard.test.js` first:

1. `appendTurn([], { role: "user", content: "water fountains" })` → one
   message; appending an assistant message after it keeps order; transcript
   array is never mutated (returns a new array).
2. `handleWizardResponse(transcript, { done: false, questions: ["Drinking or decorative?"] })`
   → `{ kind: "clarify", transcript: [...transcript, { role: "assistant",
   content: "Drinking or decorative?" }] }`.
3. `handleWizardResponse(transcript, { done: true, widgetId: "water-
   fountains-nyc", version: "0.1.0", manifest: {...} })` → `{ kind: "done",
   widgetId, version }` and the transcript is unchanged.
4. A response with `done` missing → `{ kind: "error", message: "invalid
   wizard response" }`.

- [ ] **Step 2: wizard.js**

- Mount into `#wizard`: a "Create a widget" heading, a scrollable chat log,
  an input + Send button. The panel is built-in UI, not a widget.
- `transcript` starts `[]`. Send: push `{ role: "user", content }`, render
  the user bubble, set busy (input + button disabled, "Thinking…" line),
  `fetch(agentUrl() + "/wizard/generate", { method: "POST", headers:
  { "content-type": "application/json" }, body: JSON.stringify({ messages:
  transcript }) })` — the FULL transcript every turn, per contract.
- Add a 60s `AbortController` timeout → error bubble
  `wizard timed out after 60s`.
- Non-2xx → render the response body's `error` field (or the status text) as
  an error bubble; transcript keeps the user's message so the user can
  retry or rephrase.
- `done: false` → render the single question as an assistant bubble, keep
  the transcript updated via `handleWizardResponse`, clear busy.
- `done: true` → success bubble, clear busy, then install through the
  generic server: `manager.install(widgetId, version)` (fetch manifest +
  bundle from `serverUrl()`, not the agent URL — the Agent Service already
  published to the generic server). On install failure render the error
  inline. Do not reset the transcript on success until the install succeeds
  (pin: reset transcript after a successful install; on failure keep the
  done state visible with the error).
- No streaming, no markdown rendering beyond plain text bubbles.

- [ ] **Step 3: Verify and commit**

```sh
cd client && npm test && npm run build
```
Orchestrator Playwright check against the mock server: type a prompt → send
→ one clarifying question appears; answer → busy clears, the mock widget
installs, markers appear on the map, network shows the full transcript
resent (assert via the mock server's request log or Playwright network
capture). Commit: `feat: add wizard chat panel with auto install`.

---

## Task 8: Verification checklist page and hardening

**Files (own them):**
- `client/checklist.html`
- `client/checklist/` (one module per check group: `sdk.js`, `render.js`,
  `camera.js`, `geo.js`, `lifecycle.js`, `gallery.js`, `wizard.js`,
  `persistence.js`)
- Touch-ups allowed: `client/README.md` (verification instructions only),
  `client/fixtures/` (extra fixture bundles if a check needs one).

**Interfaces:**
- Consumes: everything. `window.__ANYMAPS_DEV__` from main.js on
  index.html; on checklist.html, build its own manager via `createManager()`
  (import from `src/manager.js`) so checks never depend on the app page.
- Produces: the regression page. PLAN.md section 4 names this Column A's
  verification duty.

**Spec/contract requirements (reviewers check each against CONTRACTS.md):**
- Every row of CONTRACTS.md §4 (commands), §5 (events), §6 (anymaps API),
  §11 (camera revocation matrix), §10 (persistence), §12 (UI arbitration).
- SPEC.md §7 in full, §9.2 (room token flow through state), demo-critical
  flows: three widgets enabled at once (SPEC §3 demo 1) and publish →
  install (SPEC §3 demo 2 backbone).

### Steps

- [ ] **Step 1: Checklist harness**

`checklist.html`: standalone page (own map + sidebar, imports its own
manager). A "Run checks" button and a result list; each check renders
`✅ name` or `❌ name — detail`. Auto-runs on load when
`?auto=1`. A `phase=2` URL flag continues the persistence check after an
auto-reload. Each `checklist/*.js` module exports an async
`run({ manager, page })` returning `{ name, ok, detail }` entries.

- [ ] **Step 2: Check groups (pinned coverage)**

1. `sdk.js` — envelope capture: a capture fixture bundle posts every command
   shape; assert 21 distinct envelopes with correct names/payloads; unique
   ids; an error envelope for an intentionally malformed command; widget
   stays alive after the error.
2. `render.js` — markers (icon emoji + URL, color, label, title, rotation),
   update (move/restyle, no duplicates), remove; polylines (replace vs
   append growth); popups (two widgets, one global open, anchored popup,
   `setPopupContent`, `popup not open` error); panels (two widgets, two
   stacked collapsible sections, `clearPanel`); styles (injected CSS takes
   effect, removed on disable); `anymaps-*` classes present.
3. `camera.js` — the full revocation matrix: preempt by request, preempt by
   pan, ttl (wait ~11s), released, userGesture (simulate via
   `manager`'s lease API or a synthetic dragstart dispatch), badge shows
   name and its button releases; cameraDenied never logged.
4. `geo.js` — grant path (dot appears, `geolocation` event), stop removes
   dot, denial path (`geolocationError` code 1), multi-subscriber refcount.
5. `lifecycle.js` — disable removes every drawn item of that widget only;
   re-enable resumes with the same state; uninstall deletes registry entry
   + state key; re-enabled widget draws on top (z-order).
6. `persistence.js` — `persist` merge, reload with `?phase=2` re-enables
   the widget with the same state (`iid` survives).
7. `gallery.js` — against the mock server: list renders, install enables,
   disable/enable/uninstall cycle, provisioning idempotent (two enables →
   same routes, one worker).
8. `wizard.js` — prompt → clarifying question → answer → done → auto-install
   → markers; full transcript resent (assert request bodies via a fetch
   wrapper); 60s timeout path is optional to run (skip by default, note the
   check).
9. Three-widgets-at-once check: enable three fixture widgets; all three
   panels present, all markers on the map, all workers alive.

- [ ] **Step 3: Hardening pass**

Run the checklist against the mock server. Fix anything it exposes — within
the owning task's files if the fix is local, or file a short findings note
in the report for cross-task bugs the orchestrator routes to the right
worker. Then run the same checklist against the real server when B's is
reachable (`localStorage['anymaps.baseUrl'] = http://localhost:8000`); if B's
server is not up yet, record that as a follow-up item, do not fake it.

- [ ] **Step 4: Verify and commit**

```sh
cd client && npm test && npm run build
```
Orchestrator Playwright run of `checklist.html?auto=1` (both phases): every
check ✅. Commit: `feat: add contract verification checklist page`.

---

## Task order and waves (orchestrator)

Wave 1: Task 1.
Wave 2: Task 2.
Wave 3: Tasks 3, 4, 5 in parallel (file-disjoint by design).
Wave 4: Tasks 6, 7 in parallel (file-disjoint).
Wave 5: Task 8.
Then: whole-branch spec compliance review, then integration options.
