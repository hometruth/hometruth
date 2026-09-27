import { describe, expect, test } from "bun:test";
import { createApp } from "../../../server/app";
import { Site, registeredView, summaryDetail } from "../../../site";
import { validators } from "../../../validation";
import { Nrf24BridgeError, type Nrf24BridgeHealth, type Nrf24ListenerState, type Nrf24RadioBridge } from "../../../protocols/nrf24-bridge/client";
import { Nrf24RecordingError } from "../../../protocols/nrf24-bridge/capture-journal";
import { MemorySignalCodeStore } from "../../../signal-code-store";
import { ESP32_NRF24_BRIDGE, Esp32Nrf24Bridge } from ".";

const health: Nrf24BridgeHealth = { apiVersion: 1, status: "ok", model: "tmnt-nrf24-listener", firmwareVersion: "0.1.0", radio: { present: true } };
const state = (listening = true): Nrf24ListenerState => ({
  apiVersion: 1, listening, radioPresent: true, sequence: 1, oldestSequence: 1, dropped: 0,
  config: { channelMin: 0, channelMax: 125, dataRateKbps: 1000 },
  observations: [{ kind: "energy", sequence: 1, uptimeMs: 900, channel: 76, rpd: true }],
});

function fixture() {
  const calls: string[] = [];
  const transmitted: unknown[] = [];
  const started: unknown[] = [];
  const bridge: Nrf24RadioBridge = {
    async health() { calls.push("health"); return health; },
    async listener() { calls.push("listener"); return state(); },
    async startListening(request) { calls.push("start"); started.push(request); return state(true); },
    async stopListening() { calls.push("stop"); return state(false); },
    async transmit(request) { calls.push("transmit"); transmitted.push(request); return { apiVersion: 1, sent: true, repeats: 1, uptimeMs: 1000 }; },
  };
  const device = new Esp32Nrf24Bridge({ id: "tmnt-radio", name: "TMNT radio" }, { baseUrl: "http://10.77.0.90" }, { bridge });
  return { device, bridge, calls, transmitted, started };
}

