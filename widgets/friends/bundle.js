(async function findMyFriendsWidget() {
  const { config, state } = await anymaps.ready();
  const writeRoute = config.channelRoutes && config.channelRoutes.fmfW;
  const readRoute = config.channelRoutes && config.channelRoutes.fmfR;
  const markerIds = new Set();
  const friendPositions = new Map();
  const pollIntervalMs = 5000;
  let iid = state.iid;
  let clientId = state.clientId;
  let displayName = state.displayName || "Anonymous";
  let pollTimer;
  let refreshInFlight = false;
  let stopped = false;
  let started = false;
  let centeredOnLocation = false;
  let geolocationHandler;
  let geolocationErrorHandler;

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

  function privateRoute(route, room = iid) {
    return `${route}/instances/${encodeURIComponent(room)}`;
  }

  function personKey(record) {
    if (!record || record.clientId === undefined || record.clientId === null) return null;
    const key = String(record.clientId).trim();
    return key || null;
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
    anymaps.persist({ iid, displayName });
  }

  async function ensureIdentityAndRoom() {
    if (!clientId) {
      clientId = newClientId();
      anymaps.persist({ clientId });
    }
    anymaps.persist({ displayName });
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function showRoomChooser(message) {
    anymaps.setPanel({
      title: "Find My Friends",
      content: `${message ? `<p>${escapeHtml(message)}</p>` : ""}
        <p>Start a new room or join one with a 32-character room token.</p>
        <form data-anymaps-action="join-room">
          <input name="displayName" type="text" placeholder="Your name" value="${escapeHtml(displayName)}">
          <input name="roomToken" type="text" placeholder="Room token" minlength="32" maxlength="32" pattern="[0-9a-fA-F]{32}">
          <button type="submit">Join room</button>
        </form>
        <button type="button" data-anymaps-action="create-room">Create new room</button>`
    });
  }

  function showRoomPanel(message) {
    anymaps.setPanel({
      title: "Find My Friends",
      content: `${message ? `<p>${escapeHtml(message)}</p>` : ""}
        <p>Room ready. Share this token with friends:</p>
        <code>${escapeHtml(iid)}</code>
        <p><button type="button" data-anymaps-action="leave-room">Leave room</button></p>`
    });
  }

  function leaveRoom() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    anymaps.stopGeolocation();
    if (geolocationHandler) anymaps.off("geolocation", geolocationHandler);
    if (geolocationErrorHandler) anymaps.off("geolocationError", geolocationErrorHandler);
    geolocationHandler = undefined;
    geolocationErrorHandler = undefined;
    for (const id of markerIds) anymaps.removeMarker(id);
    markerIds.clear();
    friendPositions.clear();
    iid = null;
    started = false;
    centeredOnLocation = false;
    anymaps.persist({ iid: null });
    showRoomChooser("");
  }

  async function startSharing() {
    if (started || !iid) return;
    const room = iid;
    started = true;
    centeredOnLocation = false;
    anymaps.persist({ iid, displayName });
    showRoomPanel("");
    geolocationHandler = (position) => {
      if (!centeredOnLocation) {
        const lat = Number(position && position.lat);
        const lng = Number(position && position.lng);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          centeredOnLocation = true;
          anymaps.flyTo({ center: [lat, lng], zoom: 14 });
        }
      }
      postLocation(position).catch(() => {});
    };
    geolocationErrorHandler = () => showRoomPanel(
      "Location permission is required to share your position."
    );
    anymaps.on("geolocation", geolocationHandler);
    anymaps.on("geolocationError", geolocationErrorHandler);
    anymaps.startGeolocation({ highAccuracy: true, showUserDot: false });
    await refresh();
    if (!started || iid !== room) return;
    pollTimer = setInterval(refresh, pollIntervalMs);
  }

  async function postLocation(position) {
    const room = iid;
    if (stopped || !room) return;
    const record = {
      clientId,
      name: displayName,
      lat: Number(position.lat),
      lng: Number(position.lng),
      ts: Math.floor(Date.now() / 1000)
    };
    if (position.accuracy !== undefined) record.accuracy = Number(position.accuracy);
    if (!Number.isFinite(record.lat) || !Number.isFinite(record.lng)) return;

    const response = await fetch(privateRoute(writeRoute, room), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record)
    });
    if (!response.ok) throw new Error(`location write failed (${response.status})`);
  }

  async function loadFriends() {
    if (stopped || !iid) return;
    const room = iid;
    const url = new URL(privateRoute(readRoute, room));
    url.searchParams.set("latest", "1");
    const response = await fetch(url.toString());
    if (!response.ok) throw new Error(`friend read failed (${response.status})`);
    const body = await response.json();
    if (!started || iid !== room) return;
    const records = Array.isArray(body.records) ? body.records : [];
    const latestByClient = new Map();
    for (const record of records) {
      const key = personKey(record);
      if (key) latestByClient.set(key, record);
    }
    const nextMarkerIds = new Set();

    for (const [clientKey, record] of latestByClient) {
      const lat = Number(record && record.lat);
      const lng = Number(record && (record.lng !== undefined ? record.lng : record.lon));
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        continue;
      }
      const id = `friend:${clientKey}`;
      const name = record.name ? String(record.name) : "Friend";
      friendPositions.set(id, { lat, lng, name });
      nextMarkerIds.add(id);
      const marker = {
        id,
        lat,
        lng,
        icon: "🧑",
        label: name,
        title: name
      };
      if (markerIds.has(id)) anymaps.updateMarker(marker);
      else anymaps.addMarker(marker);
    }

    for (const id of markerIds) {
      if (!nextMarkerIds.has(id)) {
        anymaps.removeMarker(id);
        friendPositions.delete(id);
      }
    }
    markerIds.clear();
    for (const id of nextMarkerIds) markerIds.add(id);
  }

  async function refresh() {
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
      await loadFriends();
    } catch (error) {
      if (!stopped && started) {
        showRoomPanel("Friend locations are temporarily unavailable.");
      }
    } finally {
      refreshInFlight = false;
    }
  }

  anymaps.on("markerClick", ({ markerId }) => {
    if (typeof markerId !== "string" || !markerId.startsWith("friend:")) return;
    const friend = friendPositions.get(markerId);
    if (!friend) return;
    anymaps.flyTo({ center: [friend.lat, friend.lng], zoom: 14 });
    anymaps.openPopup({
      id: `friend-popup:${markerId.slice("friend:".length)}`,
      anchorMarkerId: markerId,
      content: `<strong>${escapeHtml(friend.name)}</strong>`
    });
  });

  try {
    await ensureIdentityAndRoom();
    anymaps.on("panelAction", async (event) => {
      try {
        if (!event) return;
        if (event.action === "leave-room") {
          leaveRoom();
          return;
        }
        if (started) return;
        displayName = String(event.displayName || displayName || "Anonymous").trim().slice(0, 80) || "Anonymous";
        if (event.action === "join-room") {
          const token = String(event.roomToken || "").trim();
          if (!/^[0-9a-f]{32}$/i.test(token)) {
            showRoomChooser("That room token is not valid. Check that it is 32 hexadecimal characters.");
            return;
          }
          iid = token;
          await startSharing();
        } else if (event.action === "create-room") {
          await createRoom();
          await startSharing();
        }
      } catch (error) {
        started = false;
        showRoomChooser("We could not open that room. Please try again.");
      }
    });
    if (iid) await startSharing();
    else showRoomChooser("");
  } catch (error) {
    stopped = true;
    if (pollTimer) clearInterval(pollTimer);
    anymaps.setPanel({
      title: "Find My Friends",
      content: "Unable to create or join the private room."
    });
  }
})();
