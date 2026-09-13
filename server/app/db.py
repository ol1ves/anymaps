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
