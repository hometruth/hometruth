import { describe, expect, test } from "bun:test";
import { createDemoEventSource, createDemoFetch, demoCameraPath } from "./browser";
import { COOKIE_CHUNKS, COOKIE_CHUNK_SIZE, DemoState, demoCookieWrites, readDemoCookie, type DemoData } from "./state";
import type { RegisteredDevice } from "../site";

const stamp = "2026-01-01T12:00:00.000Z";
function fixture(): DemoData {
  const device = (id: string): RegisteredDevice => ({ id, name: id, kind: "light", model: "sample", modelTitle: "Sample", capabilities: ["light"], host: "", page: `/lights/${id}`, schemaId: "https://hometruth.ai/schemas/light", enabled: true });
  const power = { turnOn: {}, turnOff: {}, toggle: {}, getState: {} };
  const light = (id: string, on: boolean) => ({ node: `device/${id}` as const, version: 1, updatedAt: stamp, observedAt: stamp, value: { id, status: "online", capabilities: { light: { id, state: { availability: "online", on, brightnessPercent: 50, colorTemperatureKelvin: 2700 }, actions: { ...power, setBrightness: { minimumPercent: 0, maximumPercent: 100 }, setColorTemperature: { minimumKelvin: 2000, maximumKelvin: 6500 }, setColor: { formats: ["hex"] } } } } } });
  return {
    version: 1, basePath: "/demo", devices: [device("lamp-one"), device("lamp-two")], groups: [{ id: "lights", name: "Lights", members: ["lamp-one", "lamp-two"] }],
    records: [light("lamp-one", false), light("lamp-two", true), { node: "group/lights", version: 1, observedAt: stamp, updatedAt: stamp, value: { id: "lights", status: "online", capabilities: { binarySwitch: { state: { value: "off", availability: "online" }, actions: power } }, group: { mixed: true, canSwitch: true, members: [] } } }],
  };
}
const cap = (state: DemoState, id: string, kind = "light"): any => (state.read(`device/${id}`)?.value as any).capabilities[kind].state;

