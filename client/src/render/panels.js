// Sidebar panel sections.
//
// NOTE: the brief lists this file as a Task 3 deliverable with a bare stub,
// but the Task 2 marker-fixture bundle calls anymaps.setPanel to render its
// log, and the orchestrator's Playwright check verifies the err log line
// appears IN THE PANEL. A bare stub makes setPanel an unknown command, so the
// panel never renders and the fixture check fails. Task 2 therefore ships a
// MINIMAL functional setPanel/clearPanel here so the fixture is verifiable.
// Task 3 replaces this with the full collapsible-section implementation.
//
// register(ctx) wires setPanel/clearPanel. One section per widget in
// #panel-host, class "anymaps-panel". Contract: CONTRACTS.md section 12.

export function register(ctx) {
  const host = document.getElementById("panel-host");
  // widgetId -> section element
  const sections = new Map();
  const cleanupRegistered = new Set();

  function sectionFor(widgetId) {
    let el = sections.get(widgetId);
    if (!el) {
      el = document.createElement("section");
      el.className = "anymaps-panel anymaps-widget-" + widgetId;
      const header = document.createElement("div");
      header.className = "anymaps-panel-header";
      header.textContent = ctx.widgetName(widgetId);
      const body = document.createElement("div");
      body.className = "anymaps-panel-body";
      el.append(header, body);
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
    if (!payload || typeof payload.content !== "string") {
      throw new Error("setPanel missing content");
    }
    const el = sectionFor(widgetId);
    if (payload.title != null) {
      el.querySelector(".anymaps-panel-header").textContent = String(payload.title);
    }
    el.querySelector(".anymaps-panel-body").innerHTML = payload.content;
  });

  ctx.registerCommand("clearPanel", (_payload, widgetId) => {
    const el = sections.get(widgetId);
    if (el) el.remove();
    sections.delete(widgetId);
  });

}
