import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptKey, encodeFrame, FrameDecoder } from "../server/ws.mjs";

test("accept key matches the RFC 6455 example", () => {
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("length encodings", () => {
  assert.equal(encodeFrame(1, Buffer.alloc(125))[1], 125);
  assert.equal(encodeFrame(1, Buffer.alloc(126))[1], 126);
  assert.equal(encodeFrame(1, Buffer.alloc(65536))[1], 127);
});

test("decoder waits for a whole frame", () => {
  const d = new FrameDecoder();
  const f = encodeFrame(1, "hello");
  assert.deepEqual(d.push(f.subarray(0, 3)), []);
  const msgs = d.push(f.subarray(3));
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].data.toString(), "hello");
});
