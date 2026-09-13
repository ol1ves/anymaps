# Column A Roadmap — Map Client

Read this when you are tired. Work in order. Each task lists what done
looks like. Build target: CONTRACTS.md sections 2–12 (SDK, camera, HTTP)
and section 15 (wizard API). SPEC.md explains why.

## What you own

- `client/` only. All browser code: WidgetManager, `anymaps` runtime,
  MapLibre integration, camera lease, geolocation proxy, events, popups,
  panels, styles, persistence, cleanup, gallery UI, wizard panel UI.
- Your test fixture bundle lives in `client/fixtures/`. C owns the three
  demo widgets in `widgets/`. Do not edit those.

## What you never touch

- `server/`, `shared/`, `agent/`, `widgets/`, `contracts/`, `docs/`,
  `docker-compose.yml`. Owned by B and C.
- No signature changes in CONTRACTS.md without a 30-second group sync.

## Ports

- Client: 5173. Server: 8000. Agent: 8001. Server CORS must allow 5173.

## Contract traps (re-read when stuck)

1. The SDK uses `lat` and `lng` everywhere. MapLibre uses `[lng, lat]`.
   Translate at the boundary only, never in widget code.
2. Commands are fire-and-forget. A bad command gets an `error` envelope
   that echoes its `id`. Errors never crash a widget.
3. Envelope: `v` is always 1. `kind` is `init`, `cmd`, `event`, or `error`.
4. A worker has no map, DOM, or storage access. The main thread does all
   of that work for it.
5. Workers fetch their own data. The main thread never proxies HTTP.
6. One popup open globally. Panels stack as collapsible sidebar sections.
7. Z-order: later-enabled widgets draw on top.
8. On disable or uninstall, remove every item that widget drew, plus its
   panel and style element. Then terminate the worker. State survives
   disable; uninstall deletes the registry entry and the state key.
9. `viewportChanged` is suppressed for the widget that issued the camera
   command.

---

## Phase 0 — Baseline (15 min)

Do: `npm install`, `npm run dev`, check the map and hello marker render.

- [ ] Page at localhost:5173 shows a map and one marker.
- [ ] Geotarget: geolocation prompts work on localhost (secure context).

## Phase 1 — SDK runtime (H+1)

### Task 1.1: The `anymaps` runtime

File: `src/sdk/anymaps.js`. This file gets prepended to every widget
bundle before the blob worker starts. Widget authors write against it,
never against raw `postMessage`.

Do, per CONTRACTS.md section 6:

1. Implement `ready()` — resolves to `{ config, state }` after the init
   message arrives.
2. Expose `config` and `state`.
3. Implement all 21 command helpers: `addMarker`, `updateMarker`,
   `removeMarker`, `addPolyline`, `updatePolyline`, `removePolyline`,
   `openPopup`, `closePopup`, `setPopupContent`, `setPanel`,
   `clearPanel`, `setStyles`, `persist`, `requestCameraControl`,
   `releaseCameraControl`, `flyTo`, `jumpTo`, `fitBounds`,
   `startGeolocation`, `stopGeolocation`.
4. Assign a unique `id` to each sent command.
5. Implement `on` and `off`. Route `event` messages to handlers and
   `error` messages to an error handler.

Success criteria:

- [ ] A fixture worker calling every helper sends one well-formed
      envelope per call: `{ v:1, kind:"cmd", id, name, payload }`.
- [ ] A malformed command in the worker yields an `error` envelope with
      the echoed `id`; the worker stays alive.
- [ ] `ready()` blocks until init and resolves with `{ config, state }`.

### Task 1.2: SDK README

Do: extend `client/README.md` with the widget authoring guide: the bundle
skeleton, `ready()`, the command list, the event list, `persist`, and the
room-token flow (`POST /instances` then `persist({ iid })`).

- [ ] C can write a widget bundle from this README without asking you.

## Phase 2 — Manager core and markers (H+2)

### Task 2.1: Worker bootstrap and init handshake

File: `src/manager.js`.

Do:

1. Implement `enable(widgetId, version, manifest)`.
2. Concatenate the runtime source with the bundle source and start it as
   a Blob worker.
3. Post one init message: `{ v, kind:"init", protocolVersion:1,
   widgetId, baseUrl, channelRoutes, state }` per CONTRACTS.md section 3.
