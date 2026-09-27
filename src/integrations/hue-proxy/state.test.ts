import { describe, expect, test } from "bun:test";
import { LightStateTracker, lightPatch, parseHueStream } from "./state";
import { buildHueStreamFrame } from "../../vendors/hue/entertainment-protocol";
import { hexToXy } from "../../vendors/hue/clip-client";
import type { HueEvent } from "./config";

const area = "12345678-1234-1234-1234-123456789abc";
describe("Hue state normalization", () => {
  test("partial patches preserve power and brightness; repeats do not emit", () => {
    const events: HueEvent[] = [];
    const tracker = new LightStateTracker(e => events.push(e));
    tracker.ingest({ type: "light", id: "one", id_v1: "/lights/2", on: { on: false }, dimming: { brightness: 20 } }, false);
    tracker.ingest({ type: "light", id: "one", color: { xy: { x: 0.7, y: 0.3 } } });
    tracker.ingest({ type: "light", id: "one", color: { xy: { x: 0.7, y: 0.3 } } });
    expect(events).toHaveLength(1);
    expect(events[0]!.state).toMatchObject({ on: false, brightnessPercent: 20 });
    expect(events[0]!.changed).not.toHaveProperty("on");
    expect(tracker.aliases("light/one")).toEqual(["light-v1/2"]);
  });
  test("temperature and xy change modes without retaining stale color", () => {
    const tracker = new LightStateTracker(() => {});
    tracker.change("light/one", { color: "#ff0000" }, "bridge");
    tracker.ingest({ type: "light", id: "one", color_temperature: { mirek: 400, mirek_valid: true }, color: { xy: { x: .3, y: .3 } } });
    expect(tracker.states.get("light/one")).toEqual({ colorTemperatureKelvin: 2500 });
    tracker.ingest({ type: "light", id: "one", color_temperature: { mirek: null, mirek_valid: false }, color: { xy: { x: .7, y: .3 } } });
    expect(tracker.states.get("light/one")).not.toHaveProperty("colorTemperatureKelvin");
  });
  test("invalid/absent color and temperature never invent a state", () => {
    expect(lightPatch({ color_temperature: { mirek: null }, dimming: { brightness: NaN }, on: {} })).toEqual({});
  });
  test("snapshot removes deleted lights", () => {
    const tracker = new LightStateTracker(() => {});
    tracker.ingest({ id: "one", type: "light", on: { on: true } });
    tracker.snapshot([], true);
    expect(tracker.states.size).toBe(0);
    expect(tracker.resources.size).toBe(0);
  });
});
describe("HueStream records", () => {
  test("RGB separates color from brightness and preserves zero", () => {
    const parsed = parseHueStream(buildHueStreamFrame(area, 5, [{ channel: 7, r: 128, g: 0, b: 0 }, { channel: 8, r: 0, g: 0, b: 0 }]));
    expect(parsed.area).toBe(area);
    expect(parsed.channels[0]!.state.color).toBe("#ff0000");
    expect(parsed.channels[0]!.state.brightnessPercent).toBeCloseTo(50.2, 1);
    expect(parsed.channels[1]!.state).toEqual({ on: false, color: "#000000", brightnessPercent: 0 });
  });
  test("v2 xy uses the luminance channel", () => {
    const frame = Buffer.from(buildHueStreamFrame(area, 1, [{ channel: 1, r: 1, g: 1, b: 1 }]));
    frame[14] = 1;
    const [x, y] = hexToXy("#00ff00");
    frame.writeUInt16BE(Math.round(x * 65535), 53); frame.writeUInt16BE(Math.round(y * 65535), 55); frame.writeUInt16BE(16384, 57);
    const state = parseHueStream(frame).channels[0]!.state;
    expect(state.color).toBe("#00ff00");
    expect(state.brightnessPercent).toBeCloseTo(25, 1);
  });
  test("v1 supports light ids above 255", () => {
    const b = Buffer.alloc(25); b.write("HueStream"); b[9] = 1; b.writeUInt16BE(400, 17); b.writeUInt16BE(65535, 19);
    expect(parseHueStream(b).channels[0]).toEqual({ channel: 400, state: { on: true, color: "#ff0000", brightnessPercent: 100 } });
  });
  test("variable channel counts are independent records; truncated data is rejected", () => {
    const frame = buildHueStreamFrame(area, 1, [{ channel: 1, r: 0, g: 1, b: 2 }]);
    expect(parseHueStream(frame).channels).toHaveLength(1);
    expect(() => parseHueStream(frame.slice(0, -1))).toThrow("Truncated");
    expect(() => parseHueStream(new Uint8Array(16))).toThrow("header");
  });
});
