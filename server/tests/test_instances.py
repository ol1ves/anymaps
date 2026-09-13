def test_create_instance_returns_32_hex_token(client):
    r = client.post("/widgets/find-my-friends/instances")
    assert r.status_code == 201
    token = r.json()["instanceToken"]
    assert len(token) == 32
    assert all(c in "0123456789abcdef" for c in token)


def test_unhandled_error_returns_contract_body(tmp_path, monkeypatch):
    import server.app.instances as instances
    from fastapi.testclient import TestClient
    from server.app.main import create_app

    monkeypatch.setattr(instances.secrets, "token_hex", lambda n: (_ for _ in ()).throw(RuntimeError("boom")))
    app = create_app(str(tmp_path / "test.db"))
    with TestClient(app, raise_server_exceptions=False) as client:
        r = client.post("/widgets/find-my-friends/instances")
    assert r.status_code == 500
    assert r.json() == {"error": "internal server error"}
