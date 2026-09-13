import os

import pytest
from fastapi.testclient import TestClient

from agent.app import main
from agent.app.source_test import SourceBlockedError


client = TestClient(main.app)


def test_browser_can_preflight_wizard():
    response = client.options("/wizard/generate", headers={
        "Origin": "http://localhost:5173", "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
    })
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_model_receives_schema_and_sdk_contract(monkeypatch):
    import asyncio
    import httpx
    original = httpx.AsyncClient
    def handler(request):
        import json
        body = json.loads(request.content)
        prompt = body["messages"][0]["content"]
        assert "config.channelRoutes" in prompt or "channelRoutes" in prompt
        assert '"$schema"' in prompt
        assert "cameraGranted" in prompt
        assert "center:[lat,lng]" in prompt
        # SDK contract must match the real SDK payloads (SPEC.md section 7).
        assert "markerClick({markerId})" in prompt
        assert "mapClick({lat,lng})" in prompt
        assert "bearing?" in prompt
        assert "error({id,error})" in prompt
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"done":false,"questions":["Which source?"]}'}}]})
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    result = asyncio.run(main.call_deepseek([main.Message(role="user", content="Make a widget")], "test-key"))
    assert result["done"] is False


def test_model_receives_wizard_flow_skill(monkeypatch):
    import asyncio
    import httpx
    original = httpx.AsyncClient
    def handler(request):
        import json
        body = json.loads(request.content)
        prompt = body["messages"][0]["content"]
        assert "Reasonable clarification test" in prompt
        assert "Point of no return" in prompt
        assert "Work conversationally" not in prompt
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"done":false,"questions":["Which source?"]}'}}]})
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    result = asyncio.run(main.call_deepseek([main.Message(role="user", content="Make a widget")], "test-key"))
    assert result["done"] is False


def test_call_deepseek_retries_transient_error_then_succeeds(monkeypatch):
    import asyncio
    import httpx
    calls = []

    async def fake_request(client, api_key, body):
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ReadError("connection reset")
        return {"choices": [{"message": {"content": '{"done":false,"questions":["Which source?"]}'}}]}

    monkeypatch.setattr(main, "_request_deepseek_json", fake_request)
    monkeypatch.setattr(main, "RETRY_BACKOFF_SECONDS", 0)
    result = asyncio.run(main.call_deepseek([main.Message(role="user", content="Make a widget")], "test-key"))
    assert result["done"] is False
    assert len(calls) == 2


def test_call_deepseek_surfaces_transient_cause_after_retries(monkeypatch):
    import asyncio
    import httpx
    from fastapi import HTTPException

    async def always_fail(client, api_key, body):
        raise httpx.ReadError("connection reset")

    monkeypatch.setattr(main, "_request_deepseek_json", always_fail)
    monkeypatch.setattr(main, "RETRY_BACKOFF_SECONDS", 0)
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(main.call_deepseek([main.Message(role="user", content="Make a widget")], "test-key"))
    assert exc_info.value.status_code == 500
    assert "ReadError" in exc_info.value.detail


def test_call_deepseek_does_not_retry_non_retryable_status(monkeypatch):
    import asyncio
    import httpx
    from fastapi import HTTPException
    calls = []

    async def fake_request(client, api_key, body):
        calls.append(1)
        raise httpx.HTTPStatusError(
            "unauthorized",
            request=httpx.Request("POST", "https://api.deepseek.com/chat/completions"),
            response=httpx.Response(401),
        )

    monkeypatch.setattr(main, "_request_deepseek_json", fake_request)
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(main.call_deepseek([main.Message(role="user", content="Make a widget")], "test-key"))
    assert "401" in exc_info.value.detail
    assert len(calls) == 1


def test_rejects_empty_messages():
    response = client.post("/wizard/generate", json={"messages": []})
    assert response.status_code == 400
    assert response.json() == {"error": "invalid wizard request"}


def test_rejects_transcript_that_starts_with_assistant(monkeypatch):
    monkeypatch.setenv("WIZARD_LLM_API_KEY", "test-key")
    response = client.post(
        "/wizard/generate",
        json={"messages": [{"role": "assistant", "content": "Question?"}]},
    )
    assert response.status_code == 400
    assert response.json() == {
        "error": "the first wizard message must have role user"
    }


def test_missing_key_returns_actionable_error(monkeypatch):
    monkeypatch.delenv("WIZARD_LLM_API_KEY", raising=False)
    response = client.post(
        "/wizard/generate",
        json={"messages": [{"role": "user", "content": "Make a map widget."}]},
    )
    assert response.status_code == 500
    assert response.json() == {
        "error": "DeepSeek API key is not configured. Add your DeepSeek API key to get started."
    }


