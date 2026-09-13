// Events fixture A. Owns marker ev-m1. Captures markerClick, mapClick, and
// viewportChanged into persisted state so the page can assert routing:
// markerClick fires only for the owner; mapClick broadcasts to all;
// viewportChanged is suppressed for the issuer (see events-c).

const {} = await anymaps.ready();
const markerClicks = [];
const mapClicks = [];
const viewports = [];
anymaps.on("markerClick", (p) => {
  markerClicks.push(p);
  anymaps.persist({ aMarkerClicks: markerClicks });
});
anymaps.on("mapClick", (p) => {
  mapClicks.push(p);
  anymaps.persist({ aMapClicks: mapClicks });
});
anymaps.on("viewportChanged", (p) => {
  viewports.push(p);
  anymaps.persist({ aViewports: viewports });
});
anymaps.addMarker({ id: "ev-m1", lat: 40.71, lng: -74.0, icon: "📍", label: "EV1" });
anymaps.persist({ aReady: true });
