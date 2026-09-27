import { describe, expect, test } from "bun:test";
import {
  CameraMediaError,
  cameraSnapshotCandidates,
  cameraUriWithCredentials,
  createCameraAudioStreamResponse,
  isSafeCameraUri,
  playbackVideoInputFormat,
  mjpegOutputArgs,
} from "./camera-media";

describe("camera media safety", () => {
  test("original camera frames are not downscaled and use higher JPEG quality", () => {
    const original = mjpegOutputArgs("original"), preview = mjpegOutputArgs("preview");
    expect(original[original.indexOf("-vf") + 1]).toBe("fps=8");
    expect(original[original.indexOf("-q:v") + 1]).toBe("1");
    expect(preview[preview.indexOf("-vf") + 1]).toContain("scale=min(1280");
    expect(preview[preview.indexOf("-q:v") + 1]).toBe("5");
    expect(mjpegOutputArgs("analysis")[1]).toBe("fps=1,scale=min(1280\\,iw):-2");
  });
  test("accepts camera-local media addresses", () => {
    expect(isSafeCameraUri("rtsp://10.78.0.88:8554/Streaming/Channels/101")).toBe(true);
    expect(isSafeCameraUri("http://petcam.local/snapshot.jpg")).toBe(true);
  });

  test("rejects public and non-media addresses", () => {
    expect(isSafeCameraUri("https://example.com/video")).toBe(false);
    expect(isSafeCameraUri("file:///etc/passwd")).toBe(false);
  });

  test("adds encoded credentials without using a shell", () => {
    expect(cameraUriWithCredentials("rtsp://10.78.0.88/live", "admin", "p@ss word"))
      .toBe("rtsp://admin:p%40ss%20word@10.78.0.88/live");
    expect(() => cameraUriWithCredentials("https://example.com", "admin", "secret"))
      .toThrow(CameraMediaError);
  });

  test("falls back from an advertised snapshot URI to the RTSP profile", () => {
    expect(cameraSnapshotCandidates({
      snapshotUri: "http://10.78.0.88/snapshot",
      streamUri: "rtsp://10.78.0.88:8554/Streaming/Channels/101",
    })).toEqual([
      "http://10.78.0.88/snapshot",
      "rtsp://10.78.0.88:8554/Streaming/Channels/101",
    ]);
    expect(cameraSnapshotCandidates({
      snapshotUri: "rtsp://10.78.0.88/live",
      streamUri: "rtsp://10.78.0.88/live",
    })).toEqual(["rtsp://10.78.0.88/live"]);
  });

  test("rejects local audio streaming when no RTSP source exists", () => {
    expect(() => createCameraAudioStreamResponse({})).toThrow(CameraMediaError);
  });

  test("selects the native ffmpeg demuxer for recorded video", () => {
    expect(playbackVideoInputFormat("h264")).toBe("h264");
    expect(playbackVideoInputFormat("h265")).toBe("hevc");
    expect(() => playbackVideoInputFormat("pcm_mulaw")).toThrow(CameraMediaError);
  });
});
