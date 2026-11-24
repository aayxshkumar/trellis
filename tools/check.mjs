// trellis checks: properties, the convergence fuzzer, the WebSocket codec,
// a real server with real WebSocket clients (one of them going offline),
// restart durability, and start-up replay time. KNOWN GAP rows are measured
// weaknesses.
//
//   node tools/check.mjs

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { between, DIGITS } from "../src/fracindex.js";
import { Doc, ROOT } from "../src/crdt.js";
import { Sync } from "../src/sync.js";
import { encodeFrame, FrameDecoder } from "../server/ws.mjs";
import { startServer } from "../server/server.mjs";
import { rng, runSeed } from "./fuzz.mjs";

const rows = [];
const add = (name, value, threshold, measures, gap = false) =>
  rows.push({ name, result: value <= threshold ? "PASS" : gap ? "KNOWN GAP" : "FAIL", value, threshold, measures });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = performance.now();

// 1. Fractional index keys.
{
  const r = rng(7);
  let bad = 0;
  const randKey = () => {
    let s = "";
    const n = 1 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) s += DIGITS[Math.floor(r() * DIGITS.length)];
    return s.replace(/0+$/, "") || "V";
  };
  for (let k = 0; k < 20000; k++) {
    let a = r() < 0.2 ? null : randKey();
    let b = r() < 0.2 ? null : randKey();
    if (a !== null && b !== null) {
      if (a === b) continue;
      if (a > b) [a, b] = [b, a];
    }
    const m = between(a, b);
    if ((a !== null && !(a < m)) || (b !== null && !(m < b)) || m.endsWith("0")) bad++;
  }
  add("fracindex", bad, 0, "keys from between(a, b) not strictly between, or ending in the lowest digit, of 20 000");
}

// 2-4. Fuzzer.
{
  let diverged = 0, cycles = 0, ties = 0;
  const seeds = 500;
  for (let s = 1; s <= seeds; s++) {
    const res = runSeed(s);
    if (!res.converged) diverged++;
    if (res.problems.length) cycles++;
  }
  // Sibling order-key ties: two replicas inserting at the same place at once.
  for (let s = 1; s <= seeds; s++) {
    const a = new Doc("a"), b = new Doc("b");
    const r = rng(s);
    const f = a.create("frame", ROOT, {});
    b.apply(f);
    for (let k = 0; k < 4; k++) {
      const op = a.create("rect", f.id, {});
      b.apply(op);
    }
    const i = Math.floor(r() * 5);
    const x = a.create("rect", f.id, {}, i), y = b.create("rect", f.id, {}, i);
    a.apply(y);
    b.apply(x);
    const keys = a.children(f.id).map((id) => a.nodes.get(id).order.v);
    if (new Set(keys).size !== keys.length) ties++;
  }
  add("converged", diverged, 0, `fuzz seeds where replicas end in different states, of ${seeds} (4 replicas, reordered + duplicated delivery)`);
  add("tree-valid", cycles / seeds, 0, `fraction of fuzz seeds where concurrent moves make a parent cycle and shapes vanish`, true);
  add("sibling-ties", ties / seeds, 0, "fraction of concurrent same-position inserts that end with two siblings sharing an order key", true);
}

// 5. WebSocket framing.
{
  let bad = 0;
  for (const n of [0, 1, 125, 126, 127, 65535, 65536, 70000]) {
    const payload = Buffer.alloc(n, 97 + (n % 26));
    // A masked client frame, fragmented in two, fed one byte at a time for small ones.
    const mask = Buffer.from([1, 2, 3, 4]);
    const frame = (fin, opcode, data) => {
      const f = encodeFrame(opcode, data);
      const hl = data.length < 126 ? 2 : data.length < 65536 ? 4 : 10;
      const head = Buffer.from(f.subarray(0, hl));
      head[0] = (fin ? 0x80 : 0) | opcode;
      head[1] |= 0x80;
      const body = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) body[i] = data[i] ^ mask[i & 3];
      return Buffer.concat([head, mask, body]);
    };
    const half = Math.floor(n / 2);
    const bytes = Buffer.concat([frame(false, 1, payload.subarray(0, half)), frame(true, 0, payload.subarray(half))]);
    const dec = new FrameDecoder();
    let msgs = [];
    if (n < 200) for (const b of bytes) msgs = msgs.concat(dec.push(Buffer.from([b])));
    else msgs = dec.push(bytes);
    if (msgs.length !== 1 || msgs[0].opcode !== 1 || !msgs[0].data.equals(payload)) bad++;
    const back = new FrameDecoder().push(encodeFrame(1, payload));
    if (back.length !== 1 || !back[0].data.equals(payload)) bad++;
  }
  add("ws-framing", bad, 0, "WebSocket frames (0-70 000 bytes, masked, fragmented, split byte by byte) decoded wrong");
}

