import { expect, test } from "bun:test";
import { readSse } from "./sse";
test("SSE decodes CRLF, multi-line payloads and UTF-8 split at every byte", async () => {
  const data = new TextEncoder().encode(': heartbeat\r\nid: 42\r\ndata: {"name":\r\ndata: "café"}\r\n\r\n');
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const byte of data) c.enqueue(new Uint8Array([byte])); c.close(); } });
  const messages: unknown[] = [];
  await readSse(stream, (data, id) => messages.push([JSON.parse(data), id]));
  expect(messages).toEqual([[{ name: "café" }, "42"]]);
});
test("SSE cancellation cancels an idle upstream reader", async () => {
  let cancelled = false;
  const stop = new AbortController();
  const task = readSse(new ReadableStream({ cancel() { cancelled = true; } }), () => {}, stop.signal);
  stop.abort(); await task;
  expect(cancelled).toBe(true);
});
