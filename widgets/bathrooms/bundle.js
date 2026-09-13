(async function bathroomsWidget() {
  const { config } = await anymaps.ready();
  const route = config.channelRoutes && config.channelRoutes.bathrooms;
  const markerIds = new Set();
  let requestNumber = 0;

  if (!route) {
    anymaps.setPanel({
      title: "Bathrooms",
      content: "The bathrooms channel is not available yet."
    });
    return;
  }

  function boundsQuery(bounds) {
    if (!Array.isArray(bounds) || bounds.length !== 2) return null;
    const southWest = bounds[0];
    const northEast = bounds[1];
    if (!Array.isArray(southWest) || !Array.isArray(northEast)) return null;
    if (southWest.length !== 2 || northEast.length !== 2) return null;
    const values = [southWest[0], southWest[1], northEast[0], northEast[1]];
    if (values.some((value) => !Number.isFinite(Number(value)))) return null;
    return values.map(Number).join(",");
  }

  async function loadBathrooms(bounds) {
    const currentRequest = ++requestNumber;
    const url = new URL(route);
    const query = boundsQuery(bounds);
    if (query) url.searchParams.set("bounds", query);

    try {
      const response = await fetch(url.toString());
      if (!response.ok) throw new Error(`server returned ${response.status}`);
      const body = await response.json();
      if (currentRequest !== requestNumber) return;

      const records = Array.isArray(body.records) ? body.records : [];
      const nextMarkerIds = new Set();

      for (const record of records) {
        const lat = Number(record && record.lat);
        const lng = Number(record && record.lon);
        if (!record || record.id === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) {
          continue;
        }

        const id = String(record.id);
        const title = record.tags && record.tags.name
          ? String(record.tags.name)
          : "Public bathroom";
        const marker = { id, lat, lng, icon: "🚻", title };
        nextMarkerIds.add(id);

        if (markerIds.has(id)) {
          anymaps.updateMarker(marker);
        } else {
          anymaps.addMarker(marker);
        }
      }

      for (const id of markerIds) {
        if (!nextMarkerIds.has(id)) anymaps.removeMarker(id);
      }

      markerIds.clear();
      for (const id of nextMarkerIds) markerIds.add(id);
      anymaps.setPanel({
        title: "Bathrooms",
        content: `${nextMarkerIds.size} public bathroom${nextMarkerIds.size === 1 ? "" : "s"} visible`
      });
    } catch (error) {
      if (currentRequest !== requestNumber) return;
      anymaps.setPanel({
        title: "Bathrooms",
        content: "Bathrooms are temporarily unavailable."
      });
    }
  }

  anymaps.on("viewportChanged", ({ bounds }) => loadBathrooms(bounds));
  await loadBathrooms(null);
})();
