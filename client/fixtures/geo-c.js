// Geolocation fixture C. Subscribes and stays subscribed so the page can
// trigger a denial (geolocationError) and observe it. Cleared by uninstall.

const {} = await anymaps.ready();
const errs = [];
anymaps.on("geolocationError", (p) => {
  errs.push(p);
  anymaps.persist({ cErrors: errs });
});
anymaps.on("geolocation", (p) => {
  anymaps.persist({ cFixes: [p] });
});
anymaps.startGeolocation();
anymaps.persist({ cStarted: true });
