def test_create_instance_returns_32_hex_token(client):
    r = client.post("/widgets/find-my-friends/instances")
    assert r.status_code == 201
    token = r.json()["instanceToken"]
    assert len(token) == 32
    assert all(c in "0123456789abcdef" for c in token)
