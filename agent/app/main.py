"""Stateless Agent Service wizard turns (Step 2)."""

from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any, Literal

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from . import research
from .prompt import build_system_prompt
from shared.proxy import create_prefix_strip_middleware
from .generator import (
    MAX_EXTERNAL_SOURCES,
    publish_widget,
    store_secret,
    test_candidate_sources,
    validate_candidate,
)
from .skills import WIDGET_EXAMPLES_SKILL, WIZARD_FLOW_SKILL, load_skill_body
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

# Credit and latency guardrails: bounded requests per turn, bounded input/output.
MAX_MESSAGES = 24
MAX_CONTENT_CHARS = 12_000
MAX_TRANSCRIPT_CHARS = 48_000
# deepseek-v4-flash is a reasoning model: chain-of-thought tokens share the
# max_tokens budget with the answer. Cap the completion budget so a full
# widget-generation turn finishes before the client's 360s (6 min) abort (see
# TURN_BUDGET_MS in client/src/ui/wizard.js). The server deadline sits just
# under the client's, so a slow turn returns a clean 500 instead of the client
# aborting first.
REQUEST_TIMEOUT_SECONDS = 350.0
MAX_OUTPUT_TOKENS = 32_000
# A turn may run up to this many research rounds (web search + doc fetch)
# before the model must produce a plan or final answer.
MAX_RESEARCH_ROUNDS = 2

# Transient DeepSeek failures (connection resets during long generations,
# rate limits, and 5xx) get one retry before the wizard turn fails.
MAX_DEEPSEEK_ATTEMPTS = 2
MAX_REPAIR_ATTEMPTS = 1
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

When the user names a third-party API and you are not certain of its exact
endpoints, parameters, or auth scheme, do not guess. Return exactly:
{"done": false, "research": {"queries": ["search terms"], "urls": ["doc url"]}}
Include queries, urls, or both — at least one must be present. The service
will look up the documentation and hand you the results; then continue and
eventually emit the plan or the final widget.

