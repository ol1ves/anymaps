from server.tests.conftest import FMF_MANIFEST


def _provision(client):
    assert client.post("/widgets/find-my-friends/provision", json={"manifest": FMF_MANIFEST}).status_code == 200


def test_create_instance_returns_32_hex_token(client):
    _provision(client)
    r = client.post("/widgets/find-my-friends/instances")
    assert r.status_code == 201
    token = r.json()["instanceToken"]
    assert len(token) == 32
    assert all(c in "0123456789abcdef" for c in token)


def test_create_instance_for_unknown_widget_404(client):
    r = client.post("/widgets/nonexistent/instances")
    assert r.status_code == 404
    assert r.json() == {"error": "widget not found"}


def test_unhandled_error_returns_contract_body(tmp_path, monkeypatch):
    import server.app.instances as instances
    from fastapi.testclient import TestClient

    from server.app.db import connect
    from server.app.main import create_app

    monkeypatch.setattr(instances.secrets, "token_hex", lambda n: (_ for _ in ()).throw(RuntimeError("boom")))
    app = create_app(str(tmp_path / "test.db"))
    # Seed a provisioned channel so create_instance passes the 404 check and
    # reaches token generation, which raises.
    db = connect(app.state.db_path)
    db.execute(
        "INSERT INTO channels (widget_id, channel_id, config, provisioned_at) VALUES (?, ?, ?, ?)",
        ("find-my-friends", "c", '{"id":"c","origin":"client","direction":"write","visibility":"public"}', 1.0),
    )
    db.commit()
    db.close()
    with TestClient(app, raise_server_exceptions=False) as client:
        r = client.post("/widgets/find-my-friends/instances")
    assert r.status_code == 500
    assert r.json() == {"error": "internal server error"}
