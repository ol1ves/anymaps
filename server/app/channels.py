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
