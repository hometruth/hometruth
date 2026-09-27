import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileNrf24CaptureJournal, Nrf24RecordingError, type Nrf24CaptureJournal } from "./capture-journal";
import { Nrf24BridgeClient, type Nrf24ListenerState } from "./client";
import { startNrf24CapturePolling } from "./polling";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const root = async () => { const path = await mkdtemp(join(tmpdir(), "tmnt-capture-test-")); directories.push(path); return path; };
const state = (sequence = 10): Nrf24ListenerState => ({
  apiVersion: 1, deviceId: "test-radio", listening: false, radioPresent: true,
  sequence, oldestSequence: sequence, dropped: 0,
  config: { mode: "raw", channelMin: 5, channelMax: 75, channel: 15, crcBytes: 2, dataRateKbps: 1000 },
  observations: [{ sequence, uptimeMs: 2500, kind: "packet", channel: 15, address: "AA:BB:CC", addressWidth: 3,
    payloadHex: "0102", length: 2, crcBytes: 2, crcValid: true, pid: 2, noAck: true, bitOffset: 17, discovery: "raw", lengthInferred: false,
    rawWindowHex: "AB".repeat(32), pcfLengthField: 2, rxPipe: 0 }],
});
const records = async (journal: FileNrf24CaptureJournal) => (await readFile(journal.path, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));

test("serializes append-only records, preserves packet metadata, and skips unchanged snapshots", async () => {
  const journal = new FileNrf24CaptureJournal("../radio", "http://radio.local", await root());
  await Promise.all(Array.from({ length: 8 }, (_, index) => journal.append({ event: "sample", index })));
  await journal.snapshot(state());
  await journal.snapshot(state());
  const lines = await records(journal);
  expect(lines.filter(line => line.event === "sample").map(line => line.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(lines.filter(line => line.event === "listener_snapshot")).toHaveLength(1);
  expect(lines.at(-1).state.observations[0]).toMatchObject({ pid: 2, bitOffset: 17, discovery: "raw", noAck: true,
    rawWindowHex: "AB".repeat(32), pcfLengthField: 2, rxPipe: 0 });
  expect(journal.path).toContain("device-%2E%2E%2Fradio");
  expect((await stat(journal.path)).mode & 0o777).toBe(0o600);
  expect(journal.status()).toMatchObject({ records: 10, lastWriteAt: expect.any(String), lastStateAt: expect.any(String) });
});

test("a restarted collector restores the saved capture while the bridge is offline", async () => {
  const directory = await root();
  const first = new FileNrf24CaptureJournal("radio", "http://radio.local", directory);
  const online = new Nrf24BridgeClient({ baseUrl: "http://radio.local", journal: first, fetch: async () => Response.json(state()) });
  await online.listener();
  const original = await readFile(first.path, "utf8");
  const second = new FileNrf24CaptureJournal("radio", "http://radio.local", directory);
  const offline = new Nrf24BridgeClient({ baseUrl: "http://radio.local", journal: second, fetch: async () => { throw new Error("test outage"); } });
  await expect(offline.listener()).rejects.toMatchObject({ code: "unreachable" });
  expect(offline.cachedListener()?.state).toEqual(state());
  expect(second.path).not.toBe(first.path);
  expect(await readFile(first.path, "utf8")).toBe(original);
  expect((await records(second)).filter(line => line.event === "http_response")).toHaveLength(2);
  expect((await records(second)).at(-1)).toMatchObject({ complete: false, error: "test outage" });
});

test("saves partial bytes and failed attempts before retrying an interrupted read", async () => {
  const journal = new FileNrf24CaptureJournal("radio", "http://radio.local", await root());
  const prefix = '{"apiVersion":1,"observations":[';
  const client = new Nrf24BridgeClient({ baseUrl: "http://radio.local", journal, fetch: async () => {
    let part = 0;
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (part++ === 0) controller.enqueue(new TextEncoder().encode(prefix));
      else controller.error(new Error("test connection reset"));
    } }), { headers: { "content-length": "500" } });
  } });
  await expect(client.listener()).rejects.toMatchObject({ code: "unreachable" });
  const replies = (await records(journal)).filter(line => line.event === "http_response");
  expect(replies.map(line => line.attempt)).toEqual([1, 2]);
  expect(replies[0].requestId).toBe(replies[1].requestId);
  for (const reply of replies) {
    expect(Buffer.from(reply.bodyBase64, "base64").toString()).toBe(prefix);
    expect(reply).toMatchObject({ complete: false, expectedBytes: 500, receivedBytes: prefix.length });
  }
});

