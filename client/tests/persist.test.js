// Tests for deepMerge (Task 3 persist). Pure, no DOM, no localStorage.
//
// Contract: CONTRACTS.md section 10 (deep merge semantics), SPEC.md 7.9.
// Arrays replace. Plain objects merge recursively. Primitives/null replace.

import { test } from "node:test";
import assert from "node:assert/strict";
import { deepMerge } from "../src/persist.js";

test("deepMerge nested objects without clobber", () => {
  const out = deepMerge({ a: 1, n: { x: 1 } }, { n: { y: 2 } });
  assert.deepEqual(out, { a: 1, n: { x: 1, y: 2 } });
});

test("deepMerge arrays replace not concat", () => {
  const out = deepMerge({ arr: [1, 2] }, { arr: [3] });
  assert.deepEqual(out, { arr: [3] });
});

test("deepMerge adds missing keys", () => {
  const out = deepMerge({}, { iid: "x" });
  assert.deepEqual(out, { iid: "x" });
});

test("deepMerge null/primitive replaces object", () => {
  assert.deepEqual(deepMerge({ n: { x: 1 } }, { n: 5 }), { n: 5 });
  assert.deepEqual(deepMerge({ n: { x: 1 } }, { n: null }), { n: null });
});

test("deepMerge does not mutate the partial", () => {
  const partial = { n: { y: 2 } };
  deepMerge({ a: 1, n: { x: 1 } }, partial);
  assert.deepEqual(partial, { n: { y: 2 } });
});

test("deepMerge returns the target", () => {
  const target = { a: 1 };
  assert.equal(deepMerge(target, { b: 2 }), target);
  assert.deepEqual(target, { a: 1, b: 2 });
});

test("deepMerge multi-level nesting", () => {
  const out = deepMerge(
    { a: { b: { c: 1, d: 2 } } },
    { a: { b: { c: 9, e: 3 }, f: 4 } },
  );
  assert.deepEqual(out, { a: { b: { c: 9, d: 2, e: 3 }, f: 4 } });
});
