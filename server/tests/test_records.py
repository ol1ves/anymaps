import json

from server.app.db import connect
from server.app import records

EXTERNAL_CHANNEL = {
    "id": "flights_nyc",
    "origin": "external",
    "direction": "read",
    "visibility": "public",
    "external": {"mode": "series", "retain": 100},
    "record": {"records": "ac", "id": "hex", "lat": "lat", "lon": "lon", "time": "@ingestedAt"},
}


def test_extract_records_external_array():
    body = {"ac": [{"hex": "a"}, {"hex": "b"}]}
    assert records.extract_records(EXTERNAL_CHANNEL, body) == [{"hex": "a"}, {"hex": "b"}]


def test_extract_records_external_no_mapping_returns_whole_body():
    channel = {"id": "w", "origin": "external", "direction": "read", "visibility": "public"}
    assert records.extract_records(channel, {"a": 1}) == [{"a": 1}]


def test_extract_records_client_write_wraps_body():
    channel = {"id": "w", "origin": "client", "direction": "write", "visibility": "public"}
    body = {"clientId": "alice", "lat": 40.7, "lng": -74.0}
    assert records.extract_records(channel, body) == [body]


def test_index_fields_extracts_and_coerces():
    mapping = {"id": "hex", "lat": "lat", "lon": "lon", "time": "@ingestedAt"}
    rec = {"hex": 123, "lat": "40.7", "lon": "-74.0"}
    assert records.index_fields(mapping, rec, 1000.0) == ("123", 40.7, -74.0, 1000.0)


def test_index_fields_record_time_wins_over_ingested():
    mapping = {"id": "hex", "time": "ts"}
    rec = {"hex": "a", "ts": 1700000000}
    assert records.index_fields(mapping, rec, 1000.0) == ("a", None, None, 1700000000.0)


def test_store_snapshot_replaces_whole_bucket(tmp_path):
    db = connect(str(tmp_path / "t.db"))
    channel = {
        "id": "b",
        "origin": "external",
        "direction": "read",
        "visibility": "public",
        "external": {"mode": "snapshot"},
        "record": {"records": "elements", "id": "id"},
    }
    records.store_records(db, "w", "b", None, channel, [{"id": 1}, {"id": 2}], 100.0)
    records.store_records(db, "w", "b", None, channel, [{"id": 3}], 200.0)
    rows = db.execute(
        "SELECT payload FROM records WHERE widget_id='w' AND channel_id='b'"
    ).fetchall()
    assert [json.loads(r["payload"]) for r in rows] == [{"id": 3}]
    db.close()


def test_store_series_appends_then_prunes_by_ingested_at(tmp_path):
    db = connect(str(tmp_path / "t.db"))
    records.store_records(db, "w", "c", None, EXTERNAL_CHANNEL, [{"hex": "a"}], 100.0)
    records.store_records(db, "w", "c", None, EXTERNAL_CHANNEL, [{"hex": "b"}], 300.0)
    rows = db.execute(
        "SELECT payload, ingested_at FROM records WHERE widget_id='w' AND channel_id='c' ORDER BY ingested_at"
    ).fetchall()
    assert [json.loads(r["payload"]) for r in rows] == [{"hex": "b"}]
    db.close()


def test_accumulation_defaults():
    assert records.accumulation_mode({"origin": "external", "external": {}}) == "snapshot"
    assert records.accumulation_mode({"origin": "client", "mode": "snapshot"}) == "snapshot"
    assert records.accumulation_mode({"origin": "client"}) == "series"
