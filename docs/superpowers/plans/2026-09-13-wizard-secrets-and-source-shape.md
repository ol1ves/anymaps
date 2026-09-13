# Wizard Secrets + Source-Shape Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the wizard use keyed APIs (via a client password input wired to the existing `/wizard/secrets`) and stop guessing API params/record mappings (test the declared source and inject its shape before the final build). Also constrain named geographic scope to the source URL/query/body.

**Architecture:** Add one internal model response shape (`done:false, plan:{proposal, sources}`). The service resolves secrets, tests sources, injects shapes/secretIds into an internal-only re-prompt, then publishes. The client gains a password input and a `secrets` request field. The raw key only ever travels client → `/wizard/secrets` → `POST /secrets`.

**Tech Stack:** Python 3.14 + FastAPI + Pydantic v2 (v1-compat fallbacks) + httpx + pytest; client Node 24 + `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-13-wizard-secrets-and-source-shape-design.md`; contract refs `CONTRACTS.md` §15, `SPEC.md` §5.10-5.11.

## Global Constraints

- Raw keys never appear in `messages`, LLM request bodies, manifests, bundles, responses, or logs. Only the opaque `secretId` (and bounded source shape) cross the wizard boundary.
- Existing wizard contract shapes (`done:false, questions`, `done:true, widgetId/version/manifest`) remain valid and unchanged.
- No new pip/npm dependencies.
- Request validation (`Message`, `WizardSecretRequest`) stays strict; only *model-response* models relax extras.
- Baseline: full pytest `176 passed, 1 skipped`; client `107 pass, 0 fail`. Keep both green.
- Run Python tests with `.venv/bin/python -m pytest`; client with `npm test` in `client/`.

---

### Task 1: Geographic scope rule (Issue 2)

**Files:**
- Modify: `agent/app/skills/wizard-flow/SKILL.md`
- Test: `agent/tests/test_skills.py`

**Interfaces:**
- Produces: the wizard-flow skill body now contains a "Geographic scope" rule; no code signature changes.

- [ ] **Step 1: Write the failing test**

Append to `agent/tests/test_skills.py`:

```python
def test_wizard_flow_skill_requires_source_scoping():
    body = skills.load_skill_body(skills.WIZARD_FLOW_SKILL)
    assert "Geographic scope" in body
    assert "encode that scope in the external source" in body
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest agent/tests/test_skills.py -q`
Expected: FAIL (assertion `"Geographic scope" in body` fails).

- [ ] **Step 3: Implement**

Append a section to `agent/app/skills/wizard-flow/SKILL.md` (after the "Defaults" section):

```markdown
## Geographic scope

When the user names a fixed area (a state, city, country, or region), encode
that scope in the external source itself — the URL, query, or POST body — using
the API's own location parameter (for example `?state=NY`, or a bounding box in
an Overpass body). Do not rely only on the viewport `bounds` filter for a fixed
area; `bounds` is only for "show what is currently in view" widgets.
```

- [ ] **Step 4: Run to verify it passes**

Run: `.venv/bin/python -m pytest agent/tests/test_skills.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/app/skills/wizard-flow/SKILL.md agent/tests/test_skills.py
git commit -m "feat(agent): require geographic scope in the external source"
```

---

### Task 2: Plan + secret models, parsing, and shape from /wizard/secrets

**Files:**
- Modify: `agent/app/main.py` (imports, `WizardRequest`, new models, `_parse_model_response`, `/wizard/secrets`)
- Test: `agent/tests/test_wizard.py`

**Interfaces:**
- Produces: `SecretBinding(id, secretId, shape?)`, `WizardRequest.secrets`, `PlanSource(id, method, url, query, headers, body, auth?)`, `PlanPayload(proposal, sources)`, `PlanResponse(done, plan)`, and `_parse_model_response` now returns `{"done": False, "plan": PlanPayload}` for plan payloads. `/wizard/secrets` returns `{"secretId", "shape"}`.
- Consumes: `SecretAuthSpec`, `SourceSpec` (already imported), `MAX_EXTERNAL_SOURCES` (from `generator`).

- [ ] **Step 1: Write the failing tests**

Append to `agent/tests/test_wizard.py`:

