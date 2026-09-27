import { expect, test } from "bun:test";
import { dogSiteDependencies } from "./dog-site";
import { DEFAULT_DOG_CONFIG } from "./dog-config";
import type { Site } from "../site";

test("site cameras and a frame detector and speech-capable standalone speakers can be used", async () => {
  let group = { isCoordinator: true, memberHosts: ["kitchen"] }, speech = true;
  const said: string[] = [];
  const site = { get: (id: string) => id === "unmapped" ? undefined : ({ capability: () => ({ supportsSay: () => speech, getState: async () => ({ group }), say: async (text: string) => { said.push(text); } }) }) } as unknown as Site;
  const deps = dogSiteDependencies(() => site, { label: async () => { throw Error("Must not label"); } });
  deps.validate(DEFAULT_DOG_CONFIG);
  expect(() => deps.validate({ ...DEFAULT_DOG_CONFIG, cameraId: "unmapped" })).toThrow("Choose a camera");
  await deps.speak("sonos-kitchen", "OUT"); expect(said).toEqual(["OUT"]);
  group = { isCoordinator: true, memberHosts: ["kitchen", "office"] };
  await expect(deps.speak("sonos-kitchen", "OUT")).rejects.toThrow("grouped");
  group = { isCoordinator: false, memberHosts: ["kitchen"] };
  await expect(deps.speak("sonos-kitchen", "OUT")).rejects.toThrow("grouped");
  speech = false; expect(() => deps.validate(DEFAULT_DOG_CONFIG)).toThrow("speech support");
  await expect(dogSiteDependencies(() => site).detect("example-camera-2", new AbortController().signal)).rejects.toThrow("Enable the Frigate");
  expect(said).toHaveLength(1);
});

test("preview reads only a configured local recorder stream", async () => {
  const { dogPreviewSource } = await import("./dog-site");
  const secrets = (uri: unknown) => ({ schemaVersion: 1 as const, vendors: { unifiProtect: { streams: { kitchen: uri } } } });
  expect(dogPreviewSource(secrets("rtsps://10.77.0.119:7441/private-token"), "kitchen")).toEqual({ streamUri: "rtsps://10.77.0.119:7441/private-token" });
  for (const uri of [undefined, 3, "https://10.77.0.119/picture", "rtsp://example.com/private-token"]) {
    expect(() => dogPreviewSource(secrets(uri), "kitchen")).toThrow("local Protect restream");
  }
  expect(() => dogPreviewSource(secrets("rtsp://10.77.0.119/stream"), "missing")).toThrow("local Protect restream");
});
