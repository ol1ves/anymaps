# Demo widgets (Column C)

One folder per widget: one manifest JSON plus one JS bundle. Bundles are
classic scripts (no imports). The WidgetManager prepends the `anymaps`
runtime and runs the result in a blob worker.

- `bathrooms/` — Overpass external read, snapshot, `bounds` filter.
- `friends/` — client write + client read, private, instances.
- `flights/` — ADSB.lol external read, series, `@ingestedAt`, `latest`, trail.

`dev/runner.html` is the optional mock-SDK runner for developing widgets
without the real client. It exists only as insurance if Column A falls behind
(PLAN.md section 1).
