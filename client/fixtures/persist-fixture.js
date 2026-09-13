// Persistence fixture (SPEC.md section 9.2 room token flow).
// On first enable (empty state), fetches a real instance token from the
// server (POST /widgets/{id}/instances) and persists it as iid, then writes
// a nested object across two merges. On reload (phase 2) the widget is
// re-enabled by startup with the same state, so it must NOT re-fetch.

const { config, state } = await anymaps.ready();
if (!state.iid) {
  const res = await fetch(
    config.baseUrl + "/widgets/" + config.widgetId + "/instances",
    { method: "POST" },
  );
  const body = await res.json();
  anymaps.persist({ iid: body.instanceToken });
  anymaps.persist({ nested: { a: 1 } });
  anymaps.persist({ nested: { b: 2 } });
}
anymaps.persist({ pDone: true });
