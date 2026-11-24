// The document CRDT. Every node (frame, rect, ellipse, text) is a set of
// last-writer-wins registers: one per property, plus parent, order (a
// fractional index among its siblings) and deleted. Ops carry a Lamport
// timestamp [counter, replica]; the larger timestamp wins, so replicas that
// have seen the same set of ops hold the same state, whatever order the ops
// arrived in and however often they were repeated.
//
// KNOWN GAP: parent is a plain LWW register. Two replicas that concurrently
// move A into B and B into A both win somewhere, and after merging A and B
// are each other's parent: a cycle, cut off from the root, so both vanish
// from every replica. tools/fuzz.mjs measures how often that happens.

import { between } from "./fracindex.js";

export const ROOT = "root";

export function cmpTs(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

const tsKey = (ts) => `${ts[0]}.${ts[1]}`;

// Concurrent inserts at the same spot can give two siblings the same order
// key (ties are then broken by id). Placing a node between two equal keys is
// impossible, so it goes just after the first one instead.
function keyBetween(before, after) {
  if (before !== null && after !== null && !(before < after)) return between(before, null);
  return between(before, after);
}

function newNode(id) {
  return { id, kind: null, created: null, props: {}, parent: null, order: null, deleted: null };
}

// Set a register if the op is newer. Returns true when it changed.
function lww(reg, value, ts) {
  if (reg && cmpTs(reg.ts, ts) >= 0) return [reg, false];
  return [{ v: value, ts }, true];
}

export class Doc {
  constructor(replica) {
    this.replica = String(replica);
    this.clock = 0;
    this.nodes = new Map();
    this.seen = new Set();
    this.log = [];  // every op applied, in arrival order (the server persists this)
    this.listeners = new Set();
  }

  tick() {
    this.clock += 1;
    return [this.clock, this.replica];
  }

  node(id) {
    let n = this.nodes.get(id);
    if (!n) {
      n = newNode(id);
      this.nodes.set(id, n);
    }
    return n;
  }

  // Apply a local or remote op. Idempotent and commutative. Returns true if
  // the op was new.
  apply(op) {
    const key = tsKey(op.ts);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.log.push(op);
    this.clock = Math.max(this.clock, op.ts[0]);
    const n = this.node(op.id);
    switch (op.type) {
      case "create": {
        if (!n.created || cmpTs(op.ts, n.created) < 0) {
          n.kind = op.kind;
          n.created = op.ts;
        }
        [n.parent] = lww(n.parent, op.parent, op.ts);
        [n.order] = lww(n.order, op.order, op.ts);
        for (const [k, v] of Object.entries(op.props || {})) [n.props[k]] = lww(n.props[k], v, op.ts);
        break;
      }
      case "set":
        [n.props[op.key]] = lww(n.props[op.key], op.value, op.ts);
        break;
      case "move":
        [n.parent] = lww(n.parent, op.parent, op.ts);
        [n.order] = lww(n.order, op.order, op.ts);
        break;
      case "delete":
        [n.deleted] = lww(n.deleted, true, op.ts);
        break;
      default:
        throw new Error(`unknown op type ${op.type}`);
    }
    for (const f of this.listeners) f(op);
    return true;
  }

  // ------------------------------------------------------------ queries

  live(id) {
    const n = this.nodes.get(id);
    return !!n && n.kind !== null && !(n.deleted && n.deleted.v);
  }

  get(id, key, fallback) {
    const n = this.nodes.get(id);
    return n && n.props[key] ? n.props[key].v : fallback;
  }

  parentOf(id) {
    const n = this.nodes.get(id);
    return n && n.parent ? n.parent.v : null;
  }

  // Live children of a node, in order (ties broken by id so every replica agrees).
  children(id) {
    const out = [];
    for (const n of this.nodes.values()) {
      if (n.parent && n.parent.v === id && this.live(n.id)) out.push(n);
    }
    out.sort((a, b) => (a.order.v < b.order.v ? -1 : a.order.v > b.order.v ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out.map((n) => n.id);
  }

  // Depth-first from the root: what the canvas actually shows.
  visibleTree() {
    const out = [];
    const walk = (id, depth) => {
      for (const c of this.children(id)) {
        out.push({ id: c, depth });
        walk(c, depth + 1);
      }
    };
    walk(ROOT, 0);
    return out;
  }

  isAncestor(maybeAncestor, id) {
    let cur = this.parentOf(id);
    for (let guard = 0; cur !== null && guard < this.nodes.size + 1; guard++) {
      if (cur === maybeAncestor) return true;
      cur = this.parentOf(cur);
    }
    return false;
  }

  // Canonical state for comparing replicas: register values only.
  snapshot() {
    const ids = [...this.nodes.keys()].sort();
    return JSON.stringify(
      ids.map((id) => {
        const n = this.nodes.get(id);
        const props = Object.keys(n.props).sort().map((k) => [k, n.props[k].v]);
        return [id, n.kind, n.parent && n.parent.v, n.order && n.order.v, !!(n.deleted && n.deleted.v), props];
      }),
    );
  }

  // ------------------------------------------------------------ local edits (return the op, already applied)

  orderAt(parent, index) {
    const sibs = this.children(parent);
    const before = index > 0 ? this.nodes.get(sibs[index - 1]).order.v : null;
    const after = index < sibs.length ? this.nodes.get(sibs[index]).order.v : null;
    return keyBetween(before, after);
  }

  create(kind, parent, props, index = Infinity) {
    const ts = this.tick();
    const id = `${kind}-${tsKey(ts)}`;
    const sibs = this.children(parent).length;
    const op = { type: "create", ts, id, kind, parent, order: this.orderAt(parent, Math.min(index, sibs)), props };
    this.apply(op);
    return op;
  }

  set(id, key, value) {
    const op = { type: "set", ts: this.tick(), id, key, value };
    this.apply(op);
    return op;
  }

  // Refuses moves into the node's own subtree locally; concurrent moves can
  // still make a cycle (see the comment at the top).
  move(id, parent, index = Infinity) {
    if (id === parent || this.isAncestor(id, parent)) return null;
    const sibs = this.children(parent).filter((c) => c !== id);
    const i = Math.min(index, sibs.length);
    const before = i > 0 ? this.nodes.get(sibs[i - 1]).order.v : null;
    const after = i < sibs.length ? this.nodes.get(sibs[i]).order.v : null;
    const op = { type: "move", ts: this.tick(), id, parent, order: keyBetween(before, after) };
    this.apply(op);
    return op;
  }

  remove(id) {
    const op = { type: "delete", ts: this.tick(), id };
    this.apply(op);
    return op;
  }
}

// Invariants the visible document should satisfy after any merge: a live
// node whose ancestors are all live must be reachable from the root. Nodes
// under a deleted frame are hidden on purpose; nodes on a parent cycle are
// lost, and that is the bug.
export function treeProblems(doc) {
  const reachable = new Set(doc.visibleTree().map((e) => e.id));
  const problems = [];
  for (const n of doc.nodes.values()) {
    if (!doc.live(n.id) || reachable.has(n.id)) continue;
    const seen = new Set([n.id]);
    let cur = doc.parentOf(n.id);
    let verdict = "hidden";
    while (true) {
      if (cur === ROOT) {
        verdict = "lost";  // every ancestor live, yet not reachable: impossible unless ordering broke
        break;
      }
      if (cur === null || !doc.live(cur)) break;  // under a deleted or unknown frame
      if (seen.has(cur)) {
        verdict = "cycle";
        break;
      }
      seen.add(cur);
      cur = doc.parentOf(cur);
    }
    if (verdict !== "hidden") problems.push(`${n.id}: ${verdict}`);
  }
  return problems;
}
