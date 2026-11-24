// trellis server: serves web/ and src/, relays ops between clients over
// WebSocket, and keeps the document as an append-only op log
// (data/<doc>.jsonl) so it survives a restart.
//
//   node server/server.mjs [--port 8090] [--data data] [--doc main]
//
// Protocol (JSON text frames):
//   client -> server  {"t":"hello","replica":"r1","have":N}   N = ops the client already has from the server
//   server -> client  {"t":"ops","ops":[...],"total":M}        backlog, then live ops from others
//   client -> server  {"t":"ops","ops":[...]}                  local ops (sent again after a reconnect)
//   client <-> server {"t":"cursor","replica":"r1","x":..,"y":..,"name":".."}   presence, not stored

import { createServer } from "node:http";
import { readFileSync, existsSync, appendFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { upgrade } from "./ws.mjs";
import { Doc } from "../src/crdt.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

export function startServer({ port = 8090, dataDir = join(ROOT, "data"), docName = "main", host = "127.0.0.1" } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const logPath = join(dataDir, `${docName}.jsonl`);
  const doc = new Doc("server");
  // Replay the whole log on start. KNOWN GAP: no snapshots or compaction, so
  // start-up time and the backlog sent to every new client grow with history.
  const t0 = performance.now();
  if (existsSync(logPath)) {
    for (const line of readFileSync(logPath, "utf8").split("\n")) {
      if (!line) continue;
      try {
        doc.apply(JSON.parse(line));
      } catch {
        // a torn last line after a crash: skip it
      }
    }
  }
  const replayMs = performance.now() - t0;
  const clients = new Set();

  const http = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/stats") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ops: doc.log.length, nodes: doc.nodes.size, clients: clients.size, replayMs }));
      return;
    }
    let path = url.pathname === "/" ? "/web/index.html" : url.pathname;
    if (!path.startsWith("/web/") && !path.startsWith("/src/")) path = "/web" + path;
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(file));
  });

  http.on("upgrade", (req, socket) => {
    const conn = upgrade(req, socket);
    if (!conn) return;
    const client = { conn, replica: null };
    clients.add(client);
    conn.onmessage = (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.t === "hello") {
        client.replica = String(msg.replica);
        const have = Math.max(0, Math.min(doc.log.length, msg.have | 0));
        conn.send(JSON.stringify({ t: "ops", ops: doc.log.slice(have), total: doc.log.length }));
      } else if (msg.t === "ops" && Array.isArray(msg.ops)) {
        const fresh = msg.ops.filter((op) => doc.apply(op));
        if (fresh.length === 0) return;
        appendFileSync(logPath, fresh.map((op) => JSON.stringify(op) + "\n").join(""));
        const out = JSON.stringify({ t: "ops", ops: fresh, total: doc.log.length });
        for (const c of clients) if (c !== client) c.conn.send(out);
      } else if (msg.t === "cursor") {
        const out = JSON.stringify(msg);
        for (const c of clients) if (c !== client) c.conn.send(out);
      }
    };
    conn.onclose = () => {
      clients.delete(client);
      const out = JSON.stringify({ t: "leave", replica: client.replica });
      for (const c of clients) c.conn.send(out);
    };
  });

  return new Promise((resolve) => {
    http.listen(port, host, () => resolve({ http, doc, replayMs, port: http.address().port, close: () => new Promise((r) => {
      for (const c of clients) c.conn.close();
      http.close(() => r());
      http.closeAllConnections?.();
    }) }));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (k, d) => {
    const i = process.argv.indexOf(`--${k}`);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const s = await startServer({ port: Number(arg("port", 8090)), dataDir: arg("data", join(ROOT, "data")), docName: arg("doc", "main") });
  console.log(`trellis: ${s.doc.log.length} ops replayed in ${s.replayMs.toFixed(1)} ms`);
  console.log(`trellis: open http://127.0.0.1:${s.port}/`);
}
