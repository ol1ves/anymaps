"""External channel poller (SPEC §10): fetch, SSRF, cache, retention."""

import asyncio
import json
import logging
from urllib.parse import urljoin, urlparse

import httpx

from shared.ssrf import assert_source_url_allowed
from . import records

logger = logging.getLogger("anymaps.server")


class Poller:
    def __init__(self, db):
        self.db = db
        self.tasks = {}
        self.client = httpx.AsyncClient(timeout=10, follow_redirects=False)

    def start(self, widget_id, channel):
        key = (widget_id, channel["id"])
        if key in self.tasks and not self.tasks[key].done():
            return
        self.tasks[key] = asyncio.create_task(self._run(widget_id, channel))

    def start_all(self):
        rows = self.db.execute("SELECT widget_id, config FROM channels").fetchall()
        for row in rows:
            channel = json.loads(row["config"])
            if channel["origin"] == "external":
                self.start(row["widget_id"], channel)

    async def _run(self, widget_id, channel):
        interval = max(5, channel.get("external", {}).get("interval", 60))
        while True:
            try:
                await self._fetch_once(widget_id, channel)
            except Exception:
                logger.warning(
                    "poller fetch failed for %s/%s", widget_id, channel["id"], exc_info=True
                )  # keep last-good cache, retry next interval
            await asyncio.sleep(interval)

    async def _fetch_once(self, widget_id, channel):
        ext = channel["external"]
        body = await self._request(ext)
        from time import time as _now

        ingested_at = _now()
        recs = records.extract_records(channel, body)
        records.store_records(self.db, widget_id, channel["id"], None, channel, recs, ingested_at)

    async def _request(self, ext):
        method = ext.get("method", "GET")
        url = ext["url"]
        params = dict(ext.get("query") or {})
        headers = dict(ext.get("headers") or {})
        body = ext.get("body")

        auth_injected = None
        auth = ext.get("auth")
        if auth:
            row = self.db.execute(
                "SELECT value FROM secrets WHERE secret_id = ?", (auth["secret"],)
            ).fetchone()
            if row is None:
                raise ValueError(f"unknown secret: {auth['secret']}")
            value = row["value"]
            if auth.get("scheme"):
                value = auth["scheme"] + value
            if auth["type"] == "header":
                headers[auth["name"]] = value
                auth_injected = ("header", auth["name"])
            else:
                params[auth["name"]] = value
                auth_injected = ("query", auth["name"])

        for _ in range(5):
            assert_source_url_allowed(url)
            if isinstance(body, dict):
                response = await self.client.request(method, url, params=params, headers=headers, json=body)
            elif isinstance(body, str):
                response = await self.client.request(method, url, params=params, headers=headers, content=body)
            else:
                response = await self.client.request(method, url, params=params, headers=headers)
            if response.status_code in (301, 302, 303, 307, 308):
                location = response.headers.get("location")
                if not location:
                    raise ValueError("redirect without location header")
                if response.status_code == 303:
                    method = "GET"
                    body = None
                new_url = urljoin(url, location)
                if auth_injected and urlparse(new_url).hostname != urlparse(url).hostname:
                    kind, name = auth_injected
                    (headers if kind == "header" else params).pop(name, None)
                url = new_url
                continue
            response.raise_for_status()
            return response.json()
        raise ValueError("too many redirects")

    async def shutdown(self):
        for task in self.tasks.values():
            task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks.values(), return_exceptions=True)
        await self.client.aclose()
