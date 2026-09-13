// Tests for the marker payload validators (client/src/validate.js).
//
// Contract: CONTRACTS.md section 4 (marker rows), SPEC.md section 7.4.
// Error strings are exact; the SPEC.md section 7.2 example uses
// "marker missing position".

import { test } from "node:test";
import assert from "node:assert/strict";
import { addMarker, updateMarker, removeMarker } from "../src/validate.js";

test("addMarker returns null for valid payloads", () => {
  assert.equal(addMarker({ id: "m1", lat: 40.71, lng: -74.0 }), null);
  assert.equal(
    addMarker({ id: "m1", lat: 40.71, lng: -74.0, icon: "🚻", color: "#0066ff",
                label: "open", title: "Public restroom", rotation: 0 }),
    null,
  );
  assert.equal(addMarker({ id: "m1", lat: -90, lng: 180 }), null);
  assert.equal(addMarker({ id: "m1", lat: 0, lng: 0, rotation: 359 }), null);
});

test("addMarker missing id", () => {
  assert.equal(addMarker({ lat: 40.71, lng: -74.0 }), "marker missing id");
  assert.equal(addMarker({ id: "", lat: 40.71, lng: -74.0 }), "marker missing id");
  assert.equal(addMarker({ id: 5, lat: 40.71, lng: -74.0 }), "marker missing id");
});

test("addMarker missing position", () => {
  assert.equal(addMarker({ id: "m1" }), "marker missing position");
  assert.equal(addMarker({ id: "m1", lat: 40.71 }), "marker missing position");
  assert.equal(addMarker({ id: "m1", lng: -74.0 }), "marker missing position");
  assert.equal(addMarker({ id: "m1", lat: "nope", lng: -74.0 }), "marker missing position");
  assert.equal(addMarker({ id: "m1", lat: 40.71, lng: "nope" }), "marker missing position");
  assert.equal(addMarker({ id: "m1", lat: NaN, lng: -74.0 }), "marker missing position");
  assert.equal(addMarker({ id: "m1", lat: Infinity, lng: -74.0 }), "marker missing position");
});

test("addMarker bad rotation", () => {
  assert.equal(
    addMarker({ id: "m1", lat: 40.71, lng: -74.0, rotation: "x" }),
    "marker rotation must be a number",
  );
  assert.equal(
    addMarker({ id: "m1", lat: 40.71, lng: -74.0, rotation: NaN }),
    "marker rotation must be a number",
  );
});

test("updateMarker returns null for valid payloads", () => {
  assert.equal(updateMarker({ id: "m1", lat: 40.71 }), null);
  assert.equal(updateMarker({ id: "m1", color: "#fff" }), null);
  assert.equal(updateMarker({ id: "m1", lat: 40.71, lng: -74.0, rotation: 90 }), null);
});

test("updateMarker missing id", () => {
  assert.equal(updateMarker({ lat: 40.71 }), "marker missing id");
  assert.equal(updateMarker({ id: "", color: "#fff" }), "marker missing id");
});

test("updateMarker needs a changed field", () => {
  assert.equal(updateMarker({ id: "m1" }), "updateMarker needs a changed field");
});

test("updateMarker bad position or rotation", () => {
  assert.equal(updateMarker({ id: "m1", lat: "nope" }), "marker missing position");
  assert.equal(updateMarker({ id: "m1", rotation: "x" }), "marker rotation must be a number");
});

test("removeMarker returns null for valid id", () => {
  assert.equal(removeMarker({ id: "m1" }), null);
});

test("removeMarker missing id", () => {
  assert.equal(removeMarker({}), "marker missing id");
  assert.equal(removeMarker({ id: "" }), "marker missing id");
  assert.equal(removeMarker({ id: 5 }), "marker missing id");
});
