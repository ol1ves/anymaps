// Fixture harness. Constructs the WidgetManager and enables the marker
// fixture bundle (fetched as raw text and prepended with the SDK runtime
// by the manager). baseUrl points at the mock server.
//
// The fixture manifest carries no channels, so provision() returns {} and no
// HTTP is needed.

import { createManager } from "../src/manager.js";
import bundleSource from "./marker-fixture.js?raw";

const manager = createManager();
window.__ANYMAPS_DEV__ = { manager };

const manifest = {
  id: "fixture-marker",
  name: "Fixture Marker",
  version: "0.1.0",
  description: "",
  server: { channels: [] },
};

manager.enable({ manifest, bundleSource, baseUrl: "http://localhost:8000" });
