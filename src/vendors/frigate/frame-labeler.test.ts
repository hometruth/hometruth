import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { FrigateFrameLabeler, parseDogFrameLabels } from "./frame-labeler";

const config = { sshConfigPath: "/private/ssh_config", sshHost: "frigate", container: "frigate" };
const jpeg = (n: number) => new Uint8Array([255, 216, n, 255, 217]);
const reply = (bytes: Uint8Array, dog = false) => ({ dog, imageHash: createHash("sha256").update(bytes).digest("hex") });
const active: FrigateFrameLabeler[] = [];
afterEach(() => { for (const labeler of active.splice(0)) labeler.close(); });

function fixture() {
  const sessions: { emit(bytes: Uint8Array): void; writes: Uint8Array[]; killed: boolean }[] = [];
  const labeler = new FrigateFrameLabeler(config, () => {
    const exited = Promise.withResolvers<number>();
    let output!: ReadableStreamDefaultController<Uint8Array>;
    const session = { emit: (bytes: Uint8Array) => output.enqueue(bytes), writes: [] as Uint8Array[], killed: false };
    sessions.push(session);
    return { stdin: { write(bytes: Uint8Array) { session.writes.push(new Uint8Array(bytes)); return bytes.length; }, flush: () => 0 },
      stdout: new ReadableStream<Uint8Array>({ start(controller) { output = controller; } }), exited: exited.promise,
      kill() { if (!session.killed) { session.killed = true; output.close(); exited.resolve(0); } },
    };
  });
  active.push(labeler);
  return { labeler, sessions, respond: (value: unknown) => sessions.at(-1)!.emit(Buffer.from(JSON.stringify(value) + "\n")) };
}

test("reuses the pipe for fresh JPEGs and accepts a reply split across reads", async () => {
  const f = fixture(), signal = new AbortController().signal;
  const first = f.labeler.label(jpeg(1), signal);
  const bytes = Buffer.from(JSON.stringify(reply(jpeg(1))) + "\n");
  f.sessions[0]!.emit(bytes.subarray(0, 13)); f.sessions[0]!.emit(bytes.subarray(13));
  expect((await first).imageHash).toBe(reply(jpeg(1)).imageHash);
  const second = f.labeler.label(jpeg(2), signal);
  f.respond(reply(jpeg(2), true)); expect(await second).toEqual(reply(jpeg(2), true));
  expect(f.sessions).toHaveLength(1);
  const sent = Buffer.concat(f.sessions[0]!.writes);
  expect(sent.readUInt32BE(0)).toBe(5); expect(sent.subarray(4, 9)).toEqual(Buffer.from(jpeg(1)));
  expect(sent.readUInt32BE(9)).toBe(5); expect(sent.subarray(13)).toEqual(Buffer.from(jpeg(2)));
});

test("cancellation rejects the pending frame, closes the pipe, and allows a fresh connection", async () => {
  const f = fixture(), abort = new AbortController();
  const pending = f.labeler.label(jpeg(1), abort.signal);
  await expect(f.labeler.label(jpeg(2), abort.signal)).rejects.toThrow("already running");
  abort.abort(); await expect(pending).rejects.toThrow("cancelled");
  expect(f.sessions[0]!.killed).toBe(true);
  const next = f.labeler.label(jpeg(2), new AbortController().signal);
  f.respond(reply(jpeg(2))); await next;
  expect(f.sessions).toHaveLength(2);
});

test("malformed, oversized and mismatched replies close the connection without leaking their content", async () => {
  for (const bad of [Buffer.from("private SSH error\n"), Buffer.alloc(65_537), Buffer.from(JSON.stringify(reply(jpeg(2))) + "\n")]) {
    const f = fixture();
    const pending = f.labeler.label(jpeg(1), new AbortController().signal);
    f.sessions[0]!.emit(bad);
    await expect(pending).rejects.toThrow("The Frigate frame detector is unavailable");
    expect(f.sessions[0]!.killed).toBe(true);
  }
});

test("closing rejects an outstanding request and an oversized image never opens a connection", async () => {
  const f = fixture();
  await expect(f.labeler.label(new Uint8Array(8 * 1024 * 1024 + 1), new AbortController().signal)).rejects.toThrow("frame size");
  expect(f.sessions).toHaveLength(0);
  const pending = f.labeler.label(jpeg(1), new AbortController().signal);
  f.labeler.close(); await expect(pending).rejects.toThrow("unavailable");
});


test("accepts only a binary decision bound to this frame", () => {
  expect(parseDogFrameLabels(reply(jpeg(1), true), jpeg(1)).dog).toBe(true);
  expect(parseDogFrameLabels(reply(jpeg(1), false), jpeg(1)).dog).toBe(false);
  for (const value of [{ ...reply(jpeg(1)), dog: 1 }, { ...reply(jpeg(1)), dog: "false" },
    { ...reply(jpeg(1)), detections: [] }, { ...reply(jpeg(1)), dogs: 1 }]) {
    expect(() => parseDogFrameLabels(value, jpeg(1))).toThrow("Invalid dog detection");
  }
});
