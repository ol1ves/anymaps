// Simple fixture: one marker + one panel. Reused for the z-order partner
// (lifecycle-2) and for the three-widgets-at-once check (three-a/b/c),
// each enabled with its own manifest id.

const {} = await anymaps.ready();
anymaps.addMarker({ id: "s-m1", lat: 40.72, lng: -74.02, icon: "🔵", label: "S" });
anymaps.setPanel({ title: "Simple", content: "<p>simple</p>" });
anymaps.persist({ simpleDone: true });
