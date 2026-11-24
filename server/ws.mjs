// WebSocket server side (RFC 6455), just enough for trellis: the opening
// handshake, text frames in both directions (client frames are masked),
// 16- and 64-bit lengths, fragmented messages, ping/pong and close. No
// extensions (so no permessage-deflate).

import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptKey(key) {
  return createHash("sha1").update(key + GUID).digest("base64");
}

// Encode one unmasked server frame.
export function encodeFrame(opcode, payload) {
  const data = typeof payload === "string" ? Buffer.from(payload) : payload;
  let head;
  if (data.length < 126) {
    head = Buffer.from([0x80 | opcode, data.length]);
  } else if (data.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(data.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([head, data]);
}

// Incremental decoder: feed bytes, get complete messages back.
export class FrameDecoder {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragOpcode = 0;
  }

  // Returns [{opcode, data}] for each complete message (fragments joined).
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let pos = 2;
      if (len === 126) {
        if (this.buf.length < 4) break;
        len = this.buf.readUInt16BE(2);
        pos = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) break;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(64 * 1024 * 1024)) throw new Error("frame too large");
        len = Number(big);
        pos = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < pos + maskLen + len) break;
      let data = this.buf.subarray(pos + maskLen, pos + maskLen + len);
      if (masked) {
        const mask = this.buf.subarray(pos, pos + 4);
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) unmasked[i] = data[i] ^ mask[i & 3];
        data = unmasked;
      } else {
        data = Buffer.from(data);
      }
      this.buf = this.buf.subarray(pos + maskLen + len);
      if (opcode >= 0x8) {
        out.push({ opcode, data });  // control frames are never fragmented
      } else if (opcode === 0) {
        this.fragments.push(data);
        if (fin) {
          out.push({ opcode: this.fragOpcode, data: Buffer.concat(this.fragments) });
          this.fragments = [];
        }
      } else if (fin) {
        out.push({ opcode, data });
      } else {
        this.fragOpcode = opcode;
        this.fragments = [data];
      }
    }
    return out;
  }
}

// Upgrade an HTTP request to a WebSocket. Returns a small connection object
// with send(text), close(), and onmessage / onclose hooks.
export function upgrade(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key || (req.headers.upgrade || "").toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return null;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  const conn = {
    onmessage: () => {},
    onclose: () => {},
    open: true,
    send(text) {
      if (conn.open) socket.write(encodeFrame(0x1, text));
    },
    close() {
      if (!conn.open) return;
      conn.open = false;
      socket.end(encodeFrame(0x8, Buffer.alloc(0)));
    },
  };
  const dec = new FrameDecoder();
  socket.on("data", (chunk) => {
    let msgs;
    try {
      msgs = dec.push(chunk);
    } catch {
      conn.close();
      return;
    }
    for (const m of msgs) {
      if (m.opcode === 0x1) conn.onmessage(m.data.toString("utf8"));
      else if (m.opcode === 0x9) socket.write(encodeFrame(0xa, m.data));
      else if (m.opcode === 0x8) conn.close();
    }
  });
  const done = () => {
    if (conn.open) conn.open = false;
    conn.onclose();
  };
  socket.on("close", done);
  socket.on("error", () => socket.destroy());
  return conn;
}
