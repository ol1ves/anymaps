"""Safe, bounded testing of a user-supplied external JSON source.

This module is intentionally internal to the Agent Service.  The wizard will
call it before generation; it does not add a public HTTP route or run widget
code.  Every request is checked with the same SSRF helper used by the server.
"""

from __future__ import annotations

import asyncio
from typing import Any, Literal
from urllib.parse import urljoin, urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field

from shared.http import with_user_agent
from shared.ssrf import assert_source_url_allowed


SOURCE_TIMEOUT_SECONDS = 30.0
MAX_SOURCE_ATTEMPTS = 2
SOURCE_RETRY_BACKOFF_SECONDS = 2.0
RETRYABLE_SOURCE_STATUS = frozenset({429, 500, 502, 503, 504})
RETRYABLE_SOURCE_TRANSPORT_ERRORS = (
    httpx.ReadError,
    httpx.ConnectError,
    httpx.RemoteProtocolError,
)
MAX_RESPONSE_BYTES = 1_000_000
MAX_REDIRECTS = 3
MAX_ARRAY_SUMMARIES = 16
MAX_SAMPLE_KEYS = 32
MAX_TOP_LEVEL_KEYS = 64
MAX_SHAPE_DEPTH = 4


class SourceTestError(RuntimeError):
    """A source could not be tested successfully."""


class SourceBlockedError(SourceTestError):
    """The source violates the shared HTTPS/SSRF rules."""


class _SourceRetryableError(Exception):
    """A transient upstream failure that the source test should retry."""


class SourceSpec(BaseModel):
    """The public, non-secret portion of an external channel configuration."""

    model_config = ConfigDict(extra="forbid")

    method: Literal["GET", "POST"] = "GET"
    url: str = Field(min_length=1)
    query: dict[str, str] = Field(default_factory=dict)
    headers: dict[str, str] = Field(default_factory=dict)
    body: str | dict[str, Any] | None = None


