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
  attributionControl: false, // replaced by the compact control below
});

// Native controls. Navigation top-right, metric scale bottom-left.
map.addControl(new maplibregl.NavigationControl(), "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

// Compact attribution: a small ⓘ that expands to the required license links.
// Tile data requires OpenStreetMap attribution; the MapLibre logo is optional.
class CompactAttribution {
  onAdd() {
    const details = document.createElement("details");
    details.className = "maplibregl-ctrl anymaps-attrib";
    const summary = document.createElement("summary");
    summary.textContent = "ⓘ";
    summary.setAttribute("aria-label", "Attribution and licenses");
    const inner = document.createElement("div");
    inner.className = "anymaps-attrib-inner";
    inner.innerHTML =
      '© <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' +
      '© <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ' +
      'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
    details.append(summary, inner);
    this._container = details;
    return details;
  }
  onRemove() {
    this._container.remove();
  }
}
map.addControl(new CompactAttribution(), "bottom-right");

map.on("load", () => {
  // Smoke-test marker so the GL render pipeline is confirmed at a glance.
  // TODO(A): remove this when the SDK lands and the WidgetManager owns markers.
  new maplibregl.Marker().setLngLat([NYC.lng - 0.02, NYC.lat + 0.02]).addTo(map);
});