describe("ESP32 nRF24 bridge device", () => {
  test("quiet capture validates settings and returns an asynchronous USB job", async () => {
    const { bridge } = fixture();
    const calls: unknown[] = [];
    const quiet = { captureId: "test", phase: "preparing" as const, wifiOff: true, profile: "xn297-1000" as const, path: "/test.jsonl",
      channel: 40, durationMs: 20000 as const, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const device = new Esp32Nrf24Bridge({ id: "tmnt-radio", name: "TMNT" }, { baseUrl: "http://radio.local" }, {
      bridge: { ...bridge, async startQuietCapture(settings) { calls.push(settings); return quiet; } },
    });
    const app = createApp(undefined, new Site([device], [ESP32_NRF24_BRIDGE]));
    const send = (body: unknown) => app.request("/api/radio-receivers/tmnt-radio/quiet", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const response = await send({ wifiOff: true, durationMs: 20000, channel: 40, note: " car off ", profile: "xn297-1000" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ quiet });
    expect(calls).toEqual([{ wifiOff: true, durationMs: 20000, channel: 40, note: "car off", profile: "xn297-1000" }]);
    expect((await send({ wifiOff: true, durationMs: 60000, note: "test" })).status).toBe(400);
    expect((await send({ wifiOff: true, durationMs: 10000, note: "" })).status).toBe(400);
    expect(calls).toHaveLength(1);
  });
  test("offline reads return a clearly stale saved capture, not an empty history", async () => {
    const { bridge } = fixture();
    const saved = state();
    const offlineBridge: Nrf24RadioBridge = { ...bridge,
      async listener() { throw new Nrf24BridgeError("test outage", "unreachable"); },
      cachedListener: () => ({ state: saved, recordedAt: "2026-09-12T18:00:00.000Z" }),
      captureStatus: () => ({ path: "/research/test.jsonl", records: 3 }),
    };
    const device = new Esp32Nrf24Bridge({ id: "tmnt-radio", name: "TMNT radio" }, { baseUrl: "http://radio.local" }, { bridge: offlineBridge });
    const app = createApp(undefined, new Site([device], [ESP32_NRF24_BRIDGE]));
    const response = await app.request("/api/radio-receivers/tmnt-radio");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ live: false, lastSeenAt: "2026-09-12T18:00:00.000Z",
      connectionError: "test outage", observations: saved.observations, recording: { records: 3 } });
  });

  test("first-use disk errors are exposed distinctly, and capture notes are bounded", async () => {
    const { bridge, started } = fixture();
    const device = new Esp32Nrf24Bridge({ id: "tmnt-radio", name: "TMNT radio" }, { baseUrl: "http://radio.local" }, {
      bridge: { ...bridge, async listener() { throw new Nrf24RecordingError(); } },
    });
    const app = createApp(undefined, new Site([device], [ESP32_NRF24_BRIDGE]));
    const response = await app.request("/api/radio-receivers/tmnt-radio");
    expect(response.status).toBe(507);
    expect((await response.json()).error.code).toBe("recording_failed");
    const start = (note: unknown) => app.request("/api/radio-receivers/tmnt-radio/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "sweep", durationMs: 30000, crcBytes: 2, note }),
    });
    expect((await start(" Forward held ")).status).toBe(200);
    expect(started[0]).toMatchObject({ note: "Forward held" });
    expect((await start("x".repeat(1001))).status).toBe(400);
    expect((await start({})).status).toBe(400);
  });

  test("accepts only the bounded 30-second CRC16 sweep and supported raw channels", async () => {
    const { device, started } = fixture();
    const app = createApp(undefined, new Site([device], [ESP32_NRF24_BRIDGE]));
    const start = (body: unknown) => app.request("/api/radio-receivers/tmnt-radio/start", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await start({ mode: "sweep", durationMs: 30000, crcBytes: 2 })).status).toBe(200);
    expect(started).toEqual([{ mode: "sweep", durationMs: 30000, crcBytes: 2 }]);
    for (const body of [
      { mode: "sweep", durationMs: 60000, crcBytes: 2 },
      { mode: "sweep", durationMs: 30000, crcBytes: 1 },
      { mode: "sweep" },
      { mode: "raw", channel: 4, crcBytes: 2 },
      { mode: "raw", channel: 76, crcBytes: 2 },
    ]) expect((await start(body)).status).toBe(400);
    expect(started).toHaveLength(1);
  });

  test("publishes a validated receiver capability without transmit or generic controls", async () => {
    const { device } = fixture();
    expect(await device.probe()).toEqual({ model: "tmnt-nrf24-listener", firmwareVersion: "0.1.0" });
    const object = await device.describe();
    expect(validators.homeTruthObject(object)).toBe(true);
    expect(object.status).toBe("online");
    expect(object.capabilities.radioFrequencyReceiver).toMatchObject({
      channels: [{ formats: ["rpd-channel-activity"], modulations: ["gfsk"] }],
      events: { signalReceived: { includesDecodedPayload: false } },
    });
    expect(device.controls()).toEqual([]);
    expect(registeredView(device)).toMatchObject({ kind: "rf-receiver", host: "http://10.77.0.90" });
    expect(summaryDetail(object)).toBe("Ready to listen");
  });

  test("provisions the model and proxies listener state and start/stop through HomeTruth", async () => {
    expect(Site.fromConfig({ schemaVersion: 2, devices: [{ id: "radio", model: ESP32_NRF24_BRIDGE.id, config: { baseUrl: "http://radio.local" } }] }).get("radio")).toBeInstanceOf(Esp32Nrf24Bridge);
    const { device, calls } = fixture();
    const app = createApp(undefined, new Site([device], [ESP32_NRF24_BRIDGE]));

    const page = await app.request("/devices/tmnt-radio");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Recent channel activity");

    const snapshot = await app.request("/api/radio-receivers/tmnt-radio");
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({ listening: true, sequence: 1 });
    for (const [path, listening] of [["start", true], ["stop", false]] as const) {
      const response = await app.request(`/api/radio-receivers/tmnt-radio/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(200);
      expect((await response.json()).listening).toBe(listening);
    }
    expect(calls).toEqual(["listener", "start", "stop"]);
  });

  test("saves only captured packets and replays a named code through the bridge", async () => {
    const calls: string[] = [];
    const transmitted: unknown[] = [];
    const packetState: Nrf24ListenerState = {
      ...state(), sequence: 8, oldestSequence: 7,
      config: { mode: "raw", channelMin: 5, channelMax: 75, channel: 42, crcBytes: 2, dataRateKbps: 1000 },
      observations: [{
        kind: "packet", sequence: 7, uptimeMs: 1400, channel: 42,
        address: "00:00:00", addressWidth: 3, payloadHex: "", length: 0, crcBytes: 2, crcValid: true,
      }, {
        kind: "packet", sequence: 8, uptimeMs: 1500, channel: 42,
        address: "A1:B2:C3:D4:E5", addressWidth: 5,
        payloadHex: "0102FF", length: 3, crcBytes: 2, crcValid: true,
      }],
    };
    const bridge: Nrf24RadioBridge = {
      async health() { return health; },
      async listener() { calls.push("listener"); return packetState; },
      async startListening() { return packetState; },
      async stopListening() { return { ...packetState, listening: false }; },
      async transmit(request) { calls.push("transmit"); transmitted.push(request); return { apiVersion: 1, sent: true, repeats: 1, uptimeMs: 2000 }; },
    };
    const device = new Esp32Nrf24Bridge({ id: "tmnt-radio", name: "TMNT radio" }, { baseUrl: "http://10.77.0.90" }, { bridge });
    const app = createApp(undefined, new Site([device], [ESP32_NRF24_BRIDGE]), new MemorySignalCodeStore());
    const emptyResponse = await app.request("/api/radio-receivers/tmnt-radio/codes", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Empty", sequence: 7 }),
    });
    expect(emptyResponse.status).toBe(409);
    expect((await emptyResponse.json()).error.code).toBe("invalid_capture");
    const savedResponse = await app.request("/api/radio-receivers/tmnt-radio/codes", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Forward", sequence: 8 }),
    });
    expect(savedResponse.status).toBe(200);
    const saved = (await savedResponse.json()).codes[0];
    expect(saved).toMatchObject({ name: "Forward", channel: "radio-frequency", frequencyHz: 2_442_000_000 });

    const replay = await app.request(`/api/radio-receivers/tmnt-radio/codes/${saved.id}/send`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repeatCount: 1 }),
    });
    expect(replay.status).toBe(200);
    expect(transmitted).toEqual([{
      channel: 42, dataRateKbps: 1000, address: "A1B2C3D4E5", addressWidth: 5,
      payloadHex: "0102FF", crcBytes: 2, repeatCount: 1,
    }]);
    expect(calls).toEqual(["listener", "listener", "transmit", "listener"]);
  });
});
