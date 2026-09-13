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
