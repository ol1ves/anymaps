# Generic Widget Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete Generic Widget Server (Column B): registry, idempotent provisioning, instances, channel handlers, filter engine, external poller, and secrets — a dumb, config-driven FastAPI + SQLite pipe.

**Architecture:** One FastAPI app (`server/app/main.py:create_app`) with a single SQLite database and five tables. All routes share a sync `sqlite3` connection on `app.state.db`; only `/widgets/{id}/provision` is `async` so it can schedule poller tasks on the event loop. Records are cached whole as JSON with four extracted index columns (id, lat, lon, time) plus `ingested_at`, and filtered by the `filter.py` engine in Python.

**Tech Stack:** Python 3.12, FastAPI, SQLite (stdlib `sqlite3`, WAL mode), `httpx` (poller), `jmespath` (record mapping), `jsonschema` (manifest validation), `pytest` + FastAPI `TestClient`.

**Spec:**
- `SPEC.md` (why; sections 8–13)
- `CONTRACTS.md` (wire contract; sections 7–14)
- `PLAN.md` (Column B scope, section 5)
- `contracts/manifest.schema.json` (frozen; validated via `shared/schema.py`)

## Global Constraints

- Server never transforms data: fetch, cache, filter, broadcast only. Every record is returned whole (`payload`).
- One channel = one direction = one handler. `external` + `write` is not allowed.
- Coordinates: `lat`/`lng` in degrees; `bounds` string is `south,west,north,east`. Time is unix seconds.
- Error bodies are always `{"error": "message"}` with codes 400 / 404 / 409 / 500 (CONTRACTS.md §14).
- Publish with an existing `id + version` returns `409`.
- Unknown channel, token, or instance returns `404` (a private instance's existence is never leaked).
- Instance token is 32-char lowercase hex (128-bit, `secrets.token_hex(16)`).
- Manifest validation is exactly `shared/schema.py:validate_manifest` against `contracts/manifest.schema.json`. No ad-hoc extra validation.
- SSRF (shared/ssrf.py): https-only, public IPs only, re-applied after every redirect.
- Filter composition order: `latest` first, then `bounds`, `ids`, `since`, `until` (CONTRACTS.md §9).
- External channel: interval default 60 / min 5; mode default `snapshot`; retain default 3600 (series only).
- Client write channel: mode default `series`; retain default 3600.
- Retention pruning uses `ingested_at` (server receipt time). `since`/`until`/`latest` use the declared `time` index.
- CORS origins: `http://localhost:5173` and `http://127.0.0.1:5173`.
- Storage: bundles and manifests in SQLite; icons are external URL strings; no file volumes.

---

## File Structure

Files created or modified, with one responsibility each:

- `server/app/db.py` — SQLite connection, schema, `get_db` dependency. **Create.**
- `server/app/records.py` — record extraction (JMESPath), index-field extraction, cache storage (snapshot/series + retention). **Create.**
- `server/app/filter.py` — parse/validate/apply read filters. **Create.**
- `server/app/registry.py` — publish, gallery, install routes. **Create.**
- `server/app/instances.py` — instance-token creation route. **Create.**
- `server/app/secrets.py` — secret store route. **Create.**
- `server/app/channels.py` — channel read/write routes (public + private) and access control. **Create.**
- `server/app/poller.py` — external fetch loop, SSRF, redirect-safe requests. **Create.**
- `server/app/provision.py` — idempotent provisioning + route builder. **Create.**
- `server/app/main.py` — `create_app` factory, CORS, error handlers, lifespan, `/health`. **Modify.**
- `server/tests/conftest.py` — fixtures (fresh temp DB per test, manifests, `insert_channel` helper). **Create.**
- `server/tests/test_health.py` — rewrite to use the `client` fixture. **Modify.**
- `server/tests/test_db.py`, `test_records.py`, `test_filter.py`, `test_registry.py`, `test_instances.py`, `test_secrets.py`, `test_channels.py`, `test_poller.py`, `test_provision.py` — contract tests. **Create.**

Reused as-is (do not edit): `shared/ssrf.py`, `shared/schema.py`, `contracts/manifest.schema.json`, `server/requirements.txt`.

---

## Task 1: Database module and app skeleton

**Files:**
- Create: `server/app/db.py`
- Modify: `server/app/main.py`
- Modify: `server/tests/test_health.py`
- Create: `server/tests/conftest.py`
- Create: `server/tests/test_db.py`

**Interfaces:**
- Consumes: `shared/ssrf.py` (unused here, but present), existing `server/app/main.py` (hello-world, replaced).
- Produces:
  - `db.connect(db_path: str) -> sqlite3.Connection`
  - `db.get_db(request) -> sqlite3.Connection` (FastAPI dependency)
  - `main.create_app(db_path: str | None = None) -> FastAPI`
  - `main.app` (module-level instance for `uvicorn server.app.main:app`)

- [ ] **Step 1: Write `server/app/db.py`**

```python
"""SQLite connection and schema for the anymaps generic widget server."""

import os
import sqlite3

from fastapi import Request

SCHEMA = """
CREATE TABLE IF NOT EXISTS widgets (
    widget_id    TEXT NOT NULL,
    version      TEXT NOT NULL,
    name         TEXT NOT NULL,
    description  TEXT NOT NULL,
    icon         TEXT,
    manifest     TEXT NOT NULL,
    bundle       TEXT NOT NULL,
    published_at REAL NOT NULL,
    PRIMARY KEY (widget_id, version)
);

CREATE TABLE IF NOT EXISTS channels (
    widget_id      TEXT NOT NULL,
    channel_id     TEXT NOT NULL,
    config         TEXT NOT NULL,
    provisioned_at REAL NOT NULL,
    PRIMARY KEY (widget_id, channel_id)
);

CREATE TABLE IF NOT EXISTS instances (
    token      TEXT PRIMARY KEY,
    widget_id  TEXT NOT NULL,
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
    rowid          INTEGER PRIMARY KEY,
    widget_id      TEXT NOT NULL,
    channel_id     TEXT NOT NULL,
    instance_token TEXT,
    payload        TEXT NOT NULL,
    id_key         TEXT,
    lat            REAL,
    lon            REAL,
    time           REAL,
    ingested_at    REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_records_scope
    ON records (widget_id, channel_id, instance_token);

CREATE TABLE IF NOT EXISTS secrets (
    secret_id  TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    created_at REAL NOT NULL
);
"""


def connect(db_path: str) -> sqlite3.Connection:
    if db_path != ":memory:":
        directory = os.path.dirname(db_path)
        if directory:
            os.makedirs(directory, exist_ok=True)
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def get_db(request: Request) -> sqlite3.Connection:
    return request.app.state.db
```

- [ ] **Step 2: Write `server/app/main.py`**

```python
"""FastAPI app factory for the anymaps generic widget server."""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import channels, db as db_module, instances, provision, registry, secrets as secrets_module
from .poller import Poller

ALLOWED_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]


def create_app(db_path: str | None = None) -> FastAPI:
    db = db_module.connect(db_path or os.environ.get("DATABASE_PATH", "data/anymaps.db"))
    poller = Poller(db)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        poller.start_all()
        yield
        await poller.shutdown()

    app = FastAPI(title="anymaps generic widget server", lifespan=lifespan)
    app.state.db = db
    app.state.poller = poller

    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(registry.router)
    app.include_router(provision.router)
    app.include_router(instances.router)
    app.include_router(channels.router)
    app.include_router(secrets_module.router)

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException):
        return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(request: Request, exc: RequestValidationError):
        return JSONResponse(status_code=400, content={"error": "malformed body"})

    return app


app = create_app()
```

> **Note:** `main.py` imports `channels`, `provision`, `instances`, `registry`, `secrets`, and `poller` modules that do not exist yet. To keep the app importable in Tasks 1–8, create each of those modules now as a stub containing `from fastapi import APIRouter; router = APIRouter()` — and create `server/app/poller.py` with a minimal `Poller` class (see below). Each later task replaces its stub with the real implementation. Do **not** leave `main.py` broken between tasks.

Create these stubs in this step:

- `server/app/records.py` (empty for now is fine; it is not imported by `main.py`)
- `server/app/filter.py` (not imported by `main.py`; empty for now)
- `server/app/registry.py`, `server/app/provision.py`, `server/app/instances.py`, `server/app/channels.py`, `server/app/secrets.py`:

```python
from fastapi import APIRouter

router = APIRouter()
```

- `server/app/poller.py`:

```python
"""External channel poller (SPEC §10). Full implementation lands in Task 8."""


class Poller:
    def __init__(self, db):
        self.db = db
        self.tasks = {}

    def start_all(self):
        pass

    async def shutdown(self):
        pass
```

- [ ] **Step 3: Write `server/tests/conftest.py`**

```python
import json

import pytest
from fastapi.testclient import TestClient

from server.app.main import create_app

FMF_MANIFEST = {
    "id": "find-my-friends",
    "name": "Find My Friends",
    "version": "0.1.0",
    "description": "Share live locations with friends",
    "server": {
        "channels": [
            {
                "id": "fmfW",
                "origin": "client",
                "direction": "write",
                "visibility": "private",
                "mode": "series",
                "retain": 3600,
                "record": {"id": "clientId", "lat": "lat", "lon": "lng", "time": "ts"},
            },
            {
                "id": "fmfR",
                "origin": "client",
                "direction": "read",
                "visibility": "private",
                "source": "fmfW",
            },
        ]
    },
}

FLIGHTS_MANIFEST = {
    "id": "flights-nyc",
    "name": "Flights NYC",
    "version": "0.1.0",
    "description": "Live planes near New York",
    "server": {
        "channels": [
            {
                "id": "flights_nyc",
                "origin": "external",
                "direction": "read",
                "visibility": "public",
                "external": {
                    "method": "GET",
                    "url": "https://api.adsb.lol/v2/point/40.71/-74.0/250",
                    "interval": 5,
                    "mode": "series",
                    "retain": 3600,
                    "record": {
                        "records": "ac",
                        "id": "hex",
                        "lat": "lat",
                        "lon": "lon",
                        "time": "@ingestedAt",
                    },
                },
            }
        ]
    },
}

BATHROOMS_MANIFEST = {
    "id": "nyc-bathrooms",
    "name": "NYC Bathrooms",
    "version": "0.1.0",
    "description": "Public restrooms in NYC",
    "server": {
        "channels": [
            {
                "id": "nyc_bathrooms",
                "origin": "external",
                "direction": "read",
                "visibility": "public",
                "external": {
                    "method": "POST",
                    "url": "https://overpass-api.de/api/interpreter",
                    "body": '[out:json];node["amenity"="toilets"](40.47,-74.26,40.92,-73.70);out;',
                    "interval": 86400,
                    "mode": "snapshot",
                    "record": {"records": "elements", "id": "id", "lat": "lat", "lon": "lon"},
                },
            }
        ]
    },
}


@pytest.fixture
def client(tmp_path):
    app = create_app(str(tmp_path / "test.db"))
    with TestClient(app) as c:
        yield c


@pytest.fixture
def db(client):
    return client.app.state.db


def insert_channel(db, widget_id, channel):
    db.execute(
        "INSERT INTO channels (widget_id, channel_id, config, provisioned_at) VALUES (?, ?, ?, ?)",
        (widget_id, channel["id"], json.dumps(channel), 1000.0),
    )
    db.commit()
```

- [ ] **Step 4: Rewrite `server/tests/test_health.py`**

```python
def test_health(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

- [ ] **Step 5: Write `server/tests/test_db.py`**

```python
from server.app.db import connect


def test_connect_creates_all_tables(tmp_path):
    conn = connect(str(tmp_path / "test.db"))
    names = {
        row["name"]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    }
    assert {"widgets", "channels", "instances", "records", "secrets"} <= names
    conn.close()
```

- [ ] **Step 6: Run the tests and verify they pass**

Run: `pytest server/tests/test_health.py server/tests/test_db.py -v`
Expected: PASS (2 tests)

- [ ] **Step 7: Run the full suite to confirm no regression**

Run: `pytest -q`
Expected: PASS (existing `shared/tests` still pass)

- [ ] **Step 8: Commit**

```bash
git add server/app/db.py server/app/main.py server/app/records.py server/app/filter.py server/app/registry.py server/app/provision.py server/app/instances.py server/app/channels.py server/app/secrets.py server/app/poller.py server/tests/
git commit -m "feat(server): add db module, app factory, and test scaffolding"
```

---

## Task 2: Record extraction and cache storage

**Files:**
- Modify: `server/app/records.py`
- Create: `server/tests/test_records.py`

**Interfaces:**
- Consumes: `jmespath`, `sqlite3.Connection` (from `db.connect`)
- Produces:
  - `records.extract_records(channel: dict, body) -> list[dict]`
  - `records.index_fields(mapping: dict | None, record: dict, ingested_at: float) -> tuple`
  - `records.accumulation_mode(channel: dict) -> str`
  - `records.retain_seconds(channel: dict) -> int`
  - `records.store_records(db, widget_id, channel_id, instance_token, channel, records, ingested_at) -> None`

- [ ] **Step 1: Write the failing tests**

```python
import json

from server.app.db import connect
from server.app import records

EXTERNAL_CHANNEL = {
    "id": "flights_nyc",
    "origin": "external",
    "direction": "read",
    "visibility": "public",
    "external": {"mode": "series", "retain": 100},
    "record": {"records": "ac", "id": "hex", "lat": "lat", "lon": "lon", "time": "@ingestedAt"},
}


def test_extract_records_external_array():
    body = {"ac": [{"hex": "a"}, {"hex": "b"}]}
    assert records.extract_records(EXTERNAL_CHANNEL, body) == [{"hex": "a"}, {"hex": "b"}]


def test_extract_records_external_no_mapping_returns_whole_body():
    channel = {"id": "w", "origin": "external", "direction": "read", "visibility": "public"}
    assert records.extract_records(channel, {"a": 1}) == [{"a": 1}]


def test_extract_records_client_write_wraps_body():
    channel = {"id": "w", "origin": "client", "direction": "write", "visibility": "public"}
    body = {"clientId": "alice", "lat": 40.7, "lng": -74.0}
    assert records.extract_records(channel, body) == [body]


def test_index_fields_extracts_and_coerces():
    mapping = {"id": "hex", "lat": "lat", "lon": "lon", "time": "@ingestedAt"}
    rec = {"hex": 123, "lat": "40.7", "lon": "-74.0"}
    assert records.index_fields(mapping, rec, 1000.0) == ("123", 40.7, -74.0, 1000.0)


def test_index_fields_record_time_wins_over_ingested():
    mapping = {"id": "hex", "time": "ts"}
    rec = {"hex": "a", "ts": 1700000000}
    assert records.index_fields(mapping, rec, 1000.0) == ("a", None, None, 1700000000.0)


def test_store_snapshot_replaces_whole_bucket(tmp_path):
    db = connect(str(tmp_path / "t.db"))
    channel = {
        "id": "b",
        "origin": "external",
        "direction": "read",
        "visibility": "public",
        "external": {"mode": "snapshot"},
        "record": {"records": "elements", "id": "id"},
    }
    records.store_records(db, "w", "b", None, channel, [{"id": 1}, {"id": 2}], 100.0)
    records.store_records(db, "w", "b", None, channel, [{"id": 3}], 200.0)
    rows = db.execute(
        "SELECT payload FROM records WHERE widget_id='w' AND channel_id='b'"
    ).fetchall()
    assert [json.loads(r["payload"]) for r in rows] == [{"id": 3}]
    db.close()


def test_store_series_appends_then_prunes_by_ingested_at(tmp_path):
    db = connect(str(tmp_path / "t.db"))
    records.store_records(db, "w", "c", None, EXTERNAL_CHANNEL, [{"hex": "a"}], 100.0)
    records.store_records(db, "w", "c", None, EXTERNAL_CHANNEL, [{"hex": "b"}], 300.0)
    rows = db.execute(
        "SELECT payload, ingested_at FROM records WHERE widget_id='w' AND channel_id='c' ORDER BY ingested_at"
    ).fetchall()
    assert [json.loads(r["payload"]) for r in rows] == [{"hex": "b"}]
    db.close()


def test_accumulation_defaults():
    assert records.accumulation_mode({"origin": "external", "external": {}}) == "snapshot"
    assert records.accumulation_mode({"origin": "client", "mode": "snapshot"}) == "snapshot"
    assert records.accumulation_mode({"origin": "client"}) == "series"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest server/tests/test_records.py -v`
Expected: FAIL (import error or `records` has no attributes)

- [ ] **Step 3: Implement `server/app/records.py`**

```python
"""Record extraction, indexing, and cache storage (the write path)."""

import json

import jmespath


def _to_float(value):
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _to_str(value):
    if value is None:
        return None
    return str(value)


def index_fields(mapping, record, ingested_at):
    """Return (id_key, lat, lon, time) extracted from one record."""
    if not mapping:
        return None, None, None, None
    id_key = _to_str(jmespath.search(mapping["id"], record)) if mapping.get("id") else None
    lat = _to_float(jmespath.search(mapping["lat"], record)) if mapping.get("lat") else None
    lon = _to_float(jmespath.search(mapping["lon"], record)) if mapping.get("lon") else None
    t = mapping.get("time")
    if t == "@ingestedAt":
        time_value = ingested_at
    elif t:
        time_value = _to_float(jmespath.search(t, record))
    else:
        time_value = None
    return id_key, lat, lon, time_value


def extract_records(channel, body):
    """Turn a fetched/request body into the list of whole records to cache."""
    mapping = channel.get("record")
    if channel["origin"] == "external":
        records_path = (mapping or {}).get("records")
        if records_path:
            found = jmespath.search(records_path, body)
            if found is None:
                return []
            if not isinstance(found, list):
                raise ValueError("record.records must resolve to a list")
            return found
        return [body]
    return [body]


def accumulation_mode(channel):
    if channel["origin"] == "external":
        return channel.get("external", {}).get("mode", "snapshot")
    return channel.get("mode", "series")


def retain_seconds(channel):
    if channel["origin"] == "external":
        return channel.get("external", {}).get("retain", 3600)
    return channel.get("retain", 3600)


def store_records(db, widget_id, channel_id, instance_token, channel, records, ingested_at):
    if accumulation_mode(channel) == "snapshot":
        db.execute(
            "DELETE FROM records WHERE widget_id = ? AND channel_id = ? AND instance_token IS ?",
            (widget_id, channel_id, instance_token),
        )
    mapping = channel.get("record")
    for record in records:
        id_key, lat, lon, time_value = index_fields(mapping, record, ingested_at)
        db.execute(
            "INSERT INTO records "
            "(widget_id, channel_id, instance_token, payload, id_key, lat, lon, time, ingested_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (widget_id, channel_id, instance_token, json.dumps(record), id_key, lat, lon, time_value, ingested_at),
        )
    if accumulation_mode(channel) == "series":
        db.execute(
            "DELETE FROM records WHERE widget_id = ? AND channel_id = ? AND instance_token IS ? AND ingested_at < ?",
            (widget_id, channel_id, instance_token, ingested_at - retain_seconds(channel)),
        )
    db.commit()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest server/tests/test_records.py -v`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add server/app/records.py server/tests/test_records.py
git commit -m "feat(server): record extraction, indexing, and snapshot/series storage"
```

---

## Task 3: Filter engine

**Files:**
- Modify: `server/app/filter.py`
- Create: `server/tests/test_filter.py`

**Interfaces:**
- Consumes: `sqlite3.Connection`, `records.store_records` (to seed caches in tests)
- Produces:
  - `filter.FilterError(Exception)` — maps to HTTP 400
  - `filter.parse_filters(query_params: dict) -> dict`
  - `filter.validate_filters(mapping: dict, filters: dict) -> None` (raises `FilterError`)
  - `filter.query_records(db, widget_id, channel_id, instance_token, mapping, filters) -> list[dict]`

- [ ] **Step 1: Write the failing tests**

```python
import pytest

from server.app.db import connect
from server.app import filter as filter_mod
from server.app import records

CHANNEL = {
    "id": "c",
    "origin": "external",
    "direction": "read",
    "visibility": "public",
    "external": {"mode": "series", "retain": 3600},
    "record": {"records": "ac", "id": "hex", "lat": "lat", "lon": "lon", "time": "@ingestedAt"},
}


def test_parse_bounds():
    filters = filter_mod.parse_filters({"bounds": "40.5,-74.3,40.9,-73.7"})
    assert filters["bounds"] == (40.5, -74.3, 40.9, -73.7)


def test_parse_bounds_rejects_bad_shape():
    with pytest.raises(filter_mod.FilterError):
        filter_mod.parse_filters({"bounds": "1,2,3"})


def test_parse_latest_flag():
    assert filter_mod.parse_filters({"latest": "1"})["latest"] is True


def test_validate_requires_declared_fields():
    with pytest.raises(filter_mod.FilterError):
        filter_mod.validate_filters({}, {"bounds": (0, 0, 1, 1)})


def test_query_latest_then_bounds(tmp_path):
    db = connect(str(tmp_path / "t.db"))
    records.store_records(db, "w", "c", None, CHANNEL, [{"hex": "a", "lat": 40.7, "lon": -74.0}], 100.0)
    records.store_records(db, "w", "c", None, CHANNEL, [{"hex": "a", "lat": 40.8, "lon": -74.1}], 200.0)
    records.store_records(db, "w", "c", None, CHANNEL, [{"hex": "b", "lat": 41.0, "lon": -73.0}], 300.0)

    mapping = CHANNEL["record"]
    filters = filter_mod.parse_filters({"latest": "1", "bounds": "40.0,-75.0,40.9,-73.0"})
    result = filter_mod.query_records(db, "w", "c", None, mapping, filters)

    assert [r["hex"] for r in result] == ["a"]
    assert result[0]["lat"] == 40.8
    db.close()


def test_query_ids_since_until(tmp_path):
    db = connect(str(tmp_path / "t.db"))
    records.store_records(db, "w", "c", None, CHANNEL, [{"hex": "a"}], 100.0)
    records.store_records(db, "w", "c", None, CHANNEL, [{"hex": "b"}], 200.0)
    records.store_records(db, "w", "c", None, CHANNEL, [{"hex": "c"}], 300.0)

    mapping = CHANNEL["record"]
    filters = filter_mod.parse_filters({"ids": "a,c", "since": "150", "until": "350"})
    result = filter_mod.query_records(db, "w", "c", None, mapping, filters)
    assert sorted(r["hex"] for r in result) == ["c"]
    db.close()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest server/tests/test_filter.py -v`
Expected: FAIL (module has no attributes)

- [ ] **Step 3: Implement `server/app/filter.py`**

```python
"""Filter engine: parse, validate, and apply read filters (CONTRACTS.md §9)."""

import json


class FilterError(Exception):
    """Raised for malformed or undeclared filters; maps to HTTP 400."""


def parse_filters(query_params):
    filters = {}
    if "bounds" in query_params:
        filters["bounds"] = _parse_bounds(query_params["bounds"])
    if "ids" in query_params:
        ids = query_params["ids"]
        filters["ids"] = set(ids.split(",")) if ids else set()
    if "since" in query_params:
        filters["since"] = _parse_float("since", query_params["since"])
    if "until" in query_params:
        filters["until"] = _parse_float("until", query_params["until"])
    if "latest" in query_params:
        filters["latest"] = query_params["latest"] in ("1", "true", "True")
    return filters


def _parse_bounds(value):
    parts = value.split(",")
    if len(parts) != 4:
        raise FilterError("bounds must be four floats: south,west,north,east")
    try:
        south, west, north, east = (float(p) for p in parts)
    except ValueError:
        raise FilterError("bounds must be four floats: south,west,north,east")
    if south > north or west > east:
        raise FilterError("bounds must satisfy south<=north and west<=east")
    return (south, west, north, east)


def _parse_float(name, value):
    try:
        return float(value)
    except ValueError:
        raise FilterError(f"{name} must be a number")


def validate_filters(mapping, filters):
    if "bounds" in filters and not (mapping.get("lat") and mapping.get("lon")):
        raise FilterError("bounds filter requires lat and lon in the record mapping")
    if "ids" in filters and not mapping.get("id"):
        raise FilterError("ids filter requires id in the record mapping")
    if ("since" in filters or "until" in filters) and not mapping.get("time"):
        raise FilterError("since/until filter requires time in the record mapping")
    if filters.get("latest") and not (mapping.get("id") and mapping.get("time")):
        raise FilterError("latest filter requires id and time in the record mapping")


def query_records(db, widget_id, channel_id, instance_token, mapping, filters):
    rows = db.execute(
        "SELECT payload, id_key, lat, lon, time FROM records "
        "WHERE widget_id = ? AND channel_id = ? AND instance_token IS ? "
        "ORDER BY time ASC",
        (widget_id, channel_id, instance_token),
    ).fetchall()

    items = [
        {
            "payload": row["payload"],
            "id_key": row["id_key"],
            "lat": row["lat"],
            "lon": row["lon"],
            "time": row["time"],
        }
        for row in rows
    ]

    # Composition order (CONTRACTS.md §9): latest, then bounds, ids, since, until.
    if filters.get("latest"):
        newest = {}
        for r in items:
            if r["id_key"] is None:
                continue
            current = newest.get(r["id_key"])
            if current is None or _later(r, current):
                newest[r["id_key"]] = r
        items = sorted(newest.values(), key=lambda r: (r["time"] is None, r["time"]))

    if "bounds" in filters:
        south, west, north, east = filters["bounds"]
        items = [
            r for r in items
            if r["lat"] is not None and r["lon"] is not None
            and south <= r["lat"] <= north and west <= r["lon"] <= east
        ]

    if "ids" in filters:
        wanted = filters["ids"]
        items = [r for r in items if r["id_key"] in wanted]

    if "since" in filters:
        s = filters["since"]
        items = [r for r in items if r["time"] is not None and r["time"] >= s]

    if "until" in filters:
        u = filters["until"]
        items = [r for r in items if r["time"] is not None and r["time"] <= u]

    return [json.loads(r["payload"]) for r in items]


def _later(a, b):
    if a["time"] is None:
        return False
    if b["time"] is None:
        return True
    return a["time"] > b["time"]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest server/tests/test_filter.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add server/app/filter.py server/tests/test_filter.py
git commit -m "feat(server): filter engine with latest/bounds/ids/since/until"
```

---

## Task 4: Registry (publish, gallery, install)

**Files:**
- Modify: `server/app/registry.py` (replace stub)
- Create: `server/tests/test_registry.py`

**Interfaces:**
- Consumes: `shared.schema.validate_manifest`, `db.get_db`
- Produces: `registry.router` (APIRouter) with routes `POST /widgets`, `GET /widgets`, `GET /widgets/{id}/versions/{version}/manifest`, `GET /widgets/{id}/versions/{version}/bundle`

- [ ] **Step 1: Write the failing tests**

```python
import copy

from server.tests.conftest import FMF_MANIFEST


def _publish(client, manifest=FMF_MANIFEST, bundle="console.log('hi')"):
    return client.post("/widgets", json={"manifest": manifest, "bundle": bundle})


def test_publish_returns_id_and_version(client):
    r = _publish(client)
    assert r.status_code == 201
    assert r.json() == {"id": "find-my-friends", "version": "0.1.0"}


def test_publish_duplicate_conflicts(client):
    assert _publish(client).status_code == 201
    r = _publish(client)
    assert r.status_code == 409
    assert r.json() == {"error": "widget version already published"}


def test_publish_invalid_manifest_is_400(client):
    bad = copy.deepcopy(FMF_MANIFEST)
    bad["version"] = "1.0"  # not semver
    r = _publish(client, manifest=bad)
    assert r.status_code == 400
    assert "error" in r.json()


def test_gallery_lists_published(client):
    _publish(client)
    r = client.get("/widgets")
    assert r.status_code == 200
    assert r.json() == [
        {
            "id": "find-my-friends",
            "name": "Find My Friends",
            "version": "0.1.0",
            "description": "Share live locations with friends",
            "icon": None,
        }
    ]


def test_manifest_fetch(client):
    _publish(client)
    r = client.get("/widgets/find-my-friends/versions/0.1.0/manifest")
    assert r.status_code == 200
    assert r.json()["id"] == "find-my-friends"


def test_bundle_fetch_is_javascript(client):
    _publish(client)
    r = client.get("/widgets/find-my-friends/versions/0.1.0/bundle")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/javascript")
    assert r.text == "console.log('hi')"


def test_unknown_version_404(client):
    r = client.get("/widgets/find-my-friends/versions/9.9.9/manifest")
    assert r.status_code == 404
    assert r.json() == {"error": "widget version not found"}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest server/tests/test_registry.py -v`
Expected: FAIL (routes do not exist)

- [ ] **Step 3: Implement `server/app/registry.py`**

```python
"""Registry routes: publish, gallery, install (CONTRACTS.md §8)."""

import json
import time

import jsonschema
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel

from shared.schema import validate_manifest
from .db import get_db

router = APIRouter()


class PublishRequest(BaseModel):
    manifest: dict
    bundle: str


@router.post("/widgets", status_code=201)
def publish_widget(body: PublishRequest, db=Depends(get_db)):
    manifest = body.manifest
    try:
        validate_manifest(manifest)
    except jsonschema.ValidationError as exc:
        raise HTTPException(status_code=400, detail=f"invalid manifest: {exc.message}")

    widget_id = manifest["id"]
    version = manifest["version"]
    existing = db.execute(
        "SELECT 1 FROM widgets WHERE widget_id = ? AND version = ?", (widget_id, version)
    ).fetchone()
    if existing:
        raise HTTPException(status_code=409, detail="widget version already published")

    db.execute(
        "INSERT INTO widgets (widget_id, version, name, description, icon, manifest, bundle, published_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            widget_id,
            version,
            manifest["name"],
            manifest["description"],
            manifest.get("icon"),
            json.dumps(manifest),
            body.bundle,
            time.time(),
        ),
    )
    db.commit()
    return {"id": widget_id, "version": version}


@router.get("/widgets")
def list_widgets(db=Depends(get_db)):
    rows = db.execute(
        "SELECT widget_id AS id, name, version, description, icon FROM widgets"
    ).fetchall()
    return [dict(row) for row in rows]


@router.get("/widgets/{widget_id}/versions/{version}/manifest")
def get_manifest(widget_id: str, version: str, db=Depends(get_db)):
    row = db.execute(
        "SELECT manifest FROM widgets WHERE widget_id = ? AND version = ?",
        (widget_id, version),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="widget version not found")
    return json.loads(row["manifest"])


@router.get("/widgets/{widget_id}/versions/{version}/bundle")
def get_bundle(widget_id: str, version: str, db=Depends(get_db)):
    row = db.execute(
        "SELECT bundle FROM widgets WHERE widget_id = ? AND version = ?",
        (widget_id, version),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="widget version not found")
    return Response(content=row["bundle"], media_type="text/javascript")
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest server/tests/test_registry.py -v`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add server/app/registry.py server/tests/test_registry.py
git commit -m "feat(server): registry publish, gallery, and install routes"
```

---

## Task 5: Instance creation

**Files:**
- Modify: `server/app/instances.py` (replace stub)
- Create: `server/tests/test_instances.py`

**Interfaces:**
- Consumes: `db.get_db`
- Produces: `instances.router` with route `POST /widgets/{widget_id}/instances` → `201 {"instanceToken": "<32 hex>"}`

- [ ] **Step 1: Write the failing test**

```python
def test_create_instance_returns_32_hex_token(client):
    r = client.post("/widgets/find-my-friends/instances")
    assert r.status_code == 201
    token = r.json()["instanceToken"]
    assert len(token) == 32
    assert all(c in "0123456789abcdef" for c in token)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest server/tests/test_instances.py -v`
Expected: FAIL (404, route not registered)

- [ ] **Step 3: Implement `server/app/instances.py`**

```python
"""Instance (room) creation (CONTRACTS.md §8)."""

import secrets
import time

from fastapi import APIRouter, Depends

from .db import get_db

router = APIRouter()


@router.post("/widgets/{widget_id}/instances", status_code=201)
def create_instance(widget_id: str, db=Depends(get_db)):
    token = secrets.token_hex(16)  # 128 bits -> 32 hex chars
    db.execute(
        "INSERT INTO instances (token, widget_id, created_at) VALUES (?, ?, ?)",
        (token, widget_id, time.time()),
    )
    db.commit()
    return {"instanceToken": token}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest server/tests/test_instances.py -v`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add server/app/instances.py server/tests/test_instances.py
git commit -m "feat(server): instance token creation"
```

---

## Task 6: Secret store

**Files:**
- Modify: `server/app/secrets.py` (replace stub)
- Create: `server/tests/test_secrets.py`

**Interfaces:**
- Consumes: `db.get_db`
- Produces: `secrets.router` with route `POST /secrets` → `201 {"secretId": "<32 hex>"}`. Values are write-only.

- [ ] **Step 1: Write the failing test**

```python
def test_create_secret_returns_id_but_never_value(client):
    r = client.post("/secrets", json={"value": "super-secret-value"})
    assert r.status_code == 201
    secret_id = r.json()["secretId"]
    assert len(secret_id) == 32
    assert "super-secret-value" not in r.text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest server/tests/test_secrets.py -v`
Expected: FAIL (404, route not registered)

- [ ] **Step 3: Implement `server/app/secrets.py`**

```python
"""Secret store (CONTRACTS.md §8, §12.2). Values are write-only."""

import secrets
import time

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from .db import get_db

router = APIRouter()


class SecretRequest(BaseModel):
    value: str


@router.post("/secrets", status_code=201)
def create_secret(body: SecretRequest, db=Depends(get_db)):
    secret_id = secrets.token_hex(16)
    db.execute(
        "INSERT INTO secrets (secret_id, value, created_at) VALUES (?, ?, ?)",
        (secret_id, body.value, time.time()),
    )
    db.commit()
    return {"secretId": secret_id}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest server/tests/test_secrets.py -v`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add server/app/secrets.py server/tests/test_secrets.py
git commit -m "feat(server): write-only secret store"
```

---

## Task 7: Channel handlers (write + read, public + private)

**Files:**
- Modify: `server/app/channels.py` (replace stub)
- Create: `server/tests/test_channels.py`

**Interfaces:**
- Consumes: `records.extract_records`, `records.store_records`, `filter.parse_filters`, `filter.validate_filters`, `filter.query_records`, `db.get_db`
- Produces: `channels.router` with routes:
  - `POST /widgets/{widget_id}/channels/{channel_id}` (public write)
  - `GET /widgets/{widget_id}/channels/{channel_id}` (public read)
  - `POST /widgets/{widget_id}/channels/{channel_id}/instances/{token}` (private write)
  - `GET /widgets/{widget_id}/channels/{channel_id}/instances/{token}` (private read)

- [ ] **Step 1: Write the failing tests**

```python
from server.tests.conftest import FMF_MANIFEST, insert_channel


def _provision_fmf(db):
    insert_channel(db, "find-my-friends", FMF_MANIFEST["server"]["channels"][0])
    insert_channel(db, "find-my-friends", FMF_MANIFEST["server"]["channels"][1])


def _token(client):
    return client.post("/widgets/find-my-friends/instances").json()["instanceToken"]


def test_private_write_read_roundtrip(client, db):
    _provision_fmf(db)
    token = _token(client)

    w = client.post(
        f"/widgets/find-my-friends/channels/fmfW/instances/{token}",
        json={"clientId": "alice", "lat": 40.71, "lng": -74.0, "ts": 1700000000, "name": "Alice"},
    )
    assert w.status_code == 201

    r = client.get(
        f"/widgets/find-my-friends/channels/fmfR/instances/{token}",
        params={"latest": "1"},
    )
    assert r.status_code == 200
    recs = r.json()["records"]
    assert len(recs) == 1
    assert recs[0]["name"] == "Alice"
    assert recs[0]["lat"] == 40.71


def test_unknown_token_404(client, db):
    _provision_fmf(db)
    r = client.get("/widgets/find-my-friends/channels/fmfR/instances/ff" * 16)
    assert r.status_code == 404


def test_private_channel_requires_token(client, db):
    _provision_fmf(db)
    assert client.get("/widgets/find-my-friends/channels/fmfR").status_code == 404


def test_write_to_read_channel_404(client, db):
    _provision_fmf(db)
    r = client.post("/widgets/find-my-friends/channels/fmfR", json={})
    assert r.status_code == 404


def test_unknown_channel_404(client):
    r = client.get("/widgets/find-my-friends/channels/nope")
    assert r.status_code == 404


def test_read_inherits_source_mapping(client, db):
    insert_channel(db, "find-my-friends", FMF_MANIFEST["server"]["channels"][0])
    insert_channel(db, "find-my-friends", FMF_MANIFEST["server"]["channels"][1])
    token = _token(client)
    # fmfR inherits fmfW's mapping (id=clientId, lat=lat, lon=lng, time=ts), so ids is valid.
    r = client.get(
        f"/widgets/find-my-friends/channels/fmfR/instances/{token}",
        params={"ids": "alice"},
    )
    assert r.status_code == 200
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest server/tests/test_channels.py -v`
Expected: FAIL (routes not registered)

- [ ] **Step 3: Implement `server/app/channels.py`**

```python
"""Channel read/write handlers (CONTRACTS.md §8, §9)."""

import json
import time

from fastapi import APIRouter, Depends, HTTPException, Request

from . import filter as filter_mod
from . import records
from .db import get_db

router = APIRouter()


def _load_channel(db, widget_id, channel_id):
    row = db.execute(
        "SELECT config FROM channels WHERE widget_id = ? AND channel_id = ?",
        (widget_id, channel_id),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="channel not found")
    return json.loads(row["config"])


def _check_access(db, channel, widget_id, token):
    """Enforce visibility and instance-token access. Returns the storage token (or None)."""
    if channel["visibility"] == "private":
        if token is None:
            raise HTTPException(status_code=404, detail="channel not found")
        row = db.execute(
            "SELECT 1 FROM instances WHERE token = ? AND widget_id = ?", (token, widget_id)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="channel not found")
        return token
    if token is not None:
        raise HTTPException(status_code=404, detail="channel not found")
    return None


def _effective_mapping(db, widget_id, channel):
    if channel["origin"] == "client" and channel["direction"] == "read":
        src = channel["source"]
        row = db.execute(
            "SELECT config FROM channels WHERE widget_id = ? AND channel_id = ?", (widget_id, src)
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="source channel not found")
        return json.loads(row["config"]).get("record", {})
    return channel.get("record", {})


@router.post("/widgets/{widget_id}/channels/{channel_id}", status_code=201)
def write_channel_public(widget_id: str, channel_id: str, body: dict, db=Depends(get_db)):
    return _write(db, widget_id, channel_id, None, body)


@router.post("/widgets/{widget_id}/channels/{channel_id}/instances/{token}", status_code=201)
def write_channel_private(widget_id: str, channel_id: str, token: str, body: dict, db=Depends(get_db)):
    return _write(db, widget_id, channel_id, token, body)


@router.get("/widgets/{widget_id}/channels/{channel_id}")
def read_channel_public(widget_id: str, channel_id: str, request: Request, db=Depends(get_db)):
    return _read(db, widget_id, channel_id, None, dict(request.query_params))


@router.get("/widgets/{widget_id}/channels/{channel_id}/instances/{token}")
def read_channel_private(widget_id: str, channel_id: str, token: str, request: Request, db=Depends(get_db)):
    return _read(db, widget_id, channel_id, token, dict(request.query_params))


def _write(db, widget_id, channel_id, token, body):
    channel = _load_channel(db, widget_id, channel_id)
    if channel["direction"] != "write" or channel["origin"] != "client":
        raise HTTPException(status_code=404, detail="channel not found")
    storage_token = _check_access(db, channel, widget_id, token)
    ingested_at = time.time()
    recs = records.extract_records(channel, body)
    records.store_records(db, widget_id, channel_id, storage_token, channel, recs, ingested_at)
    return {"ok": True}


def _read(db, widget_id, channel_id, token, query_params):
    channel = _load_channel(db, widget_id, channel_id)
    if channel["direction"] != "read":
        raise HTTPException(status_code=404, detail="channel not found")
    storage_token = _check_access(db, channel, widget_id, token)
    mapping = _effective_mapping(db, widget_id, channel)
    storage_channel_id = (
        channel["source"]
        if channel["origin"] == "client" and channel["direction"] == "read"
        else channel_id
    )
    try:
        filters = filter_mod.parse_filters(query_params)
        filter_mod.validate_filters(mapping, filters)
    except filter_mod.FilterError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    result = filter_mod.query_records(db, widget_id, storage_channel_id, storage_token, mapping, filters)
    return {"records": result}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest server/tests/test_channels.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add server/app/channels.py server/tests/test_channels.py
git commit -m "feat(server): channel read/write handlers with access control"
```

---

## Task 8: External poller

**Files:**
- Modify: `server/app/poller.py` (replace stub)
- Create: `server/tests/test_poller.py`

**Interfaces:**
- Consumes: `shared.ssrf.assert_source_url_allowed`, `records.extract_records`, `records.store_records`
- Produces:
  - `Poller(db)` with `start(widget_id, channel)`, `start_all()`, `async _fetch_once(widget_id, channel)`, `async _request(ext)`, `async shutdown()`
  - Note: `start()` must be called from async context (it schedules via `asyncio.create_task`).

- [ ] **Step 1: Write the failing tests**

```python
import asyncio

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest server/tests/test_poller.py -v`
Expected: FAIL (Poller has no `_fetch_once`, `_request`, `_run`)

- [ ] **Step 3: Implement `server/app/poller.py`**

```python
"""External channel poller (SPEC §10): fetch, SSRF, cache, retention."""

import asyncio
import json

import httpx

from shared.ssrf import assert_source_url_allowed
from . import records


class Poller:
    def __init__(self, db):
        self.db = db
        self.tasks = {}
        self.client = httpx.AsyncClient(timeout=10, follow_redirects=False)

    def start(self, widget_id, channel):
        key = (widget_id, channel["id"])
        if key in self.tasks and not self.tasks[key].done():
            return
        self.tasks[key] = asyncio.create_task(self._run(widget_id, channel))

    def start_all(self):
        rows = self.db.execute("SELECT widget_id, config FROM channels").fetchall()
        for row in rows:
            channel = json.loads(row["config"])
            if channel["origin"] == "external":
                self.start(row["widget_id"], channel)

    async def _run(self, widget_id, channel):
        interval = max(5, channel.get("external", {}).get("interval", 60))
        while True:
            try:
                await self._fetch_once(widget_id, channel)
            except Exception:
                pass  # keep last-good cache, retry next interval
            await asyncio.sleep(interval)

    async def _fetch_once(self, widget_id, channel):
        ext = channel["external"]
        body = await self._request(ext)
        from time import time as _now

        ingested_at = _now()
        recs = records.extract_records(channel, body)
        records.store_records(self.db, widget_id, channel["id"], None, channel, recs, ingested_at)

    async def _request(self, ext):
        method = ext.get("method", "GET")
        url = ext["url"]
        params = dict(ext.get("query") or {})
        headers = dict(ext.get("headers") or {})
        body = ext.get("body")

        auth = ext.get("auth")
        if auth:
            row = self.db.execute(
                "SELECT value FROM secrets WHERE secret_id = ?", (auth["secret"],)
            ).fetchone()
            if row is None:
                raise ValueError(f"unknown secret: {auth['secret']}")
            value = row["value"]
            if auth.get("scheme"):
                value = auth["scheme"] + value
            if auth["type"] == "header":
                headers[auth["name"]] = value
            else:
                params[auth["name"]] = value

        for _ in range(5):
            assert_source_url_allowed(url)
            if isinstance(body, dict):
                response = await self.client.request(method, url, params=params, headers=headers, json=body)
            elif isinstance(body, str):
                response = await self.client.request(method, url, params=params, headers=headers, content=body)
            else:
                response = await self.client.request(method, url, params=params, headers=headers)
            if response.status_code in (301, 302, 303, 307, 308):
                location = response.headers.get("location")
                if not location:
                    raise ValueError("redirect without location header")
                if response.status_code == 303:
                    method = "GET"
                    body = None
                url = location
                continue
            response.raise_for_status()
            return response.json()
        raise ValueError("too many redirects")

    async def shutdown(self):
        for task in self.tasks.values():
            task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks.values(), return_exceptions=True)
        await self.client.aclose()