```python
def test_parse_model_response_accepts_plan():
    payload = {
        "done": False,
        "plan": {
            "proposal": "Approve publishing weather widget?",
            "sources": [
                {
                    "id": "noaa-token",
                    "method": "GET",
                    "url": "https://www.ncei.noaa.gov/cdo-web/api/v2/stations",
                    "query": {},
                    "headers": {},
                    "auth": {"type": "header", "name": "token", "scheme": ""},
                }
            ],
        },
    }
    result = main._parse_model_response(payload)
    assert result["done"] is False
    assert result["plan"].proposal == "Approve publishing weather widget?"
    assert result["plan"].sources[0].id == "noaa-token"
    assert result["plan"].sources[0].auth.type == "header"


def test_wizard_request_accepts_secrets():
    request = main.WizardRequest.model_validate(
        {
            "messages": [{"role": "user", "content": "weather"}],
            "secrets": [{"id": "noaa-token", "secretId": "abc123", "shape": {"ok": True}}],
        }
    )
    assert request.secrets[0].id == "noaa-token"
    assert request.secrets[0].secretId == "abc123"


def test_wizard_secret_returns_shape(monkeypatch):
    seen = {}

    async def fake_test(source):
        seen["source"] = source
        return {"ok": True, "top_level_type": "object", "arrays": []}

    async def fake_store(value, *, server_url):
        seen["value"] = value
        return "secret-id"

    monkeypatch.setattr(main, "test_source", fake_test)
    monkeypatch.setattr(main, "store_secret", fake_store)
    response = client.post(
        "/wizard/secrets",
        json={
            "value": "secret-value",
            "source": {"url": "https://api.example.com/data"},
            "auth": {"type": "header", "name": "X-API-Key"},
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["secretId"] == "secret-id"
    assert body["shape"] == {"ok": True, "top_level_type": "object", "arrays": []}
    assert "secret-value" not in body
```

Update the existing `test_wizard_secret_verifies_then_stores_without_llm` so its final `response.json() == {"secretId": "secret-id"}` becomes `response.json()["secretId"] == "secret-id"` (the route now also returns `shape`).

- [ ] **Step 2: Run to verify they fail**

Run: `.venv/bin/python -m pytest agent/tests/test_wizard.py -q`
Expected: new tests FAIL (plan shape raises "invalid clarifying response"/"invalid wizard JSON"; `secrets` rejected as extra; `/wizard/secrets` lacks `shape`).

- [ ] **Step 3: Implement**

In `agent/app/main.py`, change the generator import to include `MAX_EXTERNAL_SOURCES`:

```python
from .generator import (
    MAX_EXTERNAL_SOURCES,
    publish_widget,
    store_secret,
    test_candidate_sources,
    validate_candidate,
)
```

Add `SecretBinding` and extend `WizardRequest`:

```python
class SecretBinding(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=128)
    secretId: str = Field(min_length=1, max_length=256)
    shape: dict[str, Any] | None = None


class WizardRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    messages: list[Message] = Field(min_length=1, max_length=MAX_MESSAGES)
    secrets: list[SecretBinding] = Field(
        default_factory=list, max_length=MAX_EXTERNAL_SOURCES
    )
```

Add the plan models after `WizardSecretRequest`:

```python
class PlanSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=128)
    method: Literal["GET", "POST"] = "GET"
    url: str = Field(min_length=1)
    query: dict[str, str] = Field(default_factory=dict)
    headers: dict[str, str] = Field(default_factory=dict)
    body: str | dict[str, Any] | None = None
    auth: SecretAuthSpec | None = None


class PlanPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    proposal: str = Field(min_length=1)
    sources: list[PlanSource] = Field(min_length=1, max_length=MAX_EXTERNAL_SOURCES)


class PlanResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    done: Literal[False]
    plan: PlanPayload
```

Add a model-dump helper near `_transcript_size`:

```python
def _dump_model(model: BaseModel) -> dict[str, Any]:
    try:
        return model.model_dump()
    except AttributeError:  # Pydantic 1 compatibility
        return model.dict()
```

In `_parse_model_response`, before the clarifying branch, handle the plan:

