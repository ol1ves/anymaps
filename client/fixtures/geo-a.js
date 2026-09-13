// Geolocation fixture A. Subscribes, records fixes/errors, and stops after
// the first fix to exercise the shared-watch refcount (the dot must remain
// while fixture B is still subscribed).

const {} = await anymaps.ready();
let stopped = false;
const fixes = [];
anymaps.on("geolocation", (p) => {
  fixes.push(p);
  if (!stopped) {
    stopped = true;
    anymaps.stopGeolocation();
    anymaps.persist({ aFixes: fixes, aStopped: true });
  } else {
    anymaps.persist({ aFixes: fixes });
  }
});
anymaps.on("geolocationError", (p) => {
  anymaps.persist({ aErrors: [...(fixes.errors ?? []), p] });
});
anymaps.startGeolocation({ highAccuracy: true });
anymaps.persist({ aStarted: true });
