import { test } from "node:test";
import assert from "node:assert/strict";
import { Doc, ROOT, cmpTs, treeProblems } from "../src/crdt.js";

test("timestamps order by counter, then replica", () => {
  assert.ok(cmpTs([1, "b"], [2, "a"]) < 0);
  assert.ok(cmpTs([2, "a"], [2, "b"]) < 0);
  assert.equal(cmpTs([3, "x"], [3, "x"]), 0);
});

test("applying an op twice changes nothing", () => {
  const a = new Doc("a");
  const op = a.create("rect", ROOT, { x: 1 });
  const b = new Doc("b");
  assert.equal(b.apply(op), true);
  const snap = b.snapshot();
  assert.equal(b.apply(op), false);
  assert.equal(b.snapshot(), snap);
});

test("concurrent sets converge to the larger timestamp in any order", () => {
  const a = new Doc("a"), b = new Doc("b");
  const c = a.create("rect", ROOT, { x: 0 });
  b.apply(c);
  const sa = a.set(c.id, "x", 10), sb = b.set(c.id, "x", 20);
  a.apply(sb);
  b.apply(sa);
  assert.equal(a.snapshot(), b.snapshot());
  assert.equal(a.get(c.id, "x"), 20);  // same counter, replica "b" > "a"
});

test("ops can arrive before the create they refer to", () => {
  const a = new Doc("a");
  const c = a.create("rect", ROOT, { x: 0 });
  const s = a.set(c.id, "fill", "#ff0000");
  const b = new Doc("b");
  b.apply(s);
  assert.equal(b.live(c.id), false);
  b.apply(c);
  assert.equal(b.get(c.id, "fill"), "#ff0000");
  assert.equal(b.snapshot(), a.snapshot());
});

test("local moves into your own subtree are refused", () => {
  const a = new Doc("a");
  const f = a.create("frame", ROOT, {});
  const g = a.create("frame", f.id, {});
  assert.equal(a.move(f.id, g.id), null);
  assert.equal(a.move(f.id, f.id), null);
  assert.deepEqual(treeProblems(a), []);
});

test("children are ordered by index", () => {
  const a = new Doc("a");
  const f = a.create("frame", ROOT, {});
  const x = a.create("rect", f.id, {}), y = a.create("rect", f.id, {}), z = a.create("rect", f.id, {}, 0);
  assert.deepEqual(a.children(f.id), [z.id, x.id, y.id]);
  a.move(x.id, f.id, 3);
  assert.deepEqual(a.children(f.id), [z.id, y.id, x.id]);
});

test("deleting a frame hides its children without calling them lost", () => {
  const a = new Doc("a");
  const f = a.create("frame", ROOT, {});
  a.create("rect", f.id, {});
  a.remove(f.id);
  assert.deepEqual(a.visibleTree(), []);
  assert.deepEqual(treeProblems(a), []);
});
