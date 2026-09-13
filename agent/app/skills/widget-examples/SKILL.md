---
name: widget-examples
description: Concrete worked examples of the wizard's clarifying and completed JSON responses, a valid manifest, and a valid bundle. Always active.
---

# Widget Wizard Worked Examples

Copy these shapes exactly. They are the only output formats that parse.

## Clarifying response

```json
{"done": false, "questions": ["Drinking water (amenity=drinking_water) or decorative fountains (amenity=fountain)?"]}
```

## Completed response

Top-level keys only: `done`, `widgetId`, `version`, `manifest`, `bundle`.
`widgetId` must equal `manifest.id`; `version` must equal `manifest.version`.
`bundle` is one JavaScript string.

```json
{
  "done": true,
  "widgetId": "water-fountains-nyc",
  "version": "1.0.0",
  "manifest": {
    "id": "water-fountains-nyc",
    "name": "NYC Water Fountains",
    "version": "1.0.0",
    "description": "Drinking water fountains in New York City",
    "server": {
      "channels": [
        {
          "id": "water",
          "origin": "external",
          "direction": "read",
          "visibility": "public",
          "external": {
            "method": "POST",
            "url": "https://overpass-api.de/api/interpreter",
            "body": "[out:json];node[\"amenity\"=\"drinking_water\"](40.47,-74.26,40.92,-73.70);out;",
            "interval": 86400,
            "mode": "snapshot",
            "record": { "records": "elements", "id": "id", "lat": "lat", "lon": "lon" }
          }
        }
      ]
    }
  },
  "bundle": "(async function () {\n  const { config } = await anymaps.ready();\n  const route = config.channelRoutes && config.channelRoutes.water;\n  if (!route) { anymaps.setPanel({ title: 'Water', content: 'Channel unavailable.' }); return; }\n  async function refresh(bounds) {\n    const url = new URL(route);\n    if (Array.isArray(bounds) && bounds.length === 2) {\n      url.searchParams.set('bounds', [bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1]].join(','));\n    }\n    const res = await fetch(url.toString());\n    const body = await res.json();\n    const records = Array.isArray(body.records) ? body.records : [];\n    for (const r of records) {\n      if (r.id === undefined || !Number.isFinite(Number(r.lat)) || !Number.isFinite(Number(r.lon))) continue;\n      anymaps.addMarker({ id: String(r.id), lat: Number(r.lat), lng: Number(r.lon), title: 'Water' });\n    }\n    anymaps.setPanel({ title: 'Water', content: records.length + ' fountains' });\n  }\n  anymaps.on('viewportChanged', ({ bounds }) => refresh(bounds));\n  await refresh(null);\n})();"
}
```
