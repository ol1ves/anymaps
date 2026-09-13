// Tests for wizard pure helpers (Task 7). Pure, no DOM, no localStorage.
//
// Contract: CONTRACTS.md section 15 (wizard API), SPEC.md 5.10-5.11.
// appendTurn returns a new transcript array; never mutates the input.
// handleWizardResponse classifies a wizard response into clarify | done |
// error and, for clarify, returns the updated transcript.

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendTurn, handleWizardResponse } from "../src/ui/wizard.js";

test("appendTurn adds a message and keeps order", () => {
  const t0 = [];
  const t1 = appendTurn(t0, { role: "user", content: "water fountains" });
  assert.deepEqual(t1, [{ role: "user", content: "water fountains" }]);
  const t2 = appendTurn(t1, { role: "assistant", content: "Drinking or decorative?" });
  assert.deepEqual(t2, [
    { role: "user", content: "water fountains" },
    { role: "assistant", content: "Drinking or decorative?" },
  ]);
});

test("appendTurn never mutates the input transcript", () => {
  const t0 = [{ role: "user", content: "hi" }];
  const t1 = appendTurn(t0, { role: "assistant", content: "hello" });
  assert.deepEqual(t0, [{ role: "user", content: "hi" }]);
  assert.notEqual(t1, t0);
  assert.equal(t0.length, 1);
  assert.equal(t1.length, 2);
});

test("handleWizardResponse clarify appends the single question as assistant", () => {
  const transcript = [{ role: "user", content: "water fountains" }];
  const out = handleWizardResponse(transcript, {
    done: false,
    questions: ["Drinking or decorative?"],
  });
  assert.equal(out.kind, "clarify");
  assert.deepEqual(out.transcript, [
    { role: "user", content: "water fountains" },
    { role: "assistant", content: "Drinking or decorative?" },
  ]);
  // original transcript unchanged
  assert.equal(transcript.length, 1);
});

test("handleWizardResponse done returns widgetId and version, transcript unchanged", () => {
  const transcript = [{ role: "user", content: "water fountains" }];
  const manifest = { id: "water-fountains-nyc", version: "0.1.0" };
  const out = handleWizardResponse(transcript, {
    done: true,
    widgetId: "water-fountains-nyc",
    version: "0.1.0",
    manifest,
  });
  assert.equal(out.kind, "done");
  assert.equal(out.widgetId, "water-fountains-nyc");
  assert.equal(out.version, "0.1.0");
  assert.deepEqual(out.transcript, []);
  assert.deepEqual(transcript, [{ role: "user", content: "water fountains" }]);
});

test("handleWizardResponse done resets the transcript to empty", () => {
  const transcript = [
    { role: "user", content: "water fountains" },
    { role: "assistant", content: "Approve publishing widget 'w' v1.0.0?" },
    { role: "user", content: "yes" },
  ];
  const out = handleWizardResponse(transcript, {
    done: true,
    widgetId: "w",
    version: "1.0.0",
    manifest: { id: "w", version: "1.0.0" },
  });
  assert.equal(out.kind, "done");
  assert.equal(out.widgetId, "w");
  assert.equal(out.version, "1.0.0");
  assert.deepEqual(out.transcript, []);
});

test("handleWizardResponse error when done is missing", () => {
  const out = handleWizardResponse([], { questions: ["x"] });
  assert.equal(out.kind, "error");
  assert.equal(out.message, "invalid wizard response");
});

test("handleWizardResponse error when done false but no question", () => {
  const out = handleWizardResponse([], { done: false, questions: [] });
  assert.equal(out.kind, "error");
  assert.equal(out.message, "invalid wizard response");
});

test("handleWizardResponse error when response is not an object", () => {
  assert.deepEqual(handleWizardResponse([], null), {
    kind: "error",
    message: "invalid wizard response",
  });
  assert.deepEqual(handleWizardResponse([], "nope"), {
    kind: "error",
    message: "invalid wizard response",
  });
});
