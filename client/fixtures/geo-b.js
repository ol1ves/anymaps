// Geolocation fixture B. Subscribes, records fixes/errors, and stops after
// the second fix so the shared watch clears and the dot disappears.

const {} = await anymaps.ready();
let count = 0;
const fixes = [];
anymaps.on("geolocation", (p) => {
  count += 1;
  fixes.push(p);
  if (count >= 2) {
    anymaps.stopGeolocation();
    anymaps.persist({ bFixes: fixes, bStopped: true });
  } else {
    anymaps.persist({ bFixes: fixes });
  }
});
anymaps.on("geolocationError", (p) => {
  anymaps.persist({ bErrors: [p] });
});
anymaps.startGeolocation();
anymaps.persist({ bStarted: true });
