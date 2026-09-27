import { describe, expect, test } from "bun:test";
import { HueEntertainmentLight, HueEntertainmentLightCapability, HUE_ENTERTAINMENT_LIGHT } from "./index";
import { LightError } from "../../../models/light";
import type { HueClipClient, HueLightState } from "../../../vendors/hue/clip-client";
import type { ChannelColor } from "../../../vendors/hue/entertainment-protocol";
import type { HueEntertainmentSession } from "../../../vendors/hue/entertainment-session";
import { LightGroupCapability } from "../../composites/light-group";

function fakeClip(initial: HueLightState = { on: false, brightnessPercent: 100 }) {
  let state = initial;
  const calls: string[] = [];
  const clip = {
    getLightState: async () => { calls.push("getLightState"); return state; },
    turnOn: async () => { calls.push("turnOn"); state = { ...state, on: true }; },
    turnOff: async () => { calls.push("turnOff"); state = { ...state, on: false }; },
    setBrightness: async (_id: string, percent: number) => { calls.push(`setBrightness:${percent}`); state = { ...state, brightnessPercent: percent }; },
    setColorTemperature: async (_id: string, kelvin: number) => { calls.push(`setColorTemperature:${kelvin}`); state = { ...state, colorTemperatureKelvin: kelvin }; },
    setColorHex: async (_id: string, hex: string) => { calls.push(`setColorHex:${hex}`); state = { ...state, color: hex }; },
  } as unknown as HueClipClient;
  return { clip, calls, getState: () => state };
}

function fakeSession(connected: boolean) {
  const sent: ChannelColor[][] = [];
  const session = {
    isConnected: connected,
    setColors: (channels: readonly ChannelColor[]) => { sent.push([...channels]); },
  } as unknown as HueEntertainmentSession;
  return { session, sent };
}

describe("HueEntertainmentLightCapability", () => {
  test("supportsColor is true", () => {
    const { clip } = fakeClip();
    const { session } = fakeSession(false);
    const light = new HueEntertainmentLightCapability({ id: "l1", lightId: "uuid-1", channel: 0, clip, session });
    expect(light.supportsColor()).toBe(true);
  });

  test("rejects an out-of-range channel", () => {
    const { clip } = fakeClip();
    const { session } = fakeSession(false);
    expect(() => new HueEntertainmentLightCapability({ id: "l1", lightId: "uuid-1", channel: 256, clip, session })).toThrow(LightError);
    expect(() => new HueEntertainmentLightCapability({ id: "l1", lightId: "uuid-1", channel: -1, clip, session })).toThrow(LightError);
  });

  test("turnOn/turnOff/setBrightness delegate to CLIP", async () => {
    const { clip, calls } = fakeClip();
    const { session } = fakeSession(false);
    const light = new HueEntertainmentLightCapability({ id: "l1", lightId: "uuid-1", channel: 0, clip, session });
    await light.turnOn();
    await light.setBrightness(50);
    await light.turnOff();
    expect(calls).toEqual(["turnOn", "setBrightness:50", "turnOff"]);
  });

  test("toggle reads state then flips it", async () => {
    const { clip, calls } = fakeClip({ on: false, brightnessPercent: 100 });
    const { session } = fakeSession(false);
    const light = new HueEntertainmentLightCapability({ id: "l1", lightId: "uuid-1", channel: 0, clip, session });
    await light.toggle();
    expect(calls).toEqual(["getLightState", "turnOn"]);
  });

  test("setColorTemperature uses CLIP and reports the actual temperature", async () => {
    const { clip } = fakeClip();
    const { session } = fakeSession(false);
    const light = new HueEntertainmentLightCapability({ id: "l1", lightId: "uuid-1", channel: 0, clip, session });
    await light.setColorTemperature(2700);
    expect((await light.getState()).colorTemperatureKelvin).toBe(2700);
  });

  test("setColor streams over the session when it is connected, not via CLIP", async () => {
    const { clip, calls } = fakeClip();
    const { session, sent } = fakeSession(true);
    const light = new HueEntertainmentLightCapability({ id: "l1", lightId: "uuid-1", channel: 3, clip, session });
    await light.setColor("#ff8800");
    expect(sent).toEqual([[{ channel: 3, r: 0xff, g: 0x88, b: 0x00 }]]);
    expect(calls).not.toContain("setColorHex:#ff8800");
  });

  test("setColor falls back to CLIP when the session is not connected", async () => {
    const { clip, calls } = fakeClip();
    const { session, sent } = fakeSession(false);
    const light = new HueEntertainmentLightCapability({ id: "l1", lightId: "uuid-1", channel: 3, clip, session });
    await light.setColor("#00ff00");
    expect(sent).toEqual([]);
    expect(calls).toContain("setColorHex:#00ff00");
  });

  test("a group sends every light's color in one Entertainment frame", async () => {
    const { clip } = fakeClip();
    const { session, sent } = fakeSession(true);
    const lights = [0, 1, 2].map((channel) => new HueEntertainmentLightCapability({
      id: `l${channel}`,
      lightId: `uuid-${channel}`,
      channel,
      clip,
      session,
    }));
    await new LightGroupCapability("room", lights).setColor("#123456");
    expect(sent).toEqual([[
      { channel: 0, r: 0x12, g: 0x34, b: 0x56 },
      { channel: 1, r: 0x12, g: 0x34, b: 0x56 },
      { channel: 2, r: 0x12, g: 0x34, b: 0x56 },
    ]]);
  });

  test("getState reports the last color set while streaming, since CLIP does not see streamed colors", async () => {
    const { clip } = fakeClip({ on: true, brightnessPercent: 100, color: "#ff0000" }); // CLIP retains the pre-stream color
    const { session } = fakeSession(true);
    const light = new HueEntertainmentLightCapability({ id: "l1", lightId: "uuid-1", channel: 0, clip, session });
    await light.setColor("#123456");
    const state = await light.getState();
    expect(state.color).toBe("#123456");
  });

  test("getState prefers CLIP's own reported color when present", async () => {
    const { clip } = fakeClip({ on: true, brightnessPercent: 100, color: "#abcdef" });
    const { session } = fakeSession(false);
    const light = new HueEntertainmentLightCapability({ id: "l1", lightId: "uuid-1", channel: 0, clip, session });
    const state = await light.getState();
    expect(state.color).toBe("#abcdef");
  });
});

describe("HueEntertainmentLight device", () => {
  test("throws when no hue service is configured", () => {
    expect(() => new HueEntertainmentLight({ id: "l1", name: "Lamp" }, { lightId: "uuid-1", channel: 0 }, {})).toThrow(LightError);
  });

  test("model.create() builds a device with a light capability", () => {
    const { clip } = fakeClip();
    const { session } = fakeSession(false);
    const device = HUE_ENTERTAINMENT_LIGHT.create({ id: "l1", name: "Lamp" }, { lightId: "uuid-1", channel: 0 }, { hue: { clip, session } }, {});
    expect(device.capabilities.light).toBeDefined();
    expect(device.model.id).toBe("hue-entertainment-light");
  });
});