```

> **Note:** the `from time import time as _now` inside `_fetch_once` is intentional to keep the module import surface small; feel free to hoist it to a top-level `import time` if you prefer — the behavior is identical.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest server/tests/test_poller.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/app/poller.py server/tests/test_poller.py
git commit -m "feat(server): external poller with SSRF, auth, and redirect safety"
```

---

## Task 9: Provisioning

**Files:**
- Modify: `server/app/provision.py` (replace stub)
- Create: `server/tests/test_provision.py`

**Interfaces:**
- Consumes: `shared.schema.validate_manifest`, `db.get_db`, `app.state.poller` (via `request.app.state.poller`)
- Produces: `provision.router` with route `POST /widgets/{widget_id}/provision` → `200 {"channelRoutes": {channelId: url}}`

- [ ] **Step 1: Write the failing tests**

```python
from server.tests.conftest import FMF_MANIFEST, FLIGHTS_MANIFEST


def test_provision_returns_channel_routes(client):
    r = client.post("/widgets/find-my-friends/provision", json={"manifest": FMF_MANIFEST})
    assert r.status_code == 200
    routes = r.json()["channelRoutes"]
    assert routes["fmfW"].endswith("/widgets/find-my-friends/channels/fmfW")
    assert routes["fmfR"].endswith("/widgets/find-my-friends/channels/fmfR")


def test_provision_is_idempotent(client):
    r1 = client.post("/widgets/find-my-friends/provision", json={"manifest": FMF_MANIFEST})
    r2 = client.post("/widgets/find-my-friends/provision", json={"manifest": FMF_MANIFEST})
    assert r1.status_code == 200
    assert r1.json() == r2.json()


def test_provision_rejects_id_mismatch(client):
    r = client.post("/widgets/other-widget/provision", json={"manifest": FMF_MANIFEST})
    assert r.status_code == 400


def test_provision_starts_external_poller(client):
    async def noop(widget_id, channel):
        return None

    client.app.state.poller._fetch_once = noop
    r = client.post("/widgets/flights-nyc/provision", json={"manifest": FLIGHTS_MANIFEST})
    assert r.status_code == 200
    assert ("flights-nyc", "flights_nyc") in client.app.state.poller.tasks
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest server/tests/test_provision.py -v`
Expected: FAIL (route not registered)

