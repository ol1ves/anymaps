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
