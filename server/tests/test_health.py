from server.app import main


def test_parse_origins_splits_and_strips():
    assert main._parse_origins("http://a, http://b ,") == ["http://a", "http://b"]


def test_allowed_origins_env_override(monkeypatch):
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://example.com, https://staging.example.com")
    assert main.allowed_origins() == ["https://example.com", "https://staging.example.com"]


def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
