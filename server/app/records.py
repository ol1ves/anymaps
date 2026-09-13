"""Record extraction, indexing, and cache storage (the write path)."""

import json

import jmespath


def _to_float(value):
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _to_str(value):
    if value is None:
        return None
    return str(value)


def index_fields(mapping, record, ingested_at):
    """Return (id_key, lat, lon, time) extracted from one record."""
    if not mapping:
        return None, None, None, None
    id_key = _to_str(jmespath.search(mapping["id"], record)) if mapping.get("id") else None
    lat = _to_float(jmespath.search(mapping["lat"], record)) if mapping.get("lat") else None
    lon = _to_float(jmespath.search(mapping["lon"], record)) if mapping.get("lon") else None
    t = mapping.get("time")
    if t == "@ingestedAt":
        time_value = ingested_at
    elif t:
        time_value = _to_float(jmespath.search(t, record))
    else:
        time_value = None
    return id_key, lat, lon, time_value


def extract_records(channel, body):
    """Turn a fetched/request body into the list of whole records to cache."""
    mapping = channel.get("record")
    if channel["origin"] == "external":
        records_path = (mapping or {}).get("records")
        if records_path:
            found = jmespath.search(records_path, body)
            if found is None:
                return []
            if not isinstance(found, list):
                raise ValueError("record.records must resolve to a list")
            return found
        return [body]
    return [body]


def accumulation_mode(channel):
    if channel["origin"] == "external":
        return channel.get("external", {}).get("mode", "snapshot")
    return channel.get("mode", "series")


def retain_seconds(channel):
    if channel["origin"] == "external":
        return channel.get("external", {}).get("retain", 3600)
    return channel.get("retain", 3600)


def store_records(db, widget_id, channel_id, instance_token, channel, records, ingested_at):
    if accumulation_mode(channel) == "snapshot":
        db.execute(
            "DELETE FROM records WHERE widget_id = ? AND channel_id = ? AND instance_token IS ?",
            (widget_id, channel_id, instance_token),
        )
    mapping = channel.get("record")
    for record in records:
        id_key, lat, lon, time_value = index_fields(mapping, record, ingested_at)
        db.execute(
            "INSERT INTO records "
            "(widget_id, channel_id, instance_token, payload, id_key, lat, lon, time, ingested_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (widget_id, channel_id, instance_token, json.dumps(record), id_key, lat, lon, time_value, ingested_at),
        )
    if accumulation_mode(channel) == "series":
        db.execute(
            "DELETE FROM records WHERE widget_id = ? AND channel_id = ? AND instance_token IS ? AND ingested_at < ?",
            (widget_id, channel_id, instance_token, ingested_at - retain_seconds(channel)),
        )
    db.commit()
