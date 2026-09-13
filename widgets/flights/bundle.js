(async function flightsWidget() {
  const { config } = await anymaps.ready();
  const route = config.channelRoutes && config.channelRoutes.flights_nyc;
  const pollIntervalMs = 5000;
  const defaultBounds = [[40.5, -74.3], [40.9, -73.7]];
  const aircraft = new Map();
  const markerIds = new Set();
  let selectedHex = null;
  let selectedTrailId = null;
  let bounds = defaultBounds;
  let refreshInFlight = false;

  if (!route) {
    anymaps.setPanel({
      title: "Flights NYC",
      content: "The flights data channel is not available yet."
    });
    return;
  }

  function boundsQuery(value) {
    if (!Array.isArray(value) || value.length !== 2) return null;
    const southWest = value[0];
    const northEast = value[1];
    if (!Array.isArray(southWest) || !Array.isArray(northEast)) return null;
    const numbers = [southWest[0], southWest[1], northEast[0], northEast[1]]
      .map(Number);
    return numbers.every(Number.isFinite) ? numbers.join(",") : null;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function rotation(value) {
    const track = Number(value);
    if (!Number.isFinite(track)) return 0;
    return ((track % 360) + 360) % 360;
  }

  function markerLabel(record) {
    const flight = String(record.flight || "").trim();
    return flight || String(record.hex || "Aircraft");
  }

  function markerTitle(record) {
    const label = markerLabel(record);
    const registration = record.r ? ` (${record.r})` : "";
    return `${label}${registration}`;
  }

  function updatePanel(record) {
    if (!record) {
      anymaps.setPanel({
        title: "Flights NYC",
        content: "Click an aircraft to view details and its recent trail."
      });
      return;
    }
    const details = [
      `<strong>${escapeHtml(markerTitle(record))}</strong>`,
      record.t ? `Type: ${escapeHtml(record.t)}` : "",
      record.alt_baro !== undefined ? `Altitude: ${escapeHtml(record.alt_baro)}` : "",
      record.gs !== undefined ? `Speed: ${escapeHtml(record.gs)} kt` : ""
    ].filter(Boolean);
    anymaps.setPanel({ title: "Selected aircraft", content: details.join("<br>") });
  }

  function applyMarker(record, now) {
    const hex = String(record.hex || "").trim();
    const lat = Number(record.lat);
    const lng = Number(record.lon !== undefined ? record.lon : record.lng);
    if (!hex || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const id = `aircraft:${hex}`;
    const prior = aircraft.get(hex);
    const from = prior ? currentPosition(prior, now) : { lat, lng };
    const next = {
      record,
      from,
      to: { lat, lng },
      receivedAt: now
    };
    aircraft.set(hex, next);
    const marker = {
      id,
      lat: from.lat,
      lng: from.lng,
      icon: "✈️",
      label: markerLabel(record),
      title: markerTitle(record),
      rotation: rotation(record.track)
    };
    if (markerIds.has(id)) anymaps.updateMarker(marker);
    else anymaps.addMarker(marker);
    markerIds.add(id);
    return hex;
  }

  function currentPosition(item, now) {
    const elapsed = Math.max(0, now - item.receivedAt);
    const progress = Math.min(1, elapsed / pollIntervalMs);
    return {
      lat: item.from.lat + (item.to.lat - item.from.lat) * progress,
      lng: item.from.lng + (item.to.lng - item.from.lng) * progress
    };
  }

  function animateMarkers() {
    const now = Date.now();
    for (const [hex, item] of aircraft) {
      const position = currentPosition(item, now);
      anymaps.updateMarker({
        id: `aircraft:${hex}`,
        lat: position.lat,
        lng: position.lng
      });
    }
  }

  async function loadTrail(hex) {
    const url = new URL(route);
    url.searchParams.set("ids", hex);
    const response = await fetch(url.toString());
    if (!response.ok) throw new Error(`trail request failed (${response.status})`);
    const body = await response.json();
    if (selectedHex !== hex) return;
    const records = Array.isArray(body.records) ? body.records : [];
    const points = records.map((record) => [
      Number(record && record.lat),
      Number(record && (record.lon !== undefined ? record.lon : record.lng))
    ]).filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));
    if (!points.length) return;
    selectedTrailId = `trail:${hex}`;
    anymaps.addPolyline({
      id: selectedTrailId,
      points,
      color: "#2563eb",
      width: 3
    });
  }

  async function selectAircraft(hex) {
    selectedHex = hex;
    if (selectedTrailId) {
      anymaps.removePolyline(selectedTrailId);
      selectedTrailId = null;
    }
    const item = aircraft.get(hex);
    updatePanel(item && item.record);
    try {
      await loadTrail(hex);
    } catch (error) {
      if (selectedHex === hex) {
        anymaps.setPanel({
          title: "Selected aircraft",
          content: "Aircraft details are available, but its trail is temporarily unavailable."
        });
      }
    }
  }

  async function refresh() {
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
      const url = new URL(route);
      const query = boundsQuery(bounds);
      if (query) url.searchParams.set("bounds", query);
      url.searchParams.set("latest", "1");
      const response = await fetch(url.toString());
      if (!response.ok) throw new Error(`flight request failed (${response.status})`);
      const body = await response.json();
      const records = Array.isArray(body.records) ? body.records : [];
      const now = Date.now();
      const nextIds = new Set();
      for (const record of records) {
        const hex = applyMarker(record || {}, now);
        if (hex) nextIds.add(`aircraft:${hex}`);
      }
      for (const id of markerIds) {
        if (!nextIds.has(id)) {
          anymaps.removeMarker(id);
          aircraft.delete(id.slice("aircraft:".length));
        }
      }
      markerIds.clear();
      for (const id of nextIds) markerIds.add(id);
      if (selectedHex && !aircraft.has(selectedHex)) {
        selectedHex = null;
        if (selectedTrailId) {
          anymaps.removePolyline(selectedTrailId);
          selectedTrailId = null;
        }
        updatePanel(null);
      }
      if (selectedHex && aircraft.has(selectedHex)) updatePanel(aircraft.get(selectedHex).record);
    } catch (error) {
      anymaps.setPanel({
        title: "Flights NYC",
        content: "Flight data is temporarily unavailable."
      });
    } finally {
      refreshInFlight = false;
    }
  }

  anymaps.on("viewportChanged", (event) => {
    if (event && Array.isArray(event.bounds)) bounds = event.bounds;
    refresh();
  });
  anymaps.on("markerClick", ({ markerId }) => {
    if (typeof markerId !== "string" || !markerId.startsWith("aircraft:")) return;
    selectAircraft(markerId.slice("aircraft:".length));
  });

  updatePanel(null);
  await refresh();
  setInterval(refresh, pollIntervalMs);
  setInterval(animateMarkers, 250);
})();
