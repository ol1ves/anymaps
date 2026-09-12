# PLAN.md — team split and build plan (10 hours)

Status: approved. This file is the operating plan. SPEC.md and CONTRACTS.md
are the build targets. No decision in those files changes without a 30-second
group sync. H+0 is the moment this plan is approved.

## 0. Hour-0 status

- Wizard API contract: done. CONTRACTS.md section 15.
- `contracts/manifest.schema.json`: done.
- JavaScript decision: done. Recorded in README.md.
- Environment facts: LLM key open. ADSB.lol and Overpass both answered 200
  from the dev machine.
- Repo scaffold: done. Client, server, and agent hello-worlds run. `pytest`
  passes on shared and server tests.

## 1. Team

Three owners. Not three equal slices. All three demo criteria touch the client
and the server, so those two columns get one dedicated owner each. Everything
else goes to the third person, who doubles as integrator and rehearsal lead.

- A — Map Client owner, about 40 percent. All browser code.
- B — Server owner, about 30 percent. Generic Widget Server plus registry.
- C — Wizard, widgets, and demo owner, about 30 percent. Agent Service, three
  demo widgets, demo script, rehearsal.

This follows SPEC section 15.2 with two changes for the 10-hour clock:

1. A ships the real SDK first, not a mock. A mock SDK exists only inside C's
   dev-runner as insurance if A falls behind.
2. The wizard panel UI code belongs to A, not C, because it lives in the
   client directory. C owns the wizard demo end to end except the panel code.

## 2. Hour 0: close four gaps before code

Do these together. CONTRACTS.md covers the SDK and the HTTP API fully. Four
things are not frozen yet.

1. Wizard API contract between the panel and the Agent Service. Add it to
   CONTRACTS.md. Minimum: `POST /wizard/generate` with `{ prompt }` returns
   `{ done, questions?, manifest?, bundle? }`. No streaming.
2. `contracts/manifest.schema.json` derived from CONTRACTS.md section 7. B
   validates against it. C's generator embeds it. One file, one truth.
3. JavaScript over TypeScript. Plain ES modules with Vite for the client.
   Widgets are classic scripts concatenated with the `anymaps` runtime and run
   from a blob worker. No build step for widgets.
4. Environment facts. Confirm a working LLM key, ADSB.lol and Overpass
   reachability, and the serve plan. The client on `localhost` gives the
   secure context geolocation needs. Two browser profiles on one machine
   cover the second-user demo.

## 3. Repo layout and ownership

One git repository, monorepo, main branch only. Directories have owners.
Columns never touch the same files.

```
anymaps/
├── SPEC.md  CONTRACTS.md  PLAN.md
├── docker-compose.yml          B owns (server + agent services)
├── contracts/                  frozen after hour 0
│   └── manifest.schema.json
├── shared/                     B owns
│   ├── ssrf.py                 same rules for poller and source test
│   └── schema.py               loads the manifest schema
├── client/                     A owns
│   ├── index.html  vite.config.js
│   └── src/
│       ├── sdk/anymaps.js      the runtime, prepended to bundles
│       ├── manager.js  camera.js  geo.js
│       ├── ui/                 panels, popups, gallery, wizard panel
│       └── main.js
├── server/                     B owns
│   ├── app/                    main, registry, provision, channels,
│   │                           filter, poller, ssrf, secrets
│   └── tests/                  contract tests from CONTRACTS.md 8-9
├── agent/                      C owns
│   ├── app/                    main, clarify, source_test, generator
│   └── templates/              manifest.j2, bundle.js.j2
├── widgets/                    C owns
│   ├── bathrooms/  friends/  flights/
│   └── dev/runner.html         optional mock-SDK runner
└── docs/demo.md                C owns: rehearsal script
```

Ownership rules:

1. A owns `client/`.
2. B owns `server/`, `shared/`, and `docker-compose.yml`.
3. C owns `agent/`, `widgets/`, and `docs/demo.md`.
4. `contracts/` freezes after hour 0. Changes need a group sync.
5. Nobody edits outside their column.

## 4. Git and agent rules

1. Main branch only. Push often. Tag `demo-stable` after each passing
   rehearsal.
2. Agents implement against CONTRACTS.md only. Never against another column's
   live code.
3. Each owner reviews their column's diffs and runs verification:
   - B: pytest contract tests from CONTRACTS.md sections 8 and 9.
   - A: browser checklist page.
   - C: demo script in `docs/demo.md`.

## 5. Column scope and delivery order

### A — Map Client

All browser code: WidgetManager, the `anymaps` runtime, MapLibre integration,
camera lease, geolocation proxy, events, popups, panels, styles, persistence,
cleanup, gallery UI, wizard panel UI. No other duties.

- H+1: SDK README defining how a widget bundle is written.
- H+2: client skeleton, real SDK, markers working.
- H+4: camera, geolocation, `viewportChanged`, full command set.
- H+6: gallery and wizard panel.

### B — Server

FastAPI plus SQLite: publish and validation, gallery, idempotent
provisioning, instances, channel handlers, filter engine with JMESPath
mapping, poller with SSRF rules, secrets, CORS, docker-compose, contract
tests.

- H+2: registry with validation.
- H+4: channels, instances, filter.
- H+6: poller, secrets, hardening.

### C — Wizard, widgets, demo

Agent Service (clarify loop, source test, generator, publish), the three demo
widgets, the demo script, the second-user flow, all rehearsals.

- H+3: Agent Service.
- H+4: bathrooms widget.
- H+5: friends widget.
- H+6: flights widget.
- H+7: demo script.
- H+8 to H+10: rehearsal. After H+6, floats to the riskiest column.

## 6. Why this shape

Three equal slices fail. One demo per person means three people editing the
SDK, the server core, and compose at once. That is the interface chaos SPEC
section 15 names as the historical failure mode.

A is oversized on purpose. All three demos bottleneck on the client, so
splitting A costs more coordination than it saves.

C is lightest on code on purpose. Integration and rehearsal fill the last two
hours, and one person must be free for them.

## 7. Timeline

1. H+0 to H+1: review CONTRACTS.md together, close the four gaps, scaffold
   the repo, run hello-worlds.
2. H+1 to H+3: build in parallel. A does the SDK. B does the registry. C does
   the Agent Service and starts bathrooms against the frozen signatures.
3. H+3: checkpoint. Walking skeleton. A's client draws bathrooms data through
   B's real server.
4. H+3 to H+6: A finishes camera, geolocation, and UI. B finishes channels,
   poller, and filter. C finishes friends and flights.
5. H+6: checkpoint. Three widgets live on one client. Publish and install
   works between two browsers. The wizard runs end to end once, rough.
6. H+6 to H+8: harden, integrate, polish the wizard. C rehearses demo 2.
7. H+8 to H+9: first full dress rehearsal of all three demos. Collect fixes.
8. H+9 to H+10: fixes, second rehearsal, final run, tag `demo-stable`.

## 8. Cut order when time runs out

1. Wizard clarifying loop. Fall back to a one-shot prompt with a fixed
   question set.
2. Flights trail via `?ids=`. Keep live planes only.
3. Second-user flow. Pre-enable the widget on browser 2 before the demo.
4. Camera lease polish, icons, panel styling.

Never cut: three widgets running at once (demo 1) and publish with
auto-install (the backbone of demos 2 and 3).
