"""Load wizard skills for injection into the DeepSeek system prompt.

Skills are markdown files with YAML frontmatter, mirroring the pi skill format.
Only the instruction body after the frontmatter is injected.
"""

from __future__ import annotations

from pathlib import Path

SKILLS_DIR = Path(__file__).resolve().parent / "skills"

WIZARD_FLOW_SKILL = "wizard-flow"
WIDGET_EXAMPLES_SKILL = "widget-examples"


def load_skill_body(name: str) -> str:
    """Return a skill's instruction body with frontmatter stripped."""

    path = SKILLS_DIR / name / "SKILL.md"
    text = path.read_text(encoding="utf-8")
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            text = parts[2]
    return text.strip()
