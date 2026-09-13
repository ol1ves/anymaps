import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// Baseline map. This direct MapLibre call disappears once the WidgetManager
// takes over the map. The SDK (src/sdk/anymaps.js) becomes the only owner.
// Basemap: OpenFreeMap "bright" (free, no key, vector, streets + labels).
const NYC = { lat: 40.71, lng: -74.0 };

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/bright",
  center: [NYC.lng, NYC.lat],
  zoom: 12,
  pitch: 0,
  bearing: 0,
});

// Native controls. Attribution stays on the default control (bottom-right),
// which reads the tile source's required attribution.
map.addControl(new maplibregl.NavigationControl(), "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

map.on("load", () => {
  // Smoke-test marker so the GL render pipeline is confirmed at a glance.
  // TODO(A): remove this when the SDK lands and the WidgetManager owns markers.
  new maplibregl.Marker().setLngLat([NYC.lng - 0.02, NYC.lat + 0.02]).addTo(map);
});
