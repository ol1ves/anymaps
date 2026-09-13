// Tests for statusbar pure helpers (Task 9). Pure, no DOM, no localStorage.
//
// The status bar is the floating "N widgets live" strip over the map. The
// DOM rendering lives in register(ctx) and is exercised by the browser
// checklist; here we cover the pure exports:
//   colorFor(widgetId) — deterministic palette color per widget.
//   summarize(widgets) — { count, chips } from the enabled-widget list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { colorFor, summarize } from "../src/ui/statusbar.js";

test("colorFor returns a stable hex color for a widgetId", () => {
  const first = colorFor("find-my-friends");
  const second = colorFor("find-my-friends");
  assert.equal(first, second);
  assert.match(first, /^#[0-9a-f]{6}$/i);
});

test("summarize returns count and chips in input order", () => {
  const out = summarize([
    { widgetId: "nyc-bathrooms", name: "NYC Public Bathrooms" },
    { widgetId: "flights-nyc", name: "Flights NYC" },
  ]);
  assert.equal(out.count, 2);
  assert.deepEqual(
    out.chips.map((c) => c.widgetId),
    ["nyc-bathrooms", "flights-nyc"],
  );
  assert.deepEqual(
    out.chips.map((c) => c.name),
    ["NYC Public Bathrooms", "Flights NYC"],
  );
});

test("summarize assigns a color to every chip", () => {
  const out = summarize([
    { widgetId: "a", name: "A" },
    { widgetId: "b", name: "B" },
  ]);
  for (const chip of out.chips) {
    assert.match(chip.color, /^#[0-9a-f]{6}$/i);
  }
});

test("summarize empty input yields zero chips", () => {
  assert.deepEqual(summarize([]), { count: 0, chips: [] });
  assert.deepEqual(summarize(), { count: 0, chips: [] });
});

test("summarize falls back to widgetId when name is missing", () => {
  const out = summarize([{ widgetId: "solo" }]);
  assert.equal(out.count, 1);
  assert.equal(out.chips[0].name, "solo");
});

test("summarize skips entries without a widgetId", () => {
  const out = summarize([
    { name: "orphan" },
    { widgetId: "real", name: "Real" },
  ]);
  assert.equal(out.count, 1);
  assert.equal(out.chips[0].widgetId, "real");
});
