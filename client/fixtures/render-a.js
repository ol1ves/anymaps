// Render fixture A for the render.js checklist group.
// Draws markers (emoji + image url, color, label, title, rotation), updates
// one (move + restyle), removes one, a polyline (then appends), a popup, a
// panel, and a per-widget style. The page inspects the DOM + map state.

const {} = await anymaps.ready();

anymaps.setStyles(".anymaps-widget-render-a { /* render-a style sentinel */ }");

anymaps.addMarker({ id: "ra-m1", lat: 40.71, lng: -74.0, icon: "🚻",
  color: "#ff0000", label: "A1", title: "A1 title", rotation: 45 });
anymaps.addMarker({ id: "ra-m2", lat: 40.711, lng: -74.01,
  icon: "https://example.com/x.png", label: "url" });
// Update: move + restyle + relabel (no duplicate marker).
anymaps.updateMarker({ id: "ra-m1", lat: 40.715, color: "#00ff00", label: "A1-moved" });
// Remove one marker.
anymaps.removeMarker("ra-m2");

anymaps.addPolyline({ id: "ra-p1", points: [[40.71, -74.0], [40.712, -74.005]],
  color: "#0000ff", width: 3 });
// Append growth (points list grows from 2 to 3).
anymaps.updatePolyline({ id: "ra-p1", append: [[40.713, -74.006]] });

anymaps.openPopup({ id: "ra-pop1", content: "<p>popup-a</p>", lat: 40.71, lng: -74.0 });
anymaps.setPanel({ title: "Render A", content: "<p>panel-a</p>" });
// clearPanel removes the section; a follow-up setPanel re-creates it.
anymaps.clearPanel();
anymaps.setPanel({ title: "Render A", content: "<p>panel-a-final</p>" });

anymaps.persist({ renderADone: true });
