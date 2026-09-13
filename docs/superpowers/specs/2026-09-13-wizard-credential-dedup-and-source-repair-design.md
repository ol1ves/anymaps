# Wizard Credential Dedup + Source Repair Design

**Date:** 2026-09-13
**Status:** Approved (direction approved by user; Option B — retain key across repair retries — chosen)

## 0. Context for the executing agent

This repo is **anymaps**: a map web app whose widget "wizard" (Agent Service +
client chat panel) turns a natural-language prompt into a published widget
(manifest + JS bundle). Read these first, in order:

- `SPEC.md` — the source of truth. Sections 5.10–5.11 (Agent Service / Wizard
  panel), 10.1 (`auth`), 10.8 (SSRF), 12.2 (secrets) are directly relevant.
- `CONTRACTS.md` §15 — the wizard HTTP contract. This spec changes §15 and that
  doc must be updated in the same work.
- `agent/app/main.py` — wizard service (models + flow).
- `agent/app/source_test.py` — SSRF-guarded source fetch/summarize.
- `client/src/ui/wizard.js` — wizard chat panel (pure helpers + DOM).
- `agent/tests/test_wizard.py`, `agent/tests/test_skills.py`,
  `client/tests/wizard.test.js` — existing tests that must stay green and be
  extended.

The wizard is **stateless and multi-turn**: the client resends the full
transcript each turn. There is already a JSON-parse **repair loop**
(`call_deepseek` → `MAX_REPAIR_ATTEMPTS`) and a "plan" intermediate response
(`done:false, plan:{proposal, sources}`) that lets the service test declared
sources and request secrets before building.

## 1. Goal

Fix two user-facing bugs in the wizard's secret-entry flow:

1. **A shared API key is requested once per source, not once.** Two NOAA
   sources that both use the `token` header (`noaa-stations`, `noaa-tavg`)
   produce two password fields.
2. **A source that fails verification dead-ends.** When a source returns a
   non-2xx during key verification, the wizard shows
   `source verification failed: source returned HTTP 400` and stops, with no
   way for the model to correct the URL/params.

## 2. Problem and root causes (verified)

- `agent/app/main.py` `_missing_secret_requests` emits one `secretRequest` per
  **plan source** that has `auth`, keyed by `source.id`. A credential shared by
  two sources becomes two requests (bug 1).
- `/wizard/secrets` (`verify_and_store_secret`) converts **any** `SourceTestError`
  into a hard `400` and the client (`verifySecrets`) throws on the first non-2xx.
  There is no feedback path for the model to correct the source (bug 2).
- The model has no docs, so it guesses endpoint params; a wrong param yields
  HTTP 400. This is what the user hit.

Dedup **alone is not enough**: if the wizard verifies only one representative
source per credential, the second source's bad URL is never caught and the
error silently moves to runtime (the poller degrades gracefully per SPEC §10.7,
but the widget is still broken). Therefore the wizard must **verify every
source** that shares a credential and let the model **correct** the failing ones.

## 3. Locked design decisions

- **D1 — Credential identity.** A credential is the full auth triple
  `(type, name, scheme)` (i.e. a `SecretAuthSpec` without `secret`). Two plan
  sources share a credential iff their triples are equal.
- **D2 — Server-side dedup.** `_missing_secret_requests` groups plan sources by
  credential. One `secretRequest` per credential, carrying the credential's
  `auth` plus **all** its sources.
- **D3 — Verify all, classify errors.** `/wizard/secrets` verifies **every**
  source for the credential. It stores the key **only when every source
  verifies**. Failures are classified (section 7): 401/403 = bad key; other
  non-2xx = bad source config (repairable); SSRF = hard block.
- **D4 — Repair loop (Option B).** The client keeps the raw key in memory
  across a bounded repair loop. On `sourceErrors`, it feeds them back to
  `/wizard/generate`; the model re-proposes corrected sources; the client
  re-verifies with the **same** key. Cap: 2 repair rounds, then a clear error.
- **D5 — Binding carries the credential + per-source shapes.**
  `SecretBinding` becomes `{id, auth, secretId, sources:[{id, shape}]}`.
