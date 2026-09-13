"""Section C assets against the real server; external feeds remain deterministic."""
import asyncio
import json
from pathlib import Path
from time import time

import httpx
import pytest
from fastapi.testclient import TestClient

from agent.app.generator import publish_widget, validate_candidate
from server.app.main import create_app
from server.app.poller import Poller

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def server(tmp_path, monkeypatch):
    monkeypatch.setattr(Poller, "start", lambda *args: None)
    with TestClient(create_app(str(tmp_path / "integration.db"))) as client:
        yield client


def asset(folder):
    root = ROOT / "widgets" / folder
    return json.loads((root / "manifest.json").read_text()), (root / "bundle.js").read_text(encoding="utf-8")


@pytest.mark.parametrize("folder", ["bathrooms", "flights", "friends"])
def test_publish_fetch_and_idempotent_provision(server, folder):
    manifest, bundle = asset(folder)
    validate_candidate(dict(done=True, widgetId=manifest["id"], version=manifest["version"], manifest=manifest, bundle=bundle))
    result = asyncio.run(publish_widget(manifest, bundle, server_url="http://testserver", transport=httpx.ASGITransport(app=server.app)))
    assert result == {"id": manifest["id"], "version": manifest["version"]}
    prefix = f'/widgets/{manifest["id"]}'
    assert server.get(f'{prefix}/versions/{manifest["version"]}/manifest').json() == manifest
    assert server.get(f'{prefix}/versions/{manifest["version"]}/bundle').text == bundle
    first = server.post(f"{prefix}/provision", json={"manifest": manifest})
    assert first.status_code == 200
    assert server.post(f"{prefix}/provision", json={"manifest": manifest}).json() == first.json()
    assert set(first.json()["channelRoutes"]) == {ch["id"] for ch in manifest["server"]["channels"]}


def test_friends_two_users_and_room_isolation(server):
    manifest, _ = asset("friends")
    prefix = f'/widgets/{manifest["id"]}'
    routes = server.post(f"{prefix}/provision", json={"manifest": manifest}).json()["channelRoutes"]
    room = server.post(f"{prefix}/instances").json()["instanceToken"]
    other = server.post(f"{prefix}/instances").json()["instanceToken"]
    for user in ("alice", "bob"):
        record = {"clientId": user, "name": user, "lat": 40.7, "lng": -74, "ts": time()}
        assert server.post(f'{routes["fmfW"]}/instances/{room}', json=record).status_code == 201
    result = server.get(f'{routes["fmfR"]}/instances/{room}?latest=1')
    assert {r["clientId"] for r in result.json()["records"]} == {"alice", "bob"}
    assert server.get(f'{routes["fmfR"]}/instances/{other}?latest=1').json() == {"records": []}
    assert server.get(routes["fmfR"]).status_code == 404


@pytest.mark.parametrize("folder,body,query", [
    ("bathrooms", {"elements": [{"id": 1, "lat": 40.7, "lon": -74, "tags": {"name": "Restroom"}}]}, "bounds=40.5,-74.3,40.9,-73.7"),
    ("flights", {"ac": [{"hex": "abc", "lat": 40.7, "lon": -74, "flight": "DEMO"}]}, "bounds=40.5,-74.3,40.9,-73.7&latest=1"),
])
def test_actual_feed_mappings_and_widget_queries(server, folder, body, query):
    manifest, _ = asset(folder)
    channel = manifest["server"]["channels"][0]
    routes = server.post(f'/widgets/{manifest["id"]}/provision', json={"manifest": manifest}).json()["channelRoutes"]

    async def ingest():
        poller = server.app.state.poller
        async def feed(_ext):
            return body
        poller._request = feed
        await poller._fetch_once(manifest["id"], channel)
    server.portal.call(ingest)
    result = server.get(f'{routes[channel["id"]]}?{query}')
    assert result.status_code == 200
    expected = body["elements" if folder == "bathrooms" else "ac"]
    assert result.json()["records"] == expected
    if folder == "flights":
        assert server.get(f'{routes[channel["id"]]}?ids=abc').json()["records"] == expected
