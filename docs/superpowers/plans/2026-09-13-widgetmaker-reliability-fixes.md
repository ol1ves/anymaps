# Widgetmaker Reliability Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the widget wizard reliably produce new widgets from user prompts by (1) tolerating real model output (prose preambles, fenced JSON, reasoning tokens, harmless extra fields), (2) giving the model worked examples, (3) adding a bounded repair pass that feeds validation errors back, and (4) fixing the client's retry-after-publish bug.

**Architecture:** The Agent Service (`agent/app/main.py`) sends the model a system prompt built from two skills plus the generation contract and the manifest JSON schema, then parses/normalizes/validates the JSON answer and publishes the widget. Changes stay inside that pipeline and the client chat panel; no new dependencies, no changes to the wire contract.

**Tech Stack:** Python 3.14, FastAPI, Pydantic v2.13 (with v1-compat fallbacks), httpx, pytest; client Node 24 + `node:test`. Tests run via `.venv/bin/python -m pytest` and `npm test` in `client/`.

**Spec:** `CONTRACTS.md` §15 (Wizard API), `SPEC.md` §5.10-5.11 (Agent Service + Wizard panel), `contracts/manifest.schema.json`. This plan implements the fixes identified in the widgetmaker reliability review (root causes #1, #4, #6, #7, and the client retry bug).

## Global Constraints

- Wizard contract is unchanged: `done:false → {"done": false, "questions": ["one question"]}` and `done:true → {"done": true, "widgetId", "version", "manifest"}` (bundle is server-internal, never returned).
- All manifests must still validate against `contracts/manifest.schema.json` and `validate_channel_matrix`.
- Bundles must remain classic scripts: no `import `/`export `, no DOM/window/navigator/localStorage/raw postMessage.
- No new pip/npm dependencies.
- Do not weaken request validation (`Message`, `WizardRequest`, `WizardSecretRequest` keep `extra="forbid"`); only the *model-response* models become tolerant.
- Existing agent tests must stay green (baseline: `65 passed, 1 skipped` in `agent/tests`).
- Run the Python test suite from the repo root with `.venv/bin/python -m pytest`.

---

### Task 1: Tolerant model-response parsing

**Files:**
- Modify: `agent/app/main.py:203-258` (`_parse_model_response`, `_extract_json_content`) and the two response models at `agent/app/main.py:124-131` (`ClarifyingResponse`)
- Modify: `agent/app/generator.py:27-31` (`GenerationCandidate` `extra`)
- Test: `agent/tests/test_wizard.py`, `agent/tests/test_generator.py`

**Interfaces:**
- Consumes: existing `_parse_model_response(payload) -> dict`, `_extract_json_content(response_json) -> dict`, `validate_candidate(payload) -> GenerationCandidate`.
- Produces: new module-private `_extract_first_json_object(text: str) -> dict | None` (used only inside `_extract_json_content`); `ClarifyingResponse` and `GenerationCandidate` now use `extra="ignore"`.

- [ ] **Step 1: Write failing tests**

Append to `agent/tests/test_wizard.py`:

```python
def test_extract_json_strips_prose_and_fence():
    content = (
        "Sure, here is the JSON:\n"
        "```json\n{\"done\": false, \"questions\": [\"Which source?\"]}\n```"
    )
    result = main._extract_json_content(
        {"choices": [{"finish_reason": "stop", "message": {"content": content}}]}
    )
    assert result == {"done": False, "questions": ["Which source?"]}


def test_extract_json_reads_reasoning_content_fallback():
    result = main._extract_json_content(
        {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "content": "",
                        "reasoning_content": '{"done":false,"questions":["q"]}',
                    },
                }
            ]
        }
    )
    assert result == {"done": False, "questions": ["q"]}


def test_parse_model_response_ignores_extra_keys():
    payload = {"done": False, "questions": ["Which source?"], "note": "extra"}
    assert main._parse_model_response(payload) == {
        "done": False,
        "questions": ["Which source?"],
    }
