// Status bar (Task 9). The floating "N widgets live" strip over the map.
//
// Contract: SPEC.md 5.1 (the client owns all non-map DOM), 7.10 (lifecycle
// states). The bar is chrome, not a widget: it reads the manager's enabled
// widget list and re-renders on the lifecycle bus events.
//
// Pure helpers (colorFor, summarize) are exported for testing. The DOM
// rendering lives inside register(ctx); it never touches localStorage,
// window, or document at module top level.

const PALETTE = ["#f59e0b", "#22c55e", "#0ea5e9", "#ec4899", "#a855f7"];

// Deterministic palette color for a widgetId. A stable hash means a widget
// keeps its color across re-enables and reloads, independent of enable order.
export function colorFor(widgetId) {
  let hash = 0;
  const s = String(widgetId ?? "");
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  return PALETTE[hash % PALETTE.length];
}

// Turn the enabled-widget list into a render-ready summary. Preserves input
// order (the manager reports enable order). Entries without a widgetId are
// dropped; a missing/empty name falls back to the widgetId.
export function summarize(widgets) {
  const list = Array.isArray(widgets) ? widgets : [];
  const chips = list
    .filter((w) => w && typeof w.widgetId === "string")
    .map((w) => ({
      widgetId: w.widgetId,
      name: typeof w.name === "string" && w.name ? w.name : w.widgetId,
      color: colorFor(w.widgetId),
    }));
  return { count: chips.length, chips };
}

export function register(ctx) {
  if (typeof document === "undefined") return; // non-DOM (tests) -> no-op
  const host = document.getElementById("statusbar");
  if (!host) return;

  function render() {
    const { count, chips } = summarize(ctx.widgets());
    host.replaceChildren();

    const live = document.createElement("span");
    live.className = "anymaps-status-live";
    const dot = document.createElement("span");
    dot.className = "anymaps-status-dot";
    live.append(dot, document.createTextNode("LIVE"));
    host.appendChild(live);

    const badge = document.createElement("span");
    badge.className = "anymaps-status-count";
    badge.textContent = String(count);
    host.appendChild(badge);

    if (count === 0) {
      const hint = document.createElement("span");
      hint.className = "anymaps-status-hint";
      hint.textContent = "install from the gallery";
      host.appendChild(hint);
    } else {
      for (const chip of chips) {
        const el = document.createElement("span");
        el.className = "anymaps-status-chip";
        const chipDot = document.createElement("span");
        chipDot.className = "anymaps-status-chip-dot";
        chipDot.style.background = chip.color;
        const nameEl = document.createElement("span");
        nameEl.className = "anymaps-status-chip-name";
        nameEl.textContent = chip.name;
        el.append(chipDot, nameEl);
        host.appendChild(el);
      }
    }

    host.title =
      count + " widget" + (count === 1 ? "" : "s") + " · " +
      count + " worker" + (count === 1 ? "" : "s") + " · isolated";
  }

  ctx.bus.on("widget-enabled", render);
  ctx.bus.on("widget-disabled", render);
  ctx.bus.on("widget-uninstalled", render);
  render();
}
