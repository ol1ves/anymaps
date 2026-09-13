// Render fixture B for the render.js checklist group.
// Opens a popup (which must close render-a's popup: one global open) and
// sets a panel (a second stacked section).

const {} = await anymaps.ready();

anymaps.addMarker({ id: "rb-m1", lat: 40.72, lng: -74.02, icon: "🅿️", label: "B1" });
anymaps.openPopup({ id: "rb-pop1", content: "<p>popup-b</p>", lat: 40.72, lng: -74.02 });
anymaps.setPanel({ title: "Render B", content: "<p>panel-b</p>" });
anymaps.persist({ renderBDone: true });
