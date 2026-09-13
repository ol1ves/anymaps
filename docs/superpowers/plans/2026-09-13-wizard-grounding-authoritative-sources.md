# Wizard Grounding in Authoritative Sources — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the wizard's hand-typed `GENERATION_CONTRACT` with the authoritative anymaps sources — the SDK source, `CONTRACTS.md`, and `SPEC.md` — loaded from disk at runtime, so generated widgets can never drift from the real SDK surface.

**Architecture:** A new `agent/app/prompt.py` loads the SDK source verbatim plus `CONTRACTS.md` §2–§13 and `SPEC.md` §7–§12/§14 by exact `##` heading, and assembles the system prompt. `agent/app/main.py` drops `GENERATION_CONTRACT` and calls the builder. `agent/Dockerfile` copies the three source files into the container. The key-entry flow is untouched.

**Tech Stack:** Python 3.14, FastAPI, Pydantic v2, pytest. No new dependencies. Tests run via `.venv/bin/python -m pytest agent/tests -q` from the repo root.

**Spec:** `docs/superpowers/specs/2026-09-13-wizard-grounding-authoritative-sources-design.md`. The plan argues from that spec; read both.

## Global Constraints

- Do **not** modify `SPEC.md`, `CONTRACTS.md`, `contracts/manifest.schema.json`, `client/src/sdk/anymaps.js`, or any server/client data-plane code. The three sources are read-only.
- Do **not** change the wizard wire contract (`CONTRACTS.md` §15) or the manifest schema.
- No new pip/npm dependencies.
- Key flow is unchanged: the raw key travels only client input → `/wizard/secrets` → `POST /secrets`; only `secretId` reaches the manifest. Never in `messages`, the LLM body, the manifest, the bundle, a response, or a log.
- Loader fails loudly on a missing section heading (D5) — a doc rename/restructure breaks tests, never silently drops content.
- Baseline: agent tests `84 passed, 1 skipped`. Keep green. Client is untouched but `cd client && npm test` must stay green.
- **Pre-existing uncommitted changes** in the working tree (secret-flow fixes in `agent/app/main.py`, `client/src/ui/wizard.js`, `client/src/styles.css`, `agent/tests/test_wizard.py`, `agent/app/skills/widget-examples/SKILL.md`) are green and must be preserved — in particular `_secret_bindings_note` and its use in `generate_wizard`, which this plan keeps. Commit them as a baseline before Task 1 so task commits stay clean.

---

## File Structure

- **Create `agent/app/prompt.py`** — owns the authoritative-source paths, the section lists, `split_sections`, `load_md_sections`, and `build_system_prompt`. The single place that knows which doc sections the wizard is grounded on.
- **Modify `agent/app/main.py`** — delete `GENERATION_CONTRACT` and the `load_manifest_schema` import; call `build_system_prompt` from `_build_deepseek_body`.
- **Modify `agent/app/skills/wizard-flow/SKILL.md`** — fix the dangling "generation contract" reference to point at the injected sources.
- **Modify `agent/Dockerfile`** — copy the SDK source, `CONTRACTS.md`, and `SPEC.md` into the agent image.
- **Tests** — create `agent/tests/test_prompt.py`; extend `agent/tests/test_wizard.py` and `agent/tests/test_skills.py`.

---

### Task 1: `agent/app/prompt.py` — authoritative-source loader + builder

**Files:**
- Create: `agent/app/prompt.py`
- Test: `agent/tests/test_prompt.py`

**Interfaces:**
- Consumes: `shared.schema.load_manifest_schema()` (existing, returns `dict`).
- Produces:
  - `prompt.SDK_SOURCE_PATH: Path`, `prompt.CONTRACTS_PATH: Path`, `prompt.SPEC_PATH: Path` (module constants).
  - `prompt.CONTRACTS_SECTIONS: list[str]`, `prompt.SPEC_SECTIONS: list[str]`.
  - `prompt.split_sections(markdown: str) -> dict[str, str]`.
  - `prompt.load_md_sections(path: Path, headings: list[str]) -> str` — raises `FileNotFoundError` / `KeyError` on missing file/heading.
  - `prompt.build_system_prompt(system_prompt: str, flow_skill: str, examples_skill: str) -> str` — the assembled prompt.

- [ ] **Step 1: Write the failing tests**

Create `agent/tests/test_prompt.py`:

