from server.tests.conftest import FMF_MANIFEST, insert_channel


def _provision_fmf(db):
    insert_channel(db, "find-my-friends", FMF_MANIFEST["server"]["channels"][0])
    insert_channel(db, "find-my-friends", FMF_MANIFEST["server"]["channels"][1])


def _token(client):
    return client.post("/widgets/find-my-friends/instances").json()["instanceToken"]


def test_private_write_read_roundtrip(client, db):
    _provision_fmf(db)
    token = _token(client)

    w = client.post(
        f"/widgets/find-my-friends/channels/fmfW/instances/{token}",
        json={"clientId": "alice", "lat": 40.71, "lng": -74.0, "ts": 1700000000, "name": "Alice"},
    )
    assert w.status_code == 201

    r = client.get(
        f"/widgets/find-my-friends/channels/fmfR/instances/{token}",
        params={"latest": "1"},
    )
    assert r.status_code == 200
    recs = r.json()["records"]
    assert len(recs) == 1
    assert recs[0]["name"] == "Alice"
    assert recs[0]["lat"] == 40.71


def test_unknown_token_404(client, db):
    _provision_fmf(db)
    r = client.get("/widgets/find-my-friends/channels/fmfR/instances/ff" * 16)
    assert r.status_code == 404


def test_private_channel_requires_token(client, db):
    _provision_fmf(db)
    assert client.get("/widgets/find-my-friends/channels/fmfR").status_code == 404


def test_write_to_read_channel_404(client, db):
    _provision_fmf(db)
    r = client.post("/widgets/find-my-friends/channels/fmfR", json={})
    assert r.status_code == 404


def test_unknown_channel_404(client):
    r = client.get("/widgets/find-my-friends/channels/nope")
    assert r.status_code == 404


def test_read_inherits_source_mapping(client, db):
    insert_channel(db, "find-my-friends", FMF_MANIFEST["server"]["channels"][0])
    insert_channel(db, "find-my-friends", FMF_MANIFEST["server"]["channels"][1])
    token = _token(client)
    # fmfR inherits fmfW's mapping (id=clientId, lat=lat, lon=lng, time=ts), so ids is valid.
    r = client.get(
        f"/widgets/find-my-friends/channels/fmfR/instances/{token}",
        params={"ids": "alice"},
    )
    assert r.status_code == 200
