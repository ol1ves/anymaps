"""Candidate validation and publication for the anymaps wizard.

The module contains no widget execution and no web search.  DeepSeek supplies
the candidate JSON; this module validates it, tests declared external sources,
and publishes the manifest plus classic JavaScript bundle to the generic server.
"""

from __future__ import annotations

from typing import Any

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from shared.schema import validate_channel_matrix, validate_manifest

from .source_test import SourceSpec, SourceTestError, test_source


MAX_BUNDLE_CHARS = 1_000_000
MAX_EXTERNAL_SOURCES = 8
PUBLISH_TIMEOUT_SECONDS = 10.0


class GenerationCandidate(BaseModel):
    """Internal model response. ``bundle`` never crosses the wizard API."""

    model_config = ConfigDict(extra="ignore")

    done: bool
    questions: list[str] | None = None
    widgetId: str | None = Field(default=None, min_length=1)
    version: str | None = Field(default=None, min_length=1)
    manifest: dict[str, Any] | None = None
    bundle: str | None = None


def validate_candidate(payload: dict[str, Any]) -> GenerationCandidate:
    """Validate the model candidate and the universal manifest/bundle shape."""

    try:
        try:
            candidate = GenerationCandidate.model_validate(payload)
        except AttributeError:  # Pydantic 1 compatibility
            candidate = GenerationCandidate.parse_obj(payload)
    except ValidationError as exc:
        raise ValueError("model returned an invalid generation response") from exc

    if candidate.done is False:
        if not candidate.questions or len(candidate.questions) != 1:
            raise ValueError("model returned an invalid clarifying response")
        question = candidate.questions[0].strip()
        if not question:
            raise ValueError("model returned an empty clarifying question")
        return GenerationCandidate(done=False, questions=[question])

    if candidate.questions is not None:
        raise ValueError("completed response cannot include questions")
    if candidate.widgetId is None or candidate.version is None:
        raise ValueError("completed response is missing widget identity")
    if candidate.manifest is None:
        raise ValueError("completed response is missing manifest")
    if not candidate.bundle or not candidate.bundle.strip():
        raise ValueError("completed response is missing bundle")
    if len(candidate.bundle) > MAX_BUNDLE_CHARS:
        raise ValueError("generated bundle exceeds the size limit")
    if "\x00" in candidate.bundle:
        raise ValueError("generated bundle contains a null byte")
    if "import " in candidate.bundle or "export " in candidate.bundle:
        raise ValueError("generated bundle must be a classic script")
    if candidate.manifest.get("id") != candidate.widgetId:
        raise ValueError("widgetId does not match manifest id")
    if candidate.manifest.get("version") != candidate.version:
        raise ValueError("version does not match manifest version")
    try:
        validate_manifest(candidate.manifest)
        validate_channel_matrix(candidate.manifest)
    except Exception as exc:  # jsonschema exposes multiple exception classes
        raise ValueError("generated manifest is invalid") from exc
    external_sources(candidate.manifest)
    return candidate


def external_sources(manifest: dict[str, Any]) -> list[SourceSpec]:
    """Extract public request configuration for every external channel."""

    channels = manifest.get("server", {}).get("channels", [])
    sources: list[SourceSpec] = []
    for channel in channels:
        if channel.get("origin") != "external":
            continue
        external = channel.get("external") or {}
        try:
            sources.append(
                SourceSpec(
                    method=external.get("method", "GET"),
                    url=external["url"],
                    query=external.get("query", {}),
                    headers=external.get("headers", {}),
                    body=external.get("body"),
                )
            )
        except (KeyError, ValidationError, TypeError) as exc:
            raise ValueError("generated external source configuration is invalid") from exc
    if len(sources) > MAX_EXTERNAL_SOURCES:
        raise ValueError("generated manifest has too many external sources")
    return sources


async def test_candidate_sources(
    manifest: dict[str, Any],
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> list[dict[str, Any]]:
    """Test each declared source exactly once and return bounded summaries."""

    external_sources(manifest)  # Enforce the same source limit before any requests.
    results: list[dict[str, Any]] = []
    for channel in manifest.get("server", {}).get("channels", []):
        if channel.get("origin") != "external":
            continue
        external = channel.get("external") or {}
        if external.get("auth") is not None:
            # /wizard/secrets verifies the authenticated source before the key
            # is stored on the generic server. The key is never recoverable by
            # this stateless service, so do not attempt a second raw-key test.
            results.append({"ok": True, "authenticated": True, "verified": "prior"})
            continue
        source = SourceSpec(
            method=external.get("method", "GET"),
            url=external["url"],
            query=external.get("query", {}),
            headers=external.get("headers", {}),
            body=external.get("body"),
        )
        results.append(await test_source(source, transport=transport))
    return results


async def publish_widget(
    manifest: dict[str, Any],
    bundle: str,
    *,
    server_url: str,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, Any]:
    """Publish one validated widget through the generic server contract."""

    try:
        async with httpx.AsyncClient(
            timeout=PUBLISH_TIMEOUT_SECONDS,
            transport=transport,
        ) as client:
            response = await client.post(
                f"{server_url.rstrip('/')}/widgets",
                json={"manifest": manifest, "bundle": bundle},
            )
            response.raise_for_status()
            payload = response.json()
    except httpx.TimeoutException as exc:
        raise RuntimeError("widget publish timed out") from exc
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 409:
            raise RuntimeError("widget version is already published") from exc
        raise RuntimeError("widget publish failed") from exc
    except (httpx.HTTPError, ValueError) as exc:
        raise RuntimeError("widget publish failed") from exc

    if payload.get("id") != manifest["id"] or payload.get("version") != manifest["version"]:
        raise RuntimeError("widget server returned an invalid publish response")
    return payload


async def store_secret(
    value: str,
    *,
    server_url: str,
    transport: httpx.AsyncBaseTransport | None = None,
) -> str:
    """Store a verified secret through the existing generic-server route."""

    try:
        async with httpx.AsyncClient(
            timeout=PUBLISH_TIMEOUT_SECONDS,
            transport=transport,
        ) as client:
            response = await client.post(
                f"{server_url.rstrip('/')}/secrets",
                json={"value": value},
            )
            response.raise_for_status()
            payload = response.json()
    except httpx.TimeoutException as exc:
        raise RuntimeError("secret storage timed out") from exc
    except httpx.HTTPStatusError as exc:
        raise RuntimeError("secret storage failed") from exc
    except (httpx.HTTPError, ValueError) as exc:
        raise RuntimeError("secret storage failed") from exc

    secret_id = payload.get("secretId")
    if not isinstance(secret_id, str) or not secret_id:
        raise RuntimeError("secret server returned an invalid response")
    return secret_id
