import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { Filter, FilterValidationError, compileFilterCondition, type FilterCondition } from "./filter";
import { filterConditionSchema, filterSchema } from "./filter-schema";
import { EventLog, type ServiceEvent } from "./event-log";

const morning: FilterCondition = { all: [
  { path: "/type", op: "eq", value: "camera_object" },
  { path: "/subject", op: "eq", value: "camera-4" },
  { path: "/data/label", op: "eq", value: "person" },
  { timeWindow: { start: "09:00", end: "12:00", timeZone: "America/Los_Angeles",
    timestamp: { path: "/data/frameTime", format: "unixSeconds" } } },
] };
const document = { schemaId: filterSchema.$id, id: "morning-person", name: "Person on camera 4 in the morning", condition: morning };
const event = (at = "2026-09-20T16:00:00Z", changes: Partial<ServiceEvent> = {}): ServiceEvent => ({
  at, level: "info", type: "camera_object", message: "Person seen", subject: "camera-4",
  data: { source: "frigate", camera: "camera_4", objectId: "track-1", phase: "new", label: "person", confidence: 0.9,
    frameTime: Date.parse(at) / 1000, startTime: Date.parse(at) / 1000, currentZones: ["entrance"], enteredZones: ["entrance"] },
  ...changes,
});

describe("Filter", () => {
  test("selects a person on camera 4 in a local morning window using observation time", () => {
    const filter = new Filter(JSON.parse(JSON.stringify(document)));
    const first = event();
    expect(filter.select([
      event("2026-09-20T15:59:59Z"), first, event("2026-09-20T18:59:59.999Z"), event("2026-09-20T19:00:00Z"),
      event(undefined, { subject: "camera-3" }), event(undefined, { data: { ...first.data, label: "dog" } }),
    ])).toEqual([first, event("2026-09-20T18:59:59.999Z")]);
    expect(filter.select([first])[0]).toBe(first);
    // A delayed/imported observation uses frame time even if it arrives after noon.
    expect(filter.matches({ ...first, at: "2026-09-21T01:00:00Z" })).toBe(true);
    expect(filter.matches(event(undefined, { data: {} }))).toBe(false);
  });

  test("serializes a first-class document and snapshots conditions against caller mutation", () => {
    const input = JSON.parse(JSON.stringify(document));
    const filter = new Filter(input);
    input.condition = { path: "/subject", op: "eq", value: "camera-3" };
    const described = filter.describe() as { condition: FilterCondition };
    described.condition = { path: "/subject", op: "eq", value: "camera-3" };
    expect(filter.id).toBe("morning-person");
    expect(filter.name).toBe(document.name);
    expect(filter.describe()).toEqual(document);
    expect(filter.matches(event())).toBe(true);
  });

  test("uses the same predicate before history limits and for live subscriptions", () => {
    let now = new Date("2026-09-20T16:00:00Z");
    const log = new EventLog(20, () => now);
    const received: ServiceEvent[] = [];
    const stop = log.subscribe(e => received.push(e), { where: morning });
    const source = event();
    const first = log.record(source.type, source.message, { subject: source.subject!, data: source.data! });
    log.record(source.type, "Other camera", { subject: "camera-3", data: source.data! });
    now = new Date("2026-09-20T19:00:00Z");
    log.record(source.type, "Noon", { subject: "camera-4", data: { ...source.data, frameTime: now.getTime() / 1000 } });
    expect(log.recent(1, { where: morning })).toEqual([first]);
    expect(received).toEqual([first]);
    stop();
    log.record(source.type, "After unsubscribe", { subject: "camera-4", data: source.data! });
    expect(received).toEqual([first]);
  });
});

