import copy

import jsonschema
import pytest

from shared.schema import validate_manifest

# The Find My Friends manifest from CONTRACTS.md section 8.4, trimmed.
FMF = {
    "id": "find-my-friends",
    "name": "Find My Friends",
    "version": "0.1.0",
    "description": "Share live locations with friends",
    "server": {
        "channels": [
            {
                "id": "fmfW",
                "origin": "client",
                "direction": "write",
                "visibility": "private",
                "mode": "series",
                "retain": 3600,
                "record": {"id": "clientId", "lat": "lat", "lon": "lng", "time": "ts"},
            },
            {
                "id": "fmfR",
                "origin": "client",
                "direction": "read",
                "visibility": "private",
                "source": "fmfW",
            },
        ]
    },
}

FLIGHTS = {
    "id": "flights-nyc",
    "name": "Flights NYC",
    "version": "0.1.0",
    "description": "Live planes near New York",
    "server": {
        "channels": [
            {
                "id": "flights_nyc",
                "origin": "external",
                "direction": "read",
                "visibility": "public",
                "external": {
                    "method": "GET",
                    "url": "https://api.adsb.lol/v2/point/40.71/-74.0/250",
                    "interval": 5,
                    "mode": "series",
                    "retain": 3600,
                    "record": {
                        "records": "ac",
                        "id": "hex",
                        "lat": "lat",
                        "lon": "lon",
                        "time": "@ingestedAt",
                    },
                },
            }
        ]
    },
}


def test_valid_client_channels():
    validate_manifest(FMF)


def test_valid_external_channel():
    validate_manifest(FLIGHTS)


def test_rejects_external_write():
    m = copy.deepcopy(FLIGHTS)
    m["server"]["channels"][0]["direction"] = "write"
    with pytest.raises(jsonschema.ValidationError):
        validate_manifest(m)


def test_rejects_client_read_without_source():
    m = copy.deepcopy(FMF)
    del m["server"]["channels"][1]["source"]
    with pytest.raises(jsonschema.ValidationError):
        validate_manifest(m)


def test_rejects_bad_semver():
    m = copy.deepcopy(FMF)
    m["version"] = "1.0"
    with pytest.raises(jsonschema.ValidationError):
        validate_manifest(m)


def test_rejects_unknown_top_level_field():
    m = copy.deepcopy(FMF)
    m["extra"] = True
    with pytest.raises(jsonschema.ValidationError):
        validate_manifest(m)


def test_rejects_missing_identity_fields():
    m = copy.deepcopy(FMF)
    del m["description"]
    with pytest.raises(jsonschema.ValidationError):
        validate_manifest(m)


def test_rejects_records_field_on_client_write():
    m = copy.deepcopy(FMF)
    m["server"]["channels"][0]["record"]["records"] = "items"
    with pytest.raises(jsonschema.ValidationError):
        validate_manifest(m)


def test_rejects_private_external_channel():
    m = copy.deepcopy(FLIGHTS)
    m["server"]["channels"][0]["visibility"] = "private"
    with pytest.raises(jsonschema.ValidationError):
        validate_manifest(m)
