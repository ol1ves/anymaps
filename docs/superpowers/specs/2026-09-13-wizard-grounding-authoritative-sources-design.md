# Wizard Grounding in Authoritative Sources — Design

**Date:** 2026-09-13
**Status:** Approved (sections 1–4 approved in chat; credential dedup + source
repair deferred to a separate execution)

## 0. Context for the executing agent

This repo is **anymaps**: a map web app whose widget "wizard" (Agent Service in
`agent/` + client chat panel) turns a natural-language prompt into a published
widget (manifest + JS bundle). Read these first, in order:

- `SPEC.md` — the source of truth. Sections 5.10–5.11 (Agent Service / Wizard
  panel), 7 (the SDK), 8 (manifest), 9 (instances), 10 (external fetching),
  11 (filtering), 12.2 (secrets) are directly relevant.
- `CONTRACTS.md` — the authoritative wire contract: the SDK surface (§3–§6),
  the manifest (§7), the HTTP data plane (§8–§9), units (§13), the wizard API
  (§15).
- `client/src/sdk/anymaps.js` — the exact global surface every widget bundle
  codes against.
- `contracts/manifest.schema.json` — the manifest schema the wizard already
  loads via `shared/schema.py`.
- `agent/app/main.py` — the wizard service; `_build_deepseek_body` assembles the
  system prompt; `GENERATION_CONTRACT` is the hand-typed string this spec deletes.
- `agent/app/skills.py` — skill loading (`load_skill_body`).
- `agent/app/skills/wizard-flow/SKILL.md`, `widget-examples/SKILL.md` — the two
  skills injected into the prompt.
- `agent/Dockerfile` — what reaches the container today (`agent/`, `shared/`,
  `contracts/` only).

The wizard is **stateless and multi-turn**: the client resends the full
transcript each turn. One turn = one DeepSeek request built by
`_build_deepseek_body`, parsed/normalized/validated, then (for `done:true`)
source-tested and published via `POST /widgets`.

## 1. Goal

Stop the wizard's knowledge of the anymaps SDK and manifest from drifting away
from the real system. Replace the hand-maintained `GENERATION_CONTRACT` string
with the authoritative sources themselves — the SDK source, `CONTRACTS.md`, and
`SPEC.md` — loaded from disk at runtime, so a widget's bundle and manifest are
generated against the same artifacts the rest of the system is built against.

The key-entry UI (password input → `/wizard/secrets` → `secretId` →
`external.auth.secret`) is preserved unchanged.

## 2. Problem and root cause (verified)

- `_build_deepseek_body` injects a hand-typed `GENERATION_CONTRACT` string that
  paraphrases `SPEC.md` §7/§8 and `CONTRACTS.md` §3–§9. It is a third,
  manually-maintained copy of the SDK surface.
- That copy has already drifted from the real SDK. The uncommitted working tree
  shows it being hand-patched: `markerClick({markerId,lat,lng})` →
  `{markerId}`, `cameraRevoked` → `cameraRevoked({reason})`, `error({error})` →
  `error({id,error})`, adding the missing `mapClick` event, adding `bearing?` to
  `flyTo/jumpTo`, and fixing `points? ,append?` → `points?|append?`.
- The manifest side is already correct: `contracts/manifest.schema.json` is
  loaded from the authoritative file. The SDK side is the only hand-maintained
  part. This spec brings the SDK side up to the same standard.

## 3. Locked design decisions

- **D1 — SDK source verbatim.** Inject `client/src/sdk/anymaps.js` unchanged.
  It is the exact global surface a bundle codes against; nothing is paraphrased.