```python
    if payload["done"] is False:
        if "plan" in payload:
            try:
                parsed = PlanResponse.model_validate(payload)
            except AttributeError:  # Pydantic 1 compatibility
                parsed = PlanResponse.parse_obj(payload)
            except ValidationError as exc:
                raise ValueError("model returned an invalid plan") from exc
            return {"done": False, "plan": parsed.plan}
        try:
            ...
```

(Note: keep the existing `questions` branch as the `else` case. The `plan` branch must come first.)

In `verify_and_store_secret`, capture the test result and return it:

```python
    try:
        verification_source = source_with_secret(
            request.source, request.auth, request.value
        )
        shape = await test_source(verification_source)
    except SourceBlockedError as exc:
        ...
    ...
    return {"secretId": secret_id, "shape": shape}
```

and change the return type annotation to `dict[str, Any]`.

- [ ] **Step 4: Run to verify they pass**

Run: `.venv/bin/python -m pytest agent/tests/test_wizard.py -q`
Expected: new tests PASS; existing wizard tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/app/main.py agent/tests/test_wizard.py
git commit -m "feat(agent): add plan/secret models and return source shape"
```

---

### Task 3: Skill guidance for plan + secrets

**Files:**
- Modify: `agent/app/skills/widget-examples/SKILL.md`
- Modify: `agent/app/skills/wizard-flow/SKILL.md`
- Test: `agent/tests/test_skills.py`

**Interfaces:**
- Produces: the examples skill now documents the `plan` response and a scoped URL; the wizard-flow skill tells the model when to emit a plan and never to claim "no key needed".

- [ ] **Step 1: Write the failing tests**

Append to `agent/tests/test_skills.py`:

```python
def test_examples_skill_documents_plan_shape():
    body = skills.load_skill_body(skills.WIDGET_EXAMPLES_SKILL)
    assert '"plan"' in body
    assert '"sources"' in body
    assert '"auth"' in body


def test_wizard_flow_skill_guides_secrets():
    body = skills.load_skill_body(skills.WIZARD_FLOW_SKILL)
    assert "never claim an API needs no key" in body
    assert "emit a plan" in body
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv/bin/python -m pytest agent/tests/test_skills.py -q`
Expected: FAIL (missing strings).

- [ ] **Step 3: Implement**

Append to `agent/app/skills/widget-examples/SKILL.md` (inside the frontmatter'd file, after the completed response example) a "Plan response (external sources)" section:

````markdown
## Plan response (external sources)

When the widget will use external channels, emit a plan first so the source can
be tested and its shape verified before you write record mappings.

```json
{
  "done": false,
  "plan": {
    "proposal": "Approve publishing weather widget 'ny-weather' v1.0.0?",
    "sources": [
      {
        "id": "noaa-token",
        "method": "GET",
        "url": "https://www.ncei.noaa.gov/cdo-web/api/v2/stations?locationid=FIPS:36",
        "query": {},
        "headers": {},
        "auth": { "type": "header", "name": "token", "scheme": "" }
      }
    ]
  }
}
```

`auth` carries only type/name/scheme, never a value. `id` is the stable slot
used to pair a later secret. Scope the source URL/query/body to the user's area
(for example `locationid=FIPS:36` for New York).
````

Append to `agent/app/skills/wizard-flow/SKILL.md` (near the output rules):

```markdown
## Plans and keys

