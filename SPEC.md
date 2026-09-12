# Map + Widget Application — System Specification

North-star spec for the hackathon build. Keeps the build pointed at the agreed
direction.

Legend used throughout:

- ✅ **Decided** — locked during design. Build to this.
- ⚠️ **Open** — not yet decided. Do not assume. Decide as a first build task.

> Data shapes are ⚠️ Open across the board: the exact JSON of manifests, data
> configs, and render commands has not been approved. This spec describes
> operations and intent only. Do not implement from guessed field names.

---

## 1. Purpose

A customizable map web application. Users add widgets — small, self-contained
extensions that draw live or static data on a shared map. The product revolves
around an SDK that makes widget creation cheap and standardized, for human
developers and AI agents alike.

The demo proves the SDK makes adding a widget cheap, not that many widgets exist.

---

## 2. Context and constraints

- **Event**: 24-hour hackathon, roughly 16 hours hands-on-keyboard.
- **Agents**: AI agents run in parallel for implementation, cost-reasonably.
- **Team**: three undergraduate CS students, generalist. Strong Python. No
  production JS/TS experience, but the team reviews agent-written code.
- **Repo**: greenfield (empty at start).
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
 ├─ WebSocket ── realtime, topic subscription (client→server→broadcast)
 ├─ HTTP REST  ── registry/manifest reads, cached data reads, publish
 └─ Poller      ── fetches external sources on their declared interval, caches
        │
 External APIs / databases (e.g. flight data, bathroom records)