- [ ] **Step 3: Implement `server/app/provision.py`**

```python
"""Idempotent channel provisioning (CONTRACTS.md §8, SPEC §9.1)."""

import json
import time

import jsonschema
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from shared.schema import validate_manifest
from .db import get_db

router = APIRouter()


class ProvisionRequest(BaseModel):
    manifest: dict


def _route(base_url, widget_id, channel_id):
    return f"{base_url}/widgets/{widget_id}/channels/{channel_id}"


@router.post("/widgets/{widget_id}/provision")
async def provision_widget(widget_id: str, body: ProvisionRequest, request: Request, db=Depends(get_db)):
    manifest = body.manifest
    try:
        validate_manifest(manifest)
    except jsonschema.ValidationError as exc:
        raise HTTPException(status_code=400, detail=f"invalid manifest: {exc.message}")
    if manifest["id"] != widget_id:
        raise HTTPException(status_code=400, detail="manifest id does not match URL")

    existing = db.execute(
        "SELECT channel_id FROM channels WHERE widget_id = ?", (widget_id,)
    ).fetchall()
    base_url = str(request.base_url).rstrip("/")

    if existing:
        return {
            "channelRoutes": {
                row["channel_id"]: _route(base_url, widget_id, row["channel_id"]) for row in existing
            }
        }

    channel_routes = {}
    now = time.time()
    for channel in manifest["server"]["channels"]:
        db.execute(
            "INSERT INTO channels (widget_id, channel_id, config, provisioned_at) VALUES (?, ?, ?, ?)",
            (widget_id, channel["id"], json.dumps(channel), now),
        )
        channel_routes[channel["id"]] = _route(base_url, widget_id, channel["id"])
    db.commit()

    poller = request.app.state.poller
    for channel in manifest["server"]["channels"]:
        if channel["origin"] == "external":
            poller.start(widget_id, channel)

    return {"channelRoutes": channel_routes}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest server/tests/test_provision.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/app/provision.py server/tests/test_provision.py
git commit -m "feat(server): idempotent provisioning and route builder"
```

