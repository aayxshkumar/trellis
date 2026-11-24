// Client side of the sync protocol, for the browser (and Node 22, which has a
// global WebSocket). Local ops are applied at once and queued; the queue is
// sent whenever the socket is open and re-sent after a reconnect, so edits
// made offline merge when the connection comes back. The server ignores ops
// it already has, so re-sending is safe.

export class Sync {
  constructor(doc, url, { onStatus = () => {}, onCursor = () => {}, onLeave = () => {} } = {}) {
    this.doc = doc;
    this.url = url;
    this.pending = [];        // local ops not yet acknowledged by an open socket
    this.fromServer = 0;      // how many server log ops we have seen
    this.onStatus = onStatus;
    this.onCursor = onCursor;
    this.onLeave = onLeave;
    this.ws = null;
    this.stopped = false;
    this.offline = false;     // forced offline (the UI's "go offline" switch)
    this.connect();
  }

  status(s) {
    this.state = s;
    this.onStatus(s);
  }

  connect() {
    if (this.stopped || this.offline) return;
    this.status("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.status("online");
      ws.send(JSON.stringify({ t: "hello", replica: this.doc.replica, have: this.fromServer }));
      this.flush();
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
      if (msg.t === "ops") {
        for (const op of msg.ops) this.doc.apply(op);
        if (typeof msg.total === "number") this.fromServer = Math.max(this.fromServer, msg.total);
      } else if (msg.t === "cursor") {
        this.onCursor(msg);
      } else if (msg.t === "leave") {
        this.onLeave(msg.replica);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.status(this.offline ? "offline" : "reconnecting");
      if (!this.stopped && !this.offline) setTimeout(() => this.connect(), 500);
    };
    ws.onerror = () => {};
  }

  // Call with every op made locally.
  local(op) {
    if (!op) return;
    this.pending.push(op);
    this.flush();
  }

  flush() {
    if (!this.ws || this.ws.readyState !== 1 || this.pending.length === 0) return;
    this.ws.send(JSON.stringify({ t: "ops", ops: this.pending }));
    this.pending = [];
  }

  cursor(x, y, name) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: "cursor", replica: this.doc.replica, x, y, name }));
  }

  setOffline(off) {
    this.offline = off;
    if (off && this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.close();
      this.status("offline");
    } else if (!off) {
      this.connect();
    }
  }

  stop() {
    this.stopped = true;
    if (this.ws) this.ws.close();
  }
}
