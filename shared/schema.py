"""Load and validate widget manifests against contracts/manifest.schema.json."""

import json
from pathlib import Path

import jsonschema

_SCHEMA_PATH = Path(__file__).resolve().parent.parent / "contracts" / "manifest.schema.json"


def load_manifest_schema() -> dict:
    with open(_SCHEMA_PATH, encoding="utf-8") as f:
        return json.load(f)


def validate_manifest(manifest: dict) -> None:
    """Raise jsonschema.ValidationError when the manifest is invalid."""
    jsonschema.validate(
        instance=manifest,
        schema=load_manifest_schema(),
        format_checker=jsonschema.FormatChecker(),
    )


class ManifestChannelError(ValueError):
    """A cross-channel manifest invariant failed.

    JSON Schema cannot express constraints between sibling channel objects
    (unique ids, a client-read's ``source`` resolving to a client-write
    channel, read/write visibility agreement), so these are enforced here and
    by the server at publish and provision time.
    """


def validate_channel_matrix(manifest: dict) -> None:
    """Raise ManifestChannelError when cross-channel invariants are violated.

    Assumes the manifest already passed ``validate_manifest``, so the channel
    objects have their required fields.
    """
    channels = manifest["server"]["channels"]
    ids = [channel["id"] for channel in channels]
    if len(set(ids)) != len(ids):
        raise ManifestChannelError("duplicate channel id")

    by_id = {channel["id"]: channel for channel in channels}
    for channel in channels:
        if channel["origin"] == "client" and channel["direction"] == "read":
            target = by_id.get(channel["source"])
            if target is None or target["origin"] != "client" or target["direction"] != "write":
                raise ManifestChannelError("source channel not found")
            if channel["visibility"] != target["visibility"]:
                raise ManifestChannelError(
                    "read channel visibility must match its source write channel"
                )