```

Append to `agent/tests/test_generator.py`:

```python
def test_candidate_ignores_unknown_fields():
    candidate = generator.validate_candidate(
        {
            "done": True,
            "widgetId": "demo-widget",
            "version": "0.1.0",
            "manifest": MANIFEST,
            "bundle": "anymaps.ready().then(() => {});",
            "summary": "a demo widget",
        }
    )
    assert candidate.done is True
    assert candidate.bundle == "anymaps.ready().then(() => {});"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest agent/tests/test_wizard.py agent/tests/test_generator.py -q`
Expected: the four new tests FAIL (prose/fence case raises "invalid JSON"; reasoning fallback raises "no assistant content"; extra-key cases raise "invalid clarifying response" / "invalid generation response").

- [ ] **Step 3: Implement**

In `agent/app/main.py`, replace `ClarifyingResponse`'s config line:

```python
    model_config = ConfigDict(extra="ignore")
```

In `agent/app/generator.py`, replace `GenerationCandidate`'s config line:

```python
    model_config = ConfigDict(extra="ignore")
```

In `agent/app/main.py`, add the scanner helper just above `_extract_json_content`:

```python
def _extract_first_json_object(text: str) -> dict[str, Any] | None:
    """Return the first balanced JSON object found in prose, or None."""

    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        char = text[i]
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
        else:
            if char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    try:
                        parsed = json.loads(text[start:i + 1])
                    except json.JSONDecodeError:
                        return None
                    return parsed if isinstance(parsed, dict) else None
    return None
