// gallery.js — gallery UI check group (against the mock server).
// list renders, install enables, disable/enable/uninstall cycle, provisioning
// idempotent (two enables -> same routes, one worker).

import { enableFixture, waitForState, wait, ok, fail, makeManifest } from "./lib.js";

const BASE_URL = "http://localhost:8000";
const WID = "gallery-test-widget";

const BUNDLE = [
  "const {} = await anymaps.ready();",
  "anymaps.addMarker({ id: 'g-m1', lat: 40.71, lng: -74.0, icon: '📌', label: 'G' });",
  "anymaps.setPanel({ title: 'Gallery Test', content: '<p>g</p>' });",
  "anymaps.persist({ gDone: true });",
].join("\n");

async function publish() {
  const manifest = makeManifest(WID, "Gallery Test");
  const res = await fetch(BASE_URL + "/widgets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest, bundle: BUNDLE }),
  });
  if (!res.ok && res.status !== 409) throw new Error("publish failed " + res.status);
}

function galleryBtn(doc, text) {
  return [...doc.querySelectorAll("#gallery .anymaps-gallery-btn")]
    .find((b) => b.textContent === text);
}

export async function run({ manager, page }) {
  const results = [];
  const { doc, panelHost } = page;

  try {
    await publish();
    // Refresh the gallery so the new widget appears.
    const refresh = doc.querySelector("#gallery .anymaps-gallery-refresh");
    if (refresh) refresh.click();
    await wait(300);

    const item = doc.querySelector("#gallery .anymaps-widget-" + WID);
    results.push(item
      ? ok("gallery list renders published widget") : fail("gallery list renders published widget", "missing"));

    // Install via the gallery button -> widget enabled.
    const installBtn = galleryBtn(doc, "Install");
    if (!installBtn) {
      results.push(fail("gallery install enables widget", "no Install button"));
      return results;
    }
    installBtn.click();
    const enabled = await waitForState(manager, WID, (s) => s.gDone, 5000);
    const regEnabled = manager.list().some((e) => e.widgetId === WID && e.enabled);
    results.push(enabled && regEnabled
      ? ok("gallery install enables widget") : fail("gallery install enables widget",
        "enabled=" + enabled + " reg=" + regEnabled));

    // Disable via gallery -> items removed, registry enabled=false.
    const disableBtn = galleryBtn(doc, "Disable");
    if (disableBtn) disableBtn.click();
    await wait(300);
    const regDisabled = manager.list().some((e) => e.widgetId === WID && !e.enabled);
    const panelGone = !panelHost.querySelector(".anymaps-widget-" + WID);
    results.push(regDisabled && panelGone
      ? ok("gallery disable removes items, keeps registry") : fail("gallery disable removes items, keeps registry",
        "regDisabled=" + regDisabled + " panelGone=" + panelGone));

    // Enable (re-install) via gallery -> items reappear.
    const enableBtn = galleryBtn(doc, "Enable");
    if (enableBtn) enableBtn.click();
    const reEnabled = await waitForState(manager, WID, (s) => s.gDone, 5000);
    results.push(reEnabled && panelHost.querySelector(".anymaps-widget-" + WID)
      ? ok("gallery enable re-installs widget") : fail("gallery enable re-installs widget", "reEnabled=" + reEnabled));

    // Provisioning idempotent: two POSTs return the same channelRoutes.
    const prov1 = await fetch(BASE_URL + "/widgets/" + WID + "/provision", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: makeManifest(WID, "Gallery Test") }),
    }).then((r) => r.json());
    const prov2 = await fetch(BASE_URL + "/widgets/" + WID + "/provision", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ manifest: makeManifest(WID, "Gallery Test") }),
    }).then((r) => r.json());
    results.push(JSON.stringify(prov1.channelRoutes) === JSON.stringify(prov2.channelRoutes)
      ? ok("provisioning is idempotent (same routes)")
      : fail("provisioning is idempotent (same routes)",
        JSON.stringify(prov1.channelRoutes) + " vs " + JSON.stringify(prov2.channelRoutes)));

    // Two enables -> one worker (no-op guard): a second enable must not
    // duplicate the panel.
    const beforeSections = panelHost.querySelectorAll(".anymaps-widget-" + WID).length;
    await manager.enable({
      manifest: makeManifest(WID, "Gallery Test"),
      bundleSource: BUNDLE, baseUrl: BASE_URL,
    });
    await wait(200);
    const afterSections = panelHost.querySelectorAll(".anymaps-widget-" + WID).length;
    results.push(beforeSections === 1 && afterSections === 1
      ? ok("two enables -> one worker (no duplicate panel)")
      : fail("two enables -> one worker (no duplicate panel)",
        "before=" + beforeSections + " after=" + afterSections));

    // Uninstall via gallery -> registry entry gone.
    const uninstallBtn = galleryBtn(doc, "Uninstall");
    if (uninstallBtn) uninstallBtn.click();
    await wait(300);
    const regGone = !manager.list().some((e) => e.widgetId === WID);
    results.push(regGone
      ? ok("gallery uninstall removes registry entry") : fail("gallery uninstall removes registry entry", "still present"));
  } finally {
    try { manager.uninstall(WID); } catch (e) { /* */ }
  }

  return results;
}
