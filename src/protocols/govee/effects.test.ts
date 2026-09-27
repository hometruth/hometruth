import { expect, test } from "bun:test";
import { arrangementPackets, bulbBrightnessPacket, bulbColorPacket, lightPacket, scenePackets } from "./effects";
import scenes from "../../devices/string-lights/govee-h7021/govee-presets.json";

test("matches independently captured manual color and brightness frames", () => {
  // H6046 captures published in wez/govee2mqtt#105; same color frame verified
  // physically on H7021 bulb 1, with bit 15 verified on physical bulb 16.
  expect(Buffer.from(bulbColorPacket(0, "#ff00fc"), "base64").toString("hex")).toBe("33 05 15 01 ff 00 fc 00 00 00 00 00 01 00 00 00 00 00 00 20".replaceAll(" ", ""));
  expect(Buffer.from(bulbBrightnessPacket(9, 54), "base64").toString("hex")).toBe("33 05 15 02 36 00 02 00 00 00 00 00 00 00 00 00 00 00 00 15".replaceAll(" ", ""));
  expect(Buffer.from(bulbColorPacket(15, "#0000ff"), "base64").subarray(12, 16)).toEqual(Buffer.from([0, 128, 0, 0]));
  expect(Buffer.from(bulbColorPacket(29, "#0000ff"), "base64").subarray(12, 16)).toEqual(Buffer.from([0, 0, 0, 32]));
  for (const index of [-1, 0.5, 30, 256]) expect(() => bulbColorPacket(index, "#ffffff")).toThrow();
  expect(() => lightPacket([256])).toThrow();
  expect(() => lightPacket(Array(20).fill(0))).toThrow();
});

test("all 51 H7021 scene uploads retain every parameter, page boundary and checksum", () => {
  expect(scenes).toHaveLength(51);
  expect(new Set(scenes.map(scene => scene.id)).size).toBe(51);
  for (const scene of scenes) {
    const frames = scenePackets(scene.code, scene.parameters).map(frame => Buffer.from(frame, "base64"));
    for (const frame of frames) {
      expect(frame.length).toBe(20);
      expect(frame.reduce((xor, byte) => xor ^ byte, 0)).toBe(0);
    }
    const select = frames.pop()!;
    expect(select.subarray(0, 5)).toEqual(Buffer.from([0x33, 5, 4, scene.code & 255, scene.code >> 8]));
    if (!scene.parameters) { expect(frames).toHaveLength(0); continue; }
    expect(frames[0]![3]).toBe(frames.length);
    const restored = Buffer.concat(frames.map((frame, i) => {
      expect(frame[0]).toBe(0xa3);
      expect(frame[1]).toBe(i === frames.length - 1 ? 255 : i);
      return frame.subarray(i === 0 ? 5 : 2, 19);
    }));
    const original = Buffer.from(scene.parameters, "base64");
    expect(restored.subarray(0, original.length)).toEqual(original);
  }
  expect(() => scenePackets(1, "not base64")).toThrow();
  expect(scenePackets(1, "")).toHaveLength(1);
  expect(() => scenePackets(65536, "AAAA")).toThrow();
});


test("static arrangements address every bulb once, preserve RGB, and fit one datagram", () => {
  const colors = Array.from({ length: 30 }, (_, i) => i % 2 ? "#FFFFFF" : "#ff0000");
  const encoded = arrangementPackets(colors);
  expect(encoded).toHaveLength(3);
  const frames = encoded.map(frame => Buffer.from(frame, "base64"));
  expect(frames[0]!.subarray(0, 9)).toEqual(Buffer.from([0x33, 5, 0x15, 2, 100, 255, 255, 255, 63]));
  expect(frames[1]!.subarray(12, 16)).toEqual(Buffer.from([0x55, 0x55, 0x55, 0x15]));
  expect(frames[2]!.subarray(12, 16)).toEqual(Buffer.from([0xaa, 0xaa, 0xaa, 0x2a]));
  for (let i = 0; i < 30; i++) {
    const matches = frames.slice(1).filter(frame => frame[12 + Math.floor(i / 8)]! & (1 << (i % 8)));
    expect(matches).toHaveLength(1);
    expect('#' + matches[0]!.subarray(4, 7).toString('hex')).toBe(colors[i]!.toLowerCase());
  }
  for (const frame of frames) expect(frame.reduce((xor, byte) => xor ^ byte, 0)).toBe(0);
  expect(Buffer.from(arrangementPackets(["#0040ff"])[1]!, "base64").subarray(12, 16)).toEqual(Buffer.from([1, 0, 0, 0]));
  const unique = arrangementPackets(Array.from({ length: 30 }, (_, i) => '#' + i.toString(16).padStart(6, '0')));
  expect(JSON.stringify({ msg: { cmd: "ptReal", data: { command: unique } } }).length).toBeLessThan(1200);
  for (const invalid of [[], ["red"], Array(31).fill("#ffffff")]) expect(() => arrangementPackets(invalid)).toThrow();
});
