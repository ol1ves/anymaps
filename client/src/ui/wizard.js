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
    return { kind: "done", widgetId: response.widgetId, version: response.version, transcript: [] };
  }
  if (response.done === false) {
    const questions = Array.isArray(response.questions) ? response.questions : [];
    const question = questions[0];
    if (typeof question !== "string" || question.length === 0) {
      return { kind: "error", message: "invalid wizard response" };
    }
    const secretRequests = Array.isArray(response.secretRequests) ? response.secretRequests : [];
    if (secretRequests.length > 0) {
      return {
        kind: "secretRequests",
        transcript: appendTurn(transcript, { role: "assistant", content: question }),
        question,
        secretRequests,
      };
    }
    return {
      kind: "clarify",
      transcript: appendTurn(transcript, { role: "assistant", content: question }),
    };
  }
  return { kind: "error", message: "invalid wizard response" };
}

// Verify each secret against the agent's /wizard/secrets route and return
// bindings {id, secretId, shape}. The raw key only travels inside the POST
// body to that route; it is never added to the transcript or logged here.
export async function verifySecrets(secretRequests, values, agentBaseUrl, fetchImpl = fetch) {
  const secrets = [];
  for (const request of secretRequests) {
    const value = values[request.id];
    if (!value) throw new Error("missing secret value for " + request.id);
    const response = await fetchImpl(agentBaseUrl + "/wizard/secrets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value, source: request.source, auth: request.auth }),
    });
    if (!response.ok) {
      let detail = "secret verification failed";
      try {
        const body = await response.json();
        if (body && typeof body.error === "string") detail = body.error;
      } catch (e) { /* keep default */ }
      throw new Error(detail);
    }
    const body = await response.json();
    secrets.push({ id: request.id, secretId: body.secretId, shape: body.shape || null });
  }
  return secrets;
}

// --- Panel -------------------------------------------------------------

const TURN_BUDGET_MS = 60_000;

export function register(ctx) {
  if (typeof document === "undefined") return; // non-DOM (tests) -> no-op
  const root = document.getElementById("wizard");
  if (!root) return;

  let transcript = [];
  let busy = false;
  let pendingSecrets = [];

  // Build the panel markup. Built-in UI, not a widget.
  root.innerHTML = "";
  const host = document.createElement("div");
  host.className = "anymaps-wizard";

  const header = document.createElement("div");
  header.className = "anymaps-wizard-header";

  const heading = document.createElement("h2");
  heading.className = "anymaps-wizard-heading";
  heading.textContent = "Create a widget";

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "anymaps-wizard-clear";
  clearBtn.textContent = "Clear";

  header.appendChild(heading);
  header.appendChild(clearBtn);

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
  sendBtn.className = "anymaps-wizard-send";
  sendBtn.textContent = "Send";

  form.appendChild(input);
  form.appendChild(sendBtn);
  host.appendChild(header);
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

  function clearConversation() {
    if (busy) return; // never clobber an in-flight turn
    transcript = [];
    pendingSecrets = [];
    log.innerHTML = "";
    input.value = "";
    setBusy(false);
    input.focus();
  }

  clearBtn.addEventListener("click", clearConversation);

  function getManager() {
    // ctx.manager is set by createManager after all feature modules
    // register. Resolved lazily at action time so register() can run
    // before the manager object exists (it does: register runs inside
    // createManager, before ctx.manager is assigned).
    try {
      return ctx && ctx.manager;
    } catch (e) { return null; }
  }

  async function sendTurn(messages, secrets) {
    setBusy(true);
    const thinking = bubble("assistant", "Thinking…", { busy: true });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TURN_BUDGET_MS);

    let res;
    try {
      res = await fetch(agentUrl() + "/wizard/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages, secrets }),
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

    const result = handleWizardResponse(messages, response);
    thinking.remove();

    if (result.kind === "error") {
      bubble("assistant", result.message, { error: true });
      setBusy(false);
      return;
    }

    if (result.kind === "clarify") {
      transcript = result.transcript;
      bubble("assistant", response.questions[0]);
      input.value = "";
      setBusy(false);
      return;
    }

    if (result.kind === "secretRequests") {
      transcript = result.transcript;
      bubble("assistant", result.question);
      input.value = "";
      setBusy(false);
      collectSecrets(result.secretRequests);
      return;
    }

    // done: install through the generic server via manager.install. The
    // Agent Service already published the manifest + bundle there.
    const { widgetId, version } = result;
    // The Agent Service already published this widget. Reset the transcript
    // now so a retry after this point starts a fresh widget instead of
    // re-publishing the same id/version (which the server rejects with 409).
    transcript = result.transcript;
    pendingSecrets = [];
    input.value = "";
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
    } catch (err) {
      const msg = (err && err.message) ? err.message : "install failed";
      bubble("assistant", msg, { error: true });
      // The widget is published and registered even on install failure; the
      // gallery is the recovery path, and the transcript is already reset.
    }
    setBusy(false);
  }

  function send(content) {
    if (busy) return;
    const text = (content || "").trim();
    if (!text) return;

    // Push the user message and render it.
    transcript = appendTurn(transcript, { role: "user", content: text });
    bubble("user", text);
    sendTurn(transcript, pendingSecrets);
  }

  function collectSecrets(secretRequests) {
    const values = {};
    const host = document.createElement("div");
    host.className = "anymaps-wizard-secrets";
    for (const request of secretRequests) {
      const field = document.createElement("input");
      field.type = "password";
      field.className = "anymaps-wizard-secret-input";
      field.autocomplete = "off";
      const authName = request.auth && request.auth.name ? request.auth.name : request.id;
      field.placeholder = "Enter " + authName + " for " + request.id;
      field.dataset.secretId = request.id;
      field.addEventListener("input", () => { values[request.id] = field.value; });
      host.appendChild(field);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "anymaps-wizard-secret-submit";
    button.textContent = "Verify & continue";
    host.appendChild(button);
    log.appendChild(host);
    button.addEventListener("click", async () => {
      setBusy(true);
      try {
        const secrets = await verifySecrets(secretRequests, values, agentUrl());
        pendingSecrets = secrets;
        transcript = appendTurn(transcript, { role: "user", content: "I've provided the key(s). Proceed." });
        bubble("user", "I've provided the key(s). Proceed.");
        host.remove();
        await sendTurn(transcript, secrets);
      } catch (err) {
        setBusy(false);
        bubble("assistant", (err && err.message) || "secret verification failed", { error: true });
      }
    });
  }

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    send(input.value);
  });
}
