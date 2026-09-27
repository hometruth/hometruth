import { describe, expect, test } from "bun:test";
import { captureCameraSnapshot, isSafeCameraUri } from "../../../camera-media";
import { parseDevicesConfig } from "../../../config/devices";
import { provision } from "../../../config/provision";
import { REVEAL_AUTH } from "../../../protocols/reveal/client";
import { authResponse, credentials, imageResponse, jpeg, photoResponse, samplePhoto } from "../../../protocols/reveal/test-fixtures";
import { MODELS } from "../../../registry";
import { Site } from "../../../site";
import { createApp } from "../../../server/app";
import { TactacamReveal } from "./index";

function fixture() {
  let now = 1000;
  let photoId = "photo-1";
  let empty = false;
  let failure = false;
  let imageFailure = false;
  const calls = { auth: 0, feed: 0, media: 0 };
  const device = new TactacamReveal({ id: "trail", name: "Trail camera" }, { cameraId: "camera-1", pollIntervalMs: 60_000 }, credentials, {
    now: () => now,
    fetch: async url => {
      if (url.href === REVEAL_AUTH) { calls.auth++; return authResponse(); }
      if (url.pathname.endsWith("/photos/v2")) {
        calls.feed++;
        if (failure) return new Response(null, { status: 503 });
        return photoResponse(empty ? [] : [{ ...samplePhoto, photoId }]);
      }
      calls.media++;
      return imageFailure ? new Response(null, { status: 503 }) : imageResponse();
    },
  });
  return { device, calls, advance: () => { now += 60_001; }, setPhoto: (id: string) => { photoId = id; }, empty: () => { empty = true; }, fail: () => { failure = true; }, failImage: () => { imageFailure = true; } };
}

describe("Tactacam REVEAL device", () => {
  test("exposes a validated snapshot-only camera, and shares polls/downloads between viewers", async () => {
    const f = fixture();
    const [document, image1, image2] = await Promise.all([f.device.describe(), f.device.snapshot(), captureCameraSnapshot(f.device.camera.mediaSource())]);
    expect(document.capabilities.camera?.state).toEqual({ availability: "online", streamAvailable: false, snapshotAvailable: true });
    expect(document.capabilities.camera?.actions).toEqual({ snapshot: { mediaTypes: ["image/jpeg"] } });
    expect(image1).toEqual(jpeg);
    expect(image2).toEqual(jpeg);
    expect(f.calls).toEqual({ auth: 1, feed: 1, media: 1 });
    expect(f.device.controls()).toEqual(["latestPhoto"]);
    const metadata = await f.device.invokeControl("latestPhoto");
    expect(metadata).toMatchObject({ photoId: "photo-1", photoTimestamp: samplePhoto.photoTimestamp });
    expect(JSON.stringify({ document, metadata })).not.toContain("private-example");
    expect(JSON.stringify(document)).not.toContain(credentials.password);
    expect(isSafeCameraUri(samplePhoto.photoUrl)).toBe(false);
  });

  test("checks for new photos after the interval and downloads only when the ID changes", async () => {
    const f = fixture();
    await f.device.snapshot();
    f.advance();
    await f.device.snapshot();
    expect(f.calls).toEqual({ auth: 1, feed: 2, media: 1 });
    f.setPhoto("photo-2"); f.advance();
    await f.device.snapshot();
    expect(f.calls).toEqual({ auth: 1, feed: 3, media: 2 });
  });

  test("reports an empty feed without claiming a snapshot exists", async () => {
    const f = fixture(); f.empty();
    expect(await f.device.camera.state()).toEqual({ availability: "online", streamAvailable: false, snapshotAvailable: false });
    expect(await f.device.invokeControl("latestPhoto")).toBeNull();
    await expect(f.device.snapshot()).rejects.toThrow("No photos have been uploaded");
  });

  test("finds the latest photo after an empty filtered page with a continuation token", async () => {
    const device = new TactacamReveal({ id: "trail", name: "Trail camera" }, { cameraId: "camera-1" }, credentials, {
      fetch: async url => {
        if (url.href === REVEAL_AUTH) return authResponse();
        return url.searchParams.has("paginationKey") ? photoResponse() : photoResponse([], "next");
      },
    });
    expect(await device.invokeControl("latestPhoto")).toMatchObject({ photoId: "photo-1" });
  });

  test("reports missing credentials and caches outages instead of serving stale photos as current", async () => {
    const missing = new TactacamReveal({ id: "missing", name: "Missing" }, { cameraId: "camera-1" });
    expect((await missing.camera.state()).availability).toBe("unknown");
    const f = fixture(); await f.device.snapshot();
    f.fail(); f.advance();
    expect((await f.device.camera.state()).availability).toBe("offline");
    await expect(f.device.snapshot()).rejects.toThrow("HTTP 503");
    await expect(f.device.snapshot()).rejects.toThrow("HTTP 503");
    expect(f.calls.feed).toBe(2);
    expect(f.calls.media).toBe(1);
  });

  test("throttles failed image downloads independently of the feed cache", async () => {
    const f = fixture(); f.failImage();
    await expect(f.device.snapshot()).rejects.toThrow("HTTP 503");
    await expect(f.device.snapshot()).rejects.toThrow("HTTP 503");
    expect(f.calls.media).toBe(1);
    f.advance();
    await expect(f.device.snapshot()).rejects.toThrow("HTTP 503");
    expect(f.calls.media).toBe(2);
  });

  test("is registered, provisions without a LAN host, and rejects secrets in public config", () => {
    const config = (extra: string) => parseDevicesConfig(`schemaVersion: 2\ndevices:\n  - id: trail\n    model: tactacam-reveal\n    config: { cameraId: camera-1${extra} }\n`);
    expect(provision(config(""), MODELS, {})[0]).toBeInstanceOf(TactacamReveal);
    expect(() => provision(config(", password: secret"), MODELS, {})).toThrow("invalid Tactacam REVEAL config");
    expect(() => provision(config(", pollIntervalMs: 1000"), MODELS, {})).toThrow("invalid Tactacam REVEAL config");
  });

  test("serves JPEG bytes through the generic HTTP route without exposing cloud URLs", async () => {
    const f = fixture();
    const app = createApp(undefined, new Site([f.device]));
    const response = await app.request("/api/cameras/trail/snapshot");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(jpeg);
    const detail = await app.request("/api/devices/trail");
    const text = await detail.text();
    expect(detail.status).toBe(200);
    expect(text).not.toContain("private-example");
    expect(text).not.toContain(credentials.password);
  });
});