class SecretAuthSpec(BaseModel):
    """How a temporary verification request supplies one raw secret."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["header", "query"]
    name: str = Field(min_length=1)
    scheme: str = ""


def source_with_secret(
    source: SourceSpec, auth: SecretAuthSpec, value: str
) -> SourceSpec:
    """Return a request source with the secret injected only for verification."""

    if not value:
        raise SourceTestError("secret value is empty")
    if auth.type == "header":
        if auth.name.lower() in {name.lower() for name in source.headers}:
            raise SourceTestError("secret header duplicates a static header")
        update = {
            "headers": {
                **source.headers,
                auth.name: f"{auth.scheme}{value}",
            }
        }
    else:
        if auth.name in source.query:
            raise SourceTestError("secret query parameter duplicates a static query")
        update = {"query": {**source.query, auth.name: f"{auth.scheme}{value}"}}
    try:
        return source.model_copy(update=update)
    except AttributeError:  # Pydantic 1 compatibility
        return source.copy(update=update)


def _validate_source_spec(source: SourceSpec) -> None:
    try:
        assert_source_url_allowed(source.url)
    except ValueError as exc:
        raise SourceBlockedError("source blocked by SSRF rules") from exc

    if source.method == "GET" and source.body is not None:
        raise SourceTestError("GET sources cannot have a request body")


def _request_kwargs(source: SourceSpec, url: str, method: str) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "headers": with_user_agent(source.headers),
        "params": dict(source.query) if source.query else None,
    }
    if method == "POST" and source.body is not None:
        if isinstance(source.body, str):
            kwargs["content"] = source.body
        else:
            kwargs["json"] = source.body
    return kwargs


async def _read_response(response: httpx.Response) -> bytes:
    chunks: list[bytes] = []
    size = 0
    async for chunk in response.aiter_bytes():
        size += len(chunk)
        if size > MAX_RESPONSE_BYTES:
            raise SourceTestError("source response exceeds the size limit")
        chunks.append(chunk)
    return b"".join(chunks)


def _sample_keys(value: Any) -> list[str]:
    if not isinstance(value, dict):
        return []
    return [str(key) for key in list(value.keys())[:MAX_SAMPLE_KEYS]]


def _collect_arrays(
    value: Any,
    path: str,
    output: list[dict[str, Any]],
    depth: int = 0,
) -> None:
    if len(output) >= MAX_ARRAY_SUMMARIES or depth > MAX_SHAPE_DEPTH:
        return
    if isinstance(value, list):
        output.append(
            {
                "path": path,
                "length": len(value),
                "sample_keys": _sample_keys(value[0]) if value else [],
            }
        )
        # A nested object inside a sample can reveal a useful array path while
        # remaining bounded.  We never return record values.
        if value and isinstance(value[0], (dict, list)):
            _collect_arrays(value[0], f"{path}[0]", output, depth + 1)
        return
    if isinstance(value, dict):
        for key, child in list(value.items())[:MAX_TOP_LEVEL_KEYS]:
            _collect_arrays(child, f"{path}.{key}" if path else str(key), output, depth + 1)


def summarize_json(value: Any) -> dict[str, Any]:
    """Return bounded shape metadata without returning upstream record data."""

    arrays: list[dict[str, Any]] = []
    _collect_arrays(value, "$", arrays)
    result: dict[str, Any] = {
        "top_level_type": "object" if isinstance(value, dict) else "array" if isinstance(value, list) else type(value).__name__,
        "arrays": arrays,
    }
    if isinstance(value, dict):
        result["top_level_keys"] = [
            str(key) for key in list(value.keys())[:MAX_TOP_LEVEL_KEYS]
        ]
    return result


async def _test_source_once(
    source: SourceSpec,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """Fetch and summarize one source, following only safe HTTPS redirects."""

    _validate_source_spec(source)
    method = source.method
    url = source.url
    request_source = source

    try:
        async with httpx.AsyncClient(
            timeout=SOURCE_TIMEOUT_SECONDS,
            follow_redirects=False,
            transport=transport,
        ) as client:
            redirects = 0
            while True:
                async with client.stream(
                    method,
                    url,
                    **_request_kwargs(request_source, url, method),
                ) as response:
                    if response.is_redirect:
                        location = response.headers.get("location")
                        if not location:
                            raise SourceTestError("source redirect has no location")
                        redirects += 1
                        if redirects > MAX_REDIRECTS:
                            raise SourceTestError("source redirects exceed the limit")
                        next_url = urljoin(str(response.request.url), location)
                        old_origin = urlsplit(url)
                        new_origin = urlsplit(next_url)
                        if (old_origin.scheme, old_origin.hostname, old_origin.port or 443) != (
                            new_origin.scheme, new_origin.hostname, new_origin.port or 443
                        ):
                            # Verification may contain a raw API key. Never forward
                            # caller headers or query credentials to another origin.
                            request_source = request_source.model_copy(
                                update={"headers": {}, "query": {}}
                            )
                        url = next_url
                        try:
                            assert_source_url_allowed(url)
                        except ValueError as exc:
                            raise SourceBlockedError(
                                "source blocked by SSRF rules"
                            ) from exc
                        if response.status_code == 303:
                            method = "GET"
                        continue

                    if response.status_code < 200 or response.status_code >= 300:
                        if response.status_code in RETRYABLE_SOURCE_STATUS:
                            raise _SourceRetryableError(
                                f"HTTP {response.status_code}"
                            )
                        raise SourceTestError(
                            f"source returned HTTP {response.status_code}"
                        )
                    content = await _read_response(response)
                    content_type = response.headers.get("content-type", "")
                    break
    except SourceTestError:
        raise
    except httpx.TimeoutException as exc:
        raise _SourceRetryableError("timeout") from exc
    except RETRYABLE_SOURCE_TRANSPORT_ERRORS as exc:
        raise _SourceRetryableError(type(exc).__name__) from exc
    except httpx.HTTPError as exc:
        raise SourceTestError("source request failed") from exc

    try:
        payload = httpx.Response(200, content=content).json()
    except ValueError as exc:
        raise SourceTestError("source returned invalid JSON") from exc

    result: dict[str, Any] = {
        "ok": True,
        "status": 200,
        "content_type": content_type,
        "content_length": len(content),
    }
    result.update(summarize_json(payload))
    return result


async def test_source(
    source: SourceSpec,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """Test one source, retrying transient upstream failures once."""

    last_cause = "unknown"
    for attempt in range(MAX_SOURCE_ATTEMPTS):
        try:
            return await _test_source_once(source, transport=transport)
        except _SourceRetryableError as exc:
            last_cause = str(exc)
        if attempt < MAX_SOURCE_ATTEMPTS - 1:
            await asyncio.sleep(SOURCE_RETRY_BACKOFF_SECONDS)
    raise SourceTestError(f"source test failed ({last_cause})")
