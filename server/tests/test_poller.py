import asyncio
import json

import httpx
import pytest

from server.app.db import connect
from server.app.poller import Poller
from server.tests.conftest import FLIGHTS_MANIFEST

CHANNEL = FLIGHTS_MANIFEST["server"]["channels"][0]


def test_fetch_once_stores_series_records(tmp_path):
    db = connect(str(tmp_path / "t.db"))
    poller = Poller(db)

    def handler(request):
        return httpx.Response(200, json={"ac": [{"hex": "abc", "lat": 40.7, "lon": -74.0}]})

    async def run():
        poller.client = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)
        await poller._fetch_once("flights-nyc", CHANNEL)
        await poller.client.aclose()

    asyncio.run(run())
    rows = db.execute(
        "SELECT payload, id_key, ingested_at FROM records WHERE widget_id='flights-nyc' AND channel_id='flights_nyc'"
    ).fetchall()
    assert len(rows) == 1
    assert rows[0]["id_key"] == "abc"
    assert rows[0]["ingested_at"] is not None
    db.close()


def test_request_rejects_non_https(tmp_path):
    db = connect(str(tmp_path / "t.db"))
    poller = Poller(db)
    ext = {"method": "GET", "url": "http://example.com/x"}
    with pytest.raises(ValueError, match="https"):
        asyncio.run(poller._request(ext))
    db.close()


def test_request_applies_header_auth(tmp_path):
    db = connect(str(tmp_path / "t.db"))
    db.execute("INSERT INTO secrets (secret_id, value, created_at) VALUES ('k', 'tok', 1.0)")
    db.commit()
    poller = Poller(db)
    seen = {}

    def handler(request):
        seen["auth"] = request.headers.get("Authorization")
        return httpx.Response(200, json={})

    async def run():
        poller.client = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)
        ext = {
            "method": "GET",
            "url": "https://example.com/x",
            "auth": {"type": "header", "name": "Authorization", "scheme": "Bearer ", "secret": "k"},
        }
        await poller._request(ext)
        await poller.client.aclose()

    asyncio.run(run())
    assert seen["auth"] == "Bearer tok"
    db.close()


def test_request_resolves_relative_redirect(tmp_path):
    db = connect(str(tmp_path / "t.db"))
    poller = Poller(db)
    urls = []

    def handler(request):
        urls.append(str(request.url))
        if len(urls) == 1:
            return httpx.Response(302, headers={"location": "/data.json"})
        return httpx.Response(200, json={"ok": 1})

    async def run():
        poller.client = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)
        result = await poller._request({"url": "https://example.com/x"})
        await poller.client.aclose()
        return result

    result = asyncio.run(run())
    assert result == {"ok": 1}
    assert urls[1] == "https://example.com/data.json"
    db.close()


def test_request_strips_auth_on_cross_origin_redirect(tmp_path):
    db = connect(str(tmp_path / "t.db"))
    db.execute("INSERT INTO secrets (secret_id, value, created_at) VALUES ('k', 'tok', 1.0)")
    db.commit()
    poller = Poller(db)
    seen = []

    def handler(request):
        seen.append(request.headers.get("Authorization"))
        if len(seen) == 1:
            return httpx.Response(302, headers={"location": "https://www.example.com/x"})
        return httpx.Response(200, json={})

    async def run():
        poller.client = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)
        ext = {
            "method": "GET",
            "url": "https://example.com/x",
            "auth": {"type": "header", "name": "Authorization", "scheme": "Bearer ", "secret": "k"},
        }
        await poller._request(ext)
        await poller.client.aclose()

    asyncio.run(run())
    assert seen[0] == "Bearer tok"
    assert seen[1] is None
    db.close()


def test_run_swallows_fetch_errors(tmp_path):
    db = connect(str(tmp_path / "t.db"))
    poller = Poller(db)
    channel = {
        "id": "c",
        "origin": "external",
        "direction": "read",
        "visibility": "public",
        "external": {"url": "https://example.com/x", "interval": 5},
    }
    calls = []

    async def boom(widget_id, channel):
        calls.append(1)
        raise ValueError("upstream down")

    poller._fetch_once = boom

    async def run_once():
        task = asyncio.create_task(poller._run("w", channel))
        await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(run_once())
    assert calls == [1]
    db.close()


def test_start_all_resumes_external_channels_on_startup(tmp_path):
    from fastapi.testclient import TestClient

    from server.app.main import create_app

    # Seed a provisioned external channel before the app starts.
    db = connect(str(tmp_path / "t.db"))
    channel = FLIGHTS_MANIFEST["server"]["channels"][0]
    db.execute(
        "INSERT INTO channels (widget_id, channel_id, config, provisioned_at) VALUES (?, ?, ?, ?)",
        ("flights-nyc", channel["id"], json.dumps(channel), 1.0),
    )
    db.commit()
    db.close()

    app = create_app(str(tmp_path / "t.db"))

    async def noop(widget_id, channel):
        return None

    app.state.poller._fetch_once = noop
    with TestClient(app):
        assert ("flights-nyc", "flights_nyc") in app.state.poller.tasks
