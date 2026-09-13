import asyncio

import httpx
import pytest

from agent.app import source_test


def run(coro):
    return asyncio.run(coro)


def allow_all_urls(monkeypatch):
    monkeypatch.setattr(source_test, "assert_source_url_allowed", lambda url: None)


def test_rejects_http_url(monkeypatch):
    monkeypatch.setattr(
        source_test,
        "assert_source_url_allowed",
        lambda url: (_ for _ in ()).throw(ValueError("only https URLs are allowed")),
    )
    with pytest.raises(source_test.SourceBlockedError, match="source blocked"):
        run(source_test.test_source(source_test.SourceSpec(url="http://example.com")))


def test_rejects_private_or_loopback_url(monkeypatch):
    monkeypatch.setattr(
        source_test,
        "assert_source_url_allowed",
        lambda url: (_ for _ in ()).throw(ValueError("private IP")),
    )
    with pytest.raises(source_test.SourceBlockedError, match="source blocked"):
        run(source_test.test_source(source_test.SourceSpec(url="https://localhost")))


def test_rejects_get_body(monkeypatch):
    allow_all_urls(monkeypatch)
    with pytest.raises(source_test.SourceTestError, match="body"):
        run(
            source_test.test_source(
                source_test.SourceSpec(url="https://example.com", body="body")
            )
        )


def test_secret_is_injected_for_verification_only():
    source = source_test.SourceSpec(url="https://example.com", query={"q": "nyc"})
    auth = source_test.SecretAuthSpec(type="query", name="key")
    verified = source_test.source_with_secret(source, auth, "secret-value")
    assert source.query == {"q": "nyc"}
    assert verified.query == {"q": "nyc", "key": "secret-value"}


def test_secret_header_scheme_is_injected():
    source = source_test.SourceSpec(url="https://example.com")
    auth = source_test.SecretAuthSpec(
        type="header", name="Authorization", scheme="Bearer "
    )
    verified = source_test.source_with_secret(source, auth, "secret-value")
    assert verified.headers == {"Authorization": "Bearer secret-value"}


def test_request_includes_default_user_agent(monkeypatch):
    from shared.http import DEFAULT_USER_AGENT

    allow_all_urls(monkeypatch)
    seen = {}

    def handler(request):
        seen["ua"] = request.headers.get("User-Agent")
        return httpx.Response(200, json={})

    run(
        source_test.test_source(
            source_test.SourceSpec(url="https://example.com"),
            transport=httpx.MockTransport(handler),
        )
    )
    assert seen["ua"] == DEFAULT_USER_AGENT


def test_successful_json_object_is_summarized(monkeypatch):
    allow_all_urls(monkeypatch)

    def handler(request):
        assert request.method == "GET"
        assert request.url.params["q"] == "nyc"
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={"ac": [{"hex": "abc", "lat": 40.7, "lon": -74.0}]},
        )

    result = run(
        source_test.test_source(
            source_test.SourceSpec(url="https://example.com", query={"q": "nyc"}),
            transport=httpx.MockTransport(handler),
        )
    )
    assert result["ok"] is True
    assert result["top_level_type"] == "object"
    assert result["top_level_keys"] == ["ac"]
    assert result["arrays"] == [
        {"path": "$.ac", "length": 1, "sample_keys": ["hex", "lat", "lon"]}
    ]


def test_successful_post_with_raw_body(monkeypatch):
    allow_all_urls(monkeypatch)

    def handler(request):
        assert request.method == "POST"
        assert request.content == b"[out:json];out;"
        return httpx.Response(200, json={"elements": []})

    result = run(
        source_test.test_source(
            source_test.SourceSpec(
                method="POST", url="https://example.com", body="[out:json];out;"
            ),
            transport=httpx.MockTransport(handler),
        )
    )
    assert result["arrays"][0]["path"] == "$.elements"


def test_rejects_unsafe_redirect(monkeypatch):
    calls = []

    def check(url):
        calls.append(url)
        if "private" in url:
            raise ValueError("private IP")

    monkeypatch.setattr(source_test, "assert_source_url_allowed", check)

    def handler(request):
        return httpx.Response(302, headers={"location": "https://private.example"})

    with pytest.raises(source_test.SourceBlockedError, match="source blocked"):
        run(
            source_test.test_source(
                source_test.SourceSpec(url="https://public.example"),
                transport=httpx.MockTransport(handler),
            )
        )
    assert calls == ["https://public.example", "https://private.example"]


def test_rejects_more_than_three_redirects(monkeypatch):
    allow_all_urls(monkeypatch)

    def handler(request):
        return httpx.Response(
            302,
            headers={"location": f"https://example.com/{request.url.path.count('/') + 1}"},
        )

    with pytest.raises(source_test.SourceTestError, match="redirects"):
        run(
            source_test.test_source(
                source_test.SourceSpec(url="https://example.com/0"),
                transport=httpx.MockTransport(handler),
            )
        )