- **D6 — Error status must be observable.** `source_test` must expose the HTTP
  status of a failed fetch so the wizard can classify 401/403 vs other.
- **D7 — SPEC.md is untouched.** The manifest schema, channel model,
  secrets-by-ID, SSRF rules, auth types, and transport are unchanged. Sharing
  one `secretId` across channels is already legal (schema has no uniqueness
  rule; `validate_channel_matrix` never checks secrets; the poller resolves each
  channel's `auth.secret` independently). This spec changes only the **wizard
  wire contract** (`CONTRACTS.md` §15).

## 4. The credential model

Given a plan source `s`, its credential is `auth(s)` when present.

```
credential_key(auth) = (auth.type, auth.name, auth.scheme)
credential_id(auth)   = f"{auth.type}:{auth.name}"
                        + (f":{auth.scheme.strip()}" if auth.scheme.strip() else "")
```

`credential_id` is deterministic and unique per triple. It is the stable key the
client echoes back, and the key the service uses to match sources to secret ids.
Example: header auth named `token` → `header:token`.

A **source descriptor** (used inside `secretRequests` and `/wizard/secrets`) is a
`PlanSource` minus `auth`:

```json
{ "id": "noaa-tavg", "method": "GET", "url": "https://…", "query": {}, "headers": {}, "body": null }
```

## 5. Wizard contract changes (CONTRACTS.md §15)

### 5.1 Clarifying response gains a per-credential `secretRequests`

When the plan has sources needing keys and the key is not yet provided, the
service returns:

```json
{
  "done": false,
  "questions": ["Approve publishing weather widget 'ny-weather' v1.0.0 — …?"],
  "secretRequests": [
    {
      "id": "header:token",
      "auth": { "type": "header", "name": "token", "scheme": "" },
      "sources": [
        { "id": "noaa-stations", "method": "GET", "url": "https://www.ncei.noaa.gov/cdo-web/api/v2/stations", "query": {}, "headers": {}, "body": null },
        { "id": "noaa-tavg", "method": "GET", "url": "https://www.ncei.noaa.gov/cdo-web/api/v2/data?datasetid=GSOY", "query": {}, "headers": {}, "body": null }
      ]
    }
  ]
}
```

`secretRequests` is grouped by credential: one entry per unique auth triple.

### 5.2 `/wizard/secrets` — verify all sources for one credential

Request:

```json
{
  "value": "<raw key>",
  "auth": { "type": "header", "name": "token", "scheme": "" },
  "sources": [
    { "id": "noaa-stations", "method": "GET", "url": "https://…/stations", "query": {}, "headers": {}, "body": null },
    { "id": "noaa-tavg", "method": "GET", "url": "https://…/data?datasetid=GSOY", "query": {}, "headers": {}, "body": null }
  ]
}
```

Responses:

- **201, every source verified** (key stored once):

```json
{
  "secretId": "abc123",
  "sources": [
    { "id": "noaa-stations", "shape": { "ok": true, "top_level_type": "object", "arrays": [] } },
    { "id": "noaa-tavg", "shape": { "ok": true, "top_level_type": "object", "arrays": [] } }
  ]
}
```

- **400, one or more sources returned a source-config error** (key NOT stored):

```json
{ "sourceErrors": [ { "id": "noaa-tavg", "error": "source returned HTTP 400" } ] }
```

- **400, key invalid** (any tested source returned 401/403):

```json
{ "error": "invalid API key" }
```

- **400, SSRF block** (unchanged):

```json
{ "error": "source blocked by SSRF rules" }
```

`shape` is the existing `summarize_json` output (bounded, no record values).
It is per-source because record mappings are per-source.

### 5.3 `secrets` field on `/wizard/generate` request

`SecretBinding` changes from `{id, secretId, shape}` to:

```json
{
  "id": "header:token",
  "auth": { "type": "header", "name": "token", "scheme": "" },
  "secretId": "abc123",
  "sources": [
    { "id": "noaa-stations", "shape": { "ok": true, "top_level_type": "object", "arrays": [] } },
    { "id": "noaa-tavg", "shape": { "ok": true, "top_level_type": "object", "arrays": [] } }
  ]
}
```

The `secrets` array still has the same `max_length` (`MAX_EXTERNAL_SOURCES`).

## 6. Flow (turn-by-turn state machine)

### Turn 1 — plan

1. Client POSTs `/wizard/generate` with the user's prompt.
2. Model emits `done:false, plan:{proposal, sources}`.
3. Service runs `_missing_secret_requests`, which now **dedups by credential**
   (D1/D2) and returns `secretRequests` per credential (5.1) when keys are
   missing; otherwise it proceeds (existing `_process_plan` path).

### Key entry

4. Client renders **one password input per `secretRequest`** (per credential),
   not per source.
5. On submit, for each credential the client POSTs `/wizard/secrets` with the
   raw key + `auth` + all `sources` (5.2).
6. Service verifies every source with the key injected (reuse
   `source_with_secret` + `test_source`):
   - all pass → store key via `POST /secrets` → `201 {secretId, sources:[{id,shape}]}`;
   - some fail with source-config errors → `400 {sourceErrors}` (no store);
   - 401/403 → `400 {error: "invalid API key"}`;
   - SSRF → `400 {error: "source blocked by SSRF rules"}`.

### Repair (only when `sourceErrors`)

7. Client keeps the raw key(s) in memory (never in transcript/LLM), appends a
   user message describing the errors (e.g. `Source 'noaa-tavg' (…/data?datasetid=GSOY) returned HTTP 400. Correct it.`), and POSTs `/wizard/generate` again.
8. Model re-emits a corrected `plan`. Service returns fresh `secretRequests`.
9. Client re-POSTs `/wizard/secrets` with the **same** key and corrected
   sources. Loop steps 6–9. Hard cap: 2 repair rounds; then the client shows a
   clear error and keeps the transcript for the user to rephrase.

### Final turn

10. Once all credentials are verified, the client POSTs `/wizard/generate` with
    the transcript + `secrets` (5.3).
11. Service injects the secret note (section 6.1) and re-prompts if the model
    emits a plan (`_process_plan`); the model emits `done:true`.
12. Service tests unauthenticated sources, publishes via `POST /widgets`, and
    returns `{done:true, widgetId, version, manifest}`. Client auto-installs.

### 6.1 Secret note injected to the model

Both injection sites (`_secret_bindings_note` for the done:true-direct path, and
`_process_plan`'s finalize note) must now say, per binding:

```text
Verified API secret for auth header 'token' → secretId=abc123.
Use this secretId (verbatim) as external.auth.secret for every external
channel whose auth is header 'token'; never invent a secretId.
Source 'noaa-stations' shape: {…}
Source 'noaa-tavg' shape: {…}
```

`_process_plan` matches a plan source to a binding when
`credential_key(binding.auth) == credential_key(source.auth)` (equivalently
`binding.id == credential_id(source.auth)`), not by `source.id`. It injects each
source's `shape` from `binding.sources` (by `source.id`).

## 7. Error classification (server)

The source test must make the HTTP status observable. Requirements:

- `SourceTestError` (or a subclass) carries an optional HTTP status for a
  non-2xx response; `None` for non-HTTP failures (invalid JSON, size limit,
  redirect limit, timeout).
- `test_source` already retries transient failures (`429/5xx/transport`) once;
  a **retryable** status that keeps failing must still surface its status.
- Classification in `/wizard/secrets`:
  - `SourceBlockedError` → `400 "source blocked by SSRF rules"` (no repair).
  - `401`/`403` on **any** tested source → `400 "invalid API key"` (a valid token is
    valid across the API's endpoints; 401/403 is the definitive bad-key signal).
  - any other non-2xx (or non-HTTP failure) on **some** source →
    `400 {sourceErrors:[{id, error}]}` (repairable).
  - all sources 2xx → `201 {secretId, sources:[{id, shape}]}`.

## 8. Security invariants

- The raw key only ever travels client input → `/wizard/secrets` →
  `POST /secrets` → server `secrets` table. It never enters `messages`, the
  LLM request body, the manifest, the bundle, a response, or any log.
- **Amendment to the prior design doc:** the key may be sent to
  `/wizard/secrets` more than once (once per repair round). This is the
  deliberate Option-B trade; the boundary is unchanged — the key still never
  crosses into the LLM or manifest. The key is stored exactly once (on the
  first fully-successful verification), so repair rounds do not orphan secrets.
- The client holds the raw key in memory only until its credential is fully
  verified or the repair cap is hit; it is cleared when the transcript resets
  on `done` (same lifecycle as `secretId` today).
- Only opaque `secretId` and bounded `shape` cross the `/wizard/generate`
  boundary.

## 9. Components touched

- `agent/app/main.py`
  - `SecretBinding` → add `auth: SecretAuthSpec`, replace `shape` with
    `sources: list[{id, shape}]`.
  - New helper `credential_key(auth)` / `credential_id(auth)`.
  - `WizardSecretRequest` → `{value, auth, sources:[SourceDescriptor]}`.
  - `_missing_secret_requests` → group by credential; emit per-credential
    `{id, auth, sources}`.
  - `verify_and_store_secret` → verify all sources, classify errors, store only
    on full success, return `{secretId, sources}` or `{sourceErrors}`.
  - `_secret_bindings_note` → emit credential + secretId + per-source shapes.
  - `_process_plan` → match by `credential_key(auth)`; inject per-source shapes.
  - `generate_wizard` → unchanged shape-wise (already injects the note; plan
    resolution unchanged).
- `agent/app/source_test.py`
  - Expose HTTP status on `SourceTestError` (e.g. `status: int | None`).
- `client/src/ui/wizard.js`
  - `handleWizardResponse` → keep `secretRequests` classification; the item
    shape changes to `{id, auth, sources}` (tests update).
  - `verifySecrets` → new `/wizard/secrets` request/response; return bindings
    `{id, auth, secretId, sources}`; surface `sourceErrors` distinctly.
  - `collectSecrets` / `sendTurn` → one input per credential; retain raw keys
    across the bounded repair loop; append repair message and re-run the turn.
- `CONTRACTS.md` §15 → document 5.1–5.3 (and the existing `plan`/`secrets`
  shapes it currently omits).
- Tests: `agent/tests/test_wizard.py`, `agent/tests/test_source_test.py`,
  `client/tests/wizard.test.js`.

## 10. Testing strategy

Python (`.venv/bin/python -m pytest`), client (`cd client && npm test`,
`npm run build`). Keep existing suites green; add:

- `_missing_secret_requests` dedups two sources sharing one auth into one
  request with two `sources`.
- `_missing_secret_requests` keeps two distinct auths as two requests.
- `credential_key`/`credential_id` determinism.
- `/wizard/secrets`: all-sources-verify stores once and returns per-source
  shapes; one source failing returns `sourceErrors` and does NOT store;
  401/403 on all sources returns `invalid API key`; SSRF stays a hard block.
- `_process_plan` and `_secret_bindings_note` inject secretId + per-source
  shapes keyed by credential, not source id.
- `test_source` surfaces HTTP status on failure.
- Client: `verifySecrets` posts `{value, auth, sources}` and returns the new
  binding shape; `verifySecrets` distinguishes `sourceErrors` (repair) from
  `invalid API key`; repair-loop state is covered by the existing pure-helper
  tests where feasible (DOM-level retention is verified by build + manual
  trace, matching the current test approach for `collectSecrets`).
- Security: raw key never appears in `messages`/LLM body/manifest (existing
  `test_raw_key_never_reaches_llm_or_manifest` extended to the new shape).

## 11. Out of scope

- Web/doc access for the agent (deferred, separate feature).
- Persistent key storage across widgets/visits.
- A generic-server "test a source with a stored secret" route (would deviate
  from the locked `SPEC.md` §12.1 route table).
- Pagination, OAuth2, WebSocket (unchanged from SPEC).

## 12. Non-goals (explicitly not changing)

- `SPEC.md` locked decisions (manifest schema, channels, secrets-by-ID, SSRF,
  auth types, transport).
- The manifest schema — sharing a `secretId` across channels is already valid.
- The SDK, WidgetManager, server data plane, or poller.
