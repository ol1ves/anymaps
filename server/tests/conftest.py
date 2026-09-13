import json

import pytest
from fastapi.testclient import TestClient

from server.app.db import connect
from server.app.main import create_app

FMF_MANIFEST = {
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

FLIGHTS_MANIFEST = {
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

BATHROOMS_MANIFEST = {
    "id": "nyc-bathrooms",
    "name": "NYC Bathrooms",
    "version": "0.1.0",
    "description": "Public restrooms in NYC",
    "server": {
        "channels": [
            {
                "id": "nyc_bathrooms",
                "origin": "external",
                "direction": "read",
                "visibility": "public",
                "external": {
                    "method": "POST",
                    "url": "https://overpass-api.de/api/interpreter",
                    "body": '[out:json];node["amenity"="toilets"](40.47,-74.26,40.92,-73.70);out;',
                    "interval": 86400,
                    "mode": "snapshot",
                    "record": {"records": "elements", "id": "id", "lat": "lat", "lon": "lon"},
                },
            }
        ]
    },
}


@pytest.fixture
def client(tmp_path):
    app = create_app(str(tmp_path / "test.db"))
    with TestClient(app) as c:
        yield c


@pytest.fixture
def db(client):
    conn = connect(client.app.state.db_path)
    try:
        yield conn
    finally:
        conn.close()


def insert_channel(db, widget_id, channel):
    db.execute(
        "INSERT INTO channels (widget_id, channel_id, config, provisioned_at) VALUES (?, ?, ?, ?)",
        (widget_id, channel["id"], json.dumps(channel), 1000.0),
    )
    db.commit()
