// Per-widget <style> injection (Task 3). Contract: CONTRACTS.md section 4
// (setStyles row), section 12 (CSS), SPEC.md section 7.8.
//
// register(ctx) wires setStyles. cssText is injected as-is into a per-widget
// <style data-widget-id="<id>"> element in document.head, global scope.
// Repeated calls replace the prior content. Cleanup is idempotent.

export function register(ctx) {
  // widgetId -> HTMLStyleElement
  const styles = new Map();
  const cleanupRegistered = new Set();

  function styleFor(widgetId) {
    let el = styles.get(widgetId);
    if (!el) {
      el = document.createElement("style");
      el.setAttribute("data-widget-id", widgetId);
      document.head.appendChild(el);
      styles.set(widgetId, el);
      if (!cleanupRegistered.has(widgetId)) {
        cleanupRegistered.add(widgetId);
        ctx.registerCleanup(widgetId, () => {
          const s = styles.get(widgetId);
          if (s) s.remove();
          styles.delete(widgetId);
          cleanupRegistered.delete(widgetId);
        });
      }
    }
    return el;
  }

  ctx.registerCommand("setStyles", (payload, widgetId) => {
    if (!payload || typeof payload.cssText !== "string") {
      throw new Error("setStyles missing cssText");
    }
    styleFor(widgetId).textContent = payload.cssText;
  });
}
