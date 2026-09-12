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
