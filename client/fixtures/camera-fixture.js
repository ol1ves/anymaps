// Camera fixture for the camera.js checklist group.
// Mode is selected by prepending `var __MODE__ = "<mode>";` before this
// bundle source. Each mode exercises one revocation trigger. Grant and
// revoke events are captured into persisted state so the page can read them.

const {} = await anymaps.ready();
const revokes = [];
let denied = false;

anymaps.on("cameraGranted", () => {
  anymaps.persist({ granted: true, revokes });
});
anymaps.on("cameraRevoked", ({ reason }) => {
  revokes.push(reason);
  anymaps.persist({ revokes });
});
anymaps.on("cameraDenied", () => { denied = true; anymaps.persist({ denied }); });

const mode = typeof __MODE__ !== "undefined" ? __MODE__ : "request";

if (mode === "request" || mode === "request-only") {
  anymaps.requestCameraControl();
} else if (mode === "request-delayed") {
  setTimeout(() => anymaps.requestCameraControl(), 150);
} else if (mode === "pan") {
  // Non-owner pan: preempts the current owner, no new lock.
  setTimeout(() => anymaps.flyTo({ center: [40.73, -74.03], zoom: 13 }), 150);
} else if (mode === "request-release") {
  anymaps.requestCameraControl();
  setTimeout(() => anymaps.releaseCameraControl(), 300);
}

anymaps.persist({ started: true });
