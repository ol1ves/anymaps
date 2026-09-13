// Pure payload validators (no DOM, no top-level browser globals).
// Each function returns null when valid, or a human-readable error string.
// Contract: CONTRACTS.md section 4 (marker rows), SPEC.md section 7.4.
//
// Task 2 ships the marker validators. Task 3 extends this module with the
// remaining command validators.

function isId(v) {
  return typeof v === "string" && v.length > 0;
}

function isFiniteNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// addMarker: id*, lat*, lng*, optional icon, color, label, title, rotation.
// "marker missing id", "marker missing position" (missing or non-finite
// lat/lng). rotation, if present, must be a finite number.
export function addMarker(p) {
  if (!p || !isId(p.id)) return "marker missing id";
  if (!isFiniteNum(p.lat) || !isFiniteNum(p.lng)) return "marker missing position";
  if ("rotation" in p && !isFiniteNum(p.rotation)) return "marker rotation must be a number";
  return null;
}

// updateMarker: id* plus any changed field.
// "marker missing id", "updateMarker needs a changed field".
// Position and rotation are validated when present to keep setLngLat/transform
// from throwing on bad data.
export function updateMarker(p) {
  if (!p || !isId(p.id)) return "marker missing id";
  const hasOther =
    "lat" in p || "lng" in p || "icon" in p || "color" in p ||
    "label" in p || "title" in p || "rotation" in p;
  if (!hasOther) return "updateMarker needs a changed field";
  if (("lat" in p && !isFiniteNum(p.lat)) || ("lng" in p && !isFiniteNum(p.lng))) {
    return "marker missing position";
  }
  if ("rotation" in p && !isFiniteNum(p.rotation)) return "marker rotation must be a number";
  return null;
}

// removeMarker: id*.
export function removeMarker(p) {
  if (!p || !isId(p.id)) return "marker missing id";
  return null;
}

// --- Task 3 extension: polylines, popups, panels -------------------------

// A valid point pair is a 2-element array of finite numbers [lat, lng].
function isValidPair(pair) {
  return Array.isArray(pair) && pair.length === 2 &&
    isFiniteNum(pair[0]) && isFiniteNum(pair[1]);
}

function isValidPoints(points) {
  if (!Array.isArray(points) || points.length === 0) return false;
  return points.every(isValidPair);
}

// addPolyline: id*, points* (array of [lat,lng] pairs), optional color, width.
// "polyline missing id", "polyline missing points",
// "polyline points must be [lat,lng] pairs".
export function addPolyline(p) {
  if (!p || !isId(p.id)) return "polyline missing id";
  if (!Array.isArray(p.points) || p.points.length === 0) {
    return "polyline missing points";
  }
  if (!isValidPoints(p.points)) return "polyline points must be [lat,lng] pairs";
  return null;
}

// updatePolyline: id*, points? or append?, optional color, width.
// Exactly one of points/append must be present and a valid pairs array.
// "polyline missing id", "updatePolyline needs points or append",
// "polyline points must be [lat,lng] pairs".
export function updatePolyline(p) {
  if (!p || !isId(p.id)) return "polyline missing id";
  const hasPoints = "points" in p;
  const hasAppend = "append" in p;
  if (!hasPoints && !hasAppend) return "updatePolyline needs points or append";
  if (hasPoints && !isValidPoints(p.points)) {
    return "polyline points must be [lat,lng] pairs";
  }
  if (hasAppend && !isValidPoints(p.append)) {
    return "polyline points must be [lat,lng] pairs";
  }
  return null;
}

// removePolyline: id*.
export function removePolyline(p) {
  if (!p || !isId(p.id)) return "polyline missing id";
  return null;
}

// openPopup: id*, content*, and (lat* + lng*) or anchorMarkerId*.
// "popup missing id", "popup missing content",
// "popup needs lat/lng or anchorMarkerId".
export function openPopup(p) {
  if (!p || !isId(p.id)) return "popup missing id";
  if (typeof p.content !== "string") return "popup missing content";
  const anchored = isId(p.anchorMarkerId);
  const standalone = isFiniteNum(p.lat) && isFiniteNum(p.lng);
  if (!anchored && !standalone) return "popup needs lat/lng or anchorMarkerId";
  return null;
}

// closePopup: id*.
export function closePopup(p) {
  if (!p || !isId(p.id)) return "popup missing id";
  return null;
}

// setPopupContent: id*, content*.
export function setPopupContent(p) {
  if (!p || !isId(p.id)) return "popup missing id";
  if (typeof p.content !== "string") return "popup missing content";
  return null;
}

// setPanel: content* (title optional).
export function setPanel(p) {
  if (!p || typeof p.content !== "string") return "panel missing content";
  return null;
}
