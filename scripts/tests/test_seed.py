import json
from pathlib import Path

import httpx
import pytest

from scripts.seed import DiscoveryError, Widget, discover_widgets, publish_one, seed

MANIFEST_A = {
    "id": "a",
    "name": "A",
    "version": "1.0.0",
    "description": "d",
    "server": {"channels": []},
}
MANIFEST_B = {
    "id": "b",
    "name": "B",
    "version": "2.0.0",
    "description": "d",
    "server": {"channels": []},
}


def _write(tmp_path, name, manifest=None, bundle="console.log(1)"):
    folder = tmp_path / name
    folder.mkdir()
    if manifest is not None:
        (folder / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    if bundle is not None:
        (folder / "bundle.js").write_text(bundle, encoding="utf-8")
    return folder


def _client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_discover_widgets_finds_all_folders_with_both_files(tmp_path):
    _write(tmp_path, "one", MANIFEST_A)
    _write(tmp_path, "two", MANIFEST_B)

    widgets = discover_widgets(tmp_path)

    assert [w.id for w in widgets] == ["a", "b"]


def test_discover_widgets_ignores_folders_missing_a_file(tmp_path):
    _write(tmp_path, "with-manifest-only", MANIFEST_A, bundle=None)
    _write(tmp_path, "with-bundle-only", None, bundle="console.log(1)")
    _write(tmp_path, "empty")

    assert discover_widgets(tmp_path) == []


def test_discover_widgets_missing_dir_raises(tmp_path):
    with pytest.raises(DiscoveryError):
        discover_widgets(tmp_path / "nope")


def test_discover_widgets_invalid_json_raises(tmp_path):
    folder = _write(tmp_path, "bad", None)
    (folder / "manifest.json").write_text("{not json", encoding="utf-8")

    with pytest.raises(DiscoveryError):
        discover_widgets(tmp_path)


def test_discover_widgets_manifest_missing_id_raises(tmp_path):
    _write(tmp_path, "bad", {"name": "no id"})

    with pytest.raises(DiscoveryError):
        discover_widgets(tmp_path)


def test_publish_one_posts_manifest_and_bundle():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(201, json={"id": "a", "version": "1.0.0"})

    widget = Widget(folder=Path("x"), manifest=MANIFEST_A, bundle="console.log(1)")
    result = publish_one(_client(handler), "http://localhost:8000", widget)

    assert result.status == "published"
    assert seen["url"] == "http://localhost:8000/widgets"
    assert seen["body"]["manifest"]["id"] == "a"
    assert seen["body"]["bundle"] == "console.log(1)"


def test_publish_one_reports_already_published_on_409():
    def handler(request):
        return httpx.Response(409, json={"error": "widget version already published"})

    widget = Widget(folder=Path("x"), manifest=MANIFEST_A, bundle="")
    result = publish_one(_client(handler), "http://localhost:8000", widget)

    assert result.status == "already-published"


def test_publish_one_reports_failure_on_error():
    def handler(request):
        return httpx.Response(500, json={"error": "internal server error"})

    widget = Widget(folder=Path("x"), manifest=MANIFEST_A, bundle="")
    result = publish_one(_client(handler), "http://localhost:8000", widget)

    assert result.status == "failed"
    assert "500" in result.detail


def test_seed_publishes_every_discovered_widget(tmp_path):
    _write(tmp_path, "one", MANIFEST_A)
    _write(tmp_path, "two", MANIFEST_B)
    _write(tmp_path, "not-a-widget")
    posted = []

    def handler(request):
        posted.append(json.loads(request.content)["manifest"]["id"])
        return httpx.Response(201, json={"id": "x", "version": "1.0.0"})

    results = seed(
        "http://localhost:8000",
        tmp_path,
        transport=httpx.MockTransport(handler),
    )

    assert [r.widget_id for r in results] == ["a", "b"]
    assert all(r.status == "published" for r in results)
    assert posted == ["a", "b"]


def test_seed_only_filters_by_id(tmp_path):
    _write(tmp_path, "one", MANIFEST_A)
    _write(tmp_path, "two", MANIFEST_B)

    results = seed("http://localhost:8000", tmp_path, only="b", dry_run=True)

    assert [r.widget_id for r in results] == ["b"]
    assert results[0].status == "dry-run"


def test_seed_only_unknown_id_raises(tmp_path):
    _write(tmp_path, "one", MANIFEST_A)

    with pytest.raises(DiscoveryError):
        seed("http://localhost:8000", tmp_path, only="nope")