Only after the user explicitly approves the proposed result may a later wizard
stage return done=true. For a ready internal candidate, return done=true with
widgetId, version, manifest, and bundle. The service removes bundle before it
responds to the client. Do not put API keys or other secrets in your response.
"""


class Message(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=MAX_CONTENT_CHARS)


class SecretBinding(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=128)
    secretId: str = Field(min_length=1, max_length=256)
    shape: dict[str, Any] | None = None


class WizardRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    messages: list[Message] = Field(min_length=1, max_length=MAX_MESSAGES)
    secrets: list[SecretBinding] = Field(
        default_factory=list, max_length=MAX_EXTERNAL_SOURCES
    )


class ClarifyingResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

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
class PlanSource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=128)
    method: Literal["GET", "POST"] = "GET"
    url: str = Field(min_length=1)
    query: dict[str, str] = Field(default_factory=dict)
    headers: dict[str, str] = Field(default_factory=dict)
    body: str | dict[str, Any] | None = None
    auth: SecretAuthSpec | None = None


class PlanPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    proposal: str = Field(min_length=1)
    sources: list[PlanSource] = Field(min_length=1, max_length=MAX_EXTERNAL_SOURCES)


class PlanResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    done: Literal[False]
    plan: PlanPayload


class ResearchRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    queries: list[str] = Field(
        default_factory=list, max_length=research.MAX_SEARCH_QUERIES
    )
    urls: list[str] = Field(
        default_factory=list, max_length=research.MAX_FETCH_URLS
    )


class ResearchResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    done: Literal[False]
    research: ResearchRequest


app = FastAPI(title="anymaps agent service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)
app.middleware("http")(create_prefix_strip_middleware())


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
async def verify_and_store_secret(request: WizardSecretRequest) -> dict[str, Any]:
    """Verify one key against its source, then store it in the generic server."""

    try:
        verification_source = source_with_secret(
            request.source, request.auth, request.value
        )
        shape = await test_source(verification_source)
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
    return {"secretId": secret_id, "shape": shape}


def _transcript_size(messages: list[Message]) -> int:
    return sum(len(message.content) for message in messages)


def _log_wizard(message: str) -> None:
    """Emit a timing trace line for one wizard turn (docker-compose logs)."""

    print(f"[wizard] {message}", flush=True)


def _secret_bindings_note(request: WizardRequest) -> str:
    """A synthetic note describing verified secrets, never the raw values."""

    lines = [
        "Verified API secrets for this widget. Use the secretId verbatim as "
        "external.auth.secret in the manifest; never invent a secretId."
    ]
    for binding in request.secrets:
        extra = ""
        if binding.shape is not None:
            extra = f" source shape: {json.dumps(binding.shape)}"
        lines.append(f"- {binding.id}: secretId={binding.secretId}{extra}")
    note = "\n".join(lines)
    if len(note) > MAX_CONTENT_CHARS:
        note = note[: MAX_CONTENT_CHARS - 1]
    return note


def _dump_model(model: BaseModel) -> dict[str, Any]:
    try:
        return model.model_dump()
    except AttributeError:  # Pydantic 1 compatibility
        return model.dict()


def _parse_model_response(payload: dict[str, Any]) -> dict[str, Any]:
    """Validate and normalize model JSON into the public contract shape."""

    if not isinstance(payload, dict) or not isinstance(payload.get("done"), bool):
        raise ValueError("model returned invalid wizard JSON")

    if payload["done"] is False:
        if "research" in payload:
            try:
                try:
                    parsed = ResearchResponse.model_validate(payload)
                except AttributeError:  # Pydantic 1 compatibility
                    parsed = ResearchResponse.parse_obj(payload)
            except ValidationError as exc:
                raise ValueError("model returned an invalid research request") from exc
            if not parsed.research.queries and not parsed.research.urls:
                raise ValueError("model returned an empty research request")
            return {"done": False, "research": parsed.research}
        if "plan" in payload:
            try:
                parsed = PlanResponse.model_validate(payload)
            except AttributeError:  # Pydantic 1 compatibility
                parsed = PlanResponse.parse_obj(payload)
            except ValidationError as exc:
                raise ValueError("model returned an invalid plan") from exc
            return {"done": False, "plan": parsed.plan}
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


def _extract_first_json_object(text: str) -> dict[str, Any] | None:
    """Return the first balanced JSON object found in prose, or None."""

    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        char = text[i]
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
        else:
            if char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    try:
                        parsed = json.loads(text[start:i + 1])
                    except json.JSONDecodeError:
                        return None
                    return parsed if isinstance(parsed, dict) else None
    return None


def _extract_json_content(response_json: dict[str, Any]) -> dict[str, Any]:
    """Extract the object from a non-streaming Chat Completions response."""

    try:
        choice = response_json["choices"][0]
        message = choice["message"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError("DeepSeek returned no assistant content") from exc

    content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        # Reasoning models may leave the final answer in reasoning_content.
        content = message.get("reasoning_content")
    if not isinstance(content, str) or not content.strip():
        if choice.get("finish_reason") == "length":
            raise ValueError(
                "DeepSeek response was truncated (finish_reason=length) "
                "before it produced complete JSON"
            )
        raise ValueError("DeepSeek returned no assistant content")

    text = content.strip()
    if "```" in text:
        start = text.find("```")
        end = text.rfind("```")
        if start != -1 and end > start:
            inner = text[start + 3:end].strip()
            if inner.lower().startswith("json"):
                inner = inner[4:].lstrip()
            text = inner

    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = _extract_first_json_object(text)
        if parsed is None:
            if choice.get("finish_reason") == "length":
                raise ValueError(
                    "DeepSeek response was truncated (finish_reason=length) "
                    "before it produced complete JSON"
                )
            raise ValueError("DeepSeek returned invalid JSON")
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


def _build_deepseek_body(messages: list[Message]) -> dict[str, Any]:
    """Assemble the system prompt and transcript for one DeepSeek request."""

    system = build_system_prompt(
        SYSTEM_PROMPT,
        load_skill_body(WIZARD_FLOW_SKILL),
        load_skill_body(WIDGET_EXAMPLES_SKILL),
    )
    return {
        "model": os.getenv("WIZARD_LLM_MODEL", DEEPSEEK_MODEL),
        "messages": [
            {"role": "system", "content": system},
            *[{"role": item.role, "content": item.content} for item in messages],
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
        "max_tokens": MAX_OUTPUT_TOKENS,
        "stream": False,
    }


async def _request_parsed_once(
    messages: list[Message], api_key: str
) -> dict[str, Any]:
    """One wizard turn with transport retries, then parse/normalize.

    Raises ValueError when the HTTP body is not a valid wizard response;
    raises HTTPException for transport or HTTP failures.
    """

    body = _build_deepseek_body(messages)
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
            return _parse_model_response(_extract_json_content(response_json))

        if attempt < MAX_DEEPSEEK_ATTEMPTS - 1:
            await asyncio.sleep(RETRY_BACKOFF_SECONDS)

    raise HTTPException(status_code=500, detail=f"DeepSeek request failed ({last_cause})")


async def call_deepseek(messages: list[Message], api_key: str) -> dict[str, Any]:
    """Make a bounded DeepSeek request for a wizard turn.

    Transient transport errors are retried once, and a response that fails to
    parse or validate is retried once with the concrete error fed back to the
    model so it can self-correct.
    """

    current = list(messages)
    last_parse_error = "unknown"
    for repair in range(MAX_REPAIR_ATTEMPTS + 1):
        try:
            return await _request_parsed_once(current, api_key)
        except ValueError as exc:
            last_parse_error = str(exc)
        if repair < MAX_REPAIR_ATTEMPTS:
            current = current + [
                Message(
                    role="user",
                    content=(
                        "Your previous response was rejected: "
                        + last_parse_error
                        + " Reply with corrected JSON only."
                    ),
                )
            ]
    raise HTTPException(status_code=500, detail=last_parse_error)


def _missing_secret_requests(
    plan: PlanPayload, bindings: dict[str, SecretBinding]
) -> list[dict[str, Any]]:
    missing: list[dict[str, Any]] = []
    for source in plan.sources:
        if source.auth is not None and source.id not in bindings:
            missing.append(
                {
                    "id": source.id,
                    "source": _dump_model(
                        SourceSpec(
                            method=source.method,
                            url=source.url,
                            query=source.query,
                            headers=source.headers,
                            body=source.body,
                        )
                    ),
                    "auth": _dump_model(source.auth),
                }
            )
    return missing


async def _process_plan(
    messages: list[Message],
    bindings: dict[str, SecretBinding],
    plan: PlanPayload,
    api_key: str,
) -> dict[str, Any]:
    missing = _missing_secret_requests(plan, bindings)
    if missing:
        return {
            "done": False,
            "questions": [plan.proposal],
            "secretRequests": missing,
        }

    notes = [
        "The plan is approved. Here is the verified source information.",
        "Return done:true with the final manifest and bundle now.",
        "Write each external source exactly as planned. For authenticated "
        "sources, set external.auth.secret to the secretId below (verbatim); "
        "never invent a secretId.",
    ]
    for source in plan.sources:
        if source.auth is not None:
            binding = bindings[source.id]
            notes.append(
                f"Source '{source.id}': auth {source.auth.type} name={source.auth.name}; "
                f"secretId={binding.secretId}."
            )
            if binding.shape is not None:
                notes.append(f"Source '{source.id}' shape: {json.dumps(binding.shape)}")
        else:
            spec = SourceSpec(
                method=source.method,
                url=source.url,
                query=source.query,
                headers=source.headers,
                body=source.body,
            )
            t_source = time.perf_counter()
            try:
                shape = await test_source(spec)
            except SourceBlockedError as exc:
                raise HTTPException(
                    status_code=400, detail="source blocked by SSRF rules"
                ) from exc
            except SourceTestError as exc:
                raise HTTPException(
                    status_code=500, detail=f"source test failed: {exc}"
                ) from exc
            _log_wizard(
                f"plan source test '{source.id}' {source.url} "
                f"took {time.perf_counter() - t_source:.1f}s"
            )
            notes.append(f"Source '{source.id}' shape: {json.dumps(shape)}")

    content = "\n".join(notes)
    if len(content) > MAX_CONTENT_CHARS:
        content = content[:MAX_CONTENT_CHARS - 1]
    final_messages = list(messages) + [Message(role="user", content=content)]
    return await call_deepseek(final_messages, api_key)


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
    serper_key = os.getenv("SERPER_API_KEY", "").strip()
    t0 = time.perf_counter()
    # On a follow-up turn the client sends the verified secret bindings. Feed
    # them to the model so it can write the right secretId even when it goes
    # straight to done:true (which skips the plan re-prompt in _process_plan).
    messages = list(request.messages)
    if request.secrets:
        messages.append(Message(role="user", content=_secret_bindings_note(request)))
    bindings = {binding.id: binding for binding in request.secrets}
    result = await call_deepseek(messages, api_key)
    _log_wizard(
        f"call_deepseek #1 took {time.perf_counter() - t0:.1f}s "
        f"(done={result.get('done')}, plan={'plan' in result}, "
        f"research={'research' in result})"
    )
    # When the model wants to look up a third-party API's documentation, run the
    # bounded search/fetch and feed the results back so it never guesses an
    # endpoint, parameter, or auth scheme.
    for round_index in range(MAX_RESEARCH_ROUNDS):
        if not (result["done"] is False and "research" in result):
            break
        t_research = time.perf_counter()
        note = await research.run_research(
            result["research"].queries,
            result["research"].urls,
            serper_key,
        )
        _log_wizard(
            f"research round {round_index + 1} took "
            f"{time.perf_counter() - t_research:.1f}s"
        )
        messages.append(Message(role="user", content=note))
        result = await call_deepseek(messages, api_key)
    if result["done"] is False and "plan" in result:
        result = await _process_plan(messages, bindings, result["plan"], api_key)
        _log_wizard(
            f"_process_plan took {time.perf_counter() - t0:.1f}s "
            f"(done={result.get('done')})"
        )
    if result["done"] is False:
        return result

    t_sources = time.perf_counter()
    try:
        await test_candidate_sources(result["manifest"])
    except SourceBlockedError as exc:
        raise HTTPException(status_code=400, detail="source blocked by SSRF rules") from exc
    except SourceTestError as exc:
        raise HTTPException(status_code=500, detail=f"source test failed: {exc}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    _log_wizard(f"test_candidate_sources took {time.perf_counter() - t_sources:.1f}s")

    t_publish = time.perf_counter()
    try:
        await publish_widget(
            result["manifest"],
            result["bundle"],
            server_url=os.getenv("SERVER_URL", "http://localhost:8000"),
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    _log_wizard(f"publish_widget took {time.perf_counter() - t_publish:.1f}s")
    _log_wizard(f"TURN TOTAL {time.perf_counter() - t0:.1f}s")

    return {
        "done": True,
        "widgetId": result["widgetId"],
        "version": result["version"],
        "manifest": result["manifest"],
    }
