// Theme controller (dark mode). Owns the light/dark toggle in #theme-toggle,
// the data-theme attribute on <html>, and the basemap style swap.
//
// Scope (ratified): chrome only. anymaps themes its own shell and the basemap
// style. Widget-authored content and widget CSS are never restyled here;
// widgets opt into dark via [data-theme] selectors (see client/README.md).
//
// The map swaps OpenFreeMap bright (light) <-> liberty (dark). MapLibre
// setStyle() wipes widget GeoJSON layers, so polylines.js exposes
// ctx.reapplyPolylines() to re-add them after the new style loads. Markers
// and popups are DOM and survive the swap untouched.

const STORAGE_KEY = "anymaps.theme";

const STYLES = {
  light: "https://tiles.openfreemap.org/styles/bright",
  dark: "https://tiles.openfreemap.org/styles/liberty",
};

// Saved explicit choice, or null when the user has not toggled yet.
function readSaved() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

function systemTheme() {
  if (
    typeof window !== "undefined" &&
    window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }
  return "light";
}

// Saved choice wins; otherwise follow the OS. Used by the manager to pick the
// initial basemap style before the theme module registers.
export function resolveTheme() {
  return readSaved() || systemTheme();
}

export function mapStyleFor(theme) {
  return STYLES[theme] || STYLES.light;
}

export function register(ctx) {
  if (typeof document === "undefined") return; // non-DOM (tests) -> no-op

  const root = document.documentElement;
  const toggle = document.getElementById("theme-toggle");
  if (!toggle) return;

  const map = ctx.map;
  // The manager created the map with mapStyleFor(resolveTheme()), so the map
  // and the initial theme start in agreement.
  let mapTheme = resolveTheme();

  function effectiveTheme() {
    return readSaved() || systemTheme();
  }

  function renderToggle(theme) {
    const dark = theme === "dark";
    toggle.setAttribute("aria-pressed", String(dark));
    toggle.setAttribute(
      "aria-label",
      dark ? "Switch to light theme" : "Switch to dark theme",
    );
  }

  function syncMap(theme) {
    if (theme === mapTheme) return;
    mapTheme = theme;
    map.setStyle(mapStyleFor(theme));
    // styledata fires once the replacement style has loaded. Re-add the
    // widget polylines that setStyle destroyed. Reapply is idempotent.
    map.once("styledata", () => {
      if (ctx.reapplyPolylines) ctx.reapplyPolylines();
    });
  }

  function apply(theme, { persist = false } = {}) {
    root.setAttribute("data-theme", theme);
    renderToggle(theme);
    syncMap(theme);
    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, theme);
      } catch (e) {
        /* ignore */
      }
    }
  }

  // Bring the DOM and toggle in line with the initial theme. The inline head
  // script already set data-theme before paint; this is idempotent.
  apply(effectiveTheme());

  // Follow the OS theme until the user makes an explicit choice.
  const mq =
    window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  if (mq && mq.addEventListener) {
    mq.addEventListener("change", () => {
      if (readSaved()) return; // explicit choice wins
      apply(systemTheme());
    });
  }

  toggle.addEventListener("click", () => {
    const next =
      root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    apply(next, { persist: true });
  });
}
