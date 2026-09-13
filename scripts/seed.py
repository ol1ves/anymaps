#!/usr/bin/env python3
"""Seed the anymaps widget registry from the widgets/ folder.

Scans WIDGETS_DIR for subfolders. A folder is a widget when it contains both
manifest.json and bundle.js. Publishes each widget to the running generic
widget server with POST /widgets. The widget list is discovered at runtime;
the script hardcodes no widget ids and is not limited to any fixed count.

Usage:
    python scripts/seed.py [--server URL] [--dir PATH] [--only WIDGET_ID]
                           [--dry-run]

Exit codes:
    0  every widget was published, or was already published (409).
    1  at least one widget failed to publish (error other than 409, or the
       server was unreachable).
    2  the widgets directory could not be read or a manifest was invalid.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import httpx

MANIFEST_NAME = "manifest.json"
BUNDLE_NAME = "bundle.js"
DEFAULT_SERVER = "http://localhost:8000"
DEFAULT_DIR = "widgets"


class DiscoveryError(RuntimeError):
    """The widgets directory could not be read or a manifest was invalid."""


@dataclass(frozen=True)
class Widget:
    folder: Path
    manifest: dict
    bundle: str

    @property
    def id(self) -> str:
        return self.manifest["id"]

    @property
    def version(self) -> str:
        return self.manifest["version"]


@dataclass(frozen=True)
class Result:
    widget_id: str
    version: str
    status: str  # "published" | "already-published" | "failed" | "dry-run"
    detail: str = ""


def discover_widgets(widgets_dir: Path) -> list[Widget]:
    """Return one Widget per subfolder that holds a manifest and a bundle."""
    if not widgets_dir.is_dir():
        raise DiscoveryError(f"widgets dir not found: {widgets_dir}")

    found: list[Widget] = []
    for folder in sorted(p for p in widgets_dir.iterdir() if p.is_dir()):
        manifest_path = folder / MANIFEST_NAME
        bundle_path = folder / BUNDLE_NAME
        if not manifest_path.is_file() or not bundle_path.is_file():
            continue
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise DiscoveryError(f"invalid JSON in {manifest_path}: {exc}") from exc
        if not isinstance(manifest, dict):
            raise DiscoveryError(f"manifest is not an object: {manifest_path}")
        if not isinstance(manifest.get("id"), str) or not isinstance(manifest.get("version"), str):
            raise DiscoveryError(f"manifest missing string id/version: {manifest_path}")
        bundle = bundle_path.read_text(encoding="utf-8")
        found.append(Widget(folder=folder, manifest=manifest, bundle=bundle))
    return found


def publish_one(client: httpx.Client, server_url: str, widget: Widget) -> Result:
    url = f"{server_url.rstrip('/')}/widgets"
    try:
        response = client.post(
            url, json={"manifest": widget.manifest, "bundle": widget.bundle}
        )
    except httpx.RequestError as exc:
        return Result(widget.id, widget.version, "failed", f"request failed: {exc}")

    if response.status_code == 201:
        return Result(widget.id, widget.version, "published")
    if response.status_code == 409:
        return Result(widget.id, widget.version, "already-published", "version exists")

    detail = ""
    try:
        body = response.json()
        if isinstance(body, dict):
            detail = str(body.get("error") or body.get("detail") or "")
    except ValueError:
        detail = response.text[:200]
    return Result(
        widget.id,
        widget.version,
        "failed",
        f"HTTP {response.status_code} {detail}".strip(),
    )


def seed(
    server_url: str,
    widgets_dir: Path,
    only: str | None = None,
    dry_run: bool = False,
    *,
    transport: httpx.BaseTransport | None = None,
) -> list[Result]:
    """Discover widgets and publish each one. Returns one Result per widget."""
    widgets = discover_widgets(widgets_dir)
    if only is not None:
        widgets = [w for w in widgets if w.id == only]
        if not widgets:
            raise DiscoveryError(f"no widget with id {only!r} in {widgets_dir}")

    if dry_run:
        return [
            Result(
                w.id,
                w.version,
                "dry-run",
                f"would publish from {w.folder.name}",
            )
            for w in widgets
        ]

    results: list[Result] = []
    with httpx.Client(timeout=30.0, transport=transport) as client:
        for widget in widgets:
            results.append(publish_one(client, server_url, widget))
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Publish every widget in the widgets/ folder to the server."
    )
    parser.add_argument("--server", default=DEFAULT_SERVER, help="server origin")
    parser.add_argument("--dir", default=DEFAULT_DIR, help="widgets folder")
    parser.add_argument("--only", default=None, help="publish only this widget id")
    parser.add_argument("--dry-run", action="store_true", help="list without publishing")
    args = parser.parse_args(argv)

    try:
        results = seed(
            args.server, Path(args.dir), only=args.only, dry_run=args.dry_run
        )
    except DiscoveryError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if not results:
        print(f"No widgets found in {args.dir}")
        return 0

    for r in results:
        if r.status == "published":
            print(f"published  {r.widget_id}@{r.version}")
        elif r.status == "already-published":
            print(f"skipped    {r.widget_id}@{r.version} (already published)")
        elif r.status == "dry-run":
            print(f"dry-run    {r.widget_id}@{r.version} ({r.detail})")
        else:
            print(f"FAILED     {r.widget_id}@{r.version}: {r.detail}")

    failed = [r for r in results if r.status == "failed"]
    if failed:
        print(f"\n{len(failed)} of {len(results)} widget(s) failed.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
