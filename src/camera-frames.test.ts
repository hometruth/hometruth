import { afterEach, expect, test } from "bun:test";
import { LatestCameraFrames, MjpegFrameParser } from "./camera-frames";

const jpeg = (id: number) => new Uint8Array([255, 216, id, 255, 217]);
const part = (id: number) => Buffer.concat([Buffer.from("--ffmpeg\r\nContent-type: image/jpeg\r\nContent-length: 5\r\n\r\n"), jpeg(id), Buffer.from("\r\n")]);
const signal = new AbortController().signal;
const source = { streamUri: "rtsps://10.77.0.119:7441/test" };
const active: LatestCameraFrames[] = [];
afterEach(() => { for (const frames of active.splice(0)) frames.stop(); });

function fixture(timeoutMs = 100) {
  let now = 0, opened = 0, cancelled = 0;
  let pipe!: ReadableStreamDefaultController<Uint8Array>;
  const frames = new LatestCameraFrames({ now: () => now, timeoutMs, open: () => {
    opened++;
    return new Response(new ReadableStream<Uint8Array>({ start(c) { pipe = c; }, cancel() { cancelled++; } }));
  } });
  active.push(frames);
  return { frames, send: (id: number) => pipe.enqueue(part(id)), end: () => pipe.close(), advance: () => { now += 2000; }, counts: () => ({ opened, cancelled }) };
}

test("multipart parser handles split headers, split JPEGs, multiple frames and mid-frame joining", () => {
  const parser = new MjpegFrameParser();
  const bytes = Buffer.concat([Buffer.from("partial older JPEG\r\n"), part(1), part(2)]);
  const frames: Uint8Array[] = [];
  for (const byte of bytes) frames.push(...parser.push(new Uint8Array([byte])));
  expect(frames).toEqual([jpeg(1), jpeg(2)]);
  expect(() => new MjpegFrameParser().push(Buffer.from("--ffmpeg\r\nContent-Length: 9000000\r\n\r\n"))).toThrow("frame size");
});

test("concurrent checks share one connection and later checks get the newest frame", async () => {
  const f = fixture();
  const first = f.frames.snapshot(source, signal), second = f.frames.snapshot(source, signal);
  f.send(1);
  expect((await first).bytes).toEqual(jpeg(1)); expect((await second).bytes).toEqual(jpeg(1));
  f.advance();
  const next = f.frames.snapshot(source, signal);
  f.send(2);
  expect((await next).bytes).toEqual(jpeg(2));
  const fresh = f.frames.snapshot(source, signal);
  f.send(3); expect((await fresh).bytes).toEqual(jpeg(3));
  expect(f.counts().opened).toBe(1);
});

test("stale frames time out and the next check reconnects instead of using old pixels", async () => {
  const f = fixture(10);
  const first = f.frames.snapshot(source, signal); f.send(1); await first;
  f.advance();
  await expect(f.frames.snapshot(source, signal)).rejects.toThrow("No fresh camera frame");
  const retry = f.frames.snapshot(source, signal); f.send(2);
  expect((await retry).bytes).toEqual(jpeg(2));
  expect(f.counts()).toEqual({ opened: 2, cancelled: 1 });
});

test("disconnection clears the cached frame and pending checks fail", async () => {
  const f = fixture();
  const pending = f.frames.snapshot(source, signal); f.end();
  await expect(pending).rejects.toThrow("disconnected");
  const retry = f.frames.snapshot(source, signal); f.send(3);
  expect((await retry).bytes).toEqual(jpeg(3));
  expect(f.counts().opened).toBe(2);
});

test("switching source and stopping cancel pending reads and release subscriptions", async () => {
  const f = fixture();
  const first = f.frames.snapshot(source, signal);
  const rejected = first.catch(error => error as Error);
  const next = f.frames.snapshot({ streamUri: "rtsps://10.77.0.119:7441/other" }, signal);
  expect((await rejected as Error).message).toContain("stopped");
  f.send(4); expect((await next).bytes).toEqual(jpeg(4));
  f.frames.stop();
  expect(f.counts()).toEqual({ opened: 2, cancelled: 2 });
});

test("an unused connection closes after its idle timeout", async () => {
  const cancelled = Promise.withResolvers<void>();
  const frames = new LatestCameraFrames({ idleMs: 10, open: () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(part(1)); }, cancel() { cancelled.resolve(); },
  })) });
  active.push(frames);
  expect((await frames.snapshot(source, signal)).bytes).toEqual(jpeg(1));
  await cancelled.promise;
});


test("aborting a pending check closes capture immediately", async () => {
  const f = fixture();
  const abort = new AbortController();
  const pending = f.frames.snapshot(source, abort.signal);
  abort.abort();
  await expect(pending).rejects.toThrow("cancelled");
  expect(f.counts().cancelled).toBe(1);
});

test("slow consumers discard intermediate frames rather than queueing history", async () => {
  const f = fixture();
  const first = f.frames.snapshot(source, signal); f.send(1); await first;
  f.send(2); f.send(3); f.send(4);
  await Bun.sleep(0);
  expect((await f.frames.snapshot(source, signal)).bytes).toEqual(jpeg(4));
  const next = f.frames.snapshot(source, signal); f.send(5);
  expect((await next).bytes).toEqual(jpeg(5));
});
