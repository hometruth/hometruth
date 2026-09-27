import { describe, expect, test } from "bun:test";
import { alarmThumbnailUrl, createTkenproCloudServices } from "./cloud-services";
import type { MeariLocalCloudEvent } from "../../protocols/tkenpro/cloud-emulator";
import type { MeariAlarmEvent } from "./alarm-upload";

const KITCHEN = { deviceId: "example-camera", name: "Kitchen pet camera", uuid: "uuid-kitchen", host: "10.78.0.147" };
const SHED = { deviceId: "example-camera-2", name: "Shed pet camera", uuid: "uuid-shed", host: "10.78.0.64" };

function alarm(overrides: Partial<MeariAlarmEvent> = {}): MeariAlarmEvent {
  return { at: "2026-09-06T12:00:00.000Z", sourceAddress: "10.78.0.147", eventType: 1, kind: "motion", bytes: 32_000, ...overrides };
}

describe("the local cloud emulator service", () => {
  test("is one service, not one per camera: every camera is a subject of its events", () => {
    const emulator = createTkenproCloudServices([KITCHEN, SHED]);
    expect(emulator.id).toBe("tkenpro-cloud-emulator");
    expect(emulator.title).toBe("TKENPRO local cloud emulator");
    // Both cameras are offered as filters before either has said anything.
    expect(emulator.subjects()).toEqual(["example-camera", "example-camera-2"]);
  });

  test("tags an event with the camera whose uuid it carries, so one log serves every camera", () => {
    const emulator = createTkenproCloudServices([KITCHEN, SHED]);
    emulator.ingest({ type: "registered", uuid: KITCHEN.uuid });
    emulator.ingest({ type: "registered", uuid: SHED.uuid });

    expect(emulator.events().map((event) => [event.type, event.subject])).toEqual([
      ["registered", "example-camera-2"],
      ["registered", "example-camera"],
    ]);
    expect(emulator.events(undefined, { subject: "example-camera" }).map((event) => event.message)).toEqual(["Camera registered"]);
  });

  test("an event from a camera that is not configured is still recorded, with no subject", () => {
    const emulator = createTkenproCloudServices([KITCHEN]);
    emulator.ingest({ type: "registered", uuid: "a-camera-we-do-not-know" });
    expect(emulator.events()).toHaveLength(1);
    expect(emulator.events()[0]?.subject).toBeUndefined();
    expect(emulator.events(undefined, { subject: "example-camera" })).toEqual([]);
  });

  test("settings and heartbeat events carry their changed property codes as data, not prose", () => {
    const emulator = createTkenproCloudServices([KITCHEN]);
    const settings: MeariLocalCloudEvent = { type: "settings", uuid: KITCHEN.uuid, source: "sync", values: { "107": 3, "106": true } };
    emulator.ingest(settings);
    emulator.ingest({ type: "message", uuid: KITCHEN.uuid, content: { runtime: 1, t: 2, ver: 3, battery: 87, alarm: 1 }, via: "heartbeat" });

    const [heartbeat, changed] = emulator.events();
    expect(changed).toMatchObject({ type: "settings", subject: "example-camera", data: { source: "sync", changed: ["106", "107"] } });
    expect(heartbeat).toMatchObject({ type: "heartbeat_extra", message: "Heartbeat carried extra fields (alarm, battery)", data: { changed: ["alarm", "battery"] } });
  });

  test("routine heartbeats do not fill the log or notify subscribers", () => {
    const emulator = createTkenproCloudServices([SHED]);
    emulator.ingest({ type: "registered", uuid: SHED.uuid });
    const seen: string[] = [];
    emulator.subscribe((event) => seen.push(event.type));
    for (let runtime = 0; runtime < 500; runtime++) {
      emulator.ingest({ type: "message", uuid: SHED.uuid, content: { runtime, t: runtime + 1000, ver: 3 }, via: "heartbeat" });
    }
    emulator.ingest({ type: "message", uuid: SHED.uuid, content: {}, via: "heartbeat" });
    expect(emulator.events().map((event) => event.type)).toEqual(["registered"]);
    expect(seen).toEqual([]);
    expect(emulator.isConnected(SHED.deviceId)).toBe(true);
  });

  test("routine heartbeat field names remain visible in other message types", () => {
    const emulator = createTkenproCloudServices([SHED]);
    emulator.ingest({ type: "message", uuid: SHED.uuid, content: { runtime: 1, t: 2, ver: 3 } });
    expect(emulator.events()[0]).toMatchObject({ type: "message", data: { keys: ["runtime", "t", "ver"] } });
  });

  test("an unhandled command records the command code as a field", () => {
    const emulator = createTkenproCloudServices([KITCHEN]);
    emulator.ingest({ type: "message", uuid: KITCHEN.uuid, content: { __unhandledCommand: 0xc7 }, via: "unhandled-command" });
    expect(emulator.events()[0]).toMatchObject({ type: "unhandled_command", data: { command: "0xc7" } });
  });

  test("an alarm becomes a motion event on the camera at that address, with a thumbnail to render", () => {
    const emulator = createTkenproCloudServices([KITCHEN, SHED]);
    const deviceId = emulator.ingestAlarm(alarm({ snapshotPath: "/x/.hometruth/captures/alarms/example-camera/20260906100002-motion-abc.jpg", videoDurationSeconds: 6, decibel: 42, eventTime: "20260906100002" }));

    expect(deviceId).toBe("example-camera");
    const event = emulator.events()[0]!;
    expect(event.type).toBe("motion");
    expect(event.subject).toBe("example-camera");
    expect(event.message).toBe("Motion detected, 6 s clip, 42 dB");
    expect(event.data).toMatchObject({
      thumbnailUrl: alarmThumbnailUrl("example-camera", "20260906100002-motion-abc.jpg"),
      clipSeconds: 6,
      decibel: 42,
      eventTime: "20260906100002",
      vendorEventType: 1,
    });
  });

  test("a non-motion alarm is its own type, so it can be filtered out", () => {
    const emulator = createTkenproCloudServices([KITCHEN]);
    emulator.ingestAlarm(alarm({ kind: "other", eventType: 18 }));
    expect(emulator.events()[0]?.type).toBe("alarm");
    expect(emulator.events(undefined, { types: ["motion"] })).toEqual([]);
  });

  test("what a camera does on the network lands in the same log, tagged with that camera", () => {
    const emulator = createTkenproCloudServices([KITCHEN]);
    emulator.ingestNetwork({ type: "dns_lookup", message: "Looked up usce.mearicloud.com", data: { name: "usce.mearicloud.com" } }, "10.78.0.147");
    emulator.ingestNetwork({ type: "dns_lookup", message: "Looked up example.com", data: { name: "example.com" } }, "192.168.9.9");

    expect(emulator.events().map((event) => event.subject)).toEqual([undefined, "example-camera"]);
    expect(emulator.deviceIdAt("10.78.0.147")).toBe("example-camera");
    expect(emulator.deviceIdAt("192.168.9.9")).toBeUndefined();
  });

  test("status counts connected cameras and names the ones still missing", () => {
    const emulator = createTkenproCloudServices([KITCHEN, SHED]);
    expect(emulator.status()).toEqual({ availability: "degraded", detail: "0 of 2 cameras connected (waiting: Kitchen pet camera, Shed pet camera)" });
    emulator.ingest({ type: "registered", uuid: KITCHEN.uuid });
    expect(emulator.status()).toEqual({ availability: "online", detail: "1 of 2 cameras connected (waiting: Shed pet camera)" });
    emulator.ingest({ type: "registered", uuid: SHED.uuid });
    expect(emulator.status().detail).toBe("2 of 2 cameras connected");
    expect(emulator.isConnected("example-camera-2")).toBe(true);
    emulator.ingest({ type: "disconnected", uuid: SHED.uuid });
    expect(emulator.isConnected("example-camera-2")).toBe(false);
  });

  test("a subscriber can follow one camera alone", () => {
    const emulator = createTkenproCloudServices([KITCHEN, SHED]);
    const seen: string[] = [];
    emulator.subscribe((event) => seen.push(event.message), { subject: "example-camera-2" });
    emulator.ingest({ type: "registered", uuid: KITCHEN.uuid });
    emulator.ingest({ type: "disconnected", uuid: SHED.uuid });
    expect(seen).toEqual(["Camera disconnected"]);
  });
});
