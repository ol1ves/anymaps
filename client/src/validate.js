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