```python
import pytest

from agent.app import prompt


def test_split_sections_keeps_subsections_under_parent():
    markdown = "## 1. Alpha\ntop\n### 1.1 Sub\nchild\n## 2. Beta\nbody\n"
    sections = prompt.split_sections(markdown)
    assert sections["1. Alpha"] == "top\n### 1.1 Sub\nchild"
    assert sections["2. Beta"] == "body"


def test_load_md_sections_returns_requested_headings_in_order(tmp_path):
    path = tmp_path / "doc.md"
    path.write_text("## 1. Alpha\nalpha\n## 2. Beta\nbeta\n", encoding="utf-8")
    result = prompt.load_md_sections(path, ["2. Beta", "1. Alpha"])
    assert result == "## 2. Beta\nbeta\n\n## 1. Alpha\nalpha"


def test_load_md_sections_raises_on_missing_heading(tmp_path):
    path = tmp_path / "doc.md"
    path.write_text("## 1. Alpha\nalpha\n", encoding="utf-8")
    with pytest.raises(KeyError, match="missing section heading"):
        prompt.load_md_sections(path, ["2. Missing"])


def test_authoritative_source_files_exist():
    assert prompt.SDK_SOURCE_PATH.is_file()
    assert prompt.CONTRACTS_PATH.is_file()
    assert prompt.SPEC_PATH.is_file()


def test_build_system_prompt_contains_authoritative_sources():
    system = prompt.build_system_prompt("SYSTEM", "FLOW", "EXAMPLES")
    assert "SYSTEM" in system
    assert "FLOW" in system
    assert "EXAMPLES" in system
    assert "globalThis.anymaps" in system      # SDK source
    assert "requestCameraControl" in system    # SDK source
    assert "fitBounds" in system               # CONTRACTS §4
    assert "instanceToken" in system           # CONTRACTS §8
    assert "api.adsb.lol" in system            # SPEC §10
    assert "secretId" in system                # SPEC §12.2 / CONTRACTS §8
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest agent/tests/test_prompt.py -q`
Expected: collection ERROR — `ModuleNotFoundError: No module named 'agent.app.prompt'`.

- [ ] **Step 3: Implement the module**

Create `agent/app/prompt.py`:

```python
"""Assemble the wizard system prompt from the authoritative anymaps sources.

The prompt is built from real files — the SDK source, CONTRACTS.md, SPEC.md,
and the manifest schema — so the wizard's knowledge of the SDK surface and the
manifest model can never drift from the code and docs the rest of the system
is built against.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

from shared.schema import load_manifest_schema

REPO_ROOT = Path(__file__).resolve().parents[2]

SDK_SOURCE_PATH = REPO_ROOT / "client" / "src" / "sdk" / "anymaps.js"
CONTRACTS_PATH = REPO_ROOT / "CONTRACTS.md"
SPEC_PATH = REPO_ROOT / "SPEC.md"

# Exact `##` headings to inject, in order. A missing heading raises at load
# time (D5), so a doc rename/restructure fails loudly instead of silently
# dropping content.
CONTRACTS_SECTIONS = [
    "2. Message envelope",
    "3. Init message",
    "4. Commands (widget → map)",
    "5. Events (map → widget)",
    "6. The `anymaps` library",
    "7. Manifest JSON schema",
    "8. HTTP API",
    "9. Filter parameters",
    "10. Persistence (localStorage, main thread)",
    "11. Camera lease rules",
    "12. UI arbitration",
    "13. Units and coordinate order",
]

SPEC_SECTIONS = [
    "7. The SDK (client side)",
    "8. The manifest and channel model",
    "9. Data flow, provisioning, and privacy",
    "10. External fetching",
    "11. Filtering and caching",
    "12. Transport and routes",
    "14. Out of scope for the MVP",
]


def split_sections(markdown: str) -> dict[str, str]:
    """Split a markdown doc into ``{heading: body}`` keyed by ``## `` headings.

    ``###`` subsections stay inside their parent's body.
    """

    sections: dict[str, str] = {}
    heading: str | None = None
    body: list[str] = []
    for line in markdown.splitlines():
        if line.startswith("## "):
            if heading is not None:
                sections[heading] = "\n".join(body).strip()
            heading = line[3:].strip()
            body = []
        elif heading is not None:
            body.append(line)
    if heading is not None:
        sections[heading] = "\n".join(body).strip()
    return sections


