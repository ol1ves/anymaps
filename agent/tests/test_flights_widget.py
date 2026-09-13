import json
from pathlib import Path

from shared.schema import validate_manifest


ROOT = Path(__file__).resolve().parents[2]
FLIGHTS_DIR = ROOT / "widgets" / "flights"


def load_manifest():
    with (FLIGHTS_DIR / "manifest.json").open(encoding="utf-8") as handle:
        return json.load(handle)


def test_flights_manifest_matches_adsb_worked_example():
    manifest = load_manifest()
    validate_manifest(manifest)

    assert manifest["id"] == "flights-nyc"
    channel = manifest["server"]["channels"][0]
    assert channel == {
        "id": "flights_nyc",
        "origin": "external",
        "direction": "read",
        "visibility": "public",
        "external": {
            "method": "GET",
            "url": "https://api.adsb.lol/v2/point/40.71/-74.0/250",
            "headers": {"User-Agent": "anymaps/0.1 (development)"},
            "interval": 5,
            "mode": "series",
            "retain": 3600,
            "record": {
                "records": "ac",
                "id": "hex",
                "lat": "lat",
                "lon": "lon",
                "time": "@ingestedAt",
            },
        },
    }


def test_flights_bundle_uses_contract_filters_and_sdk_only():
    bundle = (FLIGHTS_DIR / "bundle.js").read_text(encoding="utf-8")

    for required in (
        "anymaps.ready()",
        "config.channelRoutes.flights_nyc",
        'searchParams.set("bounds"',
        'searchParams.set("latest", "1")',
        'searchParams.set("ids", hex)',
        "anymaps.addMarker",
        "anymaps.updateMarker",
        "anymaps.removeMarker",
        "anymaps.addPolyline",
        "anymaps.removePolyline",
        'anymaps.on("viewportChanged"',
        'anymaps.on("markerClick"',
    ):
        assert required in bundle

    assert "export " not in bundle
    assert "import " not in bundle
    for forbidden in ("window", "document", "navigator", "localStorage", "postMessage"):
        assert forbidden not in bundle