// 6-7. Real server, real WebSocket clients, one goes offline and edits.
const dataDir = mkdtempSync(join(tmpdir(), "trellis-check-"));
try {
  let server = await startServer({ port: 0, dataDir, docName: "check" });
  const url = `ws://127.0.0.1:${server.port}/ws`;
  const clients = [0, 1, 2].map((i) => {
    const d = new Doc(`c${i}`);
    return { d, s: new Sync(d, url) };
  });
  await sleep(300);
  const r = rng(42);
  for (let step = 0; step < 300; step++) {
    const c = clients[Math.floor(r() * 3)];
    if (step === 100) clients[2].s.setOffline(true);
    if (step === 220) clients[2].s.setOffline(false);
    const live = c.d.visibleTree().map((e) => e.id);
    const frames = live.filter((id) => c.d.nodes.get(id).kind === "frame");
    const roll = r();
    if (live.length < 3 || roll < 0.3) c.s.local(c.d.create(r() < 0.4 ? "frame" : "rect", frames.length ? frames[0] : ROOT, { x: step, y: step }));
    else if (roll < 0.7) c.s.local(c.d.set(live[Math.floor(r() * live.length)], "x", Math.floor(r() * 500)));
    else c.s.local(c.d.move(live[Math.floor(r() * live.length)], frames.length ? frames[Math.floor(r() * frames.length)] : ROOT));
    if (step % 20 === 0) await sleep(5);
  }
  let same = false;
  for (let k = 0; k < 100 && !same; k++) {
    await sleep(100);
    const snaps = clients.map((c) => c.d.snapshot()).concat([server.doc.snapshot()]);
    same = snaps.every((x) => x === snaps[0]);
  }
  add("live-sync", same ? 0 : 1, 0, "3 WebSocket clients + server not identical after 300 edits (client 2 offline for 120 of them)");
  const before = server.doc.snapshot();
  for (const c of clients) c.s.stop();
  await server.close();
  server = await startServer({ port: 0, dataDir, docName: "check" });
  const late = new Doc("late");
  const ls = new Sync(late, `ws://127.0.0.1:${server.port}/ws`);
  await sleep(500);
  add("restart", server.doc.snapshot() === before && late.snapshot() === before ? 0 : 1, 0,
      "server restarted from its op log, or a new client, sees a different document");
  ls.stop();
  await server.close();

  // 8. Start-up replay of a long history.
  const big = new Doc("big");
  const lines = [];
  const rr = rng(3);
  const ids = [];
  for (let k = 0; k < 100000; k++) {
    let op;
    if (ids.length < 200 || rr() < 0.05) {
      op = big.create("rect", ROOT, { x: k });
      ids.push(op.id);
    } else {
      op = big.set(ids[Math.floor(rr() * ids.length)], "x", k);
    }
    lines.push(JSON.stringify(op));
  }
  writeFileSync(join(dataDir, "big.jsonl"), lines.join("\n") + "\n");
  server = await startServer({ port: 0, dataDir, docName: "big" });
  add("replay-100k", server.replayMs, 300, `ms to replay a 100 000-op log at start-up (${(lines.join("\n").length / 1e6).toFixed(1)} MB, no snapshots)`, true);
  await server.close();
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`${"check".padEnd(16)} ${"result".padEnd(10)} ${"value".padStart(10)} ${"threshold".padStart(10)}  measures`);
for (const r of rows)
  console.log(`${r.name.padEnd(16)} ${r.result.padEnd(10)} ${String(+r.value.toPrecision(6)).padStart(10)} ${String(r.threshold).padStart(10)}  ${r.measures}`);
const failed = rows.filter((r) => r.result === "FAIL").length;
const gaps = rows.filter((r) => r.result === "KNOWN GAP").length;
console.log(`\n${failed} failed, ${gaps} known gaps (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