def test_rejects_non_2xx_response(monkeypatch):
    allow_all_urls(monkeypatch)
    transport = httpx.MockTransport(lambda request: httpx.Response(503))
    with pytest.raises(source_test.SourceTestError, match="HTTP 503"):
        run(
            source_test.test_source(
                source_test.SourceSpec(url="https://example.com"),
                transport=transport,
            )
        )


def test_source_retries_transient_5xx_then_succeeds(monkeypatch):
    allow_all_urls(monkeypatch)
    monkeypatch.setattr(source_test, "SOURCE_RETRY_BACKOFF_SECONDS", 0)
    calls = []

    def handler(request):
        calls.append(1)
        if len(calls) == 1:
            return httpx.Response(504)
        return httpx.Response(200, json={"elements": []})

    result = run(
        source_test.test_source(
            source_test.SourceSpec(url="https://example.com"),
            transport=httpx.MockTransport(handler),
        )
    )
    assert result["ok"] is True
    assert len(calls) == 2


def test_source_retries_transient_transport_error_then_succeeds(monkeypatch):
    allow_all_urls(monkeypatch)
    monkeypatch.setattr(source_test, "SOURCE_RETRY_BACKOFF_SECONDS", 0)
    calls = []

    def handler(request):
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ReadError("connection reset")
        return httpx.Response(200, json={"elements": []})

    result = run(
        source_test.test_source(
            source_test.SourceSpec(url="https://example.com"),
            transport=httpx.MockTransport(handler),
        )
    )
    assert result["ok"] is True
    assert len(calls) == 2


def test_source_does_not_retry_non_transient_status(monkeypatch):
    allow_all_urls(monkeypatch)
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(400)

    with pytest.raises(source_test.SourceTestError, match="HTTP 400"):
        run(
            source_test.test_source(
                source_test.SourceSpec(url="https://example.com"),
                transport=httpx.MockTransport(handler),
            )
        )
    assert len(calls) == 1


def test_rejects_invalid_json(monkeypatch):
    allow_all_urls(monkeypatch)
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, content=b"not json")
    )
    with pytest.raises(source_test.SourceTestError, match="invalid JSON"):
        run(
            source_test.test_source(
                source_test.SourceSpec(url="https://example.com"),
                transport=transport,
            )
        )


def test_oversized_response_is_truncated_not_rejected(monkeypatch):
    allow_all_urls(monkeypatch)
    monkeypatch.setattr(source_test, "MAX_RESPONSE_BYTES", 8)
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, content=b'{"too":"large"}')
    )
    result = run(
        source_test.test_source(
            source_test.SourceSpec(url="https://example.com"),
            transport=transport,
        )
    )
    assert result["ok"] is True
    assert result["truncated"] is True
    assert "size limit" in result["note"]
    assert result["top_level_type"] == "unknown"


def test_guess_top_level_type():
    assert source_test._guess_top_level_type(b'  {"a": 1}') == "object"
    assert source_test._guess_top_level_type(b"[1, 2, 3]") == "array"
    assert source_test._guess_top_level_type(b"   ") == "unknown"
    assert source_test._guess_top_level_type(b"") == "unknown"


@pytest.mark.parametrize("kind", ["header", "query"])
def test_cross_origin_redirect_does_not_forward_secret(monkeypatch, kind):
    allow_all_urls(monkeypatch)
    seen = []
    def handler(request):
        seen.append(request)
        if len(seen) == 1:
            return httpx.Response(307, headers={"location": "https://other.example/data?next=1"})
        assert "secret-value" not in str(request.url)
        assert "secret-value" not in str(request.headers)
        assert request.url.params["next"] == "1"
        return httpx.Response(200, json={"items": []})
    verified = source_test.source_with_secret(
        source_test.SourceSpec(url="https://example.com/data"),
        source_test.SecretAuthSpec(type=kind, name="X-Key"), "secret-value",
    )
    assert run(source_test.test_source(verified, transport=httpx.MockTransport(handler)))["ok"]
    assert len(seen) == 2


def test_query_auth_scheme_matches_server():
    verified = source_test.source_with_secret(
        source_test.SourceSpec(url="https://example.com"),
        source_test.SecretAuthSpec(type="query", name="key", scheme="Prefix "), "value",
    )
    assert verified.query == {"key": "Prefix value"}


@pytest.mark.parametrize("status", [301, 302, 303, 307, 308])
def test_redirect_method_matches_server(monkeypatch, status):
    allow_all_urls(monkeypatch)
    seen = []
    def handler(request):
        seen.append(request)
        if len(seen) == 1:
            return httpx.Response(status, headers={"location": "/next"})
        assert request.method == ("GET" if status == 303 else "POST")
        assert request.content == (b"" if status == 303 else b"query")
        return httpx.Response(200, json={})
    run(source_test.test_source(source_test.SourceSpec(method="POST", url="https://example.com", body="query"), transport=httpx.MockTransport(handler)))
