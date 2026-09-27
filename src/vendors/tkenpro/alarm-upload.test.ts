import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeariAlarmUploadInterceptor, parseOssCallback, type MeariAlarmEvent } from "./alarm-upload";

/** The callback header exactly as the camera builds it (base64 JSON with a query-string body), with the captured fields. */
function callbackHeader(body: Record<string, string>): string {
  return Buffer.from(JSON.stringify({
    callbackUrl: "https://apis-us-west.cloudedge360.com/v14/devices/callback/event/image",
    callbackBody: new URLSearchParams(body).toString(),
  })).toString("base64");
}

const UPLOAD_URL = "http://meari-oss-us.oss-us-west-1.aliyuncs.com/7e/v/1006507971/1031478350/20260906/v2-830039465e914cbcd36ff009451a6a72-20260906014217.jpgx3";

describe("parseOssCallback", () => {
  test("decodes the url and the query-string body", () => {
    expect(parseOssCallback(callbackHeader({ eventType: "1", deviceID: "ppscabcdef0123456789" }))).toEqual({
      callbackUrl: "https://apis-us-west.cloudedge360.com/v14/devices/callback/event/image",
      body: { eventType: "1", deviceID: "ppscabcdef0123456789" },
    });
    expect(parseOssCallback(null)).toBeUndefined();
    expect(parseOssCallback("not base64 json")).toBeUndefined();
  });
});

describe("MeariAlarmUploadInterceptor", () => {
  test("answers a motion upload like OSS, keeps the thumbnail, and reports the event to listeners", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alarms-"));
    const interceptor = new MeariAlarmUploadInterceptor({ snapshotDirectory: directory, now: () => 1_788_683_146_157 });
    const events: MeariAlarmEvent[] = [];
    interceptor.onAlarm((event) => events.push(event));
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    const request = new Request(UPLOAD_URL, {
      method: "PUT",
      headers: {
        "x-oss-callback": callbackHeader({ eventType: "1", deviceID: "ppsc708dc5f1b76b4d2b", userID: "1006507971", eventTime: "20260906014217", videoDuration: "10", decibel: "42" }),
        "content-type": "application/json",
        "content-length": String(jpeg.length),
      },
      body: jpeg,
    });
    const response = await interceptor.handle(request, { address: "10.78.0.147", device: { id: "example-camera", name: "Kitchen", host: "10.78.0.147", cloudHostnames: [] } });
    expect(response?.status).toBe(200);
    expect(response?.headers.get("server")).toBe("AliyunOSS");
    expect(response?.headers.get("etag")).toMatch(/^"[0-9A-F]{32}"$/u);
    expect(response?.headers.get("x-oss-request-id")).toMatch(/^[0-9A-F]{24}$/u);
    expect(await response?.json()).toEqual({ t: 1_788_683_146_157, resultCode: "1001" });

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event).toMatchObject({ sourceAddress: "10.78.0.147", deviceUuid: "708dc5f1b76b4d2b", eventType: 1, kind: "motion", eventTime: "20260906014217", mediaId: "830039465e914cbcd36ff009451a6a72", videoDurationSeconds: 10, decibel: 42, bytes: jpeg.length });
    expect(event.snapshotPath).toBeDefined();
    expect(await readdir(join(directory, "example-camera"))).toEqual(["20260906014217-motion-830039465e91.jpg"]);
    expect(interceptor.lastAlarm("10.78.0.147")).toBe(event);
    expect(interceptor.count).toBe(1);
  });

  test("falls back to the upload path for the event time and treats other event types as 'other'", async () => {
    const interceptor = new MeariAlarmUploadInterceptor({ snapshotDirectory: "" });
    const events: MeariAlarmEvent[] = [];
    interceptor.onAlarm((event) => events.push(event));
    const response = await interceptor.handle(new Request(UPLOAD_URL, { method: "PUT", headers: { "x-oss-callback": callbackHeader({ eventType: "3", deviceID: "ppsc2f9d15a6f3f24d09" }) }, body: new Uint8Array([1]) }), { address: "10.78.0.64" });
    expect(response?.status).toBe(200);
    expect(events[0]).toMatchObject({ kind: "other", eventType: 3, eventTime: "20260906014217" });
    expect(events[0]!.snapshotPath).toBeUndefined();
  });

  test("leaves anything but a PUT to the isolation log", async () => {
    const interceptor = new MeariAlarmUploadInterceptor({ snapshotDirectory: "" });
    expect(await interceptor.handle(new Request(UPLOAD_URL, { method: "GET" }), { address: "10.78.0.64" })).toBeUndefined();
  });
});