```

Replace the body of `_extract_json_content` with:

```python
def _extract_json_content(response_json: dict[str, Any]) -> dict[str, Any]:
    """Extract the object from a non-streaming Chat Completions response."""

    try:
        choice = response_json["choices"][0]
        message = choice["message"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError("DeepSeek returned no assistant content") from exc

    content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        # Reasoning models may leave the final answer in reasoning_content.
        content = message.get("reasoning_content")
    if not isinstance(content, str) or not content.strip():
        if choice.get("finish_reason") == "length":
            raise ValueError(
                "DeepSeek response was truncated (finish_reason=length) "
                "before it produced complete JSON"
            )
        raise ValueError("DeepSeek returned no assistant content")

    text = content.strip()
    if "```" in text:
        start = text.find("```")
        end = text.rfind("```")
        if start != -1 and end > start:
            inner = text[start + 3:end].strip()
            if inner.lower().startswith("json"):
                inner = inner[4:].lstrip()
            text = inner

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = _extract_first_json_object(text)
        if parsed is None:
            if choice.get("finish_reason") == "length":
                raise ValueError(
                    "DeepSeek response was truncated (finish_reason=length) "
                    "before it produced complete JSON"
                )
            raise ValueError("DeepSeek returned invalid JSON")
    if not isinstance(parsed, dict):
        raise ValueError("DeepSeek returned a JSON value instead of an object")
    return parsed
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest agent/tests/test_wizard.py agent/tests/test_generator.py -q`
Expected: new tests PASS and the existing parsing tests (`test_truncated_model_response_reports_length_not_invalid_json`, `test_invalid_model_json_reports_invalid_json`) still PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/app/main.py agent/app/generator.py agent/tests/test_wizard.py agent/tests/test_generator.py
git commit -m "fix(agent): tolerate prose, fences, reasoning content, and extra keys"
```

---

### Task 2: Worked examples skill + configurable model id

**Files:**
- Create: `agent/app/skills/widget-examples/SKILL.md`
- Modify: `agent/app/skills.py` (add `WIDGET_EXAMPLES_SKILL` constant)
- Modify: `agent/app/main.py` (import the constant; inject it in the system prompt; read model id from env)
- Test: `agent/tests/test_skills.py`, `agent/tests/test_wizard.py`

**Interfaces:**
- Consumes: `load_skill_body(name)` from `agent/app/skills.py`.
- Produces: `skills.WIDGET_EXAMPLES_SKILL = "widget-examples"`; `_build_deepseek_body(messages: list[Message]) -> dict` (used by Task 3) whose `body["model"]` reads `WIZARD_LLM_MODEL` (default `deepseek-v4-flash`).

- [ ] **Step 1: Write failing tests**

Append to `agent/tests/test_skills.py`:

```python
def test_load_widget_examples_skill():
    body = skills.load_skill_body(skills.WIDGET_EXAMPLES_SKILL)
    assert "water-fountains-nyc" in body
    assert "anymaps.ready()" in body
    assert '"done": true' in body
```

Append to `agent/tests/test_wizard.py`:

```python
def test_model_receives_widget_examples(monkeypatch):
    import asyncio
    import httpx
    original = httpx.AsyncClient
    def handler(request):
        import json
        prompt = json.loads(request.content)["messages"][0]["content"]
        assert "water-fountains-nyc" in prompt
        assert "anymaps.ready()" in prompt
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"done":false,"questions":["Which source?"]}'}}]})
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    result = asyncio.run(main.call_deepseek([main.Message(role="user", content="Make a widget")], "test-key"))
    assert result["done"] is False


def test_model_id_reads_env_override(monkeypatch):
    import asyncio
    import httpx
    original = httpx.AsyncClient
    seen = {}
    def handler(request):
        import json
        seen["model"] = json.loads(request.content)["model"]
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"done":false,"questions":["Which source?"]}'}}]})
    monkeypatch.setenv("WIZARD_LLM_MODEL", "deepseek-test")
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    asyncio.run(main.call_deepseek([main.Message(role="user", content="Make a widget")], "test-key"))
    assert seen["model"] == "deepseek-test"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest agent/tests/test_skills.py agent/tests/test_wizard.py -q`
Expected: `test_load_widget_examples_skill` errors (attribute `WIDGET_EXAMPLES_SKILL` missing); the two wizard tests fail (prompt lacks `water-fountains-nyc`; body model stays `deepseek-v4-flash`).

- [ ] **Step 3: Implement**

Create `agent/app/skills/widget-examples/SKILL.md`:

````markdown
---
name: widget-examples
description: Concrete worked examples of the wizard's clarifying and completed JSON responses, a valid manifest, and a valid bundle. Always active.
---

# Widget Wizard Worked Examples

Copy these shapes exactly. They are the only output formats that parse.

## Clarifying response

```json
{"done": false, "questions": ["Drinking water (amenity=drinking_water) or decorative fountains (amenity=fountain)?"]}
```

## Completed response

Top-level keys only: `done`, `widgetId`, `version`, `manifest`, `bundle`.
`widgetId` must equal `manifest.id`; `version` must equal `manifest.version`.

```json
{
  "done": true,
  "widgetId": "water-fountains-nyc",
  "version": "1.0.0",
  "manifest": {
    "id": "water-fountains-nyc",
    "name": "NYC Water Fountains",
    "version": "1.0.0",
    "description": "Drinking water fountains in New York City",
    "server": {
      "channels": [
        {
          "id": "water",
          "origin": "external",
          "direction": "read",
          "visibility": "public",
          "external": {
            "method": "POST",
            "url": "https://overpass-api.de/api/interpreter",
            "body": "[out:json];node[\"amenity\"=\"drinking_water\"](40.47,-74.26,40.92,-73.70);out;",
            "interval": 86400,
            "mode": "snapshot",
            "record": { "records": "elements", "id": "id", "lat": "lat", "lon": "lon" }
          }
        }
      ]
    }
  },
  "bundle": "(async function () {\n  const { config } = await anymaps.ready();\n  const route = config.channelRoutes && config.channelRoutes.water;\n  if (!route) { anymaps.setPanel({ title: 'Water', content: 'Channel unavailable.' }); return; }\n  async function refresh(bounds) {\n    const url = new URL(route);\n    if (Array.isArray(bounds) && bounds.length === 2) {\n      url.searchParams.set('bounds', [bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1]].join(','));\n    }\n    const res = await fetch(url.toString());\n    const body = await res.json();\n    const records = Array.isArray(body.records) ? body.records : [];\n    for (const r of records) {\n      if (r.id === undefined || !Number.isFinite(Number(r.lat)) || !Number.isFinite(Number(r.lon))) continue;\n      anymaps.addMarker({ id: String(r.id), lat: Number(r.lat), lng: Number(r.lon), title: 'Water' });\n    }\n    anymaps.setPanel({ title: 'Water', content: records.length + ' fountains' });\n  }\n  anymaps.on('viewportChanged', ({ bounds }) => refresh(bounds));\n  await refresh(null);\n})();"
}
```
````

Modify `agent/app/skills.py` to add the constant after `WIZARD_FLOW_SKILL`:

```python
WIZARD_FLOW_SKILL = "wizard-flow"
WIDGET_EXAMPLES_SKILL = "widget-examples"
```

Modify `agent/app/main.py`:
- import: `from .skills import WIZARD_FLOW_SKILL, WIDGET_EXAMPLES_SKILL, load_skill_body`
- Add a module-level helper above `call_deepseek` (Task 3 will use it too):

```python
def _build_deepseek_body(messages: list[Message]) -> dict[str, Any]:
    """Assemble the system prompt and transcript for one DeepSeek request."""

    system = (
        SYSTEM_PROMPT
        + load_skill_body(WIZARD_FLOW_SKILL)
        + load_skill_body(WIDGET_EXAMPLES_SKILL)
        + GENERATION_CONTRACT
        + "\nManifest JSON Schema:\n" + json.dumps(load_manifest_schema())
    )
    return {
        "model": os.getenv("WIZARD_LLM_MODEL", DEEPSEEK_MODEL),
        "messages": [
            {"role": "system", "content": system},
            *[{"role": item.role, "content": item.content} for item in messages],
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
        "max_tokens": MAX_OUTPUT_TOKENS,
        "stream": False,
    }
```

- Replace the body-building block at the top of `call_deepseek` so it calls `_build_deepseek_body`. Do this in Task 3 (the function is rewritten there). For now, minimally replace the `request_messages`/`body` construction in `call_deepseek` with `body = _build_deepseek_body(messages)` and remove the now-unused `request_messages` lines.

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest agent/tests/test_skills.py agent/tests/test_wizard.py -q`
Expected: new tests PASS; `test_model_receives_wizard_flow_skill` still PASSES (examples contain no "Work conversationally").

- [ ] **Step 5: Commit**

```bash
git add agent/app/skills/widget-examples/SKILL.md agent/app/skills.py agent/app/main.py agent/tests/test_skills.py agent/tests/test_wizard.py
git commit -m "feat(agent): inject worked examples and make model id configurable"
```

---

### Task 3: Bounded repair loop

**Files:**
- Modify: `agent/app/main.py` (rewrite `call_deepseek`; add `MAX_REPAIR_ATTEMPTS` and `_request_parsed_once`)
- Test: `agent/tests/test_wizard.py`

**Interfaces:**
- Consumes: `_build_deepseek_body` (Task 2), `_request_deepseek_json`, `_parse_model_response`, `_extract_json_content`, `RETRY_BACKOFF_SECONDS`, `MAX_DEEPSEEK_ATTEMPTS`, `REQUEST_TIMEOUT_SECONDS`.
- Produces: `call_deepseek(messages, api_key) -> dict` — unchanged public signature; now retries a parse/validation failure once with the error fed back.

- [ ] **Step 1: Write failing tests**

Append to `agent/tests/test_wizard.py`:

```python
def test_call_deepseek_repairs_invalid_json_once(monkeypatch):
    import asyncio
    calls = []

    async def fake_request(client, api_key, body):
        calls.append(body)
        if len(calls) == 1:
            return {"choices": [{"finish_reason": "stop", "message": {"content": "{not json"}}]}
        return {"choices": [{"message": {"content": '{"done":false,"questions":["Which source?"]}'}}]}

    monkeypatch.setattr(main, "_request_deepseek_json", fake_request)
    monkeypatch.setattr(main, "RETRY_BACKOFF_SECONDS", 0)
    result = asyncio.run(main.call_deepseek([main.Message(role="user", content="Make a widget")], "test-key"))
    assert result["done"] is False
    assert len(calls) == 2
    assert "rejected" in calls[1]["messages"][-1]["content"]


def test_call_deepseek_surfaces_parse_error_after_repair(monkeypatch):
    import asyncio
    from fastapi import HTTPException
    calls = []

    async def always_bad(client, api_key, body):
        calls.append(1)
        return {"choices": [{"finish_reason": "stop", "message": {"content": "{not json"}}]}

    monkeypatch.setattr(main, "_request_deepseek_json", always_bad)
    monkeypatch.setattr(main, "RETRY_BACKOFF_SECONDS", 0)
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(main.call_deepseek([main.Message(role="user", content="Make a widget")], "test-key"))
    assert "invalid JSON" in exc_info.value.detail
    assert len(calls) == 2
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest agent/tests/test_wizard.py -q`
Expected: `test_call_deepseek_repairs_invalid_json_once` fails (only 1 call, then HTTPException). `test_call_deepseek_surfaces_parse_error_after_repair` fails on the call-count assertion (1 call, detail is still "invalid JSON").

- [ ] **Step 3: Implement**

Add the constant next to the other limits near `MAX_OUTPUT_TOKENS`:

```python
MAX_REPAIR_ATTEMPTS = 1
```

Replace `call_deepseek` with:

```python
async def _request_parsed_once(
    messages: list[Message], api_key: str
) -> dict[str, Any]:
    """One wizard turn with transport retries, then parse/normalize.

    Raises ValueError when the HTTP body is not a valid wizard response;
    raises HTTPException for transport or HTTP failures.
    """

    body = _build_deepseek_body(messages)
    last_cause = "unknown"
    for attempt in range(MAX_DEEPSEEK_ATTEMPTS):
        try:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
                response_json = await _request_deepseek_json(client, api_key, body)
        except _DeepSeekRetryableError as exc:
            last_cause = str(exc)
        except RETRYABLE_TRANSPORT_ERRORS as exc:
            last_cause = type(exc).__name__
        except httpx.TimeoutException as exc:
            raise HTTPException(status_code=500, detail="DeepSeek request timed out") from exc
        except httpx.HTTPStatusError as exc:
            raise HTTPException(
                status_code=500,
                detail=f"DeepSeek request failed: HTTP {exc.response.status_code}",
            ) from exc
        except ValueError as exc:
            raise HTTPException(status_code=500, detail="DeepSeek request failed") from exc
        else:
            return _parse_model_response(_extract_json_content(response_json))

        if attempt < MAX_DEEPSEEK_ATTEMPTS - 1:
            await asyncio.sleep(RETRY_BACKOFF_SECONDS)

    raise HTTPException(status_code=500, detail=f"DeepSeek request failed ({last_cause})")


async def call_deepseek(messages: list[Message], api_key: str) -> dict[str, Any]:
    """Make a bounded DeepSeek request for a wizard turn.

    Transient transport errors are retried once, and a response that fails to
    parse or validate is retried once with the concrete error fed back to the
    model so it can self-correct.
    """

    current = list(messages)
    last_parse_error = "unknown"
    for repair in range(MAX_REPAIR_ATTEMPTS + 1):
        try:
            return await _request_parsed_once(current, api_key)
        except ValueError as exc:
            last_parse_error = str(exc)
        if repair < MAX_REPAIR_ATTEMPTS:
            current = current + [
                Message(
                    role="user",
                    content=(
                        "Your previous response was rejected: "
                        + last_parse_error
                        + " Reply with corrected JSON only."
                    ),
                )
            ]
    raise HTTPException(status_code=500, detail=last_parse_error)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest agent/tests/test_wizard.py -q`
Expected: new repair tests PASS and the existing `test_call_deepseek_*` retry tests still PASS.

- [ ] **Step 5: Run the full agent suite**

Run: `.venv/bin/python -m pytest agent/tests -q`
Expected: all agent tests pass.

- [ ] **Step 6: Commit**

```bash
git add agent/app/main.py agent/tests/test_wizard.py
git commit -m "feat(agent): retry rejected wizard responses with error feedback"
```

---

### Task 4: Client resets transcript on done (fix retry-after-publish)

**Files:**
- Modify: `client/src/ui/wizard.js` (`handleWizardResponse` done branch; `send` done branch)
- Test: `client/tests/wizard.test.js`

**Interfaces:**
- Consumes: `appendTurn(transcript, message)` (existing).
- Produces: `handleWizardResponse(transcript, response)` now returns `{ kind: "done", widgetId, version, transcript: [] }` for done.

- [ ] **Step 1: Write failing tests**

Append to `client/tests/wizard.test.js`:

```js
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
```

Update the existing done test's final assertion from `assert.deepEqual(transcript, [{ role: "user", content: "water fountains" }]);` to also assert `assert.deepEqual(out.transcript, []);` (keep the unchanged-input assertion).

- [ ] **Step 2: Run tests to verify they fail**

Run (in `client/`): `npm test`
Expected: new test FAILS (`out.transcript` is `undefined`).

- [ ] **Step 3: Implement**

In `client/src/ui/wizard.js`, change the done branch of `handleWizardResponse`:

```js
  if (response.done === true) {
    return { kind: "done", widgetId: response.widgetId, version: response.version, transcript: [] };
  }
```

In the `send` done branch, reset the transcript before installing (replace the block that resets only after a successful install):

```js
    const { widgetId, version } = result;
    // The Agent Service already published this widget. Reset the transcript
    // now so a retry after this point starts a fresh widget instead of
    // re-publishing the same id/version (which the server rejects with 409).
    transcript = result.transcript;
    input.value = "";
    bubble("assistant", "Widget generated. Installing…");
```

and remove the `transcript = []; input.value = "";` lines from inside the `try` block, leaving the success bubble as just `bubble("assistant", "Installed: " + widgetId);`.

- [ ] **Step 4: Run tests to verify they pass**

Run (in `client/`): `npm test`
Expected: all wizard tests PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/ui/wizard.js client/tests/wizard.test.js
git commit -m "fix(client): reset wizard transcript on done to avoid republish 409"
```

---

## Self-Review

**Spec coverage:** The four review findings this plan addresses are each covered by a task: tolerant parsing/extra keys (Task 1), worked examples + env-configurable model (Task 2), repair loop (Task 3), client retry-after-publish (Task 4). The remaining review finding — feeding the tested source shape back to the model before it writes record mappings — is intentionally deferred (it requires a new intermediate response mode and changes the flow contract); it is tracked separately.

**Placeholder scan:** None — every code step includes full code.

**Type consistency:** `_build_deepseek_body(list[Message]) -> dict` is defined in Task 2 and consumed by `_request_parsed_once` in Task 3 with the same name/signature. `WIDGET_EXAMPLES_SKILL` is defined in Task 2 and imported in `main.py` in Task 2. `handleWizardResponse`'s done result gains `transcript: []` in Task 4 and `send` consumes `result.transcript`; the pure-helper test is updated in the same task.
