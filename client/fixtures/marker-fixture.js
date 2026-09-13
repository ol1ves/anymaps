// Fixture bundle: exercises the marker contract (verbatim from the brief).
// The anymaps runtime is prepended before the worker starts, so this bundle
// calls the global `anymaps` directly. It draws a marker, updates it on an
// interval, attempts an invalid marker (must surface an error log line and
// keep the widget alive), and removes a non-existent marker (idempotent).

const { config, state } = await anymaps.ready();
const log = [];
anymaps.setPanel({ title: "Fixture", content: "<ul id='fixture-log'></ul>" });
const append = (line) => {
  log.push(line);
  anymaps.setPanel({ content: "<ul id='fixture-log'>" +
    log.map((l) => "<li>" + l + "</li>").join("") + "</ul>" });
};
anymaps.on("markerClick", ({ markerId }) => append("click:" + markerId));
anymaps.on("error", ({ id, error }) => append("err:" + id + ":" + error));
anymaps.addMarker({ id: "m1", lat: 40.71, lng: -74.0, icon: "🚻",
  color: "#0066ff", label: "open", title: "Public restroom", rotation: 0 });
append("added");
setInterval(() => {
  anymaps.updateMarker({ id: "m1", lat: 40.71 + 0.001 * Math.random(),
    lng: -74.0 + 0.001 * Math.random() });
  append("moved");
}, 2000);
setTimeout(() => anymaps.removeMarker("m2"), 3000);
anymaps.addMarker({ id: "bad", lat: "nope", lng: -74.0 });
