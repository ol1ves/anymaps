// Persistence fixture. On first enable (empty state), persists an iid and
// a nested object across two merges. On reload (phase 2) the widget is
// re-enabled by startup with the same state, so it must NOT re-persist.

const { state } = await anymaps.ready();
if (!state.iid) {
  anymaps.persist({ iid: "persist-survives" });
  anymaps.persist({ nested: { a: 1 } });
  anymaps.persist({ nested: { b: 2 } });
}
anymaps.persist({ pDone: true });
