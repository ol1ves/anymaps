import copy

from server.tests.conftest import FMF_MANIFEST, FLIGHTS_MANIFEST


def test_provision_returns_channel_routes(client):
    r = client.post("/widgets/find-my-friends/provision", json={"manifest": FMF_MANIFEST})
    assert r.status_code == 200
    routes = r.json()["channelRoutes"]
    assert routes["fmfW"].endswith("/widgets/find-my-friends/channels/fmfW")
    assert routes["fmfR"].endswith("/widgets/find-my-friends/channels/fmfR")


def test_provision_is_idempotent(client):
    r1 = client.post("/widgets/find-my-friends/provision", json={"manifest": FMF_MANIFEST})
    r2 = client.post("/widgets/find-my-friends/provision", json={"manifest": FMF_MANIFEST})
    assert r1.status_code == 200
    assert r1.json() == r2.json()


def test_provision_rejects_id_mismatch(client):
    r = client.post("/widgets/other-widget/provision", json={"manifest": FMF_MANIFEST})
    assert r.status_code == 400


def test_provision_rejects_duplicate_channel_ids(client):
    manifest = copy.deepcopy(FMF_MANIFEST)
    dup = copy.deepcopy(FMF_MANIFEST["server"]["channels"][0])
    manifest["server"]["channels"].append(dup)
    r = client.post("/widgets/find-my-friends/provision", json={"manifest": manifest})
    assert r.status_code == 400
    assert r.json() == {"error": "duplicate channel id"}


def test_provision_rejects_bad_source_reference(client):
    manifest = copy.deepcopy(FMF_MANIFEST)
    manifest["server"]["channels"][1]["source"] = "does-not-exist"
    r = client.post("/widgets/find-my-friends/provision", json={"manifest": manifest})
    assert r.status_code == 400
    assert r.json() == {"error": "source channel not found"}


def test_provision_rejects_source_not_a_write_channel(client):
    manifest = copy.deepcopy(FMF_MANIFEST)
    manifest["server"]["channels"][1]["source"] = "fmfR"  # points at the read channel itself
    r = client.post("/widgets/find-my-friends/provision", json={"manifest": manifest})
    assert r.status_code == 400
    assert r.json() == {"error": "source channel not found"}


def test_reprovision_changed_manifest_returns_stored_routes(client, caplog):
    import logging

    r1 = client.post("/widgets/find-my-friends/provision", json={"manifest": FMF_MANIFEST})
    changed = copy.deepcopy(FMF_MANIFEST)
    changed["server"]["channels"].append(
        {"id": "extraW", "origin": "client", "direction": "write", "visibility": "public"}
    )
    with caplog.at_level(logging.WARNING, logger="anymaps.server"):
        r2 = client.post("/widgets/find-my-friends/provision", json={"manifest": changed})
    assert r2.status_code == 200
    assert r2.json() == r1.json()
    assert "extraW" not in r2.json()["channelRoutes"]
    assert any("first-wins" in rec.message for rec in caplog.records)


def test_provision_starts_external_poller(client):
    async def noop(widget_id, channel):
        return None

    client.app.state.poller._fetch_once = noop
    r = client.post("/widgets/flights-nyc/provision", json={"manifest": FLIGHTS_MANIFEST})
    assert r.status_code == 200
    assert ("flights-nyc", "flights_nyc") in client.app.state.poller.tasks
