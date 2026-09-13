// Tests for the polyline/popup/panel payload validators (Task 3 extension).
//
// Contract: CONTRACTS.md section 4 (polyline/popup/panel rows), SPEC.md
// section 7.4. Error strings are exact.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addPolyline, updatePolyline, removePolyline,
  openPopup, closePopup, setPopupContent, setPanel,
} from "../src/validate.js";

const validPairs = [
  [[40.7, -74.0], [40.8, -74.1]],
  [[0, 0]],
  [[-90, -180], [90, 180]],
];

test("addPolyline returns null for valid payloads", () => {
  assert.equal(addPolyline({ id: "t1", points: [[40.7, -74.0]] }), null);
  for (const points of validPairs) {
    assert.equal(addPolyline({ id: "t1", points }), null);
  }
  assert.equal(
    addPolyline({ id: "t1", points: [[40.7, -74.0]], color: "#ff0000", width: 3 }),
    null,
  );
});

test("addPolyline missing id", () => {
  assert.equal(addPolyline({ points: [[40.7, -74.0]] }), "polyline missing id");
  assert.equal(addPolyline({ id: "", points: [[40.7, -74.0]] }), "polyline missing id");
  assert.equal(addPolyline({ id: 5, points: [[40.7, -74.0]] }), "polyline missing id");
});

test("addPolyline missing points", () => {
  assert.equal(addPolyline({ id: "t1" }), "polyline missing points");
  assert.equal(addPolyline({ id: "t1", points: [] }), "polyline missing points");
  assert.equal(addPolyline({ id: "t1", points: "nope" }), "polyline missing points");
});

test("addPolyline bad point pairs", () => {
  assert.equal(
    addPolyline({ id: "t1", points: [[40.7]] }),
    "polyline points must be [lat,lng] pairs",
  );
  assert.equal(
    addPolyline({ id: "t1", points: [[40.7, -74.0], [40.8]] }),
    "polyline points must be [lat,lng] pairs",
  );
  assert.equal(
    addPolyline({ id: "t1", points: [["x", -74.0]] }),
    "polyline points must be [lat,lng] pairs",
  );
  assert.equal(
    addPolyline({ id: "t1", points: [[40.7, NaN]] }),
    "polyline points must be [lat,lng] pairs",
  );
  assert.equal(
    addPolyline({ id: "t1", points: [40.7, -74.0] }),
    "polyline points must be [lat,lng] pairs",
  );
});

test("updatePolyline returns null for valid payloads", () => {
  assert.equal(updatePolyline({ id: "t1", points: [[40.7, -74.0]] }), null);
  assert.equal(updatePolyline({ id: "t1", append: [[40.8, -74.1]] }), null);
  assert.equal(updatePolyline({ id: "t1", points: [[40.7, -74.0]], color: "#fff", width: 3 }), null);
});

test("updatePolyline missing id", () => {
  assert.equal(updatePolyline({ points: [[40.7, -74.0]] }), "polyline missing id");
  assert.equal(updatePolyline({ id: "", append: [[40.7, -74.0]] }), "polyline missing id");
});

test("updatePolyline needs points or append", () => {
  assert.equal(updatePolyline({ id: "t1" }), "updatePolyline needs points or append");
  assert.equal(updatePolyline({ id: "t1", color: "#fff" }), "updatePolyline needs points or append");
  assert.equal(updatePolyline({ id: "t1", width: 5 }), "updatePolyline needs points or append");
});

test("updatePolyline bad point pairs", () => {
  assert.equal(
    updatePolyline({ id: "t1", points: [[40.7]] }),
    "polyline points must be [lat,lng] pairs",
  );
  assert.equal(
    updatePolyline({ id: "t1", append: [["x", -74.0]] }),
    "polyline points must be [lat,lng] pairs",
  );
});

test("removePolyline returns null for valid id", () => {
  assert.equal(removePolyline({ id: "t1" }), null);
});

test("removePolyline missing id", () => {
  assert.equal(removePolyline({}), "polyline missing id");
  assert.equal(removePolyline({ id: "" }), "polyline missing id");
  assert.equal(removePolyline({ id: 5 }), "polyline missing id");
});

test("openPopup returns null for valid payloads", () => {
  assert.equal(openPopup({ id: "p1", content: "hi", lat: 40.7, lng: -74.0 }), null);
  assert.equal(openPopup({ id: "p1", content: "hi", anchorMarkerId: "m1" }), null);
  assert.equal(openPopup({ id: "p1", content: "<a href='x'>link</a>", lat: 0, lng: 0 }), null);
});

test("openPopup missing id", () => {
  assert.equal(openPopup({ content: "hi", lat: 40.7, lng: -74.0 }), "popup missing id");
  assert.equal(openPopup({ id: "", content: "hi", lat: 40.7, lng: -74.0 }), "popup missing id");
});

test("openPopup missing content", () => {
  assert.equal(openPopup({ id: "p1", lat: 40.7, lng: -74.0 }), "popup missing content");
  assert.equal(openPopup({ id: "p1", content: 5, lat: 40.7, lng: -74.0 }), "popup missing content");
});

test("openPopup needs lat/lng or anchorMarkerId", () => {
  assert.equal(openPopup({ id: "p1", content: "hi" }), "popup needs lat/lng or anchorMarkerId");
  assert.equal(openPopup({ id: "p1", content: "hi", lat: 40.7 }), "popup needs lat/lng or anchorMarkerId");
  assert.equal(openPopup({ id: "p1", content: "hi", lng: -74.0 }), "popup needs lat/lng or anchorMarkerId");
  assert.equal(
    openPopup({ id: "p1", content: "hi", lat: "x", lng: -74.0 }),
    "popup needs lat/lng or anchorMarkerId",
  );
});

test("closePopup returns null for valid id", () => {
  assert.equal(closePopup({ id: "p1" }), null);
});

test("closePopup missing id", () => {
  assert.equal(closePopup({}), "popup missing id");
  assert.equal(closePopup({ id: "" }), "popup missing id");
  assert.equal(closePopup({ id: 5 }), "popup missing id");
});

test("setPopupContent returns null for valid payload", () => {
  assert.equal(setPopupContent({ id: "p1", content: "hi" }), null);
});

test("setPopupContent missing id", () => {
  assert.equal(setPopupContent({ content: "hi" }), "popup missing id");
  assert.equal(setPopupContent({ id: "", content: "hi" }), "popup missing id");
});

test("setPopupContent missing content", () => {
  assert.equal(setPopupContent({ id: "p1" }), "popup missing content");
  assert.equal(setPopupContent({ id: "p1", content: 5 }), "popup missing content");
});

test("setPanel returns null for valid payload", () => {
  assert.equal(setPanel({ content: "hi" }), null);
  assert.equal(setPanel({ title: "T", content: "<ul></ul>" }), null);
});

test("setPanel missing content", () => {
  assert.equal(setPanel({}), "panel missing content");
  assert.equal(setPanel({ title: "T" }), "panel missing content");
  assert.equal(setPanel({ content: 5 }), "panel missing content");
});