---

## Task 10: Hardening and contract sweep

**Files:**
- Modify: `server/tests/test_db.py` (add startup-reload test) — or add to `server/tests/test_poller.py`
- No production code changes expected; this task verifies and fixes gaps.

**Interfaces:**
- Consumes: everything above.
- Produces: a green full test suite and confirmed error shapes.

- [ ] **Step 1: Add a startup-reload test to `server/tests/test_poller.py`**

```python
import json


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
```

- [ ] **Step 2: Run it to verify it fails (if it does), then make it pass**

Run: `pytest server/tests/test_poller.py::test_start_all_resumes_external_channels_on_startup -v`
Expected: PASS (Task 8 already implemented `start_all`); if FAIL, fix `Poller.start_all`.

- [ ] **Step 3: Add an error-shape sweep to `server/tests/test_channels.py`**

```python
def test_error_bodies_are_uniform(client, db):
    _provision_fmf(db)
    token = _token(client)
    assert client.get("/widgets/nope/channels/x").json() == {"error": "channel not found"}
    assert (
        client.get(f"/widgets/find-my-friends/channels/fmfR/instances/{token}", params={"ids": "x"}).status_code
        == 200
    )
    # bathrooms mapping has no 'time' field -> since is undeclared -> 400
    from server.tests.conftest import BATHROOMS_MANIFEST

    insert_channel(db, "nyc-bathrooms", BATHROOMS_MANIFEST["server"]["channels"][0])
    r = client.get("/widgets/nyc-bathrooms/channels/nyc_bathrooms", params={"since": "100"})
    assert r.status_code == 400
    assert "error" in r.json()
```

