import json
from pathlib import Path

from shared.schema import validate_manifest


ROOT = Path(__file__).resolve().parents[2]
FRIENDS_DIR = ROOT / "widgets" / "friends"


def load_manifest():
    with (FRIENDS_DIR / "manifest.json").open(encoding="utf-8") as handle:
        return json.load(handle)


def test_friends_manifest_matches_private_worked_example():
    manifest = load_manifest()
    validate_manifest(manifest)

    channels = {channel["id"]: channel for channel in manifest["server"]["channels"]}
    assert channels["fmfW"] == {
        "id": "fmfW",
        "origin": "client",
        "direction": "write",
        "visibility": "private",
        "mode": "series",
        "retain": 3600,
        "record": {"id": "clientId", "lat": "lat", "lon": "lng", "time": "ts"},
    }
    assert channels["fmfR"] == {
        "id": "fmfR",
        "origin": "client",
        "direction": "read",
        "visibility": "private",
        "source": "fmfW",
    }


def test_friends_bundle_is_classic_worker_safe_and_uses_contract_routes():
    bundle = (FRIENDS_DIR / "bundle.js").read_text(encoding="utf-8")

    assert "anymaps.ready()" in bundle
    assert "config.channelRoutes.fmfW" in bundle
    assert "config.channelRoutes.fmfR" in bundle
    assert "/instances/" in bundle
    assert "latest" in bundle
    assert "anymaps.startGeolocation" in bundle
    assert "anymaps.addMarker" in bundle
    assert "anymaps.updateMarker" in bundle
    assert "anymaps.removeMarker" in bundle
    assert "anymaps.flyTo({ center: [friend.lat, friend.lng], zoom: 14 })" in bundle
    assert "refreshInFlight" in bundle
    assert "anymaps.persist({ iid, displayName })" in bundle
    assert "function personKey(record)" in bundle
    assert "showUserDot: false" in bundle
    assert "anymaps.flyTo({ center: [lat, lng], zoom: 14 })" in bundle
    assert 'data-anymaps-action="leave-room"' in bundle
    assert 'showRoomPanel("Friend locations are temporarily unavailable.")' in bundle
    assert "if (!started || iid !== room) return;" in bundle
    assert 'anymaps.stopGeolocation()' in bundle
    assert 'anymaps.persist({ iid: null })' in bundle
    assert 'anymaps.off("geolocation", geolocationHandler)' in bundle
    assert "export " not in bundle
    assert "import " not in bundle
    for forbidden in ("window", "document", "navigator", "localStorage", "postMessage"):
        assert forbidden not in bundle
