import asyncio
import copy

import httpx
import pytest

from agent.app import generator


MANIFEST = {
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


def run(coro):
    return asyncio.run(coro)


def test_valid_candidate_requires_classic_bundle():
    candidate = generator.validate_candidate(
        {
            "done": True,
            "widgetId": "demo-widget",
            "version": "0.1.0",
            "manifest": MANIFEST,
            "bundle": "anymaps.ready().then(() => {});",
        }
    )
    assert candidate.done is True
    assert candidate.bundle == "anymaps.ready().then(() => {});"


def test_candidate_rejects_module_bundle():
    with pytest.raises(ValueError, match="classic script"):
        generator.validate_candidate(
            {
                "done": True,
                "widgetId": "demo-widget",
                "version": "0.1.0",
                "manifest": MANIFEST,
                "bundle": "export default {};",
            }
        )


def test_candidate_clarification_has_one_question():
    candidate = generator.validate_candidate(
        {"done": False, "questions": ["Which source should I use?"]}
    )
    assert candidate.done is False
    assert candidate.questions == ["Which source should I use?"]


def test_authenticated_source_keeps_secret_id_in_manifest_path():
    manifest = {
        **MANIFEST,
        "server": {
            "channels": [
                {
                    "id": "external",
                    "origin": "external",
                    "direction": "read",
                    "visibility": "public",
                    "external": {
                        "url": "https://api.example.com/data",
                        "auth": {
                            "type": "header",
                            "name": "Authorization",
                            "secret": "secret-id",
                        },
                    },
                }
            ]
        },
    }
    sources = generator.external_sources(manifest)
    assert len(sources) == 1
    assert sources[0].url == "https://api.example.com/data"

    results = run(generator.test_candidate_sources(manifest))
    assert results == [{"ok": True, "authenticated": True, "verified": "prior"}]


def test_publish_uses_server_contract():
    def handler(request):
        assert request.method == "POST"
        assert request.url.path == "/widgets"
        body = request.read()
        assert b"demo-widget" in body
        return httpx.Response(201, json={"id": "demo-widget", "version": "0.1.0"})

    result = run(
        generator.publish_widget(
            MANIFEST,
            "anymaps.ready().then(() => {});",
            server_url="https://server.example",
            transport=httpx.MockTransport(handler),
        )
    )
    assert result == {"id": "demo-widget", "version": "0.1.0"}


def test_publish_conflict_is_a_failure():
    transport = httpx.MockTransport(
        lambda request: httpx.Response(409, json={"error": "already exists"})
    )
    with pytest.raises(RuntimeError, match="already published"):
        run(
            generator.publish_widget(
                MANIFEST,
                "bundle",
                server_url="https://server.example",
                transport=transport,
            )
        )


def test_store_secret_uses_existing_server_route():
    def handler(request):
        assert request.method == "POST"
        assert request.url.path == "/secrets"
        assert request.read() == b'{"value":"secret-value"}'
        return httpx.Response(201, json={"secretId": "secret-id"})

    result = run(
        generator.store_secret(
            "secret-value",
            server_url="https://server.example",
            transport=httpx.MockTransport(handler),
        )
    )
    assert result == "secret-id"


@pytest.mark.parametrize("case", ["duplicate", "missing-source", "visibility"])
def test_candidate_enforces_server_channel_matrix(case):
    manifest = copy.deepcopy(MANIFEST)
    write = manifest["server"]["channels"][0]
    read = {"id": "reader", "origin": "client", "direction": "read", "visibility": "public", "source": write["id"]}
    manifest["server"]["channels"].append(read)
    if case == "duplicate":
        read["id"] = write["id"]
    elif case == "missing-source":
        read["source"] = "missing"
    else:
        read["visibility"] = "private"
    with pytest.raises(ValueError, match="manifest is invalid"):
        generator.validate_candidate(dict(done=True, widgetId=manifest["id"], version=manifest["version"], manifest=manifest, bundle="anymaps.ready();"))


def test_source_limit_is_enforced_before_fetching():
    manifest = {"server": {"channels": [
        {"origin": "external", "external": {"url": "https://example.com"}}
        for _ in range(generator.MAX_EXTERNAL_SOURCES + 1)
    ]}}
    with pytest.raises(ValueError, match="too many"):
        run(generator.test_candidate_sources(manifest))


def test_candidate_ignores_unknown_fields():
    candidate = generator.validate_candidate(
        {
            "done": True,
            "widgetId": "demo-widget",
            "version": "0.1.0",
            "manifest": MANIFEST,
            "bundle": "anymaps.ready().then(() => {});",
            "summary": "a demo widget",
        }
    )
    assert candidate.done is True
    assert candidate.bundle == "anymaps.ready().then(() => {});"
