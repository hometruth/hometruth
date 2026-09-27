import { describe, expect, test } from "bun:test";
import type { NodeRecord, StreamFrame, StreamHello } from "./protocol";
import { stateValidators } from "./schemas";
import { encodeFrame, KEEPALIVE_COMMENT, parseStreamRequest, retryLine, Streams } from "./stream";

const url = (query: string) => new URL(`http://hometruth.local/api/state/stream${query}`);

describe("parseStreamRequest", () => {
  test("collects node ids in request order, once each, and defaults the tier to glance", () => {
    const parsed = parseStreamRequest(url("?node=device/relay&node=group/lamps&node=device/relay"));
    expect(parsed).toEqual({ ok: true, nodes: ["device/relay", "group/lamps"], tier: "glance" });
  });

  test("reads the tier", () => {
    expect(parseStreamRequest(url("?node=device/relay&tier=live"))).toMatchObject({ ok: true, tier: "live" });
    expect(parseStreamRequest(url("?node=device/relay&tier=fast"))).toMatchObject({ ok: false, code: "invalid_tier" });
  });

  test("rejects malformed ids and too many nodes; an empty request is a node-less stream", () => {
    expect(parseStreamRequest(url("?node=relay"))).toMatchObject({ ok: false, code: "invalid_node", message: '"relay" is not a node id; use device/<id> or group/<id>' });
    expect(parseStreamRequest(url("?node=device/../etc"))).toMatchObject({ ok: false, code: "invalid_node" });
    expect(parseStreamRequest(url(""))).toEqual({ ok: true, nodes: [], tier: "glance" });
    const many = Array.from({ length: 3 }, (_, index) => `node=device/d${index}`).join("&");
    expect(parseStreamRequest(url(`?${many}`), { maxNodes: 2 })).toMatchObject({ ok: false, code: "too_many_nodes" });
    expect(parseStreamRequest(url(`?${many}`), { maxNodes: 3 })).toMatchObject({ ok: true });
  });
});

describe("encodeFrame", () => {
  const hello: StreamHello = { generation: "g1", tier: "live", nodes: ["device/relay"], keepaliveMs: 20_000 };
  const record: NodeRecord = { node: "device/relay", version: 2, value: { on: true }, fault: { code: "timeout", message: "Relay did not answer." }, observedAt: "2026-09-14T12:00:00.000Z", updatedAt: "2026-09-14T12:00:05.000Z" };
  const frames: StreamFrame[] = [
    { event: "hello", data: hello },
    { event: "state", data: record },
    { event: "observed", data: { "device/relay": "2026-09-14T12:00:10.000Z" } },
    { event: "error", data: { code: "too_many_streams", message: "This server already serves 64 streams" } },
  ];

  test("spells each frame as one SSE event whose data round-trips", () => {
    for (const frame of frames) {
      const wire = encodeFrame(frame);
      expect(wire).toBe(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);
      expect(JSON.parse(wire.split("\ndata: ")[1]!.trimEnd())).toEqual(frame.data);
    }
    expect(retryLine(2_000)).toBe("retry: 2000\n\n");
    expect(KEEPALIVE_COMMENT).toBe(": keepalive\n\n");
  });

  test("validates every frame under test", () => {
    expect(stateValidators.streamHello(hello)).toBe(true);
    expect(stateValidators.nodeRecord(record)).toBe(true);
    expect(stateValidators.nodeRecord({ node: "device/relay", version: 0, updatedAt: "2026-09-14T12:00:00.000Z" })).toBe(true);
    expect(stateValidators.nodeRecord({ node: "relay", version: 0, updatedAt: "2026-09-14T12:00:00.000Z" })).toBe(false);
    expect(stateValidators.streamObserved({})).toBe(false);
    expect(() => encodeFrame({ event: "hello", data: { tier: "live", nodes: [], keepaliveMs: 20_000 } as unknown as StreamHello })).toThrow(/Invalid hello frame/u);
    expect(() => encodeFrame({ event: "state", data: { ...record, fault: { code: "gone", message: "x" } } as unknown as NodeRecord })).toThrow(/Invalid state frame/u);
  });
});

describe("Streams", () => {
  test("caps open connections and frees a slot on close", () => {
    const streams = new Streams({ maxStreams: 2 });
    const closed: number[] = [];
    const one = streams.open(() => closed.push(1));
    const two = streams.open(() => closed.push(2));
    expect(one && two).toBeTruthy();
    expect(streams.open(() => closed.push(3))).toBeUndefined();
    expect(streams.count).toBe(2);
    one!.close();
    one!.close();
    expect(closed).toEqual([1]);
    expect(streams.count).toBe(1);
    expect(streams.open(() => closed.push(3))).toBeDefined();
  });

  test("closeAll runs every close callback once", () => {
    const streams = new Streams({ maxStreams: 8 });
    const closed: number[] = [];
    const handles = [1, 2, 3].map((id) => streams.open(() => closed.push(id))!);
    streams.closeAll();
    for (const handle of handles) handle.close();
    expect(closed).toEqual([1, 2, 3]);
    expect(streams.count).toBe(0);
  });
});