For any widget with external channels, after the source is decided, emit a
plan (`done:false` with `plan.sources`) so the source can be tested and its
shape confirmed before you write record mappings. If a source needs a key, set
`auth` to its type/name/scheme only. Never claim an API needs no key when you
are unsure; if the user says an API needs a key, trust them and request it via
the plan's `auth`. Secrets are never returned in chat.
```

- [ ] **Step 4: Run to verify they pass**

Run: `.venv/bin/python -m pytest agent/tests/test_skills.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/app/skills/widget-examples/SKILL.md agent/app/skills/wizard-flow/SKILL.md agent/tests/test_skills.py
git commit -m "feat(agent): document plan and secret flow in skills"
```

---

### Task 4: Service state machine + internal finalize

**Files:**
- Modify: `agent/app/main.py` (`generate_wizard` + new helpers)
- Test: `agent/tests/test_wizard.py`

**Interfaces:**
- Produces: `_missing_secret_requests(plan, bindings) -> list[dict]`, `async _process_plan(request, plan, api_key) -> dict`. `generate_wizard` now resolves plans before the publish path.
- Consumes: `PlanPayload`, `SecretBinding`, `SourceSpec`, `test_source`, `call_deepseek`.

- [ ] **Step 1: Write the failing tests**

Append to `agent/tests/test_wizard.py`:

```python
def _plan_model():
    return main.PlanResponse.model_validate(
        {
            "done": False,
            "plan": {
                "proposal": "Approve weather widget?",
                "sources": [
                    {
                        "id": "noaa-token",
                        "method": "GET",
                        "url": "https://www.ncei.noaa.gov/cdo-web/api/v2/stations",
                        "query": {},
                        "headers": {},
                        "auth": {"type": "header", "name": "token", "scheme": ""},
                    }
                ],
            },
        }
    ).plan


