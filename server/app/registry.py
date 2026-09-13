"""Registry routes: publish, gallery, install (CONTRACTS.md §8)."""

import json
import time

import jsonschema
from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel

from shared.schema import ManifestChannelError, validate_channel_matrix, validate_manifest
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
        validate_channel_matrix(manifest)
    except jsonschema.ValidationError as exc:
        raise HTTPException(status_code=400, detail=f"invalid manifest: {exc.message}")
    except ManifestChannelError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

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
    # One entry per widget: the most recently inserted (published) version.
    rows = db.execute(
        "SELECT widget_id AS id, name, version, description, icon "
        "FROM widgets "
        "WHERE rowid IN (SELECT MAX(rowid) FROM widgets GROUP BY widget_id)"
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
