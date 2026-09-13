def test_create_secret_returns_id_but_never_value(client):
    r = client.post("/secrets", json={"value": "super-secret-value"})
    assert r.status_code == 201
    secret_id = r.json()["secretId"]
    assert len(secret_id) == 32
    assert "super-secret-value" not in r.text