4. Reject a bundle whose `protocolVersion` is not 1, with a clear error.

Success criteria:

- [ ] One dedicated Worker per enabled widget. Enabling twice does not
      spawn two workers for the same widget.
- [ ] The worker receives exactly one init message with the right fields.
- [ ] A protocol mismatch rejects the bundle with a visible error and
      starts no worker.

### Task 2.2: Command router and markers

Do:

1. Route incoming `cmd` envelopes by `name`.
2. Implement `addMarker`, `updateMarker`, `removeMarker`.
3. Handle `icon` (emoji or image URL), `color`, `label` (badge text),
   `title` (tooltip), `rotation` (CSS transform, clockwise from north).
4. Translate `lat`/`lng` to `[lng, lat]` here and nowhere else.
5. Send an `error` envelope with the echoed `id` for a malformed payload.

Success criteria:

- [ ] Markers render at the correct positions.
- [ ] `updateMarker` moves and restyles a marker without duplicates.
- [ ] `removeMarker` deletes it.
- [ ] A command with a missing required field sends an `error` envelope
      with the echoed `id`; the widget keeps running.

### Task 2.3: Test fixture bundle

Do: write a small bundle in `client/fixtures/` that draws and moves
markers on a timer. This is your dev harness, not a demo widget.

- [ ] `npm run dev` shows fixture markers without touching C's widgets.

## Phase 3 — Full render surface (H+3)

### Task 3.1: Polylines

Do: `addPolyline`, `updatePolyline` (`points` replaces, `append` adds to
the end), `removePolyline`. Handle `color` and `width`.

- [ ] A trail grows via `append` without flicker.
- [ ] `removePolyline` cleans it up.

### Task 3.2: Popups

Do: `openPopup` (standalone `lat`/`lng` or `anchorMarkerId`),
`closePopup`, `setPopupContent`.

- [ ] Two widgets open popups; only the newest stays open.
- [ ] An anchored popup opens at its marker. (No tracking; that is out
      of scope.)

### Task 3.3: Panels and styles

Do: `setPanel` and `clearPanel` per widget, stacked as collapsible
sections in the shared sidebar. `setStyles` injects into a per-widget
`<style>` element. Add the `anymaps-panel`, `anymaps-popup`, and
`anymaps-widget-<id>` classes.

- [ ] Two widgets get two stacked panel sections.
- [ ] Styles inject as-is and do not break other widgets' markup.

### Task 3.4: Persistence

Do: `localStorage` keys `anymaps.registry` and `anymaps.state.<widgetId>`
on the main thread. `persist` deep-merges the partial into the state key.

- [ ] Reload re-enables every `enabled` widget with the same state
      (an `iid` survives a reload).
- [ ] `persist` merges nested fields without clobbering.

## Phase 4 — Events, camera, geolocation (H+3–H+4)

### Task 4.1: Event routing

Do: `markerClick` to the owning widget only. `mapClick` to all widgets.

- [ ] A click on a fixture marker fires in the right worker with the
      right `markerId`.

### Task 4.2: viewportChanged

Do: fire debounced on MapLibre `moveend`, on user drag/zoom/scroll, and
on another widget's camera command. Suppress for the issuing widget.
Payload: `bounds` `[[south,west],[north,east]]`, `center` `[lat,lng]`,
`zoom`.

- [ ] Widget A issues `flyTo`; widget B gets `viewportChanged`; A does
      not.

### Task 4.3: Camera lease

File: `src/camera.js`. Per CONTRACTS.md section 11.

Do:

1. Pan: `flyTo`, `jumpTo`, `fitBounds` for any widget, no lease. The
   most recent command wins.
2. Follow: `requestCameraControl` and `releaseCameraControl`. States
   `FREE` or `LOCKED(owner)`. One owner only.
3. Preempt on request (last-request-wins).
4. Lease TTL 10 seconds. Owner camera commands renew. No heartbeat.
5. Six revocation triggers: released, ttl, worker death (no message
   possible), userGesture, preempted by request, preempted by pan.
6. A pan from a non-owner while locked revokes the lease and wins.
7. Show a "Camera: <widget name>" badge with a manual release button
   while locked.

Success criteria:

- [ ] Two widgets request control; the second wins, the first gets
      `cameraRevoked` with reason `preempted`.
- [ ] Owner jumps every 5 seconds: lease stays. Owner goes quiet: ttl
      fires after 10 seconds.
