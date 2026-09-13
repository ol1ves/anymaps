import json
from pathlib import Path

from shared.schema import validate_manifest


ROOT = Path(__file__).resolve().parents[2]
BATHROOMS_DIR = ROOT / "widgets" / "bathrooms"


def test_bathrooms_manifest_matches_overpass_worked_example():
    with (BATHROOMS_DIR / "manifest.json").open(encoding="utf-8") as handle:
        manifest = json.load(handle)
    validate_manifest(manifest)

    channel = manifest["server"]["channels"][0]
    external = channel["external"]
    assert manifest["id"] == "nyc-bathrooms"
    assert channel["origin"] == "external"
    assert channel["direction"] == "read"
    assert channel["visibility"] == "public"
    assert external["method"] == "POST"
    assert external["url"] == "https://overpass-api.de/api/interpreter"
    assert external["interval"] == 86400
    assert external["mode"] == "snapshot"
    assert external["record"] == {
        "records": "elements",
        "id": "id",
        "lat": "lat",
        "lon": "lon",
    }
    assert "amenity" in external["body"]
    assert "toilets" in external["body"]


def test_bathrooms_bundle_uses_public_route_and_bounds_filter():
    bundle = (BATHROOMS_DIR / "bundle.js").read_text(encoding="utf-8")

    for required in (
        "anymaps.ready()",
        "config.channelRoutes.bathrooms",
        'searchParams.set("bounds"',
        'anymaps.on("viewportChanged"',
        "anymaps.addMarker",
        "anymaps.updateMarker",
        "anymaps.removeMarker",
    ):
        assert required in bundle

    assert "export " not in bundle
    assert "import " not in bundle
    for forbidden in ("window", "document", "navigator", "localStorage", "postMessage"):
        assert forbidden not in bundle
