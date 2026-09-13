// Events fixture C. The viewportChanged issuer: issues a flyTo after a short
// delay so the page can assert the issuer is suppressed and the other
// widgets receive viewportChanged with the correct shape.

const {} = await anymaps.ready();
const viewports = [];
anymaps.on("viewportChanged", (p) => {
  viewports.push(p);
  anymaps.persist({ cViewports: viewports });
});
anymaps.persist({ cReady: true });
setTimeout(() => {
  anymaps.flyTo({ center: [40.73, -74.03], zoom: 13 });
  anymaps.persist({ cIssued: true });
}, 300);
