import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

// Hello world. This direct MapLibre call disappears once the WidgetManager
// takes over the map. The SDK (src/sdk/anymaps.js) becomes the only owner.
const map = new maplibregl.Map({
  container: "map",
  style: "https://demotiles.maplibre.org/style.json",
  center: [-74.0, 40.71],
  zoom: 11,
});

map.on("load", () => {
  new maplibregl.Marker().setLngLat([-74.0, 40.71]).addTo(map);
});
