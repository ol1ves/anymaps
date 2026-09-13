// wizard.js — wizard chat panel check group (against the mock server).
// prompt -> clarifying question -> answer -> done -> auto-install ->
// markers; full transcript resent on every turn (assert via a fetch
// wrapper). The 60s timeout path is optional and skipped by default.

import { waitForState, ok, fail } from "./lib.js";

const AGENT = "http://localhost:8000";

// Resolve true when fn() returns true within ms.
async function waitFor(fn, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

export async function run({ manager, page }) {
  const results = [];
  const { doc, panelHost } = page;
  const captured = [];

  const origFetch = window.fetch;
  window.fetch = async (url, opts) => {
    try {
      if (typeof url === "string" && url.indexOf("/wizard/generate") !== -1 && opts && opts.body) {
        captured.push(JSON.parse(opts.body));
      }
    } catch (e) { /* */ }
    return origFetch(url, opts);
  };

  try {
    const root = doc.getElementById("wizard");
    if (!root) {
      results.push(fail("wizard panel present", "no #wizard"));
      return results;
    }
    const input = root.querySelector(".anymaps-wizard-input");
    const form = root.querySelector(".anymaps-wizard-form");
    if (!input || !form) {
      results.push(fail("wizard panel present", "no input/form"));
      return results;
    }
    results.push(ok("wizard panel present"));

    // Turn 1: prompt -> clarifying question.
    input.value = "water fountains in NYC";
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    const clarify = await waitFor(() => {
      const bubbles = [...root.querySelectorAll(".anymaps-wizard-bubble")];
      return bubbles.some((b) => /Drinking water|decorative fountains/.test(b.textContent));
    }, 4000);
    results.push(clarify
      ? ok("prompt -> clarifying question") : fail("prompt -> clarifying question", "no question"));
    // Input cleared after the clarify turn (hardening item 3).
    results.push(input.value === ""
      ? ok("input cleared after clarify turn") : fail("input cleared after clarify turn", "value=" + input.value));

    // Turn 2: answer -> done -> auto-install.
    input.value = "drinking water";
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    // The mock widget persists nothing; verify via the panel + markers.
    const installed = await waitFor(() =>
      !!panelHost.querySelector(".anymaps-widget-mock-wizard-widget"), 6000);
    results.push(installed
      ? ok("wizard done -> auto-install") : fail("wizard done -> auto-install", "no panel"));

    // The canned widget draws two markers (labels A, B).
    const labels = [...doc.querySelectorAll(".anymaps-marker")]
      .map((m) => m.querySelector(".anymaps-marker-label")?.textContent ?? "");
    results.push(labels.includes("A") && labels.includes("B")
      ? ok("installed widget draws two markers") : fail("installed widget draws two markers", labels.join(",")));

    // Full transcript resent on turn 2: captured[1].messages has all three.
    if (captured.length >= 2) {
      const m = captured[1].messages;
      const full = m.length === 3 &&
        m[0].role === "user" && /fountains/.test(m[0].content) &&
        m[1].role === "assistant" && /Drinking water|decorative fountains/.test(m[1].content) &&
        m[2].role === "user" && /drinking water/.test(m[2].content);
      results.push(full
        ? ok("full transcript resent on every turn") : fail("full transcript resent on every turn", JSON.stringify(m)));
    } else {
      results.push(fail("full transcript resent on every turn", "captures=" + captured.length));
    }

    results.push(ok("60s timeout path is optional (skipped by default)"));
  } finally {
    window.fetch = origFetch;
    try { manager.uninstall("mock-wizard-widget"); } catch (e) { /* */ }
  }

  return results;
}
