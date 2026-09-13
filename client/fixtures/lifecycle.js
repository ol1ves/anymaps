// Lifecycle fixture. Draws a marker + panel and persists a token so the
// page can verify state survives disable (state is kept) and uninstall
// (state + registry entry are deleted).

const { state } = await anymaps.ready();
const token = state.lcToken ?? "lc-1";
anymaps.setStyles(".anymaps-widget-lifecycle { z-index: 1; }");
anymaps.addMarker({ id: "lc-m1", lat: 40.71, lng: -74.0, icon: "🟢", label: "LC" });
anymaps.setPanel({ title: "Lifecycle", content: "<p>lc</p>" });
anymaps.persist({ lcToken: token, lcDone: true });
