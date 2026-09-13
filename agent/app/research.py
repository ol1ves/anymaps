"""Bounded web research for the wizard: Serper search + SSRF-guarded doc fetch.

The wizard uses this to look up third-party API documentation before it writes
a manifest's external source block, so it never guesses an endpoint, parameter,
or auth scheme. Search requires SERPER_API_KEY; fetch follows the shared SSRF
rules and returns extracted text only.
"""

from __future__ import annotations

import html as html_lib
import json
import re
from typing import Any
from urllib.parse import urljoin

import httpx

from shared.http import with_user_agent
from shared.ssrf import assert_source_url_allowed

SERPER_SEARCH_URL = "https://google.serper.dev/search"
SEARCH_TIMEOUT_SECONDS = 15.0
FETCH_TIMEOUT_SECONDS = 20.0
MAX_SEARCH_QUERIES = 3
MAX_SEARCH_RESULTS = 5
SEARCH_SNIPPET_CHARS = 300
MAX_FETCH_URLS = 3
MAX_FETCH_CHARS = 6_000
MAX_FETCH_BYTES = 500_000
MAX_REDIRECTS = 3
MAX_RESEARCH_NOTE_CHARS = 12_000

SEARCH_UNAVAILABLE_NOTE = (
    "Web search is unavailable because SERPER_API_KEY is not configured. "
    "Ask the user for a documentation URL, or fetch the URLs they provided."
)


class SearchError(RuntimeError):
    """A search request failed."""


class FetchError(RuntimeError):
    """A documentation fetch failed."""


class FetchBlockedError(FetchError):
    """The URL violates the shared HTTPS/SSRF rules."""


_TAG_RE = re.compile(r"<[^>]+>")
_SCRIPT_RE = re.compile(r"(?is)<(script|style)\b[^>]*>.*?</\1>")


def _html_to_text(html: str) -> str:
    text = _SCRIPT_RE.sub(" ", html)
    text = _TAG_RE.sub(" ", text)
    text = html_lib.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def _extract_text(content: bytes, content_type: str) -> str:
    ct = (content_type or "").lower()
    if "json" in ct:
        try:
            return json.dumps(json.loads(content), ensure_ascii=False, indent=2)
        except ValueError:
            return content.decode("utf-8", errors="replace")
    if "html" in ct:
        return _html_to_text(content.decode("utf-8", errors="replace"))
    return content.decode("utf-8", errors="replace")


async def _read_bounded(response: httpx.Response) -> bytes:
    chunks: list[bytes] = []
    size = 0
    async for chunk in response.aiter_bytes():
        size += len(chunk)
        if size > MAX_FETCH_BYTES:
            raise FetchError("document exceeds the size limit")
        chunks.append(chunk)
    return b"".join(chunks)


async def search_docs(
    query: str,
    api_key: str,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> list[dict[str, str]]:
    """Run one Serper search and return bounded ``{title, link, snippet}`` items."""

    if not api_key:
        raise SearchError("SERPER_API_KEY is not configured")
    headers = with_user_agent(
        {"X-API-KEY": api_key, "Content-Type": "application/json"}
    )
    try:
        async with httpx.AsyncClient(
            timeout=SEARCH_TIMEOUT_SECONDS, transport=transport
        ) as client:
            response = await client.post(
                SERPER_SEARCH_URL,
                headers=headers,
                json={"q": query},
            )
            response.raise_for_status()
            payload = response.json()
    except httpx.TimeoutException as exc:
        raise SearchError("search timed out") from exc
    except (httpx.HTTPError, ValueError) as exc:
        raise SearchError("search request failed") from exc

    organic = payload.get("organic") if isinstance(payload, dict) else None
    if not isinstance(organic, list):
        return []
    results: list[dict[str, str]] = []
    for item in organic[:MAX_SEARCH_RESULTS]:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        link = str(item.get("link") or "").strip()
        snippet = str(item.get("snippet") or "").strip()
        if not title and not link and not snippet:
            continue
        results.append(
            {
                "title": title,
                "link": link,
                "snippet": snippet[:SEARCH_SNIPPET_CHARS],
            }
        )
    return results


async def fetch_doc(
    url: str,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> str:
    """Fetch one documentation URL and return extracted, bounded text."""

    try:
        assert_source_url_allowed(url)
    except ValueError as exc:
        raise FetchBlockedError("document URL blocked by SSRF rules") from exc

    current_url = url
    try:
        async with httpx.AsyncClient(
            timeout=FETCH_TIMEOUT_SECONDS,
            follow_redirects=False,
            transport=transport,
        ) as client:
            redirects = 0
            while True:
                async with client.stream(
                    "GET", current_url, headers=with_user_agent({})
                ) as response:
                    if response.is_redirect:
                        location = response.headers.get("location")
                        if not location:
                            raise FetchError("document redirect has no location")
                        redirects += 1
                        if redirects > MAX_REDIRECTS:
                            raise FetchError("document redirects exceed the limit")
                        current_url = urljoin(current_url, location)
                        try:
                            assert_source_url_allowed(current_url)
                        except ValueError as exc:
                            raise FetchBlockedError(
                                "document redirect blocked by SSRF rules"
                            ) from exc
                        continue
                    if response.status_code < 200 or response.status_code >= 300:
                        raise FetchError(
                            f"document returned HTTP {response.status_code}"
                        )
                    content = await _read_bounded(response)
                    content_type = response.headers.get("content-type", "")
                    break
    except FetchError:
        raise
    except httpx.TimeoutException as exc:
        raise FetchError("document fetch timed out") from exc
    except httpx.HTTPError as exc:
        raise FetchError("document fetch failed") from exc

    return _extract_text(content, content_type)[:MAX_FETCH_CHARS]


def _format_search(query: str, results: list[dict[str, str]]) -> str:
    if not results:
        return f'## Search: "{query}"\n(no results)'
    lines = [f'## Search: "{query}"']
    for item in results:
        lines.append(f"- {item['title']} — {item['link']}")
        if item["snippet"]:
            lines.append(f"  {item['snippet']}")
    return "\n".join(lines)


async def run_research(
    queries: list[str],
    urls: list[str],
    api_key: str,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> str:
    """Run bounded web research and return a note for the model.

    Each search and fetch is best-effort: failures are recorded in the note
    instead of aborting the wizard turn.
    """

    parts: list[str] = []
    for query in list(queries)[:MAX_SEARCH_QUERIES]:
        query = query.strip()
        if not query:
            continue
        if not api_key:
            parts.append(SEARCH_UNAVAILABLE_NOTE)
            break
        try:
            results = await search_docs(query, api_key, transport=transport)
            parts.append(_format_search(query, results))
        except SearchError as exc:
            parts.append(f'Search "{query}" failed: {exc}')
    for url in list(urls)[:MAX_FETCH_URLS]:
        url = url.strip()
        if not url:
            continue
        try:
            text = await fetch_doc(url, transport=transport)
            parts.append(f"## {url}\n{text}")
        except FetchError as exc:
            parts.append(f'Fetch of {url} failed: {exc}')

    note = "\n\n".join(parts) if parts else "No research results."
    return note[:MAX_RESEARCH_NOTE_CHARS]
