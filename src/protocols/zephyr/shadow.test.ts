import { describe, expect, test } from "bun:test";
import { delta, emptyShadow, parseTopic, shadowRequest, type ShadowRecord } from "./shadow";
const prefix = "$aws/things/RangeHood_test/shadow";
function request(record: ShadowRecord, operation: string, payload: unknown = undefined, at = 1000) {
  return shadowRequest(record, `${prefix}/${operation}`, Buffer.from(payload === undefined ? "" : JSON.stringify(payload)), at);
}

describe("Zephyr classic shadow contract", () => {
  test("starts missing instead of fabricating a hood state", () => {
    const result = request(emptyShadow(), "get");
    expect(result.accepted).toBe(false);
    expect(result.messages[0]?.body.code).toBe(404);
  });
  test("accepts partial reports, persists a full document, correlates tokens", () => {
    const first = request(emptyShadow(), "update", { state: { reported: { fan: 1, light: 0 } }, clientToken: "a" });
    const second = request(first.record, "update", { state: { reported: { light: 2 } }, clientToken: "b", version: 1 }, 1005);
    expect(second.messages[0]?.body).toEqual({ state: { reported: { light: 2 } }, metadata: { reported: { light: { timestamp: 1005 } } }, version: 2, timestamp: 1005, clientToken: "b" });
    expect(second.record.document?.state.reported).toEqual({ fan: 1, light: 2 });
    expect(second.record.document?.metadata.reported).toEqual({ fan: { timestamp: 1000 }, light: { timestamp: 1005 } });
    expect(second.messages.at(-1)?.topic).toBe(`${prefix}/update/documents`);
    expect(first.record.document?.state.reported).toEqual({ fan: 1, light: 0 });
  });
  test("merges nested state, deletes nulls, replaces arrays and metadata types", () => {
    const first = request(emptyShadow(), "update", { state: { reported: { lamp: { a: 1, b: 2 }, modes: [1, 2], value: 2 } } });
    const second = request(first.record, "update", { state: { reported: { lamp: 3, modes: [3], value: { x: 2 } } } }, 1001);
    expect(second.record.document?.metadata.reported).toEqual({ lamp: { timestamp: 1001 }, modes: { timestamp: 1001 }, value: { x: { timestamp: 1001 } } });
    const third = request(second.record, "update", { state: { reported: { lamp: null, value: { x: null } } } });
    expect(third.record.document?.state.reported).toEqual({ modes: [3], value: {} });
    expect(request(third.record, "update", { state: { reported: null } }).record.document?.state).toEqual({});
  });
  test("full outstanding delta, nested comparisons, atomic arrays and metadata", () => {
    const first = request(emptyShadow(), "update", { state: { desired: { fan: 2, lamp: { r: 1, b: 2 }, modes: [1, 2] }, reported: { fan: 1, lamp: { r: 1, b: 0 }, modes: [1] } } });
    const second = request(first.record, "update", { state: { reported: { fan: 2 } } }, 1002);
    const difference = second.messages.find(m => m.topic.endsWith("/delta"))!;
    expect(difference.body.state).toEqual({ lamp: { b: 2 }, modes: [1, 2] });
    expect(difference.body.metadata).toEqual({ lamp: { b: { timestamp: 1000 } }, modes: { timestamp: 1000 } });
    expect(request(second.record, "get").messages[0]?.body.state).toMatchObject({ delta: { lamp: { b: 2 }, modes: [1, 2] } });
    expect(delta({ object: { a: 1, b: 2 } }, { object: { b: 2, a: 1 } })).toEqual({});
  });
  test("version conflict does not change state", () => {
    const first = request(emptyShadow(), "update", { state: { reported: { fan: 1 } } });
    const rejected = request(first.record, "update", { state: { reported: { fan: 3 } }, version: 0, clientToken: "retry" });
    expect(rejected.messages[0]?.body).toMatchObject({ code: 409, clientToken: "retry" });
    expect(rejected.record).toEqual(first.record);
  });
  test("delete ignores its payload and preserves version for 48 hours", () => {
    const first = request(emptyShadow(), "update", { state: {} });
    const deleted = shadowRequest(first.record, `${prefix}/delete`, Buffer.from("not json"), 1002);
    expect(deleted.accepted).toBe(true);
    expect(request(deleted.record, "get").messages[0]?.body.code).toBe(404);
    expect(request(deleted.record, "update", { state: {} }, 1003).record.version).toBe(2);
    expect(request(deleted.record, "update", { state: {} }, 173802).record.version).toBe(1);
  });
  test.each([
    [{}, 400], [{ state: [] }, 400], [{ state: { reported: 3 } }, 400],
    [{ state: { other: {} } }, 400], [{ state: {}, clientToken: "é".repeat(33) }, 400],
    [{ state: {}, version: -1 }, 400], [{ state: { reported: { array: [null] } } }, 400],
    [{ state: { reported: { big: "x".repeat(8192) } } }, 413],
    [JSON.parse('{"state":{"reported":{"__proto__":{"polluted":true}}}}'), 400],
    [{ state: { reported: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } } } }, 400],
  ])("rejects invalid state %#", (payload, code) => {
    const result = request(emptyShadow(), "update", payload);
    expect(result.accepted).toBe(false);
    expect(result.messages[0]?.body.code).toBe(code);
    expect(result.record).toEqual(emptyShadow());
  });
  test("rejects malformed UTF-8, bad JSON, oversized envelopes and topic wildcards", () => {
    for (const payload of [Buffer.from([0xff]), Buffer.from("{")]) expect(shadowRequest(emptyShadow(), `${prefix}/update`, payload, 1).messages[0]?.body.code).toBe(400);
    expect(shadowRequest(emptyShadow(), `${prefix}/update`, Buffer.alloc(16385), 1).messages[0]?.body.code).toBe(413);
    expect(parseTopic("$aws/things/+/shadow/update")).toBeUndefined();
    expect(parseTopic("$aws/things/a/shadow/name/b/update")?.suffix).toBe("name/b/update");
    expect(() => request(emptyShadow(), "name/b/update", { state: {} })).toThrow("Unsupported");
  });
});