describe("Filter conditions", () => {
  test("detection selections match structured Event payloads, across camera and photo sources", () => {
    const matches = compileFilterCondition({ detectionLabels: ["person", "white tailed deer"] });
    for (const data of [
      { label: " Human " }, { subLabel: "Person" }, { classification: { label: "white_tailed_deer" } },
      { detections: [{ label: "animal" }, { label: "human" }] },
    ]) expect(matches(event(undefined, { data }))).toBe(true);
    for (const data of [{}, { label: "car" }, { detections: [] }]) expect(matches(event(undefined, { data }))).toBe(false);
    const empty = compileFilterCondition({ detectionLabels: ["no detection"] });
    expect(empty(event(undefined, { data: { detections: [] } }))).toBe(true);
    expect(empty(event(undefined, { data: { label: "blank" } }))).toBe(true);
    expect(empty(event(undefined, { data: {} }))).toBe(false);
    expect(compileFilterCondition({ all: [] })(event())).toBe(true);
    for (const labels of [[], [" "], ["person", "person"], [42]]) {
      expect(() => compileFilterCondition({ detectionLabels: labels })).toThrow(FilterValidationError);
    }
  });

  test("composes typed payload comparisons with all, any, not and scalar array membership", () => {
    const matches = compileFilterCondition({ all: [
      { any: [{ path: "/data/label", op: "in", value: ["person", "dog"] }, { path: "/level", op: "eq", value: "error" }] },
      { path: "/data/confidence", op: "gte", value: 0.8 },
      { path: "/data/currentZones", op: "contains", value: "entrance" },
      { not: { path: "/data/phase", op: "eq", value: "end" } },
    ] });
    expect(matches(event())).toBe(true);
    expect(matches(event(undefined, { data: { ...event().data, confidence: 0.7 } }))).toBe(false);
    expect(matches(event(undefined, { data: { ...event().data, confidence: "0.9" } }))).toBe(false);
    expect(matches(event(undefined, { data: { ...event().data, phase: "end" } }))).toBe(false);
  });

  test("distinguishes absent and null values and never traverses inherited properties", () => {
    const value = event(undefined, { data: { "a/b": { "~key": null }, labels: ["person"] } });
    expect(compileFilterCondition({ path: "/data/a~1b/~0key", op: "eq", value: null })(value)).toBe(true);
    expect(compileFilterCondition({ path: "/data/labels/0", op: "eq", value: "person" })(value)).toBe(true);
    expect(compileFilterCondition({ path: "/data/missing", op: "exists", value: false })(value)).toBe(true);
    expect(compileFilterCondition({ path: "/data/missing", op: "ne", value: "person" })(value)).toBe(false);
    expect(compileFilterCondition({ path: "/data/labels/0", op: "ne", value: null })(value)).toBe(true);
    expect(compileFilterCondition({ path: "/data/labels", op: "ne", value: null })(value)).toBe(false);
    expect(compileFilterCondition({ path: "/data/a~1b/~0key", op: "exists", value: true })(value)).toBe(true);
    expect(compileFilterCondition({ path: "/data/toString", op: "exists", value: true })(value)).toBe(false);
    expect(compileFilterCondition({ path: "/data/labels/length", op: "exists", value: true })(value)).toBe(false);
  });

  test("handles winter offsets, overnight windows and both DST transitions", () => {
    const morning = compileFilterCondition({ timeWindow: { start: "09:00", end: "12:00", timeZone: "America/Los_Angeles" } });
    expect(morning(event("2026-01-20T17:00:00Z"))).toBe(true);
    expect(morning(event("2026-01-20T16:59:59Z"))).toBe(false);
    expect(morning(event("2026-01-20T09:00:00-08:00"))).toBe(true);
    const night = compileFilterCondition({ timeWindow: { start: "22:00", end: "02:00", timeZone: "America/Los_Angeles" } });
    for (const at of ["2026-11-01T05:00:00Z", "2026-11-01T08:30:00Z", "2026-11-01T09:30:00Z"]) expect(night(event(at))).toBe(true);
    expect(night(event("2026-11-01T10:00:00Z"))).toBe(false);
    expect(night(event("2026-11-01T04:59:59Z"))).toBe(false);
    const spring = compileFilterCondition({ timeWindow: { start: "01:00", end: "03:00", timeZone: "America/Los_Angeles" } });
    expect(spring(event("2026-03-08T09:59:59Z"))).toBe(true);
    expect(spring(event("2026-03-08T10:00:00Z"))).toBe(false);
  });

  test("supports epoch milliseconds and refuses missing, invalid or unzoned timestamps", () => {
    const matches = compileFilterCondition({ timeWindow: { start: "09:00", end: "12:00", timeZone: "UTC",
      timestamp: { path: "/data/processedAt", format: "unixMilliseconds" } } });
    expect(matches(event(undefined, { data: { processedAt: Date.parse("2026-09-20T09:00:00Z") } }))).toBe(true);
    for (const processedAt of [undefined, null, "1789894800000", Infinity, 1e30]) expect(matches(event(undefined, { data: { processedAt } }))).toBe(false);
    const recorded = compileFilterCondition({ timeWindow: { start: "09:00", end: "12:00", timeZone: "UTC" } });
    for (const at of ["invalid", "2026-09-20T09:00:00", "2026-09-20"]) expect(recorded(event(at))).toBe(false);
  });

  test("rejects invalid definitions and excessive or cyclic recursion before use", () => {
    for (const condition of [
      {}, { any: [] }, { path: "/data/label", op: "invented", value: "person" },
      { path: "/data/confidence", op: "gte", value: "0.8" }, { path: "data.label", op: "eq", value: "person" },
      { path: "/data/~2", op: "exists", value: true }, { path: "/type", op: "eq", value: "motion", extra: true },
      { timeWindow: { start: "24:00", end: "12:00", timeZone: "UTC" } },
      { timeWindow: { start: "09:00", end: "12:00" } },
      { timeWindow: { start: "09:00", end: "12:00", timeZone: "Made/Up" } },
      { timeWindow: { start: "09:00", end: "09:00", timeZone: "UTC" } },
    ]) expect(() => compileFilterCondition(condition)).toThrow(FilterValidationError);
    let deep: FilterCondition = { path: "/type", op: "eq", value: "motion" };
    for (let index = 0; index < 16; index++) deep = { not: deep };
    expect(() => compileFilterCondition(deep)).toThrow("16 levels");
    const cycle: { not?: unknown } = {}; cycle.not = cycle;
    expect(() => compileFilterCondition(cycle)).toThrow("cycles");
    expect(() => compileFilterCondition({ all: Array.from({ length: 256 }, () => ({ path: "/type", op: "exists", value: true })) })).toThrow("256 conditions");
    expect(() => new Filter({ ...document, id: "" })).toThrow(FilterValidationError);
  });

  test("portable schemas validate serialized filter documents without custom keywords", () => {
    const registry = new Ajv2020({ strict: true });
    registry.addSchema(JSON.parse(JSON.stringify(filterConditionSchema)));
    const validate = registry.compile(JSON.parse(JSON.stringify(filterSchema)));
    expect(validate(document)).toBe(true);
    expect(validate({ ...document, condition: { path: "/subject", op: "eq" } })).toBe(false);
  });
});
