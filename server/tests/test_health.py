from server.app import main


def test_parse_origins_splits_and_strips():
    assert main._parse_origins("http://a, http://b ,") == ["http://a", "http://b"]


def test_allowed_origins_env_override(monkeypatch):
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://example.com, https://staging.example.com")
    assert main.allowed_origins() == ["https://example.com", "https://staging.example.com"]


def test_allowed_origins_default_is_wildcard(monkeypatch):
    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    assert main.allowed_origins() == ["*"]


def test_allowed_origins_wildcard_anywhere_wins(monkeypatch):
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://a.com, *")
    assert main.allowed_origins() == ["*"]


def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
