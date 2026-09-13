(async function findMyFriendsWidget() {
  const { config, state } = await anymaps.ready();
  const writeRoute = config.channelRoutes && config.channelRoutes.fmfW;
  const readRoute = config.channelRoutes && config.channelRoutes.fmfR;
  const markerIds = new Set();
  const pollIntervalMs = 5000;
  let iid = state.iid;
  let clientId = state.clientId;
  let displayName = state.displayName || "Anonymous";
  let pollTimer;
  let stopped = false;

  if (!writeRoute || !readRoute) {
    anymaps.setPanel({
      title: "Find My Friends",
      content: "The private friends channels are not available yet."
    });
    return;
  }

  function newClientId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function privateRoute(route) {
    return `${route}/instances/${encodeURIComponent(iid)}`;
  }

  async function createRoom() {
    const response = await fetch(
      `${config.baseUrl}/widgets/${config.widgetId}/instances`,
      { method: "POST" }
    );
    if (!response.ok) throw new Error(`room creation failed (${response.status})`);
    const body = await response.json();
    if (
      typeof body.instanceToken !== "string" ||
      !/^[0-9a-f]{32}$/i.test(body.instanceToken)
    ) {
      throw new Error("server returned an invalid room token");
    }
    iid = body.instanceToken;
    anymaps.persist({ iid });
  }

  async function ensureIdentityAndRoom() {
    if (!clientId) {
      clientId = newClientId();
      anymaps.persist({ clientId });
    }
    if (!iid) await createRoom();
    anymaps.persist({ displayName });
    anymaps.setPanel({
      title: "Find My Friends",
      content: `Room ready. Share this room token out of band: ${iid}`
    });
  }

  async function postLocation(position) {
    if (stopped || !iid) return;
    const record = {
      clientId,
      name: displayName,
      lat: Number(position.lat),
      lng: Number(position.lng),
      ts: Math.floor(Date.now() / 1000)
    };
    if (position.accuracy !== undefined) record.accuracy = Number(position.accuracy);
    if (!Number.isFinite(record.lat) || !Number.isFinite(record.lng)) return;

    const response = await fetch(privateRoute(writeRoute), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record)
    });
    if (!response.ok) throw new Error(`location write failed (${response.status})`);
  }

  async function loadFriends() {
    if (stopped || !iid) return;
    const url = new URL(privateRoute(readRoute));
    url.searchParams.set("latest", "1");
    const response = await fetch(url.toString());
    if (!response.ok) throw new Error(`friend read failed (${response.status})`);
    const body = await response.json();
    const records = Array.isArray(body.records) ? body.records : [];
    const nextMarkerIds = new Set();

    for (const record of records) {
      const lat = Number(record && record.lat);
      const lng = Number(record && (record.lng !== undefined ? record.lng : record.lon));
      if (!record || record.clientId === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        continue;
      }
      const id = `friend:${String(record.clientId)}`;
      const name = record.name ? String(record.name) : "Friend";
      nextMarkerIds.add(id);
      const marker = {
        id,
        lat,
        lng,
        icon: "📍",
        label: name,
        title: name
      };
      if (markerIds.has(id)) anymaps.updateMarker(marker);
      else anymaps.addMarker(marker);
    }

    for (const id of markerIds) {
      if (!nextMarkerIds.has(id)) anymaps.removeMarker(id);
    }
    markerIds.clear();
    for (const id of nextMarkerIds) markerIds.add(id);
  }

  async function refresh() {
    try {
      await loadFriends();
    } catch (error) {
      if (!stopped) {
        anymaps.setPanel({
          title: "Find My Friends",
          content: "Friend locations are temporarily unavailable."
        });
      }
    }
  }

  try {
    await ensureIdentityAndRoom();
    anymaps.on("geolocation", (position) => {
      postLocation(position).catch(() => {});
    });
    anymaps.on("geolocationError", () => {
      anymaps.setPanel({
        title: "Find My Friends",
        content: "Location permission is required to share your position."
      });
    });
    anymaps.startGeolocation({ highAccuracy: true });
    await refresh();
    pollTimer = setInterval(refresh, pollIntervalMs);
  } catch (error) {
    stopped = true;
    if (pollTimer) clearInterval(pollTimer);
    anymaps.setPanel({
      title: "Find My Friends",
      content: "Unable to create or join the private room."
    });
  }
})();