def test_model_clarifying_response_is_normalized():
    assert main._parse_model_response(
        {"done": False, "questions": ["  Which data source should I use?  "]}
    ) == {"done": False, "questions": ["Which data source should I use?"]}


def test_model_rejects_multiple_questions():
    with pytest.raises(ValueError, match="clarifying response"):
        main._parse_model_response(
            {"done": False, "questions": ["One?", "Two?"]}
        )


def test_truncated_model_response_reports_length_not_invalid_json():
    with pytest.raises(ValueError, match="truncated"):
        main._extract_json_content(
            {"choices": [{"finish_reason": "length", "message": {"content": ""}}]}
        )


def test_invalid_model_json_reports_invalid_json():
    with pytest.raises(ValueError, match="invalid JSON"):
        main._extract_json_content(
            {"choices": [{"finish_reason": "stop", "message": {"content": "{not json"}}]}
        )


def test_done_response_publishes_then_hides_bundle(monkeypatch):
    manifest = {
        "id": "demo-widget",
        "name": "Demo Widget",
        "version": "0.1.0",
        "description": "A small demo widget",
        "server": {
            "channels": [
                {
                    "id": "demo",
                    "origin": "client",
                    "direction": "write",
                    "visibility": "public",
                }
            ]
        },
    }

    async def fake_model(messages, api_key):
        return {
            "done": True,
            "widgetId": "demo-widget",
            "version": "0.1.0",
            "manifest": manifest,
            "bundle": "anymaps.ready().then(() => {});",
        }

    async def fake_sources(manifest):
        return []

    async def fake_publish(manifest, bundle, *, server_url):
        assert bundle.startswith("anymaps")
        return {"id": "demo-widget", "version": "0.1.0"}

    monkeypatch.setenv("WIZARD_LLM_API_KEY", "test-key")
    monkeypatch.setattr(main, "call_deepseek", fake_model)
    monkeypatch.setattr(main, "test_candidate_sources", fake_sources)
    monkeypatch.setattr(main, "publish_widget", fake_publish)

    response = client.post(
        "/wizard/generate",
        json={"messages": [{"role": "user", "content": "Make a demo widget."}]},
    )
    assert response.status_code == 200
    assert response.json() == {
        "done": True,
        "widgetId": "demo-widget",
        "version": "0.1.0",
        "manifest": manifest,
    }


def test_blocked_candidate_source_is_contract_400(monkeypatch):
    async def fake_model(messages, api_key):
        return {
            "done": True,
            "widgetId": "demo-widget",
            "version": "0.1.0",
            "manifest": {},
            "bundle": "bundle",
        }

    async def blocked_sources(manifest):
        raise SourceBlockedError("source blocked by SSRF rules")

    monkeypatch.setenv("WIZARD_LLM_API_KEY", "test-key")
    monkeypatch.setattr(main, "call_deepseek", fake_model)
    monkeypatch.setattr(main, "test_candidate_sources", blocked_sources)
    response = client.post(
        "/wizard/generate",
        json={"messages": [{"role": "user", "content": "Make a widget."}]},
    )
    assert response.status_code == 400
    assert response.json() == {"error": "source blocked by SSRF rules"}


def test_wizard_secret_verifies_then_stores_without_llm(monkeypatch):
    seen = {}

    async def fake_test(source):
        seen["source"] = source
        return {"ok": True}

    async def fake_store(value, *, server_url):
        seen["value"] = value
        return "secret-id"

    monkeypatch.setattr(main, "test_source", fake_test)
    monkeypatch.setattr(main, "store_secret", fake_store)
    response = client.post(
        "/wizard/secrets",
        json={
            "value": "secret-value",
            "source": {"url": "https://api.example.com/data"},
            "auth": {"type": "header", "name": "X-API-Key"},
        },
    )
    assert response.status_code == 201
    assert response.json()["secretId"] == "secret-id"
    assert seen["value"] == "secret-value"
    assert seen["source"].headers == {"X-API-Key": "secret-value"}


def test_parse_model_response_accepts_plan():
    payload = {
        "done": False,
        "plan": {
            "proposal": "Approve publishing weather widget?",
            "sources": [
                {
                    "id": "noaa-token",
                    "method": "GET",
                    "url": "https://www.ncei.noaa.gov/cdo-web/api/v2/stations",
                    "query": {},
                    "headers": {},
                    "auth": {"type": "header", "name": "token", "scheme": ""},
                }
            ],
        },
    }
    result = main._parse_model_response(payload)
    assert result["done"] is False
    assert result["plan"].proposal == "Approve publishing weather widget?"
    assert result["plan"].sources[0].id == "noaa-token"
    assert result["plan"].sources[0].auth.type == "header"