test("malformed JSON and protocol-invalid replies remain in the raw disk log", async () => {
  const journal = new FileNrf24CaptureJournal("radio", "http://radio.local", await root());
  let calls = 0;
  const client = new Nrf24BridgeClient({ baseUrl: "http://radio.local", journal, fetch: async () => {
    return ++calls === 1 ? new Response("broken JSON") : Response.json({ apiVersion: 99, diagnostic: "original body preserved" });
  } });
  await expect(client.listener()).rejects.toMatchObject({ code: "protocol" });
  await expect(client.listener()).rejects.toMatchObject({ code: "protocol" });
  const lines = await records(journal);
  expect(lines.find(line => line.bodyBase64)?.bodyBase64).toBe(Buffer.from("broken JSON").toString("base64"));
  expect(lines.find(line => line.body?.diagnostic)?.body).toEqual({ apiVersion: 99, diagnostic: "original body preserved" });
  expect(lines.at(-1).event).toBe("decode_error");
  expect(calls).toBe(2);
});

test("disk failure blocks transmission and does not advance the capture cursor", async () => {
  let networkCalls = 0;
  const failedJournal: Nrf24CaptureJournal = {
    async append() { throw new Nrf24RecordingError(); }, async snapshot() {},
    status: () => ({ path: "test", records: 0 }), lastSnapshot: () => undefined,
  };
  const blocked = new Nrf24BridgeClient({ baseUrl: "http://radio.local", journal: failedJournal,
    fetch: async () => { networkCalls++; return Response.json({}); } });
  await expect(blocked.transmit({ channel: 15, dataRateKbps: 1000, address: "AABBCC", addressWidth: 3, payloadHex: "01", crcBytes: 2 })).rejects.toBeInstanceOf(Nrf24RecordingError);
  expect(networkCalls).toBe(0);
  const calls: string[] = [];
  let writes = 0;
  const client = new Nrf24BridgeClient({ baseUrl: "http://radio.local", journal: {
    ...failedJournal, async append() {}, async snapshot() { if (++writes === 1) throw new Nrf24RecordingError(); },
  }, fetch: async input => { calls.push(String(input)); return Response.json(state()); } });
  await expect(client.listener()).rejects.toBeInstanceOf(Nrf24RecordingError);
  await client.listener();
  expect(calls).toEqual(["http://radio.local/api/listener", "http://radio.local/api/listener"]);
});

test("a new sweep drains existing history to disk before the destructive start request", async () => {
  const journal = new FileNrf24CaptureJournal("radio", "http://radio.local", await root());
  const client = new Nrf24BridgeClient({ baseUrl: "http://radio.local", journal, fetch: async (_input, init) => {
    if (init?.method === "POST") {
      expect((await records(journal)).some(line => line.event === "listener_snapshot" && line.state.observations.length === 1)).toBe(true);
      return Response.json({ ...state(), oldestSequence: 11, observations: [] });
    }
    return Response.json(state());
  } });
  await client.startListening({ mode: "sweep", durationMs: 30000, crcBytes: 2, note: "Forward held, user reported" });
  const intent = (await records(journal)).find(line => line.method === "POST" && line.event === "http_request");
  expect(intent.payload.note).toBe("Forward held, user reported");
});

test("background collector writes without viewers, never overlaps reads, and stops", async () => {
  const journal = new FileNrf24CaptureJournal("radio", "http://radio.local", await root());
  let calls = 0;
  const client = new Nrf24BridgeClient({ baseUrl: "http://radio.local", journal, fetch: async input => {
    calls++;
    return String(input).endsWith("health")
      ? Response.json({ apiVersion: 1, status: "ok", model: "tmnt-nrf24-listener", firmwareVersion: "test", radio: { present: true } })
      : Response.json(state());
  } });
  const polling = startNrf24CapturePolling(() => [client], { idleMs: 5, activeMs: 5 });
  try {
    for (let i = 0; i < 100 && calls < 4; ++i) await Bun.sleep(5);
  } finally { await polling.stop(); }
  expect(calls).toBeGreaterThanOrEqual(4);
  const stoppedAt = calls;
  await Bun.sleep(20);
  expect(calls).toBe(stoppedAt);
  expect((await records(journal)).some(line => line.event === "listener_snapshot")).toBe(true);
  expect((await readdir(journal.directory)).filter(name => name.endsWith(".snapshot.json"))).toHaveLength(1);
});