- **D2 — CONTRACTS.md by heading.** Inject `CONTRACTS.md` §2–§13 (section 4
  lists the exact headings). Skip §1 (protocol version — the bundle does not
  control it), §14 (server error codes), and §15 (the wizard's own contract).
- **D3 — SPEC.md by heading.** Inject `SPEC.md` §7–§12 and §14 (section 4 lists
  the exact headings). Skip §1–§6 (project rationale and the locked-decision
  table, fully expanded in §7–§11), §13 (registry internals — the service
  handles publishing), §15 (build approach), §16 (glossary).
- **D4 — Delete `GENERATION_CONTRACT`.** Remove the constant and its injection.
  Nothing hand-typed replaces it; the authoritative sources are the reference.
- **D5 — Fail loudly on a missing heading.** The section loader raises at load
  time if any requested heading is absent, so a doc rename/restructure breaks
  tests and startup instead of silently dropping content. This is what keeps
  the curation (decision B) drift-proof.
- **D6 — Key flow unchanged.** The client password input, `/wizard/secrets`,
  `POST /secrets`, and `external.auth.secret = secretId` flow is preserved
  exactly. The raw key never appears in the manifest, the bundle, the LLM
  request, or any response (SPEC §12.2).
- **D7 — Files reach the container.** `agent/Dockerfile` gains COPY lines for
  the SDK source, `CONTRACTS.md`, and `SPEC.md`, since today only `agent/`,
  `shared/`, and `contracts/` are copied.
- **D8 — Skills trimmed, no dangling references.** Remove SDK-surface prose
  that `GENERATION_CONTRACT` used to own from the two SKILL.md files; fix any
  text that references "the generation contract" to reference the injected
  authoritative docs instead.

## 4. Injection set (exact)

### 4.1 SDK source (verbatim)

```
client/src/sdk/anymaps.js
```

Wrapped in a fenced JS block with a short label, e.g.
`## anymaps SDK (authoritative source)`.

### 4.2 CONTRACTS.md sections (by exact `##` heading)

| Heading | Why |
|---|---|
| `## 2. Message envelope` | documents the `error` event semantics (§5's table omits it) |
| `## 3. Init message` | `channelRoutes`, `state`, `baseUrl` bootstrap |
| `## 4. Commands (widget → map)` | exact command payload fields |
| `## 5. Events (map → widget)` | exact event payload fields |
| `## 6. The \`anymaps\` library` | canonical `anymaps.ready()` bootstrap example |
| `## 7. Manifest JSON schema` | channel matrix, record mapping, external block |
| `## 8. HTTP API` | routes the bundle fetches (incl. instances, `/secrets`) |
| `## 9. Filter parameters` | `bounds`, `ids`, `since/until`, `latest` |
| `## 10. Persistence (localStorage, main thread)` | `anymaps.persist` semantics |
| `## 11. Camera lease rules` | pan vs follow; revocation triggers |
| `## 12. UI arbitration` | popups, panels, z-order, CSS classes |
| `## 13. Units and coordinate order` | `lat`/`lng` order, bounds order, time |

### 4.3 SPEC.md sections (by exact `##` heading)

| Heading | Why |
|---|---|
| `## 7. The SDK (client side)` | SDK semantics: execution model, bootstrap, camera, persistence, lifecycle |
| `## 8. The manifest and channel model` | worked Find-My-Friends manifest |
| `## 9. Data flow, provisioning, and privacy` | instance tokens; the C1/C2/C3 worked example |
| `## 10. External fetching` | external block; ADSB.lol, Overpass, OpenWeatherMap worked examples; SSRF; failure handling |
| `## 11. Filtering and caching` | record mapping, filter composition, accumulation |
| `## 12. Transport and routes` | route table + the §12.2 secrets rule (secretId, never raw key) |
| `## 14. Out of scope for the MVP` | negative guidance (no pagination, no OAuth2, no anchored popups, no dynamic viewport) |

### 4.4 Manifest schema

`contracts/manifest.schema.json` — already loaded via `shared.load_manifest_schema()`;
unchanged.

### 4.5 Order in the assembled system prompt

```
SYSTEM_PROMPT
+ wizard-flow skill body
+ widget-examples skill body
+ SDK source (D1)
+ CONTRACTS.md §2–§13 (D2)
+ SPEC.md §7–§12, §14 (D3)
+ "\nManifest JSON Schema:\n" + json.dumps(schema)
```

Skills stay adjacent to `SYSTEM_PROMPT` so the behavioral/output-format rules
remain prominent; the authoritative references follow as the material the
skills govern.

## 5. Loader and builder

New module `agent/app/prompt.py`:

- `REPO_ROOT = Path(__file__).resolve().parents[2]` (the same pattern
  `shared/schema.py` uses, so it resolves identically under local pytest and
  inside the container).
- `SDK_SOURCE_PATH = REPO_ROOT / "client/src/sdk/anymaps.js"`,
  `CONTRACTS_PATH = REPO_ROOT / "CONTRACTS.md"`,
  `SPEC_PATH = REPO_ROOT / "SPEC.md"`.
- `split_sections(md: str) -> dict[str, str]` — split a markdown doc into
  `{ "2. Message envelope": "body…", ... }` keyed by the text after `## `.
  Splitting is on lines that begin with `## ` (and stop at the next `## `);
  `###` subsections stay inside their parent.
- `load_md_sections(path: Path, headings: list[str]) -> str` — read the file,
  split, and return the requested sections concatenated, each preceded by its
  `## heading`. Raise `FileNotFoundError` if the file is missing and
  `KeyError` (wrapped as a clear error naming the file + heading) if a heading
  is missing. This is D5.
- `build_system_prompt() -> str` — assemble section 4.5 and return it. Cache the
  result (e.g. `functools.lru_cache`) so the files are read once per process.

`agent/app/main.py` changes:

- Delete `GENERATION_CONTRACT`.
- `_build_deepseek_body(messages)` replaces its `SYSTEM_PROMPT + skills +
  GENERATION_CONTRACT + schema` concatenation with a single call to
  `build_system_prompt()`. Signature is unchanged
  (`_build_deepseek_body(list[Message]) -> dict`).

## 6. Container wiring

`agent/Dockerfile` adds, after the existing COPYs:

```dockerfile
COPY client/src/sdk ./client/src/sdk
COPY CONTRACTS.md ./CONTRACTS.md
COPY SPEC.md ./SPEC.md
```

The container layout then matches `REPO_ROOT` resolution: `/app/client/src/sdk/anymaps.js`,
`/app/CONTRACTS.md`, `/app/SPEC.md`, alongside the existing `/app/contracts/`.

## 7. Key-entry flow (preserved)

Unchanged by this spec:

1. The model emits a plan whose `sources[]` carry `auth` (`{type, name, scheme}`).
2. The service returns `secretRequests`; the client renders a password input.
3. The client posts the raw key to `/wizard/secrets`; the service verifies it
   against the source (SSRF-guarded), stores it via `POST /secrets`, and returns
   `{secretId, shape}`.
4. The client sends `secrets: [{id, secretId, shape?}]` back on the next
   `/wizard/generate`; the model writes `secretId` into `external.auth.secret`.

Security invariant (SPEC §12.2, decision 13): the raw key travels only
client input → `/wizard/secrets` → `POST /secrets` → the server secrets table.
Only the opaque `secretId` reaches the manifest; the server resolves it at poll
time. The raw key never enters `messages`, the LLM body, the manifest, the
bundle, a response, or a log.

## 8. Non-goals

- **Credential dedup + source repair.** Deferred to a separate execution; it is
  already fully specified in
  `docs/superpowers/specs/2026-09-13-wizard-credential-dedup-and-source-repair-design.md`.
- **Web/doc access for the agent** (discovering external APIs by browsing). Still
  deferred.
- No changes to `SPEC.md`, `CONTRACTS.md`, `contracts/manifest.schema.json`,
  `client/src/sdk/anymaps.js`, or the server/client data plane. They are read,
  not modified.
- No changes to the wizard wire contract (`CONTRACTS.md` §15) or the manifest
  schema.
- No new pip/npm dependencies.

## 9. Components touched

- `agent/app/prompt.py` — new loader + builder.
- `agent/app/main.py` — delete `GENERATION_CONTRACT`; call `build_system_prompt()`.
- `agent/app/skills/wizard-flow/SKILL.md` — remove SDK-surface prose; fix the
  "generation contract" reference.
- `agent/app/skills/widget-examples/SKILL.md` — remove SDK-surface prose (keep
  the worked example response shapes, the plan example, and the plan/secret flow).
- `agent/Dockerfile` — COPY the three authoritative files.
- Tests — `agent/tests/test_prompt.py` (new), plus any adjustments to
  `agent/tests/test_wizard.py` / `agent/tests/test_skills.py`.

## 10. Testing strategy

Python suite: `.venv/bin/python -m pytest`. Client suite is unaffected but
should stay green: `cd client && npm test`.

New `agent/tests/test_prompt.py`:

- `split_sections` returns the right body for a heading and keeps `###` children
  under their parent.
- `load_md_sections` returns the requested sections with headings preserved.
- `load_md_sections` raises a clear error when a requested heading is missing
  (temp file) — locks D5.
- `build_system_prompt()` contains the SDK source (`globalThis.anymaps` and a
  distinctive SDK token such as `requestCameraControl`), a CONTRACTS marker
  (`fitBounds`, `instanceToken`), a SPEC marker (`api.adsb.lol`), and the
  secrets rule (`secretId`).
- `build_system_prompt()` does NOT contain the removed `GENERATION_CONTRACT`
  text (assert a distinctive old token such as `SDK methods: addMarker` is
  absent).

Existing assertions that must still hold:

- `test_model_receives_widget_examples` (`water-fountains-nyc` and
  `anymaps.ready()` in the prompt) — both remain present via the examples skill
  and the SDK source.
- `test_model_receives_wizard_flow_skill` — the flow skill still loads.
- All wizard/generator/source-test suites stay green.

Manual/deployment sanity: `docker compose build agent` succeeds and the three
files exist inside the built image at the paths in section 6.

## 11. Risks

- **Prompt size.** The three sources add roughly 40–50 KB (~15k tokens) to the
  system prompt. The existing `MAX_OUTPUT_TOKENS = 32_000` and
  `MAX_TRANSCRIPT_CHARS = 48_000` remain; if a turn begins to truncate, the
  section lists in section 4 are the tunable knob (drop SPEC §12/§14 first,
  then the least-used CONTRACTS sections). Measured, not guessed.
- **Skill drift.** The two SKILL.md files remain hand-maintained prose. They are
  trimmed to conversation flow + worked examples only, minimizing their
  SDK-surface surface area; any SDK facts that survive in them must match the
  injected sources. (A future hardening would generate the examples from the
  SDK, out of scope here.)
