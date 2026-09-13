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
