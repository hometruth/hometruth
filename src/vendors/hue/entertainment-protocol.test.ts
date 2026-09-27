import { describe, expect, test } from "bun:test";
import { buildHueStreamFrame } from "./entertainment-protocol";

const AREA_ID = "7f6715a0-2d9a-4a72-944d-90fb206c14e5";

describe("buildHueStreamFrame", () => {
  test("has the exact size for the header + UUID + N channels", () => {
    const frame = buildHueStreamFrame(AREA_ID, 0, [{ channel: 0, r: 255, g: 0, b: 0 }]);
    expect(frame.length).toBe(16 + 36 + 7);
  });

  test("scales linearly with channel count", () => {
    const channels = [
      { channel: 0, r: 255, g: 0, b: 0 },
      { channel: 1, r: 0, g: 255, b: 0 },
      { channel: 2, r: 0, g: 0, b: 255 },
    ];
    const frame = buildHueStreamFrame(AREA_ID, 0, channels);
    expect(frame.length).toBe(16 + 36 + 7 * 3);
  });

  test("starts with the literal \"HueStream\" magic", () => {
    const frame = buildHueStreamFrame(AREA_ID, 0, [{ channel: 0, r: 0, g: 0, b: 0 }]);
    expect(new TextDecoder().decode(frame.slice(0, 9))).toBe("HueStream");
  });

  test("version bytes are 0x02 0x00", () => {
    const frame = buildHueStreamFrame(AREA_ID, 0, [{ channel: 0, r: 0, g: 0, b: 0 }]);
    expect([frame[9], frame[10]]).toEqual([0x02, 0x00]);
  });

  test("sequence byte reflects the given sequence, wrapping at 256", () => {
    expect(buildHueStreamFrame(AREA_ID, 5, [{ channel: 0, r: 0, g: 0, b: 0 }])[11]).toBe(5);
    expect(buildHueStreamFrame(AREA_ID, 256, [{ channel: 0, r: 0, g: 0, b: 0 }])[11]).toBe(0);
    expect(buildHueStreamFrame(AREA_ID, 257, [{ channel: 0, r: 0, g: 0, b: 0 }])[11]).toBe(1);
  });

  test("color space byte (offset 14) is 0x00 for RGB", () => {
    const frame = buildHueStreamFrame(AREA_ID, 0, [{ channel: 0, r: 0, g: 0, b: 0 }]);
    expect(frame[14]).toBe(0x00);
  });

  test("embeds the area UUID verbatim at offset 16", () => {
    const frame = buildHueStreamFrame(AREA_ID, 0, [{ channel: 0, r: 0, g: 0, b: 0 }]);
    expect(new TextDecoder().decode(frame.slice(16, 16 + 36))).toBe(AREA_ID);
  });

  test("each channel is id + duplicated R,G,B bytes, in order", () => {
    const frame = buildHueStreamFrame(AREA_ID, 0, [
      { channel: 2, r: 10, g: 20, b: 30 },
      { channel: 5, r: 200, g: 100, b: 50 },
    ]);
    const base = 16 + 36;
    expect(Array.from(frame.slice(base, base + 7))).toEqual([2, 10, 10, 20, 20, 30, 30]);
    expect(Array.from(frame.slice(base + 7, base + 14))).toEqual([5, 200, 200, 100, 100, 50, 50]);
  });

  test("clamps out-of-range color components", () => {
    const frame = buildHueStreamFrame(AREA_ID, 0, [{ channel: 0, r: 300, g: -10, b: 128.6 }]);
    const base = 16 + 36;
    expect(Array.from(frame.slice(base, base + 7))).toEqual([0, 255, 255, 0, 0, 129, 129]);
  });

  test("rejects an empty channel list", () => {
    expect(() => buildHueStreamFrame(AREA_ID, 0, [])).toThrow();
  });

  test("rejects a malformed area id", () => {
    expect(() => buildHueStreamFrame("not-a-uuid", 0, [{ channel: 0, r: 0, g: 0, b: 0 }])).toThrow();
    expect(() => buildHueStreamFrame(AREA_ID.slice(0, 35), 0, [{ channel: 0, r: 0, g: 0, b: 0 }])).toThrow();
  });
});