def test_wizard_request_accepts_secrets():
    request = main.WizardRequest.model_validate(
        {
            "messages": [{"role": "user", "content": "weather"}],
            "secrets": [{"id": "noaa-token", "secretId": "abc123", "shape": {"ok": True}}],
        }
    )
    assert request.secrets[0].id == "noaa-token"
    assert request.secrets[0].secretId == "abc123"


def test_wizard_secret_returns_shape(monkeypatch):
    seen = {}

    async def fake_test(source):
        seen["source"] = source
        return {"ok": True, "top_level_type": "object", "arrays": []}

    async def fake_store(value, *, server_url):
        seen["value"] = value
        return "secret-id"

    monkeypatch.setattr(main, "test_source", fake_test)
    monkeypatch.setattr(main, "store_secret", fake_store)
    response = client.post(
        "/wizard/secrets",
        json={
            "value": "secret-value",
            "source": {"url": "https://api.example.com/data"},
            "auth": {"type": "header", "name": "X-API-Key"},
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["secretId"] == "secret-id"
    assert body["shape"] == {"ok": True, "top_level_type": "object", "arrays": []}
    assert "secret-value" not in body


def test_wizard_secret_does_not_store_blocked_source(monkeypatch):
    async def blocked(source):
        raise SourceBlockedError("source blocked by SSRF rules")

    async def should_not_store(value, *, server_url):
        raise AssertionError("must not store an unverified secret")

    monkeypatch.setattr(main, "test_source", blocked)
    monkeypatch.setattr(main, "store_secret", should_not_store)
    response = client.post(
        "/wizard/secrets",
        json={
            "value": "secret-value",
            "source": {"url": "https://api.example.com/data"},
            "auth": {"type": "query", "name": "key"},
        },
    )
    assert response.status_code == 400
    assert response.json() == {"error": "source blocked by SSRF rules"}


@pytest.mark.skipif(
    not os.getenv("RUN_LIVE_DEEPSEEK_TEST"),
    reason="set RUN_LIVE_DEEPSEEK_TEST=1 to spend one live DeepSeek request",
)
def test_live_deepseek_smoke():
    """One opt-in live request verifies the configured model and JSON mode."""

    response = client.post(
        "/wizard/generate",
        json={
            "messages": [
                {
                    "role": "user",
                    "content": "I want a map widget showing public drinking water fountains in NYC.",
                }
            ]
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["done"] is False
    assert len(body["questions"]) == 1


def test_extract_json_strips_prose_and_fence():
    content = (
        "Sure, here is the JSON:\n"
        "```json\n{\"done\": false, \"questions\": [\"Which source?\"]}\n```"
    )
    result = main._extract_json_content(
        {"choices": [{"finish_reason": "stop", "message": {"content": content}}]}
    )
    assert result == {"done": False, "questions": ["Which source?"]}


def test_extract_json_reads_reasoning_content_fallback():
    result = main._extract_json_content(
        {
            "choices": [
                {
                    "finish_reason": "stop",
                    "message": {
                        "content": "",
                        "reasoning_content": '{"done":false,"questions":["q"]}',
                    },
                }
            ]
        }
    )
    assert result == {"done": False, "questions": ["q"]}


def test_parse_model_response_ignores_extra_keys():
    payload = {"done": False, "questions": ["Which source?"], "note": "extra"}
    assert main._parse_model_response(payload) == {
        "done": False,
        "questions": ["Which source?"],
    }


def test_model_receives_widget_examples(monkeypatch):
    import asyncio
    import httpx
    original = httpx.AsyncClient
    def handler(request):
        import json
        prompt = json.loads(request.content)["messages"][0]["content"]
        assert "water-fountains-nyc" in prompt
        assert "anymaps.ready()" in prompt
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"done":false,"questions":["Which source?"]}'}}]})
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    result = asyncio.run(main.call_deepseek([main.Message(role="user", content="Make a widget")], "test-key"))
    assert result["done"] is False


def test_model_id_reads_env_override(monkeypatch):
    import asyncio
    import httpx
    original = httpx.AsyncClient
    seen = {}
    def handler(request):
        import json
        seen["model"] = json.loads(request.content)["model"]
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"done":false,"questions":["Which source?"]}'}}]})
    monkeypatch.setenv("WIZARD_LLM_MODEL", "deepseek-test")
    monkeypatch.setattr(main.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs))
    asyncio.run(main.call_deepseek([main.Message(role="user", content="Make a widget")], "test-key"))
    assert seen["model"] == "deepseek-test"


def test_call_deepseek_repairs_invalid_json_once(monkeypatch):
    import asyncio
    calls = []

    async def fake_request(client, api_key, body):
        calls.append(body)
        if len(calls) == 1:
            return {"choices": [{"finish_reason": "stop", "message": {"content": "{not json"}}]}
        return {"choices": [{"message": {"content": '{"done":false,"questions":["Which source?"]}'}}]}

    monkeypatch.setattr(main, "_request_deepseek_json", fake_request)
    monkeypatch.setattr(main, "RETRY_BACKOFF_SECONDS", 0)
    result = asyncio.run(main.call_deepseek([main.Message(role="user", content="Make a widget")], "test-key"))
    assert result["done"] is False
    assert len(calls) == 2
    assert "rejected" in calls[1]["messages"][-1]["content"]


def test_call_deepseek_surfaces_parse_error_after_repair(monkeypatch):
    import asyncio
    from fastapi import HTTPException
    calls = []

    async def always_bad(client, api_key, body):
        calls.append(1)
        return {"choices": [{"finish_reason": "stop", "message": {"content": "{not json"}}]}

    monkeypatch.setattr(main, "_request_deepseek_json", always_bad)
    monkeypatch.setattr(main, "RETRY_BACKOFF_SECONDS", 0)
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(main.call_deepseek([main.Message(role="user", content="Make a widget")], "test-key"))
    assert "invalid JSON" in exc_info.value.detail
    assert len(calls) == 2


def _plan_model():
    return main.PlanResponse.model_validate(
        {
            "done": False,
            "plan": {
                "proposal": "Approve weather widget?",
                "sources": [
                    {
                        "id": "noaa-token",
                        "method": "GET",
                        "url": "https://www.ncei.noaa.gov/cdo-web/api/v2/stations",
                        "query": {},
                        "headers": {},
                        "auth": {"type": "header", "name": "token", "scheme": ""},
                    }
                ],
            },
        }
    ).plan


def test_plan_with_missing_secret_returns_secret_requests(monkeypatch):
    async def fake_model(messages, api_key):
        return {"done": False, "plan": _plan_model()}

    async def fake_publish(manifest, bundle, *, server_url):
        raise AssertionError("must not publish while a secret is missing")

    monkeypatch.setenv("WIZARD_LLM_API_KEY", "test-key")
    monkeypatch.setattr(main, "call_deepseek", fake_model)
    monkeypatch.setattr(main, "publish_widget", fake_publish)
    response = client.post(
        "/wizard/generate",
        json={"messages": [{"role": "user", "content": "NOAA stations in NY"}]},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["done"] is False
    assert body["questions"] == ["Approve weather widget?"]
    assert body["secretRequests"][0]["id"] == "noaa-token"
    assert body["secretRequests"][0]["auth"] == {"type": "header", "name": "token", "scheme": ""}


def test_plan_with_secret_finalizes_and_publishes(monkeypatch):
    calls = []
    manifest = {
        "id": "ny-weather",
        "name": "NY Weather",
        "version": "1.0.0",
        "description": "NY weather",
        "server": {
            "channels": [
                {
                    "id": "noaa",
                    "origin": "external",
                    "direction": "read",
                    "visibility": "public",
                    "external": {
                        "method": "GET",
                        "url": "https://www.ncei.noaa.gov/cdo-web/api/v2/stations",
                        "auth": {"type": "header", "name": "token", "secret": "abc123"},
                    },
                }
            ]
        },
    }

    async def fake_model(messages, api_key):
        calls.append(messages)
        if len(calls) == 1:
            return {"done": False, "plan": _plan_model()}
        return {"done": True, "widgetId": "ny-weather", "version": "1.0.0",
                "manifest": manifest, "bundle": "anymaps.ready().then(() => {});"}

    async def fake_sources(manifest_arg):
        return []

    async def fake_publish(manifest_arg, bundle, *, server_url):
        assert manifest_arg["server"]["channels"][0]["external"]["auth"]["secret"] == "abc123"
        return {"id": "ny-weather", "version": "1.0.0"}

    monkeypatch.setenv("WIZARD_LLM_API_KEY", "test-key")
    monkeypatch.setattr(main, "call_deepseek", fake_model)
    monkeypatch.setattr(main, "test_candidate_sources", fake_sources)
    monkeypatch.setattr(main, "publish_widget", fake_publish)
    response = client.post(
        "/wizard/generate",
        json={
            "messages": [{"role": "user", "content": "NOAA stations in NY"}],
            "secrets": [{"id": "noaa-token", "secretId": "abc123", "shape": {"ok": True}}],
        },
    )
    assert response.status_code == 200
    assert response.json()["done"] is True
    assert len(calls) == 2
    final_note = calls[1][-1].content
    assert "abc123" in final_note


def test_followup_turn_secret_reaches_model_before_build(monkeypatch):
    """The real two-turn flow: turn 1 returns secretRequests, turn 2 sends
    the verified bindings and the model emits done:true directly. The
    secretId must still reach the model so it can write external.auth.secret.
    """

    calls = []
    manifest = {
        "id": "ny-weather",
        "name": "NY Weather",
        "version": "1.0.0",
        "description": "NY weather",
        "server": {
            "channels": [
                {
                    "id": "noaa",
                    "origin": "external",
                    "direction": "read",
                    "visibility": "public",
                    "external": {
                        "method": "GET",
                        "url": "https://www.ncei.noaa.gov/cdo-web/api/v2/stations",
                        "auth": {"type": "header", "name": "token", "secret": "abc123"},
                    },
                }
            ]
        },
    }

    async def fake_model(messages, api_key):
        calls.append(messages)
        return {
            "done": True,
            "widgetId": "ny-weather",
            "version": "1.0.0",
            "manifest": manifest,
            "bundle": "anymaps.ready().then(() => {});",
        }

    async def fake_sources(manifest_arg):
        return []

    async def fake_publish(manifest_arg, bundle, *, server_url):
        return {"id": "ny-weather", "version": "1.0.0"}

    monkeypatch.setenv("WIZARD_LLM_API_KEY", "test-key")
    monkeypatch.setattr(main, "call_deepseek", fake_model)
    monkeypatch.setattr(main, "test_candidate_sources", fake_sources)
    monkeypatch.setattr(main, "publish_widget", fake_publish)

    response = client.post(
        "/wizard/generate",
        json={
            "messages": [
                {"role": "user", "content": "NOAA stations in NY"},
                {"role": "assistant", "content": "Approve publishing weather widget?"},
                {"role": "user", "content": "I've provided the key(s). Proceed."},
            ],
            "secrets": [
                {"id": "noaa-token", "secretId": "abc123", "shape": {"ok": True}}
            ],
        },
    )
    assert response.status_code == 200
    assert response.json()["done"] is True
    # The model must have been told the verified secretId before building.
    assert any("abc123" in message.content for message in calls[0])


def test_raw_key_never_reaches_llm_or_manifest(monkeypatch):
    llm_bodies = []

    async def fake_model(messages, api_key):
        llm_bodies.append(messages)
        if len(llm_bodies) == 1:
            return {"done": False, "plan": _plan_model()}
        return {
            "done": True,
            "widgetId": "ny-weather",
            "version": "1.0.0",
            "manifest": {
                "id": "ny-weather",
                "name": "NY Weather",
                "version": "1.0.0",
                "description": "NY weather",
                "server": {
                    "channels": [
                        {
                            "id": "noaa",
                            "origin": "external",
                            "direction": "read",
                            "visibility": "public",
                            "external": {
                                "method": "GET",
                                "url": "https://www.ncei.noaa.gov/cdo-web/api/v2/stations",
                                "auth": {"type": "header", "name": "token", "secret": "abc123"},
                            },
                        }
                    ]
                },
            },
            "bundle": "anymaps.ready().then(() => {});",
        }

    async def fake_sources(manifest):
        return []

    async def fake_publish(manifest, bundle, *, server_url):
        return {"id": "ny-weather", "version": "1.0.0"}

    monkeypatch.setenv("WIZARD_LLM_API_KEY", "test-key")
    monkeypatch.setattr(main, "call_deepseek", fake_model)
    monkeypatch.setattr(main, "test_candidate_sources", fake_sources)
    monkeypatch.setattr(main, "publish_widget", fake_publish)

    response = client.post(
        "/wizard/generate",
        json={
            "messages": [{"role": "user", "content": "NOAA stations in NY"}],
            "secrets": [{"id": "noaa-token", "secretId": "abc123", "shape": {"ok": True}}],
        },
    )
    assert response.status_code == 200
    for messages in llm_bodies:
        for message in messages:
            assert "secret-value" not in message.content
