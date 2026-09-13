"""ASGI middleware for running a service behind a reverse-proxy path prefix.

The demo hosts the server and agent under /server and /agent on one domain.
Nginx Proxy Manager forwards the full path (including the prefix) to the
backend, but the FastAPI routes live at the root. This middleware:

  * strips the configured prefix from the request path before routing,
  * records the prefix as the ASGI root_path so absolute URLs (channel
    routes) include the prefix again,
  * trusts the proxy's X-Forwarded-Proto so those URLs use https.

Configure with the PATH_PREFIX environment variable. When it is empty the
middleware is a no-op, so local (non-proxied) runs are unaffected.
"""

from __future__ import annotations

import os


def create_prefix_strip_middleware(prefix_env: str = "PATH_PREFIX"):
    prefix = os.getenv(prefix_env, "").strip().rstrip("/")

    async def dispatch(request, call_next):
        if not prefix:
            return await call_next(request)

        forwarded_proto = request.headers.get("x-forwarded-proto")
        if forwarded_proto in ("http", "https"):
            request.scope["scheme"] = forwarded_proto

        # Always record the prefix so absolute URLs built from request.base_url
        # keep it, even when the proxy has already stripped the path.
        request.scope["root_path"] = prefix

        path = request.scope["path"]
        if path == prefix:
            request.scope["path"] = "/"
        elif path.startswith(prefix + "/"):
            request.scope["path"] = path[len(prefix):]

        return await call_next(request)

    return dispatch