- [ ] **Step 4: Run the full suite**

Run: `pytest -q`
Expected: PASS (shared + server tests, no warnings-as-errors)

- [ ] **Step 5: Verify the Docker build and compose file**

Run:
```bash
docker compose config
```
Expected: valid compose file, `server` and `agent` services resolve. (If Docker is unavailable in this environment, skip and note it in the commit message.)

- [ ] **Step 6: Commit**

```bash
git add server/tests/
git commit -m "test(server): startup reload and uniform error shape coverage"
```

---

## Self-Review Notes (for the executor, already checked)

- **Spec coverage:** registry (§8 publish/gallery/install), provision (§9.1), instances (§9.2), channel handlers + privacy (§8, §9.4), filter engine (§9, §11), poller + SSRF + retention (§10), secrets (§12.2), CORS + error shapes (§14) all map to tasks 1–10.
- **Type consistency:** `store_records` signature is identical across `records.py`, `channels.py`, and `poller.py`. `query_records`/`parse_filters`/`validate_filters` names match between `filter.py` and `channels.py`. The poller task key is `(widget_id, channel["id"])` everywhere.
- **Known, accepted limits (do not "fix"):** external channels are public-read only in practice (a `private` external channel would store under `instance_token NULL` and be unreachable via the token route); filtering is done in Python (fine at demo scale); raw string bodies are sent as-is per contract.
