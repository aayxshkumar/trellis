import { test } from "node:test";
import assert from "node:assert/strict";
import { between, spread } from "../src/fracindex.js";

test("between respects its bounds", () => {
  for (const [a, b] of [[null, null], [null, "V"], ["V", null], ["A", "B"], ["Az", "B"], ["V", "V1"], ["zz", null]]) {
    const m = between(a, b);
    if (a) assert.ok(a < m, `${a} < ${m}`);
    if (b) assert.ok(m < b, `${m} < ${b}`);
    assert.ok(!m.endsWith("0"));
  }
});

test("between rejects reversed bounds", () => {
  assert.throws(() => between("B", "A"));
  assert.throws(() => between("A", "A"));
});

test("repeated inserts at the front stay ordered", () => {
  let first = "V";
  const keys = [first];
  for (let k = 0; k < 200; k++) {
    first = between(null, first);
    keys.unshift(first);
  }
  assert.deepEqual([...keys].sort(), keys);
  assert.equal(spread("A", "B", 50).length, 50);
});
