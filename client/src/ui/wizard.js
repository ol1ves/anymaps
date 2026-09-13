// Wizard chat panel (Task 7).
//
// CONTRACTS.md section 15 (wizard API), SPEC.md 5.10-5.11.
// A built-in chat panel in #wizard, not a widget. It relays the user's
// prompt to the Agent Service, shows clarifying questions, and auto-installs
// the generated widget on done. The panel resends the full transcript on
// every turn. No streaming.
//
// Pure helpers (appendTurn, handleWizardResponse) are exported for testing.
// The panel DOM and fetch logic live inside register(ctx); it never touches
// localStorage, window, or document at module top level.

// --- Base URL resolution (private) -------------------------------------
// Pinned values from the brief: agent service URL is
// localStorage 'anymaps.agentUrl', fallback http://localhost:8001, with a
// window.__ANYMAPS_CONFIG__.agentUrl override. install.js (Task 6) owns the
// same resolver for its own use; this private copy keeps this file
// file-disjoint from install.js per the controller ruling.
function agentUrl() {
  try {
    if (typeof window !== "undefined" && window.__ANYMAPS_CONFIG__ && window.__ANYMAPS_CONFIG__.agentUrl) {
      return window.__ANYMAPS_CONFIG__.agentUrl;
    }
  } catch (e) { /* ignore */ }
  try {
    const v = localStorage.getItem("anymaps.agentUrl");
    if (v) return v;
  } catch (e) { /* ignore */ }
  return "http://localhost:8001";
}

// --- Pure helpers ------------------------------------------------------

// Return a new transcript array with `message` appended. Never mutates the
// input transcript.
export function appendTurn(transcript, message) {
  return [...transcript, message];
}

// Classify a wizard response into clarify | done | error. For clarify, the
// returned transcript appends the single question as an assistant message.
// For done, the transcript is unchanged and only widgetId/version are
// returned (the manifest is not needed by the panel; manager.install fetches
// it from the generic server).
export function handleWizardResponse(transcript, response) {
  if (!response || typeof response !== "object") {
    return { kind: "error", message: "invalid wizard response" };
  }
  if (response.done === true) {
    return { kind: "done", widgetId: response.widgetId, version: response.version };
  }
  if (response.done === false) {
    const questions = Array.isArray(response.questions) ? response.questions : [];
    const question = questions[0];
    if (typeof question !== "string" || question.length === 0) {
      return { kind: "error", message: "invalid wizard response" };
    }
    return {
      kind: "clarify",
      transcript: appendTurn(transcript, { role: "assistant", content: question }),
    };
  }
  return { kind: "error", message: "invalid wizard response" };
}

// --- Panel -------------------------------------------------------------

const TURN_BUDGET_MS = 60_000;

export function register(ctx) {
  if (typeof document === "undefined") return; // non-DOM (tests) -> no-op
  const root = document.getElementById("wizard");
  if (!root) return;

  let transcript = [];
  let busy = false;

  // Build the panel markup. Built-in UI, not a widget.
  root.innerHTML = "";
  const host = document.createElement("div");
  host.className = "anymaps-wizard";

  const heading = document.createElement("h2");
  heading.textContent = "Create a widget";

  const log = document.createElement("div");
  log.className = "anymaps-wizard-log";

  const form = document.createElement("form");
  form.className = "anymaps-wizard-form";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Describe a widget…";
  input.className = "anymaps-wizard-input";

  const sendBtn = document.createElement("button");
  sendBtn.type = "submit";
  sendBtn.textContent = "Send";

  form.appendChild(input);
  form.appendChild(sendBtn);
  host.appendChild(heading);
  host.appendChild(log);
  host.appendChild(form);
  root.appendChild(host);

  function setBusy(state) {
    busy = state;
    input.disabled = state;
    sendBtn.disabled = state;
  }

  function bubble(role, text, opts = {}) {
    const el = document.createElement("div");
    el.className = "anymaps-wizard-bubble anymaps-wizard-" + role;
    if (opts.error) el.classList.add("anymaps-wizard-error");
    if (opts.busy) el.classList.add("anymaps-wizard-busy");
    el.textContent = text;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function getManager() {
    // main.js exposes the manager on window.__ANYMAPS_DEV__ after
    // construction. Resolved lazily at action time so register() can run
    // before the manager object exists.
    try {
      return window.__ANYMAPS_DEV__ && window.__ANYMAPS_DEV__.manager;
    } catch (e) { return null; }
  }

  async function send(content) {
    if (busy) return;
    const text = (content || "").trim();
    if (!text) return;

    // Push the user message and render it.
    transcript = appendTurn(transcript, { role: "user", content: text });
    bubble("user", text);

    setBusy(true);
    const thinking = bubble("assistant", "Thinking…", { busy: true });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TURN_BUDGET_MS);

    let res;
    try {
      res = await fetch(agentUrl() + "/wizard/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: transcript }), // full transcript every turn
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      thinking.remove();
      const msg = (err && err.name === "AbortError")
        ? "wizard timed out after 60s"
        : "wizard request failed";
      bubble("assistant", msg, { error: true });
      setBusy(false);
      // transcript keeps the user message so the user can retry.
      return;
    }
    clearTimeout(timer);

    // Non-2xx: render the body's error field (or status text). Keep the
    // transcript so the user can rephrase.
    if (!res.ok) {
      thinking.remove();
      let detail = res.statusText || ("HTTP " + res.status);
      try {
        const body = await res.json();
        if (body && typeof body.error === "string") detail = body.error;
      } catch (e) { /* not JSON; keep status text */ }
      bubble("assistant", detail, { error: true });
      setBusy(false);
      return;
    }

    let response;
    try {
      response = await res.json();
    } catch (err) {
      thinking.remove();
      bubble("assistant", "invalid wizard response", { error: true });
      setBusy(false);
      return;
    }

    const result = handleWizardResponse(transcript, response);
    thinking.remove();

    if (result.kind === "error") {
      bubble("assistant", result.message, { error: true });
      setBusy(false);
      return;
    }

    if (result.kind === "clarify") {
      transcript = result.transcript;
      bubble("assistant", response.questions[0]);
      setBusy(false);
      return;
    }

    // done: install through the generic server via manager.install. The
    // Agent Service already published the manifest + bundle there.
    const { widgetId, version } = result;
    bubble("assistant", "Widget generated. Installing…");
    const manager = getManager();
    if (!manager || typeof manager.install !== "function") {
      bubble("assistant", "install unavailable: manager not ready", { error: true });
      setBusy(false);
      return;
    }
    try {
      await manager.install(widgetId, version);
      bubble("assistant", "Installed: " + widgetId);
      // Reset the transcript only after a successful install.
      transcript = [];
      input.value = "";
    } catch (err) {
      const msg = (err && err.message) ? err.message : "install failed";
      bubble("assistant", msg, { error: true });
      // Keep the done state visible with the error; do not reset transcript.
    }
    setBusy(false);
  }

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    send(input.value);
  });
}
