"""Instance (room) creation (CONTRACTS.md §8)."""

import secrets
import time

from fastapi import APIRouter, Depends, HTTPException

from .db import get_db

router = APIRouter()


@router.post("/widgets/{widget_id}/instances", status_code=201)
def create_instance(widget_id: str, db=Depends(get_db)):
    row = db.execute(
        "SELECT 1 FROM channels WHERE widget_id = ?", (widget_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="widget not found")
    token = secrets.token_hex(16)  # 128 bits -> 32 hex chars
    db.execute(
        "INSERT INTO instances (token, widget_id, created_at) VALUES (?, ?, ?)",
        (token, widget_id, time.time()),
    )
    db.commit()
    return {"instanceToken": token}
