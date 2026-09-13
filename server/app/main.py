"""FastAPI app factory for the anymaps generic widget server."""

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import channels, db as db_module, instances, provision, registry, secrets as secrets_module
from .poller import Poller
from shared.proxy import create_prefix_strip_middleware

logger = logging.getLogger("anymaps.server")

def _parse_origins(raw: str) -> list[str]:
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


def allowed_origins() -> list[str]:
    raw = os.environ.get("ALLOWED_ORIGINS", "*")
    origins = _parse_origins(raw)
    if "*" in origins:
        return ["*"]
    return origins


def create_app(db_path: str | None = None) -> FastAPI:
    resolved_path = db_path or os.environ.get("DATABASE_PATH", "data/anymaps.db")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        poller = Poller(db_module.connect(resolved_path))
        app.state.poller = poller
        poller.start_all()
        yield
        await poller.shutdown()

    app = FastAPI(title="anymaps generic widget server", lifespan=lifespan)
    app.state.db_path = resolved_path

    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins(),
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.middleware("http")(create_prefix_strip_middleware())

    app.include_router(registry.router)
    app.include_router(provision.router)
    app.include_router(instances.router)
    app.include_router(channels.router)
    app.include_router(secrets_module.router)

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.exception_handler(StarletteHTTPException)
    async def http_exception_handler(request: Request, exc: StarletteHTTPException):
        return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(request: Request, exc: RequestValidationError):
        return JSONResponse(status_code=400, content={"error": "malformed body"})

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        logger.exception("unhandled error")
        return JSONResponse(status_code=500, content={"error": "internal server error"})

    return app


app = create_app()
