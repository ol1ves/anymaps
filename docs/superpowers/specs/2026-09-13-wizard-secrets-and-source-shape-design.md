# Wizard Secrets + Source-Shape Injection Design

**Date:** 2026-09-13
**Status:** Approved (design + "add a password input")

## Goal

Make the widget wizard able to (1) use APIs that require a key (header or query
auth), and (2) stop guessing API parameters and record mappings, by testing the
declared source and feeding its shape back to the model before the final build.
Also constrain named geographic scope to the source itself rather than relying
on viewport-following bounds.

## Problem (from investigation)

- The server already fully handles secrets: `POST /secrets` stores a value and
  returns a `secretId` (`server/app/secrets.py`); the manifest's
  `external.auth.secret` references that id; the poller injects the value at
  fetch time (`server/app/poller.py`).
- The agent already verifies a key via `/wizard/secrets` before storing it.
- What's missing is the user-facing link: the chat panel has no key-entry UI,
  and the skill tells the model to punt keys, so the model never obtains a
  `secretId` and instead claims "no key needed" and pivots to a keyless API.
- The model also generates record mappings blind. Evidence: a generated widget
  used `https://api.weather.gov/stations` with no `state=NY`, cached 500
  nationwide stations, and filtered only by viewport bounds.

## Design

### Issue 2 (bounded): scope the source, not the viewport

Rule added to `wizard-flow` skill and reflected in the examples skill: when the
user names a fixed geographic scope, encode it in the external URL/query/body
using the API's own location parameter (`?state=NY`, Overpass bbox, etc.).
`?bounds=` remains for "show what's in view" widgets only.

### Issue 1 (architectural): secrets + source shape

One new internal model output shape unifies both, because both require the model
to declare its sources before building:

```json
{
  "done": false,
  "plan": {
    "proposal": "Approve publishing ...?",
    "sources": [
      {
        "id": "noaa-token",
        "method": "GET",
        "url": "https://www.ncei.noaa.gov/cdo-web/api/v2/stations",
        "query": {},
        "headers": {},
        "auth": { "type": "header", "name": "token", "scheme": "" }
      }
    ]
  }
}
```

- `sources[].auth` carries only `{type, name, scheme}` — never a value.
- `sources[].id` is a stable slot the client uses to pair a verified `secretId`
  with this source.

#### Service state machine (`/wizard/generate`)

1. Model returns `done:false, questions:[q]` → pass through (today).
2. Model returns `done:false, plan:{proposal, sources}`:
   - For each source with `auth`, look for a matching `secretId` in the request's
     `secrets` field. Missing ones become `secretRequests`.
   - If any missing → return to client:
     `{done:false, questions:[proposal], secretRequests:[{id, source, auth}...]}`.
   - Else → test each source:
     - unauthenticated: fetch + `summarize_json` (existing, bounded);
     - authenticated: use the shape captured during key verification.
     - Then append one synthetic, internal-only user message with the shapes and
       secretIds, and re-prompt the model to emit `done:true`.
3. Model returns `done:true` → test sources + publish (today).

#### Key entry (client, `/wizard/secrets`)

- `/wizard/secrets` now returns `{secretId, shape}` (it already computes `shape`
  during verification; stop discarding it).
- On `secretRequests`, the client renders one `<input type="password">` per
  request plus the proposal text, then for each request POSTs the raw key to the
  existing `/wizard/secrets`, keeping `{id → {secretId, shape}}` **in memory
  only**.
- The client sends that map back as a new `secrets` field on `WizardRequest`:
  `secrets: [{id, secretId, shape?}]`.

#### Security invariants (enforced by tests)

- The raw key appears exactly once: client input → `/wizard/secrets` →
  `POST /secrets` → server `secrets` table.
- The raw key never appears in `messages`, the LLM request body, the manifest,
  the bundle, any response, or any log.
- Only the opaque `secretId` (and the bounded source shape) cross the wizard
  boundary, and the model is told to write that `secretId` into
  `external.auth.secret`.
- Secret ids live in client memory and are cleared when the transcript resets
  (a completed widget = fresh conversation = fresh keys).

## Components touched

- `agent/app/main.py` — models (`SecretBinding`, `PlanSource`, plan parsing),
  `WizardRequest.secrets`, `/wizard/secrets` returns shape, `generate_wizard`
  state machine, internal finalize re-prompt.
- `agent/app/skills/wizard-flow/SKILL.md` — scope rule + plan/secret guidance.
- `agent/app/skills/widget-examples/SKILL.md` — plan example + scoped URL.
- `client/src/ui/wizard.js` — password input UI, `/wizard/secrets` call,
  `secrets` field, transcript handling.
- Tests in `agent/tests/` and `client/tests/`.

## Out of scope

- Persistent key storage across widgets/visits (keys reset per widget).
- Pagination for external sources (unchanged: first page only).
- WebSocket/streaming (unchanged).