describe("static demo state", () => {
  test("power, brightness and color persist across navigation without the inventory in cookies", () => {
    const data = fixture();
    const state = new DemoState(data);
    state.invoke("device/lamp-one", "light", "turnOn");
    state.invoke("device/lamp-one", "light", "setBrightness", 73);
    state.invoke("device/lamp-one", "light", "setColor", "#aabbcc");
    const persisted = state.persist();
    const restored = new DemoState(data, persisted);
    expect(cap(restored, "lamp-one")).toMatchObject({ on: true, brightnessPercent: 73, color: "#aabbcc" });
    expect(cap(restored, "lamp-one").colorTemperatureKelvin).toBeUndefined();
    expect(atob(persisted)).not.toContain("lamp-one");
    expect(atob(persisted)).not.toContain("hometruth.ai");
    expect(data.records[0]?.value).toMatchObject({ capabilities: { light: { state: { on: false, brightnessPercent: 50 } } } });
    restored.reset();
    expect(restored.persist()).toBe("");
    expect(cap(restored, "lamp-one")).toMatchObject({ on: false, brightnessPercent: 50, colorTemperatureKelvin: 2700 });
  });

  test("group controls fan out and member changes update mixed state", () => {
    const state = new DemoState(fixture());
    state.invoke("group/lights", "binarySwitch", "turnOff");
    expect(cap(state, "lamp-one").on).toBe(false);
    expect(cap(state, "lamp-two").on).toBe(false);
    expect(state.read("group/lights")?.value).toMatchObject({ group: { mixed: false }, capabilities: { binarySwitch: { state: { value: "off" } } } });
    state.invoke("device/lamp-one", "light", "turnOn");
    expect(state.read("group/lights")?.value).toMatchObject({ group: { mixed: true } });
    state.invoke("group/lights", "light", "setBrightness", 64);
    expect(cap(state, "lamp-two").brightnessPercent).toBe(64);
  });

  test("string controls update the individually browsable bulbs", () => {
    const data = fixture();
    const caps = (data.records[0]!.value as any).capabilities;
    caps.stringLight = caps.light; delete caps.light;
    (data.devices[1] as any).parent = { id: "lamp-one", index: 0 };
    const state = new DemoState(data);
    state.invoke("device/lamp-one", "stringLight", "setColor", "#2255aa");
    state.invoke("device/lamp-one", "stringLight", "turnOff");
    expect(cap(state, "lamp-two")).toMatchObject({ color: "#2255aa", on: false });
    expect(cap(new DemoState(data, state.persist()), "lamp-two")).toMatchObject({ color: "#2255aa", on: false });
  });

  test("invalid values and stale cookies cannot change the seed", () => {
    const state = new DemoState(fixture());
    expect(() => state.invoke("device/lamp-one", "light", "setBrightness", 900)).toThrow();
    expect(cap(state, "lamp-one").brightnessPercent).toBe(50);
    state.invoke("device/lamp-one", "light", "turnOn");
    const changed = fixture();
    (changed.records[0]!.value as any).id = "different-export";
    expect(cap(new DemoState(changed, state.persist()), "lamp-one").on).toBe(false);
    expect(cap(new DemoState(fixture(), "invalid-cookie"), "lamp-one").on).toBe(false);
  });

  test("cookies are bounded, path-scoped and cleared completely on reset", () => {
    const state = new DemoState(fixture());
    state.invoke("device/lamp-one", "light", "turnOn");
    const value = state.persist();
    const writes = demoCookieWrites(value, "/demo", true);
    expect(writes).toHaveLength(COOKIE_CHUNKS + 1);
    expect(writes.every(cookie => cookie.includes("Path=/demo; SameSite=Lax; Secure"))).toBe(true);
    expect(readDemoCookie(writes.map(cookie => cookie.split(";")[0]).join("; "))).toBe(value);
    expect(demoCookieWrites("", "/demo", false).every(cookie => cookie.includes("Max-Age=0"))).toBe(true);
    expect(() => demoCookieWrites("a".repeat(COOKIE_CHUNKS * COOKIE_CHUNK_SIZE + 1), "/demo", true)).toThrow();
  });

  test("all fetches terminate locally including absolute and unknown destinations", async () => {
    const state = new DemoState(fixture());
    const fetch = createDemoFetch(state, "https://example.test");
    const result = await fetch("/demo/api/devices/lamp-one/capabilities/light/controls/turnOn", { method: "POST", body: "{}" });
    expect(result.status).toBe(200);
    expect(cap(state, "lamp-one").on).toBe(true);
    for (const target of ["https://device.example/api/power", "/api/unknown", "/api/devices/lamp-one/settings", "/api/auth/logout"]) {
      const result = await fetch(target, { method: "POST" });
      expect(result.ok).toBe(false);
      expect(await result.json()).toMatchObject({ demo: true, error: { code: "demo_not_supported" } });
    }
  });

  test("speaker, TV and cooktop controls use the same simulated and persisted state", async () => {
    const data = fixture();
    (data.records[0]!.value as any).capabilities = {
      speaker: { state: { volumePercent: 25, playback: "paused" }, actions: { play: {}, pause: {}, setVolume: {}, say: {} } },
      television: { state: { power: "standby", artMode: "off" }, actions: { turnOn: {}, setArtMode: {}, setInput: { inputs: [{ id: "hdmi1", name: "HDMI 1" }] } } },
      cooktop: { state: { childLocked: false, timerSeconds: 0 }, actions: { setChildLock: {}, setTimer: {} } },
    };
    const state = new DemoState(data);
    const fetch = createDemoFetch(state, "https://example.test");
    state.invoke("device/lamp-one", "speaker", "play");
    state.invoke("device/lamp-one", "speaker", "setVolume", 68);
    state.invoke("device/lamp-one", "television", "setArtMode", true);
    state.invoke("device/lamp-one", "television", "setInput", "hdmi1");
    expect((await fetch("/api/devices/lamp-one/controls/setChildLock", { method: "POST", body: '{"value":true}' })).ok).toBe(true);
    expect((await fetch("/api/devices/lamp-one/controls/setTimer", { method: "POST", body: '{"value":300}' })).ok).toBe(true);
    const restored = new DemoState(data, state.persist());
    expect(cap(restored, "lamp-one", "speaker")).toMatchObject({ playback: "playing", volumePercent: 68 });
    expect(cap(restored, "lamp-one", "television")).toMatchObject({ power: "on", artMode: "on", input: { id: "hdmi1" } });
    expect(cap(restored, "lamp-one", "cooktop")).toMatchObject({ childLocked: true, timerSeconds: 300 });
  });

  test("camera frames are inline drawings and log history is an empty local resource", async () => {
    for (const path of ["/api/cameras/demo/snapshot?t=1", "/demo/api/cameras/demo/stream.mjpeg", "/api/cameras/demo/photos/sample"]) expect(demoCameraPath(path, "/demo")).toStartWith("data:image/svg+xml,");
    expect(demoCameraPath("https://real-camera.example/snapshot", "/demo")).toBeUndefined();
    const fetch = createDemoFetch(new DemoState(fixture()), "https://example.test");
    expect(await (await fetch("/api/events")).json()).toMatchObject({ events: [], nextCursor: null });
    expect(await (await fetch("/api/devices/lamp-one/events")).json()).toMatchObject({ events: [] });
  });

  test("mock streams publish seed and command changes then stop on close", async () => {
    const state = new DemoState(fixture());
    const Source = createDemoEventSource(state, "https://example.test");
    const stream = new Source("/api/state/stream?node=device%2Flamp-one");
    const values: any[] = [];
    const hello: any[] = [];
    stream.addEventListener("state", event => values.push(JSON.parse((event as MessageEvent).data)));
    stream.addEventListener("hello", event => hello.push(JSON.parse((event as MessageEvent).data)));
    await new Promise(resolve => queueMicrotask(() => resolve(undefined)));
    expect(hello[0]?.generation).toBe("static-demo");
    expect(values).toHaveLength(1);
    state.invoke("device/lamp-one", "light", "turnOn");
    expect(values.at(-1).value.capabilities.light.state.on).toBe(true);
    stream.close();
    state.invoke("device/lamp-one", "light", "turnOff");
    expect(values).toHaveLength(2);
    const denied = new Source("https://device.example/api/state/stream");
    await new Promise(resolve => queueMicrotask(() => resolve(undefined)));
    expect(denied.readyState).toBe(Source.CLOSED);
  });
});
