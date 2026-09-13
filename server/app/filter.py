"""Filter engine: parse, validate, and apply read filters (CONTRACTS.md §9)."""

import json


class FilterError(Exception):
    """Raised for malformed or undeclared filters; maps to HTTP 400."""


def parse_filters(query_params):
    filters = {}
    if "bounds" in query_params:
        filters["bounds"] = _parse_bounds(query_params["bounds"])
    if "ids" in query_params:
        ids = query_params["ids"]
        filters["ids"] = set(ids.split(",")) if ids else set()
    if "since" in query_params:
        filters["since"] = _parse_float("since", query_params["since"])
    if "until" in query_params:
        filters["until"] = _parse_float("until", query_params["until"])
    if "latest" in query_params:
        if query_params["latest"] != "1":
            raise FilterError("latest must be 1")
        filters["latest"] = True
    return filters


def _parse_bounds(value):
    parts = value.split(",")
    if len(parts) != 4:
        raise FilterError("bounds must be four floats: south,west,north,east")
    try:
        south, west, north, east = (float(p) for p in parts)
    except ValueError:
        raise FilterError("bounds must be four floats: south,west,north,east")
    if south > north or west > east:
        raise FilterError("bounds must satisfy south<=north and west<=east")
    return (south, west, north, east)


def _parse_float(name, value):
    try:
        return float(value)
    except ValueError:
        raise FilterError(f"{name} must be a number")


def validate_filters(mapping, filters):
    if "bounds" in filters and not (mapping.get("lat") and mapping.get("lon")):
        raise FilterError("bounds filter requires lat and lon in the record mapping")
    if "ids" in filters and not mapping.get("id"):
        raise FilterError("ids filter requires id in the record mapping")
    if ("since" in filters or "until" in filters) and not mapping.get("time"):
        raise FilterError("since/until filter requires time in the record mapping")
    if filters.get("latest") and not (mapping.get("id") and mapping.get("time")):
        raise FilterError("latest filter requires id and time in the record mapping")


def query_records(db, widget_id, channel_id, instance_token, mapping, filters):
    rows = db.execute(
        "SELECT payload, id_key, lat, lon, time FROM records "
        "WHERE widget_id = ? AND channel_id = ? AND instance_token IS ? "
        "ORDER BY time ASC",
        (widget_id, channel_id, instance_token),
    ).fetchall()

    items = [
        {
            "payload": row["payload"],
            "id_key": row["id_key"],
            "lat": row["lat"],
            "lon": row["lon"],
            "time": row["time"],
        }
        for row in rows
    ]

    # Composition order (CONTRACTS.md §9): latest, then bounds, ids, since, until.
    if filters.get("latest"):
        newest = {}
        for r in items:
            if r["id_key"] is None:
                continue
            current = newest.get(r["id_key"])
            if current is None or _later(r, current):
                newest[r["id_key"]] = r
        items = sorted(newest.values(), key=lambda r: (r["time"] is None, r["time"]))

    if "bounds" in filters:
        south, west, north, east = filters["bounds"]
        items = [
            r for r in items
            if r["lat"] is not None and r["lon"] is not None
            and south <= r["lat"] <= north and west <= r["lon"] <= east
        ]

    if "ids" in filters:
        wanted = filters["ids"]
        items = [r for r in items if r["id_key"] in wanted]

    if "since" in filters:
        s = filters["since"]
        items = [r for r in items if r["time"] is not None and r["time"] >= s]

    if "until" in filters:
        u = filters["until"]
        items = [r for r in items if r["time"] is not None and r["time"] <= u]

    return [json.loads(r["payload"]) for r in items]


def _later(a, b):
    if a["time"] is None:
        return False
    if b["time"] is None:
        return True
    return a["time"] > b["time"]