- [ ] User drags the map: owner gets reason `userGesture`.
- [ ] `releaseCameraControl` fires reason `released`.
- [ ] The badge shows while locked; its button releases.

### Task 4.4: Geolocation proxy

File: `src/geo.js`.

Do: `startGeolocation` begins a `watchPosition` on the main thread.
`stopGeolocation` ends it. Fire `geolocation` per fix and
`geolocationError` on denial, timeout, or unavailability. Draw the native
user-location dot while a watch is active.

- [ ] The dot appears, tracks fixes, and disappears on stop.
- [ ] Denied permission sends `geolocationError` with code 1 and a
      readable message.
- [ ] The dot is drawn by the manager, not as a widget marker.

## Phase 5 — Provisioning and real server (H+4–H+5)

Needs B's server up. Until then, use a stub `baseUrl`.

### Task 5.1: Provision on enable

Do: `POST /widgets/{id}/provision` with the manifest. Use the returned
`channelRoutes` in the init message. Call it on every enable; it is
idempotent.

### Task 5.2: Install path

Do: fetch `/widgets/{id}/versions/{version}/manifest` and `/bundle`.
Write the registry entry. This path serves the gallery and the wizard.

### Task 5.3: Walking skeleton (H+3 checkpoint)

Do: C's bathrooms widget runs on your client against B's real server.

- [ ] Markers from server data draw on the map.
- [ ] The same widget enables in a second browser without errors
      (idempotent provisioning).

## Phase 6 — Gallery, lifecycle, cleanup (H+5–H+6)

### Task 6.1: Gallery UI

Do: a sidebar gallery listing `GET /widgets` results. Install button runs
the Phase 5.2 path and enables the widget. Show enabled and disabled
states with enable, disable, and uninstall controls.

### Task 6.2: Cleanup

Do: track every drawn id per widget. On disable or uninstall, remove all
markers, polylines, popups, the panel, and the style element, then
terminate the worker.

- [ ] Disabling flights removes everything flights drew; other widgets
      are untouched.
- [ ] Re-enable resumes with the same state (the same `iid`).

### Task 6.3: Z-order

Do: later-enabled widgets draw on top, per enable order.

- [ ] Re-enabling a widget moves it to the top.

## Phase 7 — Wizard panel UI (H+6)

The wizard panel is built-in chat UI, not a widget.

### Task 7.1: Chat UI

Do: `POST /wizard/generate` with `{ messages }` per CONTRACTS.md section
15. Resend the full transcript on every turn. Show the single question
from a clarifying response. Show a busy state while waiting. Show error
bodies from 400/500 responses in the chat.

### Task 7.2: Auto-install

Do: on `done`, take `widgetId` and `version`, run the same install path
as the gallery, and enable the widget.

- [ ] A prompt yields a clarifying question; the answer yields a live
      widget with markers on the map.
- [ ] The network tab shows the full transcript resent each turn.

## Phase 8 — Harden and verify (H+6–H+8)

### Task 8.1: Verification checklist page

Do: a `client/checklist.html` page that exercises the contract: all 21
commands, all 8 events, the camera revocation matrix, persistence across
reload, cleanup on disable, gallery install, wizard flow. This is your
verification duty from PLAN.md section 4.

- [ ] One page, about two minutes, catches regressions after each
      integration.

### Task 8.2: Integration

Do: fix bugs with B and C as the three widgets go live. Support the
second-browser demo (two browser profiles, both localhost:5173).

### Task 8.3: Rehearsal

Do: attend C's rehearsals, fix only what the demo shows. Tag
`demo-stable` after a passing run.

## Cut order (when time runs out)

Cut in this order, per PLAN.md section 8:

1. Wizard clarifying loop: one-shot prompt with fixed questions.
2. Flights trail via `?ids=`: live planes only.
3. Second-user flow: pre-enable the widget on browser 2.
4. Camera lease polish, icons, panel styling.

Never cut: three widgets at once (demo 1) and publish with auto-install
(demos 2 and 3).

## Time targets

- H+1: Task 1.1 and 1.2 done.
- H+2: Phase 2 done; markers working.
- H+4: Phase 4 done; full command set, camera, geolocation.
- H+6: Phase 6 and 7 done; gallery and wizard panel.
- H+8: Phase 8 done; demo rehearsals with C.
