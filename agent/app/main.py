"""Stateless Agent Service wizard turns (Step 2)."""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any, Literal

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from shared.schema import load_manifest_schema
from .generator import (
    publish_widget,
    store_secret,
    test_candidate_sources,
    validate_candidate,
)
from .skills import WIZARD_FLOW_SKILL, load_skill_body
from .source_test import (
    SecretAuthSpec,
    SourceBlockedError,
    SourceSpec,
    SourceTestError,
    source_with_secret,
    test_source,
)


# Fixed for the first implementation. This is DeepSeek's current API model ID.
DEEPSEEK_BASE_URL = "https://api.deepseek.com"
DEEPSEEK_CHAT_URL = f"{DEEPSEEK_BASE_URL}/chat/completions"
DEEPSEEK_MODEL = "deepseek-v4-flash"

# Credit and latency guardrails: one request per turn, bounded input/output.
MAX_MESSAGES = 24
MAX_CONTENT_CHARS = 12_000
MAX_TRANSCRIPT_CHARS = 48_000
# deepseek-v4-flash is a reasoning model: chain-of-thought tokens share the
# max_tokens budget with the answer. A full widget-generation turn measured
# ~14k completion tokens (~12k of them reasoning), so the old 8k cap ended
# with finish_reason=length and an empty content string ("invalid JSON").
REQUEST_TIMEOUT_SECONDS = 180.0
MAX_OUTPUT_TOKENS = 32_000

# Transient DeepSeek failures (connection resets during long generations,
# rate limits, and 5xx) get one retry before the wizard turn fails.
MAX_DEEPSEEK_ATTEMPTS = 2
RETRY_BACKOFF_SECONDS = 2.0
RETRYABLE_HTTP_STATUS = frozenset({429, 500, 502, 503, 504})
RETRYABLE_TRANSPORT_ERRORS = (
    httpx.ReadError,
    httpx.ConnectError,
    httpx.RemoteProtocolError,
)

MISSING_KEY_MESSAGE = (
    "DeepSeek API key is not configured. Add your DeepSeek API key to get started."
)

SYSTEM_PROMPT = """You are the friendly anymaps widget wizard. Explain things in
plain language for a non-technical reader. Avoid jargon; if you must use a
technical term, briefly define it. Keep questions short and ask only one at a
time. Summarize the user's goal before asking for the next missing detail.

The user is describing a map widget. Work conversationally and ask exactly one
clarifying question when the requirements, data source, API details, or visual
behavior are not sufficiently defined. The full transcript is supplied on every
turn, so do not assume server-side memory.

Return JSON only, with no markdown or explanatory text. The completed result
must be a complete, installable widget package: include the manifest and the
classic JavaScript bundle needed to run it. The manifest must describe the
widget's identity, data channels, and permissions; the bundle must use only
the anymaps SDK described below. Until the user has
approved the proposed widget, return exactly:
{"done": false, "questions": ["one concise question"]}

Only after the user explicitly approves the proposed result may a later wizard
stage return done=true. For a ready internal candidate, return done=true with
widgetId, version, manifest, and bundle. The service removes bundle before it
responds to the client. Do not put API keys or other secrets in your response.
"""


GENERATION_CONTRACT = """
Generate a classic JavaScript script using an async IIFE. The host supplies
global anymaps. Begin with const {config, state} = await anymaps.ready().
config has widgetId, baseUrl, channelRoutes (absolute URLs keyed by channel id).
Use fetch on these provisioned routes, never call external sources from a widget.
GET returns {records: [...]} containing original source records, not renamed
fields. External record mappings are JMESPath expressions used for indexing.
Filters: bounds=south,west,north,east; ids=comma-separated; latest=1;
since/until=unix seconds. Only use filters supported by declared record mappings.
Private read/write routes append /instances/{token}. POST
{baseUrl}/widgets/{widgetId}/instances returns {instanceToken}; persist as iid.
Client writes POST one raw record. A client read's source must name a client
write channel of matching visibility. All channel ids must be unique.
External channels are public read channels. Secrets go only in external.auth
as {type: 'header'|'query', name, secret: secretId, scheme?: prefix}.
Do not invent a secretId; ask the user to verify it outside the chat first.
SDK methods: addMarker/updateMarker({id,lat,lng,icon?,label?,title?,rotation?});
removeMarker(id); addPolyline({id,points:[[lat,lng],...],color?,width?});
updatePolyline({id,points? ,append?,color?,width?}); removePolyline(id);
setPanel({title?,content: html}); clearPanel(); setStyles(cssText);
openPopup({id,content,lat?,lng?,anchorMarkerId?}); closePopup(id);
setPopupContent({id,content}); persist(partialState);
startGeolocation({highAccuracy?}); stopGeolocation();
requestCameraControl(); releaseCameraControl(); flyTo/jumpTo({center:[lat,lng],zoom?});
fitBounds({bounds:[[south,west],[north,east]]}). Request camera control and wait
for cameraGranted before moving the map.
anymaps.on(name, handler) subscribes: viewportChanged({bounds,center,zoom}),
markerClick({markerId,lat,lng}), geolocation({lat,lng,accuracy}),
geolocationError({code,message}), cameraGranted, cameraRevoked,
error({error}). Coordinates are [lat,lng]; times are unix seconds.
No DOM, window, navigator, localStorage, imports, or raw postMessage in bundles.
Panels contain HTML but have no form-input SDK event; use persisted state for
settings. Escape external strings before including them in HTML.
"""


