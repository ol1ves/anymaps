"""Shared outbound HTTP defaults.

Some public APIs (notably Overpass/OSM) reject the default httpx User-Agent
("python-httpx/...") with HTTP 406, and OSM policy requires applications to
identify themselves. Both the Agent Service source test and the generic
server's poller use these helpers.
"""

from __future__ import annotations

DEFAULT_USER_AGENT = "anymaps/0.1"


def with_user_agent(headers: dict[str, str] | None) -> dict[str, str]:
    """Return headers including a default User-Agent unless one is already set."""

    headers = dict(headers or {})
    if not any(key.lower() == "user-agent" for key in headers):
        headers["User-Agent"] = DEFAULT_USER_AGENT
    return headers