def load_md_sections(path: Path, headings: list[str]) -> str:
    """Return the requested ``##`` sections of a markdown file, in order.

    Raises FileNotFoundError when the file is missing, and KeyError (with a
    clear message naming the file and headings) when a requested heading is
    absent.
    """

    markdown = path.read_text(encoding="utf-8")
    sections = split_sections(markdown)
    missing = [heading for heading in headings if heading not in sections]
    if missing:
        raise KeyError(
            f"{path.name}: missing section heading(s): {', '.join(missing)}"
        )
    return "\n\n".join(
        f"## {heading}\n{sections[heading]}" for heading in headings
    )


@lru_cache(maxsize=1)
def build_system_prompt(
    system_prompt: str,
    flow_skill: str,
    examples_skill: str,
) -> str:
    """Assemble the full wizard system prompt from authoritative sources."""

    sdk = SDK_SOURCE_PATH.read_text(encoding="utf-8").strip()
    contracts = load_md_sections(CONTRACTS_PATH, CONTRACTS_SECTIONS)
    spec = load_md_sections(SPEC_PATH, SPEC_SECTIONS)
    schema = json.dumps(load_manifest_schema())

    return "\n\n".join(
        [
            system_prompt,
            flow_skill,
            examples_skill,
            "## anymaps SDK (authoritative source)\n```js\n" + sdk + "\n```",
            contracts,
            spec,
            "Manifest JSON Schema:\n" + schema,
        ]
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest agent/tests/test_prompt.py -q`
Expected: 5 passed.

- [ ] **Step 5: Run the full agent suite**

Run: `.venv/bin/python -m pytest agent/tests -q`
Expected: `89 passed, 1 skipped` (the 5 new tests added to the 84 baseline).

- [ ] **Step 6: Commit**

```bash
git add agent/app/prompt.py agent/tests/test_prompt.py
git commit -m "feat(agent): build wizard prompt from authoritative sources"
```

---

### Task 2: Wire `main.py` to the builder; delete `GENERATION_CONTRACT`

**Files:**
- Modify: `agent/app/main.py` (import block `:16`, the `GENERATION_CONTRACT` block `:76-111`, and `_build_deepseek_body` `:405-424`)
- Test: `agent/tests/test_wizard.py`

**Interfaces:**
- Consumes: `prompt.build_system_prompt(system_prompt, flow_skill, examples_skill) -> str` (Task 1).
- Produces: `_build_deepseek_body(list[Message]) -> dict` — unchanged signature; its `body["messages"][0]["content"]` is now the authoritative prompt.
- Preserve: `_secret_bindings_note` and its use in `generate_wizard` are untouched.

- [ ] **Step 1: Write the failing test**

Append to `agent/tests/test_wizard.py`:

```python
def test_deepseek_body_uses_authoritative_prompt_and_omits_old_contract():
    body = main._build_deepseek_body([])
    system = body["messages"][0]["content"]
    assert "globalThis.anymaps" in system
    assert "api.adsb.lol" in system
    assert "SDK methods: addMarker" not in system
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest agent/tests/test_wizard.py::test_deepseek_body_uses_authoritative_prompt_and_omits_old_contract -q`
Expected: FAIL — the current prompt contains `SDK methods: addMarker` (from `GENERATION_CONTRACT`) and lacks `globalThis.anymaps`.

- [ ] **Step 3: Implement**

In `agent/app/main.py`, make three edits.

(a) Replace the `shared.schema` import with the prompt import:

```python
from shared.schema import load_manifest_schema
```

becomes

```python
from .prompt import build_system_prompt
```

(Remove the `from shared.schema import load_manifest_schema` line entirely; add `from .prompt import build_system_prompt` next to the other `from .` imports.)

(b) Delete the entire `GENERATION_CONTRACT` block (the `GENERATION_CONTRACT = """` literal through its closing `"""` immediately before `class Message(BaseModel):`).

(c) Replace the body of `_build_deepseek_body`:

```python
def _build_deepseek_body(messages: list[Message]) -> dict[str, Any]:
    """Assemble the system prompt and transcript for one DeepSeek request."""

    system = build_system_prompt(
        SYSTEM_PROMPT,
        load_skill_body(WIZARD_FLOW_SKILL),
        load_skill_body(WIDGET_EXAMPLES_SKILL),
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest agent/tests/test_wizard.py::test_deepseek_body_uses_authoritative_prompt_and_omits_old_contract agent/tests/test_wizard.py::test_model_receives_widget_examples agent/tests/test_wizard.py::test_model_receives_wizard_flow_skill -q`
Expected: all PASS (`test_model_receives_widget_examples` still finds `anymaps.ready()` and `water-fountains-nyc` via the SDK source and examples skill).

- [ ] **Step 5: Run the full agent suite**

Run: `.venv/bin/python -m pytest agent/tests -q`
Expected: `90 passed, 1 skipped`.

- [ ] **Step 6: Commit**

```bash
git add agent/app/main.py agent/tests/test_wizard.py
git commit -m "fix(agent): ground wizard prompt in authoritative SDK and docs"
```

---

### Task 3: Fix the dangling skill reference

**Files:**
- Modify: `agent/app/skills/wizard-flow/SKILL.md` (`## Output` section, lines 124-125)
- Test: `agent/tests/test_skills.py`

**Interfaces:**
- Consumes: none.
- Produces: the `wizard-flow` skill body no longer references "the generation contract" and instead names the injected sources.

- [ ] **Step 1: Write the failing test**

Append to `agent/tests/test_skills.py`:

```python
def test_wizard_flow_skill_references_authoritative_sources_not_generation_contract():
    body = skills.load_skill_body(skills.WIZARD_FLOW_SKILL)
    assert "generation contract" not in body
    assert "CONTRACTS.md" in body
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest agent/tests/test_skills.py::test_wizard_flow_skill_references_authoritative_sources_not_generation_contract -q`
Expected: FAIL — the skill contains "generation contract" and no "CONTRACTS.md".

- [ ] **Step 3: Implement**

In `agent/app/skills/wizard-flow/SKILL.md`, change:

```markdown
- done:true must satisfy the manifest schema and the classic-script bundle rules
  from the generation contract.
```

to:

```markdown
- done:true must satisfy the manifest schema and the classic-script bundle rules
  from the authoritative sources (the SDK source, CONTRACTS.md, SPEC.md).
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest agent/tests/test_skills.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/app/skills/wizard-flow/SKILL.md agent/tests/test_skills.py
git commit -m "docs(agent): point wizard-flow skill at authoritative sources"
```

---

### Task 4: Copy the sources into the agent image

**Files:**
- Modify: `agent/Dockerfile`

**Interfaces:**
- Consumes: the three authoritative files at their repo-root paths (verified by `test_authoritative_source_files_exist` in Task 1).
- Produces: the agent image now contains `/app/client/src/sdk/anymaps.js`, `/app/CONTRACTS.md`, `/app/SPEC.md`, matching `prompt.REPO_ROOT` resolution.

- [ ] **Step 1: Implement**

In `agent/Dockerfile`, after the existing `COPY contracts ./contracts` line, add:

```dockerfile
COPY client/src/sdk ./client/src/sdk
COPY CONTRACTS.md ./CONTRACTS.md
COPY SPEC.md ./SPEC.md
```

- [ ] **Step 2: Verify the image builds**

Run: `docker compose build agent`
Expected: build succeeds. (If Docker is unavailable in the environment, verify with `git diff agent/Dockerfile` that the three COPY lines are present and note the build as a CI step.)

- [ ] **Step 3: Run the full agent suite (unchanged, sanity)**

Run: `.venv/bin/python -m pytest agent/tests -q`
Expected: `90 passed, 1 skipped`.

- [ ] **Step 4: Commit**

```bash
git add agent/Dockerfile
git commit -m "build(agent): copy SDK source and contracts into the agent image"
```

---

## Self-Review

**Spec coverage:** Spec §4.1 (SDK verbatim) → Task 1 `build_system_prompt`; §4.2/§4.3 (CONTRACTS/SPEC sections by heading) → Task 1 `CONTRACTS_SECTIONS`/`SPEC_SECTIONS` + `load_md_sections`; §4.4 (schema) → Task 1; §4.5 (order) → Task 1; §5 (loader/builder) → Task 1; D4 (delete `GENERATION_CONTRACT`) → Task 2; D5 (fail loudly) → Task 1 `load_md_sections` + test; D6 (key flow unchanged) → no code touches it, and Global Constraints state it; D7 (Dockerfile COPY) → Task 4; D8 (skill reference) → Task 3.

**Placeholder scan:** none — every step carries full code or an exact command.

**Type consistency:** `build_system_prompt(system_prompt, flow_skill, examples_skill) -> str` is defined in Task 1 and consumed in Task 2 with the same name/signature. `SDK_SOURCE_PATH`/`CONTRACTS_PATH`/`SPEC_PATH` are defined in Task 1 and asserted in Task 1's own test and consumed by Task 4's COPY lines. Section headings are copied verbatim from the two docs.