```

Rules that shape everything:

1. A widget never touches the map or the DOM directly. It speaks only through
   the SDK.
2. The server never transforms data. It fetches, caches, and broadcasts.
   All processing and aggregation happen in the widget (client worker).
3. One widget = one Web Worker, one JSON manifest, one JS bundle, and a
   declarative data config. No server code.

---

## 5. Component definitions

### 5.1 Map Client

The frontend wrapper around the map renderer. It owns the map, all DOM outside
the map (side panels, popups, badges), and exposes rendering capability to
widgets exclusively through the SDK. No widget code runs here.

### 5.2 Widget

A self-contained extension. One widget is: a JSON manifest, a JS bundle that
runs in a Web Worker, and a declarative data config describing where its data
comes from. It draws on the map only through the SDK. It contains no server
code.

### 5.3 Widget Runtime

The environment a widget's JS bundle executes in: a dedicated Web Worker per
enabled widget. Isolation means a misbehaving widget cannot freeze the map's
main thread. The worker has no direct map or DOM access; everything crosses the
SDK boundary.

### 5.4 SDK (the boundary)

The typed contract between a widget and the Map Client, in two directions:

- **Widget → Map**: render commands (draw, move, remove, popups, panels,
  camera).
- **Map → Widget**: events (marker clicked, map clicked).

The SDK is the single owner of the map and DOM. This is the most important
interface in the system; its whole job is to define the breadth of what a widget
can express.

### 5.5 WidgetManager

The main-thread runtime. It owns the registry of installed widgets, spawns and
terminates workers, routes events to the correct widget, and owns the map and
DOM. It is the only code that talks to MapLibre directly.

### 5.6 Generic Widget Server

One backend for all widgets. It is a dumb, config-driven pipe:

- reads each widget's data config;
- for external sources: fetches on the declared interval, caches, serves;
- for realtime sources: accepts client messages and broadcasts them to topic
  subscribers.

It never transforms data. This is what preserves breadth while widgets ship no
server code: any processing a widget needs happens in its client worker, not on
the server.

### 5.7 Widget Registry

The server-hosted store of published widgets: manifests plus JS bundles. It
backs a gallery page where users browse and install. Installing pulls a bundle
to the client, starts a worker, and adds the widget to that user's map.

### 5.8 Transport

Two channels:

- **WebSocket** — realtime. Widgets publish and subscribe by topic; the server
  broadcasts messages to subscribers of a topic.
- **HTTP REST** — one-shot reads and writes: fetch registry and manifests, read
  cached polled data, publish a widget.

---

## 6. Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Map renderer | MapLibre GL JS |
| 2 | Widget client execution | Web Worker, one per enabled widget |
| 3 | Server code model | Client-only code + declarative data config (no server code) |
| 4 | Server role | Dumb config-driven pipe; no transforms server-side |
| 5 | Publishing | Server-hosted registry; manifest + JS bundle |
| 6 | Deployment | FastAPI + SQLite, one Docker Compose service |
| 7 | Transport | WebSocket (realtime) + HTTP REST (reads/publish) |
| 8 | Render command style | Imperative typed commands over postMessage |
| 9 | Lifecycle | One worker per widget; WidgetManager owns lifecycle |
| 10 | Camera | Lease model with auto-release (see section 8) |

---

## 7. Render command surface (MVP)

Imperative commands, sent worker → main thread. Each command maps one-to-one to
a MapLibre operation. ⚠️ Payload field names are Open.

**MVP primitives:**

1. **Markers** — add, update, remove. Used for static points (bathrooms) and
   moving points (friends, planes).
2. **Polylines** — add, update, remove. Used for flight paths and movement
   trails.
3. **Popups** — open, close, set content (text or HTML). The Google Maps
   directions link renders inside popup HTML.
4. **Events** — marker click and map click, dispatched to the owning widget.
5. **Info panel** — set the side-bar content a widget controls.

**Stretch**: heatmap (bathroom density).

**Out of scope**: routing. Use a Google Maps directions link inside a popup.

### 7.1 Ownership and event routing

- Widgets assign their own unique string IDs to the things they draw. The SDK
  uses these IDs for update, remove, and events.
- A click on any widget-owned item automatically dispatches to that widget.

---

## 8. Camera control (lease model)

Camera control is not a lock held forever. It is a lease that expires. States:
`FREE` or `LOCKED(owner)`. One owner, never two.

- **Acquire**: a widget calls `requestCameraControl()`. Granted if free, denied
  otherwise. No queue, no forced preemption.
- **Lease**: granted for 10 seconds. Any camera command from the owner renews
  the lease automatically. No heartbeat message.
- **Release — any one of four triggers reclaims the map:**
  1. widget calls `releaseCameraControl()`;
  2. lease TTL expires (catches a hung widget);
  3. worker dies, disables, or uninstalls (catches a crashed widget);
  4. the user drags, zooms, or scrolls the map (catches everything else).
- **UI**: a "Camera: <widget name>" badge with a manual release button while
  locked.

**Camera commands (MVP):**

- `flyTo` — center, zoom, optional bearing. Follows a moving plane.
- `fitBounds` — a southwest and northeast corner. Frames a cluster of points.

---

## 9. Widget lifecycle and concurrency

- One dedicated Worker per enabled widget.
- WidgetManager spawns and terminates workers, routes events, owns map and DOM.
- States: `installed` → `enabled` ⇄ `disabled` → `uninstalled`.
- Disable terminates the worker; enable respawns it.
- No hard resource caps at demo scale (three to four widgets).

---

## 10. Open items (⚠️ decide before/at build, do not assume)

1. **Manifest schema** — the exact fields of a widget manifest. Known intent: it
   identifies the widget, carries a version (plain semver string), references
   the JS bundle, and holds the data config. Field names are Open.
2. **Data-source config schema** — how a widget declares its data. Known intent:
   it expresses at minimum the source location, authentication, refresh/poll
   interval, and whether the data is realtime or polled. Field names are Open.
3. **Render command payloads** — exact field names and types for marker,
   polyline, popup, panel, and camera commands. Operations are locked; shapes
   are Open.
4. **Secret handling** — where API keys live and how the server attaches them to
   external fetches without exposing them to clients. Open.
5. **Topic naming** — how realtime topics/rooms are named and scoped. Open.
6. **AI assistant (stretch)** — what it generates, how it is validated, and how
   it publishes. Open; do not design the core around it.

---

## 11. Out of scope for the MVP

- Heatmap (stretch).
- Routing engine (use Google Maps link instead).
- AI assistant (stretch).
- Docker/Kubernetes per-widget isolation — one generic server covers all widgets.

---

## 12. Glossary

- **Widget** — a self-contained map extension: manifest + JS bundle + data config.
- **SDK** — the typed command/event boundary between widgets and the Map Client.
- **WidgetManager** — main-thread runtime that owns registry, workers, events,
  map, and DOM.
- **Generic Widget Server** — the single, dumb, config-driven backend.
- **Registry** — the store and gallery for published widgets.
- **Realtime source** — data that flows client → server → broadcast (live
  friends).
- **External poll source** — data the server fetches on an interval and caches
  (flight paths).
- **Camera lease** — time-boxed, auto-releasing camera control.
