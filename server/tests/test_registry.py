import copy

from server.tests.conftest import FMF_MANIFEST


def _publish(client, manifest=FMF_MANIFEST, bundle="console.log('hi')"):
    return client.post("/widgets", json={"manifest": manifest, "bundle": bundle})


def test_publish_returns_id_and_version(client):
    r = _publish(client)
    assert r.status_code == 201
    assert r.json() == {"id": "find-my-friends", "version": "0.1.0"}


def test_publish_duplicate_conflicts(client):
    assert _publish(client).status_code == 201
    r = _publish(client)
    assert r.status_code == 409
    assert r.json() == {"error": "widget version already published"}


def test_publish_invalid_manifest_is_400(client):
    bad = copy.deepcopy(FMF_MANIFEST)
    bad["version"] = "1.0"  # not semver
    r = _publish(client, manifest=bad)
    assert r.status_code == 400
    assert "error" in r.json()


def test_gallery_lists_published(client):
    _publish(client)
    r = client.get("/widgets")
    assert r.status_code == 200
    assert r.json() == [
        {
            "id": "find-my-friends",
            "name": "Find My Friends",
            "version": "0.1.0",
            "description": "Share live locations with friends",
            "icon": None,
        }
    ]


def test_gallery_dedupes_to_latest_version(client):
    _publish(client, manifest=FMF_MANIFEST, bundle="v1")
    newer = copy.deepcopy(FMF_MANIFEST)
    newer["version"] = "0.2.0"
    newer["description"] = "Newer description"
    _publish(client, manifest=newer, bundle="v2")
    r = client.get("/widgets")
    assert r.status_code == 200
    assert len(r.json()) == 1
    assert r.json()[0]["version"] == "0.2.0"
    assert r.json()[0]["description"] == "Newer description"


def test_manifest_fetch(client):
    _publish(client)
    r = client.get("/widgets/find-my-friends/versions/0.1.0/manifest")
    assert r.status_code == 200
    assert r.json()["id"] == "find-my-friends"


def test_bundle_fetch_is_javascript(client):
    _publish(client)
    r = client.get("/widgets/find-my-friends/versions/0.1.0/bundle")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/javascript")
    assert r.text == "console.log('hi')"


def test_unknown_version_404(client):
    r = client.get("/widgets/find-my-friends/versions/9.9.9/manifest")
    assert r.status_code == 404
    assert r.json() == {"error": "widget version not found"}
