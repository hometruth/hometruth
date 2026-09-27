import { describe, expect, test } from "bun:test";
import { EventLog, matchesFilter, type ServiceEvent } from "./event-log";

const at = () => new Date("2026-09-06T12:00:00.000Z");

describe("EventLog", () => {
  test("records a known type with its data and defaults the level from the catalog", () => {
    const log = new EventLog(10, at);
    const event = log.record("motion", "Motion detected", { subject: "example-camera", data: { bytes: 32_000, clipSeconds: 6 } });
    expect(event).toEqual({
      at: "2026-09-06T12:00:00.000Z",
      level: "info",
      type: "motion",
      message: "Motion detected",
      subject: "example-camera",
      data: { bytes: 32_000, clipSeconds: 6 },
    });
    expect(log.record("protocol_error", "Refused").level).toBe("warn");
    expect(log.record("persistence_error", "Disk full").level).toBe("error");
  });

  test("refuses a type that is not in the catalog, naming where to add it", () => {
    const log = new EventLog();
    expect(() => log.record("invented_here", "?")).toThrow(/Unknown event type "invented_here".*event-types\.ts/su);
  });

  test("refuses data that does not match the type's schema", () => {
    const log = new EventLog();
    expect(() => log.record("motion", "Motion", { data: { bytes: "lots" } })).toThrow(/Invalid data for a "motion" event/u);
    expect(() => log.record("registered", "Registered", { data: { nonsense: true } })).toThrow(/Invalid data for a "registered" event/u);
    expect(log.recent()).toEqual([]);
  });

  test("validates the general event and does not let omitted payloads bypass required fields", () => {
    const log = new EventLog();
    expect(() => log.record("camera_object", "Missing required payload")).toThrow(/Invalid data/u);
    expect(() => log.record("connected", "")).toThrow(/Invalid event/u);
    expect(log.recent()).toEqual([]);
  });

  test("keeps only the most recent events, newest first", () => {
    const log = new EventLog(2, at);
    log.record("connected", "one");
    log.record("connected", "two");
    log.record("connected", "three");
    expect(log.recent().map((event) => event.message)).toEqual(["three", "two"]);
    expect(log.recent(1).map((event) => event.message)).toEqual(["three"]);
  });

  test("filters by subject and by type, and lists both for a filter menu", () => {
    const log = new EventLog(20, at);
    log.record("motion", "Kitchen motion", { subject: "example-camera", data: { bytes: 1 } });
    log.record("registered", "Kitchen registered", { subject: "example-camera", data: { uuid: "a" } });
    log.record("motion", "Hall motion", { subject: "example-camera-2", data: { bytes: 2 } });
    log.record("started", "Emulator started");

    expect(log.recent(undefined, { subject: "example-camera" }).map((event) => event.message)).toEqual(["Kitchen registered", "Kitchen motion"]);
    expect(log.recent(undefined, { types: ["motion"] }).map((event) => event.message)).toEqual(["Hall motion", "Kitchen motion"]);
    expect(log.recent(undefined, { subject: "example-camera", types: ["motion"] }).map((event) => event.message)).toEqual(["Kitchen motion"]);
    expect(log.subjects()).toEqual(["example-camera", "example-camera-2"]);
    expect(log.types()).toEqual(["motion", "registered", "started"]);
  });

  test("a subscriber with a filter is told only about its own matches", () => {
    const log = new EventLog(20, at);
    const kitchen: ServiceEvent[] = [];
    const everything: ServiceEvent[] = [];
    log.subscribe((event) => kitchen.push(event), { subject: "example-camera" });
    const stop = log.subscribe((event) => everything.push(event));
    log.record("motion", "Kitchen", { subject: "example-camera", data: { bytes: 1 } });
    log.record("motion", "Hall", { subject: "example-camera-2", data: { bytes: 1 } });
    stop();
    log.record("motion", "Kitchen again", { subject: "example-camera", data: { bytes: 1 } });

    expect(kitchen.map((event) => event.message)).toEqual(["Kitchen", "Kitchen again"]);
    expect(everything.map((event) => event.message)).toEqual(["Kitchen", "Hall"]);
  });
});

describe("matchesFilter", () => {
  const event: ServiceEvent = { at: "2026-09-06T12:00:00.000Z", level: "info", type: "motion", message: "m", subject: "example-camera" };

  test("an empty filter matches everything; each field narrows", () => {
    expect(matchesFilter(event, {})).toBe(true);
    expect(matchesFilter(event, { subject: "example-camera" })).toBe(true);
    expect(matchesFilter(event, { subject: "example-camera-2" })).toBe(false);
    expect(matchesFilter(event, { types: ["motion", "alarm"] })).toBe(true);
    expect(matchesFilter(event, { types: ["registered"] })).toBe(false);
    expect(matchesFilter(event, { level: "warn" })).toBe(false);
    const { subject: _subject, ...withoutSubject } = event;
    void _subject;
    expect(matchesFilter(withoutSubject, { subject: "example-camera" })).toBe(false);
  });
});
