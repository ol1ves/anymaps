// Sidebar panel sections (Task 3). Contract: CONTRACTS.md section 4 (panel
// rows), section 12 (one collapsible section per widget, stacked vertically,
// classes anymaps-panel / anymaps-widget-<id>), SPEC.md section 7.11.
//
// register(ctx) wires setPanel/clearPanel. Each widget gets one
// <details class="anymaps-panel anymaps-widget-<id>"> with a <summary>
// (title) and a content div (raw innerHTML). Title precedence:
// payload.title if present, else the existing title if the section exists,
// else ctx.widgetName(widgetId). New sections start open (<details open>).

import { setPanel as validateSetPanel } from "../validate.js";

export function register(ctx) {
  const host = document.getElementById("panel-host");
  // widgetId -> section element
  const sections = new Map();
  const cleanupRegistered = new Set();

  function sectionFor(widgetId) {
    let el = sections.get(widgetId);
    if (!el) {
      el = document.createElement("details");
      el.className = "anymaps-panel anymaps-widget-" + widgetId;
      el.open = true; // new sections start open
      const summary = document.createElement("summary");
      summary.className = "anymaps-panel-header";
      summary.textContent = ctx.widgetName(widgetId);
      const body = document.createElement("div");
      body.className = "anymaps-panel-body";
      body.addEventListener("click", (event) => {
        const control = event.target.closest("[data-anymaps-action]");
        if (!control || !body.contains(control)) return;
        if (control.closest("form")) return;
        event.preventDefault();
        const input = body.querySelector("[name=roomToken]");
        const name = body.querySelector("[name=displayName]");
        ctx.emit(widgetId, "panelAction", {
          action: control.getAttribute("data-anymaps-action"),
          value: control.value ?? "",
          roomToken: input ? input.value : "",
          displayName: name ? name.value : "",
        });
      });
      body.addEventListener("submit", (event) => {
        const form = event.target.closest("form[data-anymaps-action]");
        if (!form || !body.contains(form)) return;
        event.preventDefault();
        const input = form.querySelector("[name=roomToken]");
        const name = form.querySelector("[name=displayName]");
        ctx.emit(widgetId, "panelAction", {
          action: form.getAttribute("data-anymaps-action"),
          roomToken: input ? input.value : "",
          displayName: name ? name.value : "",
        });
      });
      el.append(summary, body);
      sections.set(widgetId, el);
      // Register cleanup once per widget (idempotent under re-enable).
      if (!cleanupRegistered.has(widgetId)) {
        cleanupRegistered.add(widgetId);
        ctx.registerCleanup(widgetId, () => {
          const s = sections.get(widgetId);
          if (s) s.remove();
          sections.delete(widgetId);
          cleanupRegistered.delete(widgetId);
        });
      }
    }
    if (host && !el.isConnected) host.appendChild(el);
    return el;
  }

  ctx.registerCommand("setPanel", (payload, widgetId) => {
    const err = validateSetPanel(payload);
    if (err) throw new Error(err);
    const el = sectionFor(widgetId);
    const summary = el.querySelector(".anymaps-panel-header");
    // Title precedence: payload.title, else existing title, else widget name.
    if (payload.title != null) {
      summary.textContent = String(payload.title);
    }
    el.querySelector(".anymaps-panel-body").innerHTML = payload.content;
  });

  ctx.registerCommand("clearPanel", (_payload, widgetId) => {
    const el = sections.get(widgetId);
    if (el) el.remove();
    sections.delete(widgetId);
    // Re-register a no-op cleanup guard so a later re-enable does not double
    // register; the guard is idempotent.
    if (!cleanupRegistered.has(widgetId)) {
      cleanupRegistered.add(widgetId);
      ctx.registerCleanup(widgetId, () => {});
    }
  });
}