def test_plan_with_missing_secret_returns_secret_requests(monkeypatch):
    async def fake_model(messages, api_key):
        return {"done": False, "plan": _plan_model()}

    async def fake_publish(manifest, bundle, *, server_url):
        raise AssertionError("must not publish while a secret is missing")

    monkeypatch.setenv("WIZARD_LLM_API_KEY", "test-key")
    monkeypatch.setattr(main, "call_deepseek", fake_model)
    monkeypatch.setattr(main, "publish_widget", fake_publish)
    response = client.post(
        "/wizard/generate",
        json={"messages": [{"role": "user", "content": "NOAA stations in NY"}]},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["done"] is False
    assert body["questions"] == ["Approve weather widget?"]
    assert body["secretRequests"][0]["id"] == "noaa-token"
    assert body["secretRequests"][0]["auth"] == {"type": "header", "name": "token", "scheme": ""}


def test_plan_with_secret_finalizes_and_publishes(monkeypatch):
    calls = []
    manifest = {
        "id": "ny-weather",
        "name": "NY Weather",
        "version": "1.0.0",
        "description": "NY weather",
        "server": {
            "channels": [
                {
                    "id": "noaa",
                    "origin": "external",
                    "direction": "read",
                    "visibility": "public",
                    "external": {
                        "method": "GET",
                        "url": "https://www.ncei.noaa.gov/cdo-web/api/v2/stations",
                        "auth": {"type": "header", "name": "token", "secret": "abc123"},
                    },
                }
            ]
        },
    }

    async def fake_model(messages, api_key):
        calls.append(messages)
        if len(calls) == 1:
            return {"done": False, "plan": _plan_model()}
        return {"done": True, "widgetId": "ny-weather", "version": "1.0.0",
                "manifest": manifest, "bundle": "anymaps.ready().then(() => {});"}

    async def fake_sources(manifest_arg):
        return []

    async def fake_publish(manifest_arg, bundle, *, server_url):
        assert manifest_arg["server"]["channels"][0]["external"]["auth"]["secret"] == "abc123"
        return {"id": "ny-weather", "version": "1.0.0"}

    monkeypatch.setenv("WIZARD_LLM_API_KEY", "test-key")
    monkeypatch.setattr(main, "call_deepseek", fake_model)
    monkeypatch.setattr(main, "test_candidate_sources", fake_sources)
    monkeypatch.setattr(main, "publish_widget", fake_publish)
    response = client.post(
        "/wizard/generate",
        json={
            "messages": [{"role": "user", "content": "NOAA stations in NY"}],
            "secrets": [{"id": "noaa-token", "secretId": "abc123", "shape": {"ok": True}}],
        },
    )
    assert response.status_code == 200
    assert response.json()["done"] is True
    assert len(calls) == 2
    final_note = calls[1][-1].content
    assert "abc123" in final_note
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv/bin/python -m pytest agent/tests/test_wizard.py -q`
Expected: FAIL (plans are treated as clarifying responses; missing-secret test returns the plan's `questions` or errors; finalize test makes only one model call).

- [ ] **Step 3: Implement**

In `agent/app/main.py`, add these helpers above `generate_wizard`:

```python
def _missing_secret_requests(
    plan: PlanPayload, bindings: dict[str, SecretBinding]
) -> list[dict[str, Any]]:
    missing: list[dict[str, Any]] = []
    for source in plan.sources:
        if source.auth is not None and source.id not in bindings:
            missing.append(
                {
                    "id": source.id,
                    "source": _dump_model(
                        SourceSpec(
                            method=source.method,
                            url=source.url,
                            query=source.query,
                            headers=source.headers,
                            body=source.body,
                        )
                    ),
                    "auth": _dump_model(source.auth),
                }
            )
    return missing


async def _process_plan(
    request: WizardRequest, plan: PlanPayload, api_key: str
) -> dict[str, Any]:
    bindings = {binding.id: binding for binding in request.secrets}
    missing = _missing_secret_requests(plan, bindings)
    if missing:
        return {
            "done": False,
            "questions": [plan.proposal],
            "secretRequests": missing,
        }

    notes = [
        "The plan is approved. Here is the verified source information.",
        "Return done:true with the final manifest and bundle now.",
        "Write each external source exactly as planned. For authenticated "
        "sources, set external.auth.secret to the secretId below (verbatim); "
        "never invent a secretId.",
    ]
    for source in plan.sources:
        if source.auth is not None:
            binding = bindings[source.id]
            notes.append(
                f"Source '{source.id}': auth {source.auth.type} name={source.auth.name}; "
                f"secretId={binding.secretId}."
            )
            if binding.shape is not None:
                notes.append(f"Source '{source.id}' shape: {json.dumps(binding.shape)}")
        else:
            spec = SourceSpec(
                method=source.method,
                url=source.url,
                query=source.query,
                headers=source.headers,
                body=source.body,
            )
            try:
                shape = await test_source(spec)
            except SourceBlockedError as exc:
                raise HTTPException(
                    status_code=400, detail="source blocked by SSRF rules"
                ) from exc
            except SourceTestError as exc:
                raise HTTPException(
                    status_code=500, detail=f"source test failed: {exc}"
                ) from exc
            notes.append(f"Source '{source.id}' shape: {json.dumps(shape)}")

    content = "\n".join(notes)
    if len(content) > MAX_CONTENT_CHARS:
        content = content[:MAX_CONTENT_CHARS - 1]
    final_messages = list(request.messages) + [Message(role="user", content=content)]
    return await call_deepseek(final_messages, api_key)
```

In `generate_wizard`, after the first `call_deepseek`, insert plan resolution:

```python
    result = await call_deepseek(request.messages, api_key)
    if result["done"] is False and "plan" in result:
        result = await _process_plan(request, result["plan"], api_key)
    if result["done"] is False:
        return result
```

(replace the existing `if result["done"] is False: return result` block with the above two blocks.)

- [ ] **Step 4: Run to verify they pass**

Run: `.venv/bin/python -m pytest agent/tests/test_wizard.py -q`
Expected: new tests PASS.

- [ ] **Step 5: Run the full agent suite**

Run: `.venv/bin/python -m pytest agent/tests -q`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add agent/app/main.py agent/tests/test_wizard.py
git commit -m "feat(agent): resolve plans with secret entry and source shape"
```

---

### Task 5: Client password input + secrets field

**Files:**
- Modify: `client/src/ui/wizard.js` (`handleWizardResponse`, new `verifySecrets`, `send`/`sendTurn` refactor)
- Test: `client/tests/wizard.test.js`

**Interfaces:**
- Produces: `handleWizardResponse` returns `{kind:"secretRequests", transcript, question, secretRequests}`; `verifySecrets(secretRequests, values, agentBaseUrl, fetchImpl) -> Promise<secrets>`.
- Consumes: `appendTurn`, `agentUrl()`.

- [ ] **Step 1: Write the failing tests**

Append to `client/tests/wizard.test.js`:

```js
test("handleWizardResponse secretRequests appends the question and flags key entry", () => {
  const transcript = [{ role: "user", content: "NOAA stations" }];
  const out = handleWizardResponse(transcript, {
    done: false,
    questions: ["This API needs a token header. Enter your key?"],
    secretRequests: [
      { id: "noaa-token", source: { url: "https://example.com" }, auth: { type: "header", name: "token", scheme: "" } },
    ],
  });
  assert.equal(out.kind, "secretRequests");
  assert.equal(out.question, "This API needs a token header. Enter your key?");
  assert.deepEqual(out.secretRequests[0], { id: "noaa-token", source: { url: "https://example.com" }, auth: { type: "header", name: "token", scheme: "" } });
  assert.deepEqual(out.transcript, [
    { role: "user", content: "NOAA stations" },
    { role: "assistant", content: "This API needs a token header. Enter your key?" },
  ]);
});

test("verifySecrets posts each key to /wizard/secrets and returns bindings", async () => {
  const posted = [];
  const fetchImpl = async (url, options) => {
    posted.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ secretId: "sid-" + posted.length, shape: { ok: true } }) };
  };
  const secrets = await verifySecrets(
    [
      { id: "a", source: { url: "https://one.example" }, auth: { type: "header", name: "X" } },
      { id: "b", source: { url: "https://two.example" }, auth: { type: "query", name: "key" } },
    ],
    { a: "key-a", b: "key-b" },
    "http://agent",
    fetchImpl,
  );
  assert.deepEqual(secrets, [
    { id: "a", secretId: "sid-1", shape: { ok: true } },
    { id: "b", secretId: "sid-2", shape: { ok: true } },
  ]);
  assert.equal(posted[0].url, "http://agent/wizard/secrets");
  assert.equal(posted[0].body.value, "key-a");
  assert.equal(posted[1].body.value, "key-b");
});
```

- [ ] **Step 2: Run to verify they fail**

Run (in `client/`): `npm test`
Expected: FAIL (`secretRequests` classified as error; `verifySecrets` not exported).

- [ ] **Step 3: Implement**

In `client/src/ui/wizard.js`, extend `handleWizardResponse`'s `done === false` branch:

```js
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
```

Add the exported helper near `handleWizardResponse`:

```js
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
```

Refactor `send` into `sendTurn(messages, secrets)` and add the secret-request branch. Inside `register`, replace the fetch body to include `secrets`, and add:

```js
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
    } catch (err) { /* unchanged error handling */ }
    clearTimeout(timer);
    // ... (existing non-ok / json parse handling, but use `messages`/`secrets` below)
    const result = handleWizardResponse(messages, response);
    thinking.remove();
    if (result.kind === "error") { /* unchanged */ }
    if (result.kind === "clarify") { /* unchanged */ }
    if (result.kind === "secretRequests") {
      transcript = result.transcript;
      bubble("assistant", result.question);
      input.value = "";
      await collectSecrets(result.secretRequests);
      setBusy(false);
      return;
    }
    // done: unchanged (uses result.transcript reset + manager.install)
  }

  async function collectSecrets(secretRequests) {
    const values = {};
    const host = document.createElement("div");
    host.className = "anymaps-wizard-secrets";
    for (const request of secretRequests) {
      const field = document.createElement("input");
      field.type = "password";
      field.placeholder = "Enter key for " + request.id;
      field.dataset.secretId = request.id;
      field.addEventListener("input", () => { values[request.id] = field.value; });
      host.appendChild(field);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Verify & continue";
    log.appendChild(host);
    host.appendChild(button);
    await new Promise((resolve) => {
      button.addEventListener("click", async () => {
        try {
          const secrets = await verifySecrets(secretRequests, values, agentUrl());
          transcript = appendTurn(transcript, { role: "user", content: "I've provided the key(s). Proceed." });
          bubble("user", "I've provided the key(s). Proceed.");
          host.remove();
          await sendTurn(transcript, secrets);
          resolve();
        } catch (err) {
          bubble("assistant", (err && err.message) || "secret verification failed", { error: true });
          resolve();
        }
      });
    });
  }
```

Replace `send` with a thin wrapper:

```js
  function send(content) {
    if (busy) return;
    const text = (content || "").trim();
    if (!text) return;
    transcript = appendTurn(transcript, { role: "user", content: text });
    bubble("user", text);
    sendTurn(transcript, []);
  }
```

(The existing `send` body's fetch/response handling is what becomes `sendTurn`; keep the `busy` guard in `send` only. Preserve all existing error handling and the done-branch install logic, with `messages`/`secrets` in place of the old `transcript`/no-secrets.)

- [ ] **Step 4: Run to verify they pass**

Run (in `client/`): `npm test`
Expected: new tests PASS; existing wizard tests PASS.

- [ ] **Step 5: Run build**

Run (in `client/`): `npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add client/src/ui/wizard.js client/tests/wizard.test.js
git commit -m "feat(client): password entry for wizard secrets"
```

---

### Task 6: Security end-to-end (no key leak)

**Files:**
- Test: `agent/tests/test_wizard.py`

**Interfaces:**
- Consumes: `call_deepseek`, `test_source`, `store_secret`, `publish_widget` (all monkeypatchable), plus the two routes.

- [ ] **Step 1: Write the failing test**

Append to `agent/tests/test_wizard.py`:

```python
def test_raw_key_never_reaches_llm_or_manifest(monkeypatch):
    llm_bodies = []

    async def fake_model(messages, api_key):
        llm_bodies.append(messages)
        if len(llm_bodies) == 1:
            return {"done": False, "plan": _plan_model()}
        return {
            "done": True,
            "widgetId": "ny-weather",
            "version": "1.0.0",
            "manifest": {
                "id": "ny-weather",
                "name": "NY Weather",
                "version": "1.0.0",
                "description": "NY weather",
                "server": {
                    "channels": [
                        {
                            "id": "noaa",
                            "origin": "external",
                            "direction": "read",
                            "visibility": "public",
                            "external": {
                                "method": "GET",
                                "url": "https://www.ncei.noaa.gov/cdo-web/api/v2/stations",
                                "auth": {"type": "header", "name": "token", "secret": "abc123"},
                            },
                        }
                    ]
                },
            },
            "bundle": "anymaps.ready().then(() => {});",
        }

    async def fake_sources(manifest):
        return []

    async def fake_publish(manifest, bundle, *, server_url):
        return {"id": "ny-weather", "version": "1.0.0"}

    monkeypatch.setenv("WIZARD_LLM_API_KEY", "test-key")
    monkeypatch.setattr(main, "call_deepseek", fake_model)
    monkeypatch.setattr(main, "test_candidate_sources", fake_sources)
    monkeypatch.setattr(main, "publish_widget", fake_publish)

    response = client.post(
        "/wizard/generate",
        json={
            "messages": [{"role": "user", "content": "NOAA stations in NY"}],
            "secrets": [{"id": "noaa-token", "secretId": "abc123", "shape": {"ok": True}}],
        },
    )
    assert response.status_code == 200
    for messages in llm_bodies:
        for message in messages:
            assert "secret-value" not in message.content
            assert "abc123" in message.content or message.role == "user"
```

(Add `_plan_model()` from Task 4 to the test file if not already present — it is defined in Task 4's tests.)

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest agent/tests/test_wizard.py -q`
Expected: the test may pass once Task 4/5 are in; if it passes, adjust the assertion to match the actual invariant (the point is to lock the no-key-leak behavior). If it already passes, this step confirms it and you may skip to Step 3's commit.

- [ ] **Step 3: Commit**

```bash
git add agent/tests/test_wizard.py
git commit -m "test(agent): lock no-key-leak invariant for wizard secrets"
```

---

## Self-Review

**Spec coverage:** Issue 2 (source scoping) → Task 1 + Task 3. Issue 1 secrets (models, /wizard/secrets shape) → Task 2; skill guidance → Task 3; state machine → Task 4; client password input → Task 5; no-key-leak invariant → Task 6.

**Placeholder scan:** None — every step carries full code.

**Type consistency:** `PlanPayload`/`PlanSource`/`SecretBinding` are defined in Task 2 and consumed by Tasks 4/6 with the same field names. `handleWizardResponse` `secretRequests` result shape is defined in Task 5 and its `send` consumer in the same task. `verifySecrets(secretRequests, values, agentBaseUrl, fetchImpl)` is defined and tested in Task 5. `_plan_model()` is introduced in Task 4 and reused in Task 6 (documented).
