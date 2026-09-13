import pytest

from server.app.db import connect
from server.app import filter as filter_mod
from server.app import records

CHANNEL = {
    "id": "c",
    "origin": "external",
    "direction": "read",
    "visibility": "public",
    "external": {"mode": "series", "retain": 3600},
    "record": {"records": "ac", "id": "hex", "lat": "lat", "lon": "lon", "time": "@ingestedAt"},
}


def test_parse_bounds():
    filters = filter_mod.parse_filters({"bounds": "40.5,-74.3,40.9,-73.7"})
    assert filters["bounds"] == (40.5, -74.3, 40.9, -73.7)


def test_parse_bounds_rejects_bad_shape():
    with pytest.raises(filter_mod.FilterError):
        filter_mod.parse_filters({"bounds": "1,2,3"})


def test_parse_latest_flag():
    assert filter_mod.parse_filters({"latest": "1"})["latest"] is True


def test_parse_latest_rejects_other_values():
    for bad in ("0", "true", "True", ""):
        with pytest.raises(filter_mod.FilterError):
            filter_mod.parse_filters({"latest": bad})


def test_validate_requires_declared_fields():
    with pytest.raises(filter_mod.FilterError):
        filter_mod.validate_filters({}, {"bounds": (0, 0, 1, 1)})


def test_query_latest_then_bounds(tmp_path):
    db = connect(str(tmp_path / "t.db"))
    records.store_records(db, "w", "c", None, CHANNEL, [{"hex": "a", "lat": 40.7, "lon": -74.0}], 100.0)
    records.store_records(db, "w", "c", None, CHANNEL, [{"hex": "a", "lat": 40.8, "lon": -74.1}], 200.0)
    records.store_records(db, "w", "c", None, CHANNEL, [{"hex": "b", "lat": 41.0, "lon": -73.0}], 300.0)

    mapping = CHANNEL["record"]
    filters = filter_mod.parse_filters({"latest": "1", "bounds": "40.0,-75.0,40.9,-73.0"})
    result = filter_mod.query_records(db, "w", "c", None, mapping, filters)

    assert [r["hex"] for r in result] == ["a"]
    assert result[0]["lat"] == 40.8
    db.close()


def test_query_latest_preserves_ascending_time_order(tmp_path):
    db = connect(str(tmp_path / "t.db"))
    records.store_records(db, "w", "c", None, CHANNEL, [{"hex": "a"}], 100.0)
    records.store_records(db, "w", "c", None, CHANNEL, [{"hex": "a"}], 400.0)
    records.store_records(db, "w", "c", None, CHANNEL, [{"hex": "b"}], 200.0)
    records.store_records(db, "w", "c", None, CHANNEL, [{"hex": "b"}], 300.0)

    mapping = CHANNEL["record"]
    filters = filter_mod.parse_filters({"latest": "1"})
    result = filter_mod.query_records(db, "w", "c", None, mapping, filters)
    assert [r["hex"] for r in result] == ["b", "a"]
    db.close()


def test_query_ids_since_until(tmp_path):
    db = connect(str(tmp_path / "t.db"))
    records.store_records(db, "w", "c", None, CHANNEL, [{"hex": "a"}], 100.0)
    records.store_records(db, "w", "c", None, CHANNEL, [{"hex": "b"}], 200.0)
    records.store_records(db, "w", "c", None, CHANNEL, [{"hex": "c"}], 300.0)

    mapping = CHANNEL["record"]
    filters = filter_mod.parse_filters({"ids": "a,c", "since": "150", "until": "350"})
    result = filter_mod.query_records(db, "w", "c", None, mapping, filters)
    assert sorted(r["hex"] for r in result) == ["c"]
    db.close()
