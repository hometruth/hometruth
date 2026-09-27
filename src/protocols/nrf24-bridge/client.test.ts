import { describe, expect, test } from "bun:test";
import { Nrf24BridgeClient, Nrf24BridgeError, decodeNrf24Health, decodeNrf24ListenerState, type Nrf24BridgeFetch } from "./client";

const listener = (overrides: Record<string, unknown> = {}) => ({
  apiVersion: 1,
  listening: true,
  radioPresent: true,
  sequence: 2,
  oldestSequence: 1,
  dropped: 0,
  config: { channelMin: 0, channelMax: 125, dataRateKbps: 1000 },
  observations: [
    { kind: "energy", sequence: 1, uptimeMs: 1200, channel: 40, rpd: true, hits: 2, samples: 4 },
    { kind: "packet", sequence: 2, uptimeMs: 1250, channel: 40, address: "aabbccddee", addressWidth: 5, payloadHex: "0102ff", length: 3, crcBytes: 2, crcValid: true, noAck: false, rpd: true },
  ],
  ...overrides,
});

describe("nRF24 bridge wire adapter", () => {
  test("preserves bounded raw receive windows and original PCF length fields", () => {
    const packet = { ...listener().observations[1], discovery: "raw", rawWindowHex: "ab".repeat(32),
      pcfLengthField: 51, rxPipe: 1, pid: 2, bitOffset: 17, lengthInferred: true };
    expect(decodeNrf24ListenerState(listener({ observations: [packet] })).observations[0]).toMatchObject({
      rawWindowHex: "AB".repeat(32), pcfLengthField: 51, rxPipe: 1, pid: 2, bitOffset: 17, lengthInferred: true,
    });
    for (const rawWindowHex of ["ab", "ab".repeat(33), "gg".repeat(32), 1]) {
      expect(() => decodeNrf24ListenerState(listener({ observations: [{ ...packet, rawWindowHex }] }))).toThrow(/rawWindowHex/);
    }
    for (const pcfLengthField of [-1, 64, 1.5, "51"]) {
      expect(() => decodeNrf24ListenerState(listener({ observations: [{ ...packet, pcfLengthField }] }))).toThrow(/pcfLengthField/);
    }
    expect(() => decodeNrf24ListenerState(listener({ observations: [{ ...packet, rxPipe: 2 }] }))).toThrow(/rxPipe/);
  });

  test("decodes bounded automatic sweep progress and clears the previous capture", async () => {
    const sweep = { durationMs: 30000, elapsedMs: 15000, channelsVisited: 71, passes: 2, completed: false };
    const snapshot = listener({ config: { mode: "sweep", channelMin: 5, channelMax: 75, dataRateKbps: 1000, crcBytes: 2 },
      oldestSequence: 3, observations: [], rawFramesSeen: 900, sweep });
    expect(decodeNrf24ListenerState(snapshot)).toMatchObject({ sweep, rawFramesSeen: 900 });
    expect(() => decodeNrf24ListenerState({ ...snapshot, sweep: { ...sweep, elapsedMs: 30001 } })).toThrow(/elapsedMs/);
    expect(() => decodeNrf24ListenerState({ ...snapshot, sweep: { ...sweep, channelsVisited: 72 } })).toThrow(/channelsVisited/);
    expect(() => decodeNrf24ListenerState({ ...snapshot, sweep: undefined })).toThrow(/sweep/);
    let calls = 0;
    let sent: unknown;
    const client = new Nrf24BridgeClient({ baseUrl: "http://tmnt-radio.local", fetch: async (_input, init) => {
      if (++calls === 1) return Response.json(listener());
      sent = JSON.parse(String(init?.body));
      return Response.json(snapshot);
    } });
    expect((await client.listener()).observations).toHaveLength(2);
    expect((await client.startListening({ mode: "sweep", durationMs: 30000, crcBytes: 2 })).observations).toHaveLength(0);
    expect(sent).toEqual({ mode: "sweep", durationMs: 30000, crcBytes: 2 });
  });

  test("accepts only the versioned TMNT bridge identity", () => {
    expect(decodeNrf24Health({ apiVersion: 1, status: "ok", model: "tmnt-nrf24-listener", firmwareVersion: "0.1.0", radio: { present: true } })).toEqual({
      apiVersion: 1, status: "ok", model: "tmnt-nrf24-listener", firmwareVersion: "0.1.0", radio: { present: true },
    });
    for (const invalid of [
      { apiVersion: 2, status: "ok", model: "tmnt-nrf24-listener", firmwareVersion: "0.1.0", radio: { present: true } },
      { apiVersion: 1, status: "ok", model: "another-device", firmwareVersion: "0.1.0", radio: { present: true } },
    ]) expect(() => decodeNrf24Health(invalid)).toThrow(Nrf24BridgeError);
  });

  test("decodes channel activity separately from captured packets", () => {
    const state = decodeNrf24ListenerState(listener());
    expect(state.observations[0]).toEqual({ kind: "energy", sequence: 1, uptimeMs: 1200, channel: 40, rpd: true, hits: 2, samples: 4 });
    expect(state.observations[1]).toEqual({ kind: "packet", sequence: 2, uptimeMs: 1250, channel: 40, address: "AA:BB:CC:DD:EE", addressWidth: 5, payloadHex: "0102FF", length: 3, crcBytes: 2, crcValid: true, noAck: false, rpd: true });
    expect(() => decodeNrf24ListenerState(listener({ observations: [{ kind: "energy", sequence: 3, uptimeMs: 1, channel: 126, rpd: true }] }))).toThrow(/channel/);
    expect(() => decodeNrf24ListenerState(listener({ observations: [{ kind: "energy", sequence: 3, uptimeMs: 1, channel: 2, rpd: false }] }))).toThrow(/energy observation/);
    expect(() => decodeNrf24ListenerState(listener({ observations: [{ kind: "packet", sequence: 3, uptimeMs: 1, channel: 2, address: "aabbcc", addressWidth: 3, payloadHex: "00", length: 2, crcBytes: 2, crcValid: true }] }))).toThrow(/does not match/);
    expect(decodeNrf24ListenerState(listener({ dropped: undefined, droppedObservations: 7 })).dropped).toBe(7);
  });

  test("polls incrementally, merges observations, and sends empty JSON to controls", async () => {
    const calls: { url: string; method?: string; body?: BodyInit | null }[] = [];
    const responses = [
      listener(),
      listener({ sequence: 3, observations: [{ kind: "energy", sequence: 3, uptimeMs: 1400, channel: 76, rpd: true }] }),
      listener({ listening: false, sequence: 3, observations: [] }),
    ];
    const fetch: Nrf24BridgeFetch = async (input, init) => {
      calls.push({ url: String(input), ...(init?.method ? { method: init.method } : {}), ...(init?.body !== undefined ? { body: init.body } : {}) });
      return Response.json(responses.shift());
    };
    const client = new Nrf24BridgeClient({ baseUrl: "http://tmnt-radio.local/bridge", fetch });
    expect((await client.listener()).observations.map(({ sequence }) => sequence)).toEqual([2, 1]);
    expect((await client.listener()).observations.map(({ sequence }) => sequence)).toEqual([3, 2, 1]);
    expect((await client.stopListening()).listening).toBe(false);
    expect(calls.map(({ url }) => url)).toEqual([
      "http://tmnt-radio.local/bridge/api/listener",
      "http://tmnt-radio.local/bridge/api/listener?since=2",
      "http://tmnt-radio.local/bridge/api/listener/stop",
    ]);
    expect(calls[2]).toMatchObject({ method: "POST", body: "{}" });
  });

  test("an empty-payload packet does not invalidate the listener history", () => {
    const empty = { kind: "packet", sequence: 3, uptimeMs: 242888, channel: 15, address: "000000",
      addressWidth: 3, payloadHex: "", length: 0, crcBytes: 2, crcValid: true };
    const state = decodeNrf24ListenerState(listener({ sequence: 3, observations: [...listener().observations, empty] }));
    expect(state.observations).toHaveLength(3);
    expect(state.observations[2]).toMatchObject({ kind: "packet", payloadHex: "", length: 0 });
    expect(() => decodeNrf24ListenerState(listener({ observations: [{ ...empty, length: 1 }] }))).toThrow(/does not match/);
  });

  test("rejects public bridge URLs and maps unsupported controls", async () => {
    expect(() => new Nrf24BridgeClient({ baseUrl: "https://example.com" })).toThrow(/private LAN/);
    const client = new Nrf24BridgeClient({ baseUrl: "http://10.77.0.90", fetch: async () => new Response("", { status: 404 }) });
    await expect(client.startListening()).rejects.toMatchObject({ code: "not_supported" });
  });

  test("sends explicit capture and bounded packet replay settings", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetch: Nrf24BridgeFetch = async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body) });
      return calls.length === 1
        ? Response.json(listener({ config: { mode: "raw", channelMin: 5, channelMax: 75, channel: 42, crcBytes: 2, dataRateKbps: 1000 } }))
        : Response.json({ apiVersion: 1, sent: true, repeats: 2, uptimeMs: 5000 });
    };
    const client = new Nrf24BridgeClient({ baseUrl: "http://tmnt-radio.local", fetch });
    expect((await client.startListening({ mode: "raw", channel: 42, crcBytes: 2 })).config.mode).toBe("raw");
    expect(await client.transmit({
      channel: 42, dataRateKbps: 1000, address: "A1B2C3D4E5", addressWidth: 5,
      payloadHex: "0102FF", crcBytes: 2, repeatCount: 2,
    })).toMatchObject({ sent: true, repeats: 2 });
    expect(JSON.parse(calls[0]!.body)).toEqual({ mode: "raw", channel: 42, crcBytes: 2 });
    expect(calls[1]!.url).toEndWith("/api/transmit");
    expect(JSON.parse(calls[1]!.body)).toMatchObject({ payloadHex: "0102FF", repeatCount: 2 });
  });

  test("coalesces concurrent listener reads for the single-request ESP32 server", async () => {
    let calls = 0;
    let resolveResponse: ((response: Response) => void) | undefined;
    const fetch: Nrf24BridgeFetch = () => {
      calls++;
      return new Promise((resolve) => { resolveResponse = resolve; });
    };
    const client = new Nrf24BridgeClient({ baseUrl: "http://tmnt-radio.local", fetch });
    const first = client.listener();
    const second = client.listener();
    await Promise.resolve();
    expect(calls).toBe(1);
    resolveResponse!(Response.json(listener()));
    expect(await first).toEqual(await second);
    expect(calls).toBe(1);
  });

  test("queues controls behind the complete listener body, not just its headers", async () => {
    const calls: string[] = [];
    let finishBody!: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        finishBody = () => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(listener())));
          controller.close();
        };
      },
    });
    const client = new Nrf24BridgeClient({ baseUrl: "http://tmnt-radio.local", fetch: async (input) => {
      calls.push(new URL(String(input)).pathname);
      return calls.length === 1 ? new Response(stream) : Response.json(listener({ listening: false, observations: [] }));
    } });
    const poll = client.listener();
    const stop = client.stopListening();
    await Promise.resolve();
    expect(calls).toEqual(["/api/listener"]);
    finishBody();
    await poll;
    expect((await stop).observations).toHaveLength(2);
    expect(calls).toEqual(["/api/listener", "/api/listener/stop"]);
  });

  test("retries an interrupted read body once and releases the queue after a failure", async () => {
    let calls = 0;
    const client = new Nrf24BridgeClient({ baseUrl: "http://tmnt-radio.local", fetch: async () => {
      calls++;
      if (calls <= 2) return new Response(new ReadableStream({ start(controller) {
        controller.error(new DOMException("The operation timed out.", "TimeoutError"));
      } }));
      return Response.json(listener());
    } });
    await expect(client.listener()).rejects.toMatchObject({ code: "unreachable", message: expect.stringContaining("interrupted") });
    expect(calls).toBe(2);
    expect((await client.listener()).radioPresent).toBe(true);
    expect(calls).toBe(3);
  });

  test("retries a truncated read but does not treat malformed JSON as a connection failure", async () => {
    let calls = 0;
    const client = new Nrf24BridgeClient({ baseUrl: "http://tmnt-radio.local", fetch: async () => {
      calls++;
      if (calls === 1) return new Response('{"apiVersion":', { headers: { "content-length": "500" } });
      if (calls === 2) return Response.json(listener());
      return new Response("malformed");
    } });
    expect((await client.listener()).observations).toHaveLength(2);
    expect(calls).toBe(2);
    await expect(client.listener()).rejects.toMatchObject({ code: "protocol", message: "Radio bridge returned invalid JSON" });
    expect(calls).toBe(3);
  });

  test("never retries a transmission after its response body is lost", async () => {
    let calls = 0;
    const client = new Nrf24BridgeClient({ baseUrl: "http://tmnt-radio.local", fetch: async () => {
      calls++;
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error("connection reset")); } }));
    } });
    await expect(client.transmit({ channel: 42, dataRateKbps: 1000, address: "A1B2C3D4E5", addressWidth: 5,
      payloadHex: "0102FF", crcBytes: 2 })).rejects.toMatchObject({ code: "unreachable" });
    expect(calls).toBe(1);
  });
});
