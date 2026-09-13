// Capture fixture for the sdk.js checklist group.
//
// Captures every command envelope the anymaps runtime sends, WITHOUT
// executing them (postMessage is tee'd into a buffer and not forwarded),
// then ships the captured envelopes back to the main thread through a real
// persist command. Finally exercises the real error path (a malformed
// addMarker) and proves the widget stays alive by setting a panel.
//
// The runtime is prepended before this bundle, so `anymaps` is a global.

const {} = await anymaps.ready();

const origPost = self.postMessage;
const sent = [];
// Intercept outbound worker->main messages so the 21 command shapes are
// recorded but never executed (no side effects on the shared map).
self.postMessage = (m) => { sent.push(m); };

// 20 valid command shapes (one per CONTRACTS.md section 4 row).
anymaps.addMarker({ id: "m1", lat: 40.71, lng: -74.0, icon: "📍",
  color: "#ff0000", label: "L", title: "T", rotation: 45 });
anymaps.updateMarker({ id: "m1", lat: 40.715, color: "#00ff00", label: "L2" });
anymaps.removeMarker("m1");
anymaps.addPolyline({ id: "p1", points: [[40.71, -74.0], [40.72, -74.01]],
  color: "#0000ff", width: 2 });
anymaps.updatePolyline({ id: "p1", append: [[40.73, -74.02]] });
anymaps.removePolyline("p1");
anymaps.openPopup({ id: "pop1", content: "<p>hi</p>", lat: 40.71, lng: -74.0 });
anymaps.setPopupContent({ id: "pop1", content: "<p>x</p>" });
anymaps.closePopup("pop1");
anymaps.setPanel({ title: "Cap", content: "<p>cap</p>" });
anymaps.clearPanel();
anymaps.setStyles("/* capture css */");
anymaps.persist({ capToken: "c1" });
anymaps.requestCameraControl();
anymaps.releaseCameraControl();
anymaps.flyTo({ center: [40.71, -74.0], zoom: 13, bearing: 0 });
anymaps.jumpTo({ center: [40.72, -74.01], zoom: 14 });
anymaps.fitBounds({ bounds: [[40.7, -74.1], [40.8, -74.0]] });
anymaps.startGeolocation({ highAccuracy: true });
anymaps.stopGeolocation();
// 1 malformed shape: the 21st envelope. Validation happens on the main
// thread; the runtime still assigns it a unique id and posts a cmd envelope.
anymaps.addMarker({ id: "bad", lat: "nope", lng: -74.0 });

// Restore the real postMessage and ship the captured envelopes back via a
// real persist command (deep-merged into the widget's state).
self.postMessage = origPost;
anymaps.persist({ capture: sent });

// Real error path: send the malformed command for real so the main thread
// validates, throws, and posts an error envelope back. Capture it.
anymaps.on("error", (p) => { anymaps.persist({ errorEnvelope: p }); });
anymaps.addMarker({ id: "bad2", lat: "nope", lng: -74.0 });

// The widget must still be alive after the error: set a real panel.
anymaps.setPanel({ title: "Capture Alive", content: "<p id='cap-alive'>alive</p>" });
anymaps.persist({ alive: true });
