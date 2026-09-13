// Render fixture A for the render.js checklist group.
// Draws markers (emoji + image url, color, label, title, rotation), updates
// one (move + restyle), removes one; a polyline with a full points REPLACE
// then an append growth; popups (standalone open, setPopupContent update,
// anchored popup on the widget's own marker, setPopupContent on the
// anchored, and a "popup not open" error for a closed popup); a panel
// (clearPanel then re-set); and a per-widget style.

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
// Full points REPLACE (2 -> 3), not an append.
anymaps.updatePolyline({ id: "ra-p1",
  points: [[40.71, -74.0], [40.712, -74.005], [40.713, -74.006]] });
// Append growth (3 -> 4).
anymaps.updatePolyline({ id: "ra-p1", append: [[40.714, -74.007]] });

// Standalone popup, then update its content (setPopupContent execution).
anymaps.openPopup({ id: "ra-pop1", content: "<p>popup-a</p>", lat: 40.71, lng: -74.0 });
anymaps.setPopupContent({ id: "ra-pop1", content: "<p>popup-a-updated</p>" });

// Anchored popup on the widget's own marker (closes ra-pop1 globally).
anymaps.openPopup({ id: "ra-anchored", content: "<p>anchored</p>", anchorMarkerId: "ra-m1" });
anymaps.setPopupContent({ id: "ra-anchored", content: "<p>anchored-updated</p>" });

// Capture the "popup not open" error: ra-pop1 is now closed.
const errs = [];
anymaps.on("error", (p) => { errs.push(p); anymaps.persist({ raErrors: errs }); });
anymaps.setPopupContent({ id: "ra-pop1", content: "x" });

anymaps.setPanel({ title: "Render A", content: "<p>panel-a</p>" });
// clearPanel removes the section; a follow-up setPanel re-creates it.
anymaps.clearPanel();
anymaps.setPanel({ title: "Render A", content: "<p>panel-a-final</p>" });

anymaps.persist({ renderADone: true });
