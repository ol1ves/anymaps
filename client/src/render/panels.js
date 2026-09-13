// Sidebar panel sections (Task 3). Contract: CONTRACTS.md section 4 (panel
// rows), section 12 (one collapsible section per widget, stacked vertically,
// classes anymaps-panel / anymaps-widget-<id>), SPEC.md section 7.11.
//
// register(ctx) wires setPanel/clearPanel. Each widget gets one
// <details class="anymaps-panel anymaps-widget-<id>"> with a <summary>
// (title) and a content div (raw innerHTML). Title precedence:
// payload.title if present, else the existing title if the section exists,
// else ctx.widgetName(widgetId). New sections start open (<details open>).

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
    if (!payload || typeof payload.content !== "string") {
      throw new Error("panel missing content");
    }
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
