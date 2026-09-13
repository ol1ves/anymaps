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
