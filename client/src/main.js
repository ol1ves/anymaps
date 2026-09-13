// Bootstrap. Constructs the WidgetManager, re-enables registry entries on
// startup (no-op until Task 6 implements install.js startupEnable), and
// exposes the manager for dev tooling. No direct MapLibre calls remain.

import { createManager } from "./manager.js";

const manager = createManager();
manager.startup();

window.__ANYMAPS_DEV__ = { manager };
