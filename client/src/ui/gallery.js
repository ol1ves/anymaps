// Gallery UI (Task 6). Contract: CONTRACTS.md section 8 (GET /widgets),
// section 12 (UI arbitration), section 13 (install = fetch manifest +
// bundle); SPEC.md section 7.10 (lifecycle states), section 13.
//
// register(ctx) mounts the gallery into #gallery: a heading, a Refresh
// button, and a list of published widgets. Each item shows name,
// description, version, and an optional icon, plus controls by state:
//   - not installed      -> Install button -> ctx.manager.install(id, version)
//   - installed + enabled -> "Enabled" badge, Disable, Uninstall
//   - installed + disabled -> Enable (re-install path), Uninstall
// It subscribes to ctx.bus events widget-enabled / widget-disabled /
// widget-uninstalled and re-renders from ctx.manager.list() + server data.
// Styling lives in src/styles.css under the anymaps-gallery-* classes.

import { serverUrl } from "../install.js";

const REGISTRY_KEY = "anymaps.registry";

function readRegistry(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(REGISTRY_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function makeIcon(img) {
  if (!isNonEmptyString(img)) return null;
  const el = document.createElement("img");
  el.className = "anymaps-gallery-icon";
  el.src = img;
  el.alt = "";
  el.width = 20;
  el.height = 20;
  return el;
}

export function register(ctx) {
  const root = document.getElementById("gallery");
  if (!root) return;

  let serverList = [];   // [{ id, name, version, description, icon }]
  let serverError = null;
  let pending = new Set(); // widgetIds with an install in flight

  function registryById() {
    const reg = readRegistry(localStorage);
    const map = new Map();
    for (const e of reg) map.set(e.widgetId, e);
    return map;
  }

  async function load() {
    const url = serverUrl(window, localStorage) + "/widgets";
    try {
      const res = await fetch(url);
      if (!res.ok) {
        serverError = "gallery: list " + res.status;
        serverList = [];
      } else {
        const arr = await res.json();
        serverList = Array.isArray(arr) ? arr : [];
        serverError = null;
      }
    } catch (e) {
      serverError = "gallery: network error";
      serverList = [];
    }
    render();
  }

  function render() {
    root.replaceChildren();

    const heading = document.createElement("h2");
    heading.className = "anymaps-gallery-heading";
    heading.textContent = "Widgets";
    root.appendChild(heading);

    const refresh = document.createElement("button");
    refresh.textContent = "Refresh";
    refresh.className = "anymaps-gallery-refresh";
    refresh.addEventListener("click", () => load());
    root.appendChild(refresh);

    const list = document.createElement("ul");
    list.className = "anymaps-gallery-list";
    root.appendChild(list);

    if (serverError) {
      const li = document.createElement("li");
      li.className = "anymaps-gallery-list-error";
      li.textContent = serverError;
      list.appendChild(li);
      return;
    }

    if (serverList.length === 0) {
      const li = document.createElement("li");
      li.className = "anymaps-gallery-list-empty";
      li.textContent = "No widgets published.";
      list.appendChild(li);
      return;
    }

    const reg = registryById();

    for (const item of serverList) {
      const li = document.createElement("li");
      li.className = "anymaps-gallery-item anymaps-widget-" + item.id;

      const icon = makeIcon(item.icon);
      if (icon) li.appendChild(icon);

      const body = document.createElement("div");
      body.className = "anymaps-gallery-body";

      const name = document.createElement("div");
      name.className = "anymaps-gallery-name";
      name.textContent = item.name || item.id;
      body.appendChild(name);

      if (isNonEmptyString(item.description)) {
        const desc = document.createElement("div");
        desc.className = "anymaps-gallery-desc";
        desc.textContent = item.description;
        body.appendChild(desc);
      }

      const meta = document.createElement("div");
      meta.className = "anymaps-gallery-meta";
      meta.textContent = "v" + (item.version || "?");
      body.appendChild(meta);

      const entry = reg.get(item.id);
      const installed = !!entry;
      const enabled = !!(entry && entry.enabled);
      const inFlight = pending.has(item.id);

      const controls = document.createElement("div");
      controls.className = "anymaps-gallery-controls";

      function addBtn(label, onClick, opts = {}) {
        const b = document.createElement("button");
        b.textContent = label;
        b.className = "anymaps-gallery-btn";
        if (opts.danger) b.classList.add("anymaps-gallery-btn--danger");
        b.addEventListener("click", onClick);
        controls.appendChild(b);
        return b;
      }

      function addBadge(text) {
        const span = document.createElement("span");
        span.textContent = text;
        span.className = "anymaps-gallery-badge";
        controls.appendChild(span);
      }

      function addErr(msg) {
        const span = document.createElement("span");
        span.textContent = msg;
        span.className = "anymaps-gallery-error";
        controls.appendChild(span);
      }

      if (inFlight) {
        addBadge("Installing…");
      } else if (!installed) {
        addBtn("Install", async () => {
          pending.add(item.id);
          render();
          try {
            await ctx.manager.install(item.id, item.version);
          } catch (e) {
            // Re-render the full item first so the controls are back in
            // the DOM (the in-flight state showed only a badge), then
            // append the inline error.
            pending.delete(item.id);
            render();
            renderErrFor(item.id, e.message || "install failed");
            return;
          }
          pending.delete(item.id);
          // bus "widget-enabled" re-renders; guard render in case no event.
          render();
        });
      } else if (enabled) {
        addBadge("Enabled");
        addBtn("Disable", () => ctx.manager.disable(item.id));
        addBtn("Uninstall", () => ctx.manager.uninstall(item.id), { danger: true });
      } else {
        // Re-enable uses the stored registry version, not the listed server
        // version (the brief pins "re-installs via install path with the
        // stored version"). Falls back to the listed version only when the
        // registry has no entry.
        const storedVersion = (entry && entry.version) || item.version;
        addBtn("Enable", async () => {
          pending.add(item.id);
          render();
          try {
            await ctx.manager.install(item.id, storedVersion);
          } catch (e) {
            // Re-render the full item first so the controls are back in
            // the DOM (the in-flight state showed only a badge), then
            // append the inline error.
            pending.delete(item.id);
            render();
            renderErrFor(item.id, e.message || "enable failed");
            return;
          }
          pending.delete(item.id);
          render();
        });
        addBtn("Uninstall", () => ctx.manager.uninstall(item.id), { danger: true });
      }

      body.appendChild(controls);
      li.appendChild(body);
      list.appendChild(li);
    }
  }

  // Render an inline error for a single item without refetching the list.
  function renderErrFor(id, msg) {
    const li = root.querySelector(".anymaps-widget-" + CSS.escape(id));
    if (!li) return;
    const controls = li.querySelector(".anymaps-gallery-btn")
      ? li.querySelector(".anymaps-gallery-btn").parentElement
      : null;
    if (!controls) return;
    const span = document.createElement("span");
    span.className = "anymaps-gallery-error";
    span.textContent = msg;
    controls.appendChild(span);
  }

  function refresh() { load(); }

  ctx.bus.on("widget-enabled", refresh);
  ctx.bus.on("widget-disabled", refresh);
  ctx.bus.on("widget-uninstalled", refresh);

  // Initial render (empty) then load from the server.
  render();
  load();
}
