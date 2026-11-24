// Convergence fuzzer. For each seed: several replicas make random edits
// (create, set, move, delete) while a simulated network delivers each op to
// the others late, out of order and sometimes twice. At the end everything
// is delivered and we check two things:
//   converged:  every replica holds exactly the same state
//   tree-valid: no live shape is lost from the canvas (no parent cycles)
//
//   node tools/fuzz.mjs [--seeds 500] [--replicas 4] [--ops 120] [--seed N] [--verbose]

import { Doc, ROOT, treeProblems } from "../src/crdt.js";

// mulberry32: tiny, seedable, the same everywhere.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function runSeed(seed, { replicas = 4, ops = 120 } = {}) {
  const r = rng(seed);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const docs = Array.from({ length: replicas }, (_, i) => new Doc(`r${i}`));
  const inflight = [];  // {to, op, at}
  let step = 0;
  const broadcast = (from, op) => {
    if (!op) return;
    for (let k = 0; k < docs.length; k++) {
      if (k === from) continue;
      inflight.push({ to: k, op, at: step + Math.floor(r() * 30) });
      if (r() < 0.1) inflight.push({ to: k, op, at: step + Math.floor(r() * 60) });  // duplicate
    }
  };
  for (step = 0; step < ops; step++) {
    // Deliver whatever is due, in random order.
    for (let i = inflight.length - 1; i >= 0; i--) {
      if (inflight[i].at <= step && r() < 0.7) {
        const { to, op } = inflight.splice(i, 1)[0];
        docs[to].apply(op);
      }
    }
    const who = Math.floor(r() * docs.length);
    const d = docs[who];
    const live = d.visibleTree().map((e) => e.id);
    const frames = live.filter((id) => d.nodes.get(id).kind === "frame");
    const roll = r();
    if (live.length < 3 || roll < 0.25) {
      const kind = r() < 0.4 ? "frame" : pick(["rect", "ellipse", "text"]);
      const parent = frames.length && r() < 0.6 ? pick(frames) : ROOT;
      broadcast(who, d.create(kind, parent, { x: Math.floor(r() * 400), y: Math.floor(r() * 300), w: 50, h: 40, fill: "#4f8cff" }));
    } else if (roll < 0.55) {
      const id = pick(live);
      broadcast(who, d.set(id, pick(["x", "y", "w", "h", "fill"]), Math.floor(r() * 500)));
    } else if (roll < 0.9) {
      const id = pick(live);
      const target = frames.length && r() < 0.8 ? pick(frames) : ROOT;
      broadcast(who, d.move(id, target, Math.floor(r() * 4)));
    } else {
      broadcast(who, d.remove(pick(live)));
    }
  }
  for (const { to, op } of inflight) docs[to].apply(op);
  // Everyone also gets everything (catches ops a replica made but never sent).
  for (const a of docs) for (const b of docs) for (const op of b.log) a.apply(op);
  const snaps = docs.map((d) => d.snapshot());
  const converged = snaps.every((s) => s === snaps[0]);
  const problems = treeProblems(docs[0]);
  return { converged, problems, ops: docs[0].log.length, nodes: docs[0].nodes.size };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, d) => {
    const i = process.argv.indexOf(`--${k}`);
    return i > 0 ? Number(process.argv[i + 1]) : d;
  };
  const verbose = process.argv.includes("--verbose");
  const only = arg("seed", null);
  const seeds = only !== null ? [only] : Array.from({ length: arg("seeds", 500) }, (_, i) => i + 1);
  let diverged = 0, broken = 0;
  for (const s of seeds) {
    const res = runSeed(s, { replicas: arg("replicas", 4), ops: arg("ops", 120) });
    if (!res.converged) diverged++;
    if (res.problems.length) broken++;
    if (verbose || only !== null) console.log(`seed ${s}: ${res.ops} ops, converged ${res.converged}, ${res.problems.join("; ") || "tree ok"}`);
  }
  console.log(`${seeds.length} seeds: ${diverged} diverged, ${broken} with shapes lost to parent cycles`);
}
