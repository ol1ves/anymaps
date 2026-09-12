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
