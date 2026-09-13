// Polyline commands (Task 3). Contract: CONTRACTS.md section 4 (polyline
// rows), section 12 (z-order), section 13 (coordinate order).
//
// register(ctx) wires addPolyline/updatePolyline/removePolyline and extends
// ctx.reorder so the widget's layers move to the top on enable/re-enable.
// Per widget: Map<id, { sourceId, layerId, points, color, width }>.
// Coordinate translation [[lat,lng],...] -> [[lng,lat],...] happens here only,
// at the MapLibre boundary.

import {
  addPolyline as validateAdd,
  updatePolyline as validateUpdate,
  removePolyline as validateRemove,
} from "../validate.js";

const DEFAULT_COLOR = "#3b82f6";
const DEFAULT_WIDTH = 3;

// widgetId -> Map<polylineId, { sourceId, layerId, points, color, width }>
const stores = new Map();

function storeFor(widgetId) {
  let m = stores.get(widgetId);
  if (!m) { m = new Map(); stores.set(widgetId, m); }
  return m;
}

function layerIdFor(id) { return "anymaps-polyline-" + id; }
function sourceIdFor(id) { return "anymaps-polyline-src-" + id; }

// [[lat,lng],...] -> GeoJSON LineString coordinates [[lng,lat],...].
function toGeoJSON(points) {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: points.map(([lat, lng]) => [lng, lat]) },
  };
}

function addLayer(ctx, widgetId, id, data, color, width) {
  const sourceId = sourceIdFor(id);
  const lid = layerIdFor(id);
  ctx.map.addSource(sourceId, { type: "geojson", data });
  ctx.map.addLayer({
    id: lid,
    type: "line",
    source: sourceId,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": color ?? DEFAULT_COLOR,
      "line-width": width ?? DEFAULT_WIDTH,
    },
  });
}

export function register(ctx) {
  ctx.registerCommand("addPolyline", (payload, widgetId) => {
    const err = validateAdd(payload);
    if (err) throw new Error(err);

    const store = storeFor(widgetId);
    // Replace an existing polyline with the same id rather than double-draw.
    const prev = store.get(payload.id);
    if (prev) {
      if (ctx.map.getLayer(prev.layerId)) ctx.map.removeLayer(prev.layerId);
      if (ctx.map.getSource(prev.sourceId)) ctx.map.removeSource(prev.sourceId);
    }

    const color = payload.color ?? DEFAULT_COLOR;
    const width = payload.width ?? DEFAULT_WIDTH;
    const data = toGeoJSON(payload.points);
    addLayer(ctx, widgetId, payload.id, data, color, width);

    const rec = {
      sourceId: sourceIdFor(payload.id),
      layerId: layerIdFor(payload.id),
      points: payload.points.map((p) => [...p]),
      color,
      width,
    };
    store.set(payload.id, rec);

    ctx.track(widgetId, "polyline", payload.id, () => {
      const m = ctx.map;
      if (m.getLayer(rec.layerId)) m.removeLayer(rec.layerId);
      if (m.getSource(rec.sourceId)) m.removeSource(rec.sourceId);
      store.delete(payload.id);
    });

    ctx.reorder(widgetId);
  });

  ctx.registerCommand("updatePolyline", (payload, widgetId) => {
    const err = validateUpdate(payload);
    if (err) throw new Error(err);

    const store = storeFor(widgetId);
    const rec = store.get(payload.id);
    if (!rec) throw new Error("polyline not found");

    if ("points" in payload) {
      rec.points = payload.points.map((p) => [...p]);
    }
    if ("append" in payload) {
      for (const p of payload.append) rec.points.push([...p]);
    }
    if ("color" in payload) rec.color = payload.color;
    if ("width" in payload) rec.width = payload.width;

    const m = ctx.map;
    if (m.getSource(rec.sourceId)) {
      m.getSource(rec.sourceId).setData(toGeoJSON(rec.points));
    }
    if ("color" in payload && m.getLayer(rec.layerId)) {
      m.setPaintProperty(rec.layerId, "line-color", rec.color);
    }
    if ("width" in payload && m.getLayer(rec.layerId)) {
      m.setPaintProperty(rec.layerId, "line-width", rec.width);
    }
  });

  ctx.registerCommand("removePolyline", (payload, widgetId) => {
    const err = validateRemove(payload);
    if (err) throw new Error(err);

    const store = storeFor(widgetId);
    const rec = store.get(payload.id);
    // Unknown id: ignore silently (idempotent, fire-and-forget).
    if (!rec) return;
    const m = ctx.map;
    if (m.getLayer(rec.layerId)) m.removeLayer(rec.layerId);
    if (m.getSource(rec.sourceId)) m.removeSource(rec.sourceId);
    store.delete(payload.id);
    // The tracked removeFn is idempotent; cleanup will no-op on this id.
  });

  // Re-apply z-order to all of this widget's polylines: move each layer to
  // the top. The manager owns the enable-order counter; markers.js sets
  // marker element z-index. We wrap the upstream reorder (markers.js) and
  // call it first so both markers and polylines reorder per widget.
  const upstream = ctx.reorder;
  ctx.reorder = (widgetId) => {
    if (upstream) upstream(widgetId);
    const m = ctx.map;
    for (const { layerId } of storeFor(widgetId).values()) {
      if (m.getLayer(layerId)) m.moveLayer(layerId);
    }
  };
}