class Message(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=MAX_CONTENT_CHARS)


class WizardRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    messages: list[Message] = Field(min_length=1, max_length=MAX_MESSAGES)


class ClarifyingResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    done: Literal[False]
    questions: list[str] = Field(min_length=1, max_length=1)


class WizardSecretRequest(BaseModel):
    """Temporary key-verification request; never part of the transcript."""

    model_config = ConfigDict(extra="forbid")

    value: str = Field(min_length=1, max_length=4096)
    source: SourceSpec
    auth: SecretAuthSpec


def _allowed_origins() -> list[str]:
    raw = os.getenv("ALLOWED_ORIGINS", "*")
    origins = [origin.strip() for origin in raw.split(",") if origin.strip()]
    if "*" in origins:
        return ["*"]
    return origins


app = FastAPI(title="anymaps agent service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@app.exception_handler(RequestValidationError)
async def request_validation_error_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """Return the wizard contract's 400 {error} shape instead of FastAPI's 422."""

    del request, exc
    return JSONResponse(status_code=400, content={"error": "invalid wizard request"})


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    del request
    detail = exc.detail if isinstance(exc.detail, str) else "wizard request failed"
    return JSONResponse(status_code=exc.status_code, content={"error": detail})


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/wizard/secrets", status_code=201)
async def verify_and_store_secret(request: WizardSecretRequest) -> dict[str, str]:
    """Verify one key against its source, then store it in the generic server."""

    try:
        verification_source = source_with_secret(
            request.source, request.auth, request.value
        )
        await test_source(verification_source)
    except SourceBlockedError as exc:
        raise HTTPException(status_code=400, detail="source blocked by SSRF rules") from exc
    except SourceTestError as exc:
        raise HTTPException(
            status_code=400, detail=f"source verification failed: {exc}"
        ) from exc

    try:
        secret_id = await store_secret(
            request.value,
            server_url=os.getenv("SERVER_URL", "http://localhost:8000"),
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"secretId": secret_id}


def _transcript_size(messages: list[Message]) -> int:
    return sum(len(message.content) for message in messages)


def _parse_model_response(payload: dict[str, Any]) -> dict[str, Any]:
    """Validate and normalize model JSON into the public contract shape."""

    if not isinstance(payload, dict) or not isinstance(payload.get("done"), bool):
        raise ValueError("model returned invalid wizard JSON")

    if payload["done"] is False:
        try:
            try:
                parsed = ClarifyingResponse.model_validate(payload)
            except AttributeError:  # Pydantic 1 compatibility
                parsed = ClarifyingResponse.parse_obj(payload)
        except ValidationError as exc:
            raise ValueError("model returned an invalid clarifying response") from exc
        question = parsed.questions[0].strip()
        if not question:
            raise ValueError("model returned an empty clarifying question")
        return {"done": False, "questions": [question]}

    try:
        candidate = validate_candidate(payload)
    except ValueError as exc:
        raise ValueError(str(exc)) from exc
    try:
        return candidate.model_dump()
    except AttributeError:  # Pydantic 1 compatibility
        return candidate.dict()


def _extract_json_content(response_json: dict[str, Any]) -> dict[str, Any]:
    """Extract the object from a non-streaming Chat Completions response."""

    try:
        choice = response_json["choices"][0]
        content = choice["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError("DeepSeek returned no assistant content") from exc
    if not isinstance(content, str):
        raise ValueError("DeepSeek returned non-text assistant content")

    text = content.strip()
    if text.startswith("```") and text.endswith("```"):
        text = text[3:-3].strip()
        if text.lower().startswith("json"):
            text = text[4:].lstrip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        if choice.get("finish_reason") == "length":
            raise ValueError(
                "DeepSeek response was truncated (finish_reason=length) "
                "before it produced complete JSON"
            ) from exc
        raise ValueError("DeepSeek returned invalid JSON") from exc
    if not isinstance(parsed, dict):
        raise ValueError("DeepSeek returned a JSON value instead of an object")
    return parsed


class _DeepSeekRetryableError(Exception):
    """A DeepSeek response that should be retried (rate limit or server error)."""


async def _request_deepseek_json(
    client: httpx.AsyncClient, api_key: str, body: dict[str, Any]
) -> dict[str, Any]:
    """POST one DeepSeek request and return its parsed JSON body."""

    response = await client.post(
        DEEPSEEK_CHAT_URL,
        headers={"Authorization": f"Bearer {api_key}"},
        json=body,
    )
    if response.status_code in RETRYABLE_HTTP_STATUS:
        raise _DeepSeekRetryableError(f"HTTP {response.status_code}")
    response.raise_for_status()
    return response.json()


async def call_deepseek(messages: list[Message], api_key: str) -> dict[str, Any]:
    """Make one bounded DeepSeek request for a wizard turn, retrying transient errors once."""

    request_messages = [
        {"role": "system", "content": SYSTEM_PROMPT + load_skill_body(WIZARD_FLOW_SKILL)
         + GENERATION_CONTRACT
         + "\nManifest JSON Schema:\n" + json.dumps(load_manifest_schema())},
        *[{"role": item.role, "content": item.content} for item in messages],
    ]
    body = {
        "model": DEEPSEEK_MODEL,
        "messages": request_messages,
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
        "max_tokens": MAX_OUTPUT_TOKENS,
        "stream": False,
    }

    last_cause = "unknown"
    for attempt in range(MAX_DEEPSEEK_ATTEMPTS):
        try:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
                response_json = await _request_deepseek_json(client, api_key, body)
        except _DeepSeekRetryableError as exc:
            last_cause = str(exc)
        except RETRYABLE_TRANSPORT_ERRORS as exc:
            last_cause = type(exc).__name__
        except httpx.TimeoutException as exc:
            raise HTTPException(status_code=500, detail="DeepSeek request timed out") from exc
        except httpx.HTTPStatusError as exc:
            raise HTTPException(
                status_code=500,
                detail=f"DeepSeek request failed: HTTP {exc.response.status_code}",
            ) from exc
        except ValueError as exc:
            raise HTTPException(status_code=500, detail="DeepSeek request failed") from exc
        else:
            try:
                return _parse_model_response(_extract_json_content(response_json))
            except ValueError as exc:
                raise HTTPException(status_code=500, detail=str(exc)) from exc

        if attempt < MAX_DEEPSEEK_ATTEMPTS - 1:
            await asyncio.sleep(RETRY_BACKOFF_SECONDS)

    raise HTTPException(status_code=500, detail=f"DeepSeek request failed ({last_cause})")


@app.post("/wizard/generate")
async def generate_wizard(request: WizardRequest) -> dict[str, Any]:
    """Process one stateless wizard turn and return the contract response."""

    if request.messages[0].role != "user":
        raise HTTPException(status_code=400, detail="the first wizard message must have role user")
    if _transcript_size(request.messages) > MAX_TRANSCRIPT_CHARS:
        raise HTTPException(status_code=400, detail="wizard transcript is too long")

    api_key = os.getenv("WIZARD_LLM_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(status_code=500, detail=MISSING_KEY_MESSAGE)
    result = await call_deepseek(request.messages, api_key)
    if result["done"] is False:
        return result

    try:
        await test_candidate_sources(result["manifest"])
    except SourceBlockedError as exc:
        raise HTTPException(status_code=400, detail="source blocked by SSRF rules") from exc
    except SourceTestError as exc:
        raise HTTPException(status_code=500, detail=f"source test failed: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    try:
        await publish_widget(
            result["manifest"],
            result["bundle"],
            server_url=os.getenv("SERVER_URL", "http://localhost:8000"),
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "done": True,
        "widgetId": result["widgetId"],
        "version": result["version"],
        "manifest": result["manifest"],
    }
