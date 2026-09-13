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
