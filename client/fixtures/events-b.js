// Events fixture B. No marker. Captures markerClick (must stay empty: not
// the owner), mapClick (broadcast), and viewportChanged.

const {} = await anymaps.ready();
const markerClicks = [];
const mapClicks = [];
const viewports = [];
anymaps.on("markerClick", (p) => {
  markerClicks.push(p);
  anymaps.persist({ bMarkerClicks: markerClicks });
});
anymaps.on("mapClick", (p) => {
  mapClicks.push(p);
  anymaps.persist({ bMapClicks: mapClicks });
});
anymaps.on("viewportChanged", (p) => {
  viewports.push(p);
  anymaps.persist({ bViewports: viewports });
});
anymaps.persist({ bReady: true });
