import asyncio
import json

import httpx
import pytest

from agent.app import research
from agent.app.research import FetchBlockedError, FetchError, SearchError


def run(coro):
    return asyncio.run(coro)


def allow_all_urls(monkeypatch):
    monkeypatch.setattr(research, "assert_source_url_allowed", lambda url: None)


def test_search_docs_posts_to_serper_and_returns_results():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["api_key"] = request.headers.get("x-api-key")
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "organic": [
                    {
                        "title": "Docs A",
                        "link": "https://a.example.com",
                        "snippet": "Snippet A",
                    },
                    {
                        "title": "Docs B",
                        "link": "https://b.example.com",
                        "snippet": "Snippet B",
                    },
                ]
            },
        )

    results = run(
        research.search_docs(
            "anyapi docs", "test-key", transport=httpx.MockTransport(handler)
        )
    )
    assert seen["url"] == "https://google.serper.dev/search"
    assert seen["api_key"] == "test-key"
    assert seen["body"] == {"q": "anyapi docs"}
    assert results == [
        {"title": "Docs A", "link": "https://a.example.com", "snippet": "Snippet A"},
        {"title": "Docs B", "link": "https://b.example.com", "snippet": "Snippet B"},
    ]


def test_search_docs_returns_empty_when_no_organic_results():
    def handler(request):
        return httpx.Response(200, json={"organic": []})

    results = run(
        research.search_docs("nothing", "k", transport=httpx.MockTransport(handler))
    )
    assert results == []


def test_search_docs_raises_on_http_error():
    def handler(request):
        return httpx.Response(401, json={"error": "bad key"})

    with pytest.raises(SearchError):
        run(
            research.search_docs("q", "bad", transport=httpx.MockTransport(handler))
        )


def test_fetch_doc_extracts_html_text(monkeypatch):
    allow_all_urls(monkeypatch)

    def handler(request):
        return httpx.Response(
            200,
            headers={"content-type": "text/html"},
            content=b"<html><body><script>x()</script><h1>Endpoints</h1>"
            b"<p>GET /v1/data</p></body></html>",
        )

    text = run(
        research.fetch_doc(
            "https://docs.example.com/api", transport=httpx.MockTransport(handler)
        )
    )
    assert "Endpoints" in text
    assert "GET /v1/data" in text
    assert "x()" not in text  # scripts are stripped


def test_fetch_doc_extracts_json(monkeypatch):
    allow_all_urls(monkeypatch)

    def handler(request):
        return httpx.Response(
            200,
            headers={"content-type": "application/json"},
            json={"paths": {"/v1/data": {"get": {}}}},
        )

    text = run(
        research.fetch_doc(
            "https://api.example.com/openapi.json",
            transport=httpx.MockTransport(handler),
        )
    )
    assert "/v1/data" in text


def test_fetch_doc_blocks_non_https():
    with pytest.raises(FetchBlockedError):
        run(research.fetch_doc("http://example.com/doc"))


def test_fetch_doc_truncates_long_documents(monkeypatch):
    allow_all_urls(monkeypatch)

    def handler(request):
        return httpx.Response(
            200,
            headers={"content-type": "text/plain"},
            content=("word " * 100_000).encode(),
        )

    text = run(
        research.fetch_doc(
            "https://docs.example.com/long", transport=httpx.MockTransport(handler)
        )
    )
    assert len(text) <= research.MAX_FETCH_CHARS


def test_fetch_doc_raises_on_non_2xx(monkeypatch):
    allow_all_urls(monkeypatch)
    transport = httpx.MockTransport(lambda request: httpx.Response(404))
    with pytest.raises(FetchError, match="404"):
        run(research.fetch_doc("https://docs.example.com", transport=transport))


def test_run_research_combines_search_and_fetch(monkeypatch):
    async def fake_search(query, api_key, *, transport=None):
        return [{"title": "T", "link": "https://l.example.com", "snippet": "S"}]

    async def fake_fetch(url, *, transport=None):
        return "Doc body"

    monkeypatch.setattr(research, "search_docs", fake_search)
    monkeypatch.setattr(research, "fetch_doc", fake_fetch)
    note = run(research.run_research(["q"], ["https://l.example.com"], "key"))
    assert "q" in note
    assert "https://l.example.com" in note
    assert "Doc body" in note


def test_run_research_reports_missing_search_key():
    note = run(research.run_research(["q"], [], ""))
    assert "SERPER_API_KEY" in note


def test_run_research_reports_fetch_failure(monkeypatch):
    async def fake_fetch(url, *, transport=None):
        raise FetchError("boom")

    monkeypatch.setattr(research, "fetch_doc", fake_fetch)
    note = run(research.run_research([], ["https://x.example.com"], "key"))
    assert "boom" in note
    assert "https://x.example.com" in note
