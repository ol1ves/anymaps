"""Idempotent channel provisioning (CONTRACTS.md §8, SPEC §9.1)."""

import json
import logging
import sqlite3
import time

import jsonschema
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from shared.schema import ManifestChannelError, validate_channel_matrix, validate_manifest
from .db import get_db

logger = logging.getLogger("anymaps.server")

router = APIRouter()


class ProvisionRequest(BaseModel):
    manifest: dict


def _route(base_url, widget_id, channel_id):
    return f"{base_url}/widgets/{widget_id}/channels/{channel_id}"


@router.post("/widgets/{widget_id}/provision")
async def provision_widget(widget_id: str, body: ProvisionRequest, request: Request, db=Depends(get_db)):
    """Provision channels for a widget. Idempotent and first-wins: if the widget
    is already provisioned the stored routes are returned and no new channels or
    pollers are created, even when the incoming manifest differs (SPEC §9.1)."""
    manifest = body.manifest
    try:
        validate_manifest(manifest)
    except jsonschema.ValidationError as exc:
        raise HTTPException(status_code=400, detail=f"invalid manifest: {exc.message}")
    if manifest["id"] != widget_id:
        raise HTTPException(status_code=400, detail="manifest id does not match URL")

    try:
        validate_channel_matrix(manifest)
    except ManifestChannelError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    existing = db.execute(
        "SELECT channel_id FROM channels WHERE widget_id = ?", (widget_id,)
    ).fetchall()
    base_url = str(request.base_url).rstrip("/")

    if existing:
        stored_ids = {row["channel_id"] for row in existing}
        incoming_ids = {channel["id"] for channel in manifest["server"]["channels"]}
        if incoming_ids != stored_ids:
            logger.warning(
                "re-provision of %s differs from stored channels (first-wins): incoming=%s stored=%s",
                widget_id,
                sorted(incoming_ids),
                sorted(stored_ids),
            )
        return {
            "channelRoutes": {
                row["channel_id"]: _route(base_url, widget_id, row["channel_id"]) for row in existing
            }
        }

    channel_routes = {}
    now = time.time()
    try:
        for channel in manifest["server"]["channels"]:
            db.execute(
                "INSERT INTO channels (widget_id, channel_id, config, provisioned_at) VALUES (?, ?, ?, ?)",
                (widget_id, channel["id"], json.dumps(channel), now),
            )
            channel_routes[channel["id"]] = _route(base_url, widget_id, channel["id"])
        db.commit()
    except sqlite3.IntegrityError:
        db.rollback()
        raise HTTPException(status_code=400, detail="duplicate channel id")

    poller = request.app.state.poller
    for channel in manifest["server"]["channels"]:
        if channel["origin"] == "external":
            poller.start(widget_id, channel)

    return {"channelRoutes": channel_routes}
