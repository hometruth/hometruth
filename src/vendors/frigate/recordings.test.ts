import { expect, test } from "bun:test";
import { protectRecordingLink, protectRecordingsConfig } from "./recordings";

const cameraId = "a".repeat(24);
const config = { baseUrl: "https://nvr.example.test/protect", cameras: { front: cameraId } };

test("links the label's frame to the correct Protect camera in milliseconds with pre-roll", () => {
  const result = protectRecordingLink(protectRecordingsConfig(config), "front", 1789162392.975834)!;
  expect(result.recordingUrl).toBe(`https://nvr.example.test/protect/timelapse/${cameraId}?start=1789162387975`);
  expect(result.recordingStartTime).toBe(1789162387975);
  expect(protectRecordingLink(protectRecordingsConfig(config), "front", 3)?.recordingStartTime).toBe(0);
});

test("supports the signed-in UniFi console URL and explicit zero pre-roll", () => {
  const parsed = protectRecordingsConfig({ ...config, baseUrl: "https://unifi.ui.com/consoles/EXAMPLE:123/protect/", preRollSeconds: 0 });
  expect(protectRecordingLink(parsed, "front", 1789162392)?.recordingUrl)
    .toBe(`https://unifi.ui.com/consoles/EXAMPLE:123/protect/timelapse/${cameraId}?start=1789162392000`);
});

test("unmapped cameras, missing configuration and invalid timestamps have no recording link", () => {
  const parsed = protectRecordingsConfig(config);
  expect(protectRecordingLink(undefined, "front", 123)).toBeUndefined();
  for (const camera of ["unknown", "__proto__", "toString"]) expect(protectRecordingLink(parsed, camera, 123)).toBeUndefined();
  for (const time of [undefined, "123", NaN, Infinity, -1, 1e15]) expect(protectRecordingLink(parsed, "front", time)).toBeUndefined();
});

test("configuration excludes credentials, arbitrary paths, malformed IDs and unsafe protocols", () => {
  expect(protectRecordingsConfig(undefined)).toBeUndefined();
  for (const baseUrl of ["javascript:alert(1)", "https://user:secret@nvr.test/protect", "https://nvr.test/protect?token=secret",
    "https://nvr.test/protect#token", "https://nvr.test/other", "https://nvr.test/protect/timelapse/id"]) {
    expect(() => protectRecordingsConfig({ ...config, baseUrl })).toThrow("Invalid Protect");
  }
  expect(() => protectRecordingsConfig({ ...config, cameras: { front: "../camera" } })).toThrow();
  expect(() => protectRecordingsConfig({ ...config, preRollSeconds: NaN })).toThrow();
  expect(() => protectRecordingsConfig({ ...config, preRollSeconds: 61 })).toThrow();
});
