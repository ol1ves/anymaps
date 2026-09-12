# anymaps

Customizable map web application. Users add widgets, small self-contained
extensions that draw live or static data on a shared map.

Read first: `SPEC.md` (why), `CONTRACTS.md` (the wire contract), `PLAN.md`
(team split, timeline, cut order). Onboarding needs no other files.

## Layout

- `client/` — Map Client, WidgetManager, the `anymaps` SDK. Column A.
- `server/` — Generic Widget Server plus registry. FastAPI + SQLite. Column B.
- `agent/` — Agent Service, the wizard backend. Column C.
- `shared/` — SSRF rules and manifest schema loader. Column B.
- `contracts/` — `manifest.schema.json`, frozen.
- `widgets/` — the three demo widgets. Column C.
- `docs/demo.md` — rehearsal script. Column C.

## Decisions from hour 0

- Plain JavaScript, no TypeScript. Client is Vite + vanilla JS. Widgets are
  classic scripts concatenated with the `anymaps` runtime into a blob worker.
- Wizard API contract: CONTRACTS.md section 15.
- Ports: client 5173, server 8000, agent 8001. The client on `localhost` is a
  secure context, so geolocation works.

## Run

Client:

```sh
cd client
npm install
npm run dev      # http://localhost:5173
```

Server and agent, from the repo root:

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r server/requirements.txt -r agent/requirements.txt
uvicorn server.app.main:app --reload --port 8000
uvicorn agent.app.main:app --reload --port 8001
```

Or both services with Docker:

```sh
cp .env.example .env   # fill WIZARD_LLM_API_KEY
docker compose up --build
```

## Tests

```sh
source .venv/bin/activate
pytest
```

## Second-user demo

Two browser profiles on one machine, both pointed at `localhost:5173`.
That covers the install-and-run demo without a second device.

## Open items (team)

- [ ] Working LLM key in `.env` (`WIZARD_LLM_API_KEY`).
- [ ] Confirm ADSB.lol and Overpass reachability from the demo network.
      Both answered 200 from the dev machine at hour 0.
