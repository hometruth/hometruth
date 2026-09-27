import { describe, expect, test } from "bun:test";
import type { NodeId, NodeRecord } from "../../state/protocol.ts";
import { BACKOFF_MAX_MS, BACKOFF_MIN_MS, COALESCE_MS, SETTLE_MS, controlRequest, controlUrl, createStateClient, readSeed, streamUrl, type ConnectionState, type RequestInitLike, type ResponseLike, type StreamEvent, type StreamSource } from "./state.ts";
import type { StoredRecord } from "./store.ts";

const AT = "2026-09-14T10:00:00.000Z";
const LATER = "2026-09-14T10:00:05.000Z";

class FakeSource implements StreamSource {
  static instances: FakeSource[] = [];
  readyState = 0;
  closed = false;
  readonly #listeners = new Map<string, ((event: StreamEvent) => void)[]>();

  constructor(readonly url: string) {
    FakeSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: StreamEvent) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  frame(type: string, data: unknown): void {
    this.readyState = 1;
    for (const listener of this.#listeners.get(type) ?? []) listener({ type, data: JSON.stringify(data) });
  }

  hello(nodes: readonly NodeId[], tier = "live", generation = "g1"): void {
    this.frame("hello", { generation, tier, nodes, keepaliveMs: 20_000 });
  }

  /** The browser's own error event: `0` while it retries by itself, `2` once it gave up. */
  fail(readyState: 0 | 2): void {
    this.readyState = readyState;
    for (const listener of this.#listeners.get("error") ?? []) listener({ type: "error" });
  }
}

interface Timer { id: number; fn: () => void; ms: number; cleared: boolean; ran: boolean }

interface Listeners {
  addEventListener(type: string, listener: () => void): void;
  fire(type: string): void;
}

function listeners(): Listeners {
  const map = new Map<string, (() => void)[]>();
  return {
    addEventListener: (type, listener) => { map.set(type, [...(map.get(type) ?? []), listener]); },
    fire: (type) => { for (const listener of map.get(type) ?? []) listener(); },
  };
}

function harness(options: { hidden?: boolean; seed?: NodeRecord[] } = {}) {
  FakeSource.instances = [];
  const timers: Timer[] = [];
  let nextId = 1;
  const fetches: { url: string; init: RequestInitLike | undefined; respond: (response: ResponseLike) => void; reject: (error: Error) => void }[] = [];
  const document = { hidden: options.hidden ?? false, ...listeners() };
  const window = { ...listeners(), ht: { t: (key: string) => `t:${key}` } };
  const states: ConnectionState[] = [];
  const client = createStateClient({
    EventSource: FakeSource,
    fetch: (url, init) => new Promise<ResponseLike>((resolve, reject) => { fetches.push({ url, init, respond: resolve, reject }); }),
    document,
    window,
    setTimeout: (fn, ms) => { const id = nextId++; timers.push({ id, fn, ms, cleared: false, ran: false }); return id; },
    clearTimeout: (id) => { const timer = timers.find((item) => item.id === id); if (timer) timer.cleared = true; },
    ...(options.seed ? { seed: options.seed } : {}),
  });
  client.onConnection((state) => { states.push(state); });
  const pending = () => timers.filter((timer) => !timer.cleared && !timer.ran);
  const run = (ms?: number) => {
    for (const timer of pending()) {
      if (ms !== undefined && timer.ms !== ms) continue;
      timer.ran = true;
      timer.fn();
    }
  };
  const source = () => FakeSource.instances.at(-1)!;
  const ok = (payload: unknown = {}): ResponseLike => ({ ok: true, json: async () => payload });
  const failed = (message: string): ResponseLike => ({ ok: false, json: async () => ({ error: { code: "bad", message } }) });
  return { client, document, window, states, fetches, timers, pending, run, source, ok, failed };
}

const tick = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

function record(node: NodeId, version: number, extra: Partial<NodeRecord> = {}): NodeRecord {
  return { node, version, updatedAt: AT, value: { id: node }, ...extra };
}

describe("controlUrl", () => {
  test.each([
    ["device/shelly", "binarySwitch", "turnOn", "/api/devices/shelly/capabilities/binarySwitch/controls/turnOn"],
    ["device/shelly", "binarySwitch", "getState", "/api/switches/shelly/state"],
    ["device/a b/c", "binarySwitch", "getState", "/api/switches/a%20b%2Fc/state"],
    ["device/lamp", "light", "setBrightness", "/api/devices/lamp/capabilities/light/controls/setBrightness"],
    ["device/tree", "stringLight", "setColorTemperature", "/api/devices/tree/capabilities/stringLight/controls/setColorTemperature"],
    ["device/candles", "button", "press", "/api/devices/candles/capabilities/button/controls/press"],
    ["device/a b/c", "camera", "pan.left", "/api/devices/a%20b%2Fc/capabilities/camera/controls/pan.left"],
    ["group/living", "binarySwitch", "turnOn", "/api/device-groups/living/switch/turn-on"],
    ["group/living", "binarySwitch", "turnOff", "/api/device-groups/living/switch/turn-off"],
    ["group/living", "binarySwitch", "toggle", "/api/device-groups/living/switch/toggle"],
    ["group/living", "binarySwitch", "getState", "/api/device-groups/living/switch"],
    ["group/tv area", "binarySwitch", "toggle", "/api/device-groups/tv%20area/switch/toggle"],
  ] as const)("%s %s %s → %s", (node, capability, controlId, expected) => {
    expect(controlUrl(node, capability, controlId)).toBe(expected);
  });

  test("controlRequest sends JSON for writes and a bodyless GET for switch reads", () => {
    expect(controlRequest("device/a", "binarySwitch", "turnOn")).toEqual({ url: "/api/devices/a/capabilities/binarySwitch/controls/turnOn", method: "POST", body: "{}" });
    expect(controlRequest("device/a", "light", "setBrightness", 40)).toEqual({ url: "/api/devices/a/capabilities/light/controls/setBrightness", method: "POST", body: JSON.stringify({ value: 40 }) });
    expect(controlRequest("device/a", "button", "press", { durationMs: 500 })).toEqual({ url: "/api/devices/a/capabilities/button/controls/press", method: "POST", body: JSON.stringify({ value: { durationMs: 500 } }) });
    expect(controlRequest("group/g", "binarySwitch", "getState")).toEqual({ url: "/api/device-groups/g/switch", method: "GET" });
    expect(controlRequest("device/a", "binarySwitch", "getState")).toEqual({ url: "/api/switches/a/state", method: "GET" });
    expect(controlRequest("group/g", "binarySwitch", "turnOn")).toEqual({ url: "/api/device-groups/g/switch/turn-on", method: "POST", body: "{}" });
  });

  test("streamUrl repeats node and ends with the tier", () => {
    expect(streamUrl(["device/a", "group/b c"], "live")).toBe("/api/state/stream?node=device%2Fa&node=group%2Fb%20c&tier=live");
    expect(streamUrl([], "glance")).toBe("/api/state/stream?tier=glance");
  });

  test("readSeed reads #ht-state and tolerates its absence or garbage", () => {
    const withSeed = { getElementById: (id: string) => id === "ht-state" ? { textContent: JSON.stringify([record("device/a", 1)]) } : null };
    expect(readSeed(withSeed)).toEqual([record("device/a", 1)]);
    expect(readSeed({ getElementById: () => null })).toEqual([]);
    expect(readSeed({ getElementById: () => ({ textContent: "not json" }) })).toEqual([]);
    expect(readSeed({ getElementById: () => ({ textContent: "{}" }) })).toEqual([]);
  });
});

describe("state client stream", () => {
  test("a seeded record is stale, delivered on subscribe, and confirmed by a state frame", () => {
    const h = harness({ seed: [record("device/a", 1, { observedAt: AT })] });
    const seen: StoredRecord[] = [];
    h.client.subscribe("device/a", (item) => { seen.push(item); }, "live");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ version: 1, stale: true });
    expect(h.client.connection).toBe("connecting");
    h.run(COALESCE_MS);
    expect(FakeSource.instances).toHaveLength(1);
    expect(h.source().url).toBe("/api/state/stream?node=device%2Fa&tier=live");
    h.source().hello(["device/a"]);
    expect(h.client.connection).toBe("live");
    h.source().frame("state", record("device/a", 2, { observedAt: LATER }));
    expect(seen.at(-1)).toMatchObject({ version: 2, stale: false });
    expect(h.client.read("device/a")).toMatchObject({ version: 2, stale: false });
  });

  test("subscriptions inside the coalescing window share one stream; live wins over glance", () => {
    const h = harness();
    h.client.subscribe("device/b", () => {}, "glance");
    h.client.subscribe("device/a", () => {}, "live");
    expect(FakeSource.instances).toHaveLength(0);
    expect(h.pending().map((timer) => timer.ms)).toEqual([COALESCE_MS]);
    h.run(COALESCE_MS);
    expect(FakeSource.instances).toHaveLength(1);
    expect(h.source().url).toBe("/api/state/stream?node=device%2Fa&node=device%2Fb&tier=live");
  });

  test("a node set change reopens the stream and keeps live until the new stream errors", () => {
    const h = harness();
    h.client.subscribe("device/a", () => {}, "live");
    h.run(COALESCE_MS);
    const first = h.source();
    first.hello(["device/a"]);
    expect(h.client.connection).toBe("live");
    h.client.subscribe("device/b", () => {}, "live");
    h.run(COALESCE_MS);
    expect(first.closed).toBe(true);
    expect(FakeSource.instances).toHaveLength(2);
    expect(h.source().url).toContain("node=device%2Fa&node=device%2Fb");
    expect(h.client.connection).toBe("live");
    expect(h.states).toEqual(["live"]);
    h.source().fail(0);
    expect(h.client.connection).toBe("disconnected");
    h.source().hello(["device/a", "device/b"]);
    expect(h.client.connection).toBe("live");
  });

  test("frames on a replaced stream are ignored", () => {
    const h = harness();
    const seen: StoredRecord[] = [];
    h.client.subscribe("device/a", (item) => { seen.push(item); }, "live");
    h.run(COALESCE_MS);
    const first = h.source();
    h.client.subscribe("device/b", () => {}, "live");
    h.run(COALESCE_MS);
    first.frame("state", record("device/a", 9));
    expect(seen).toEqual([]);
    h.source().frame("state", record("device/a", 1));
    expect(seen).toHaveLength(1);
  });

  test("an unchanged node set does not reopen", () => {
    const h = harness();
    const release = h.client.subscribe("device/a", () => {}, "live");
    h.run(COALESCE_MS);
    h.client.subscribe("device/a", () => {}, "live");
    release();
    h.run(COALESCE_MS);
    expect(FakeSource.instances).toHaveLength(1);
    expect(h.source().closed).toBe(false);
  });

  test("observed frames refresh observedAt and notify", () => {
    const h = harness();
    const seen: StoredRecord[] = [];
    h.client.subscribe("device/a", (item) => { seen.push(item); }, "live");
    h.run(COALESCE_MS);
    h.source().frame("state", record("device/a", 1, { observedAt: AT }));
    h.source().frame("observed", { "device/a": LATER, "device/unknown": LATER });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ version: 1, observedAt: LATER, stale: false });
  });

  test("when the browser gives up (CLOSED) the client reopens with 2 s → 30 s backoff and resets on hello", () => {
    const h = harness();
    h.client.subscribe("device/a", () => {}, "live");
    h.run(COALESCE_MS);
    let expected = BACKOFF_MIN_MS;
    for (const _ of [1, 2, 3, 4, 5, 6]) {
      const before = FakeSource.instances.length;
      h.source().fail(2);
      expect(h.client.connection).toBe("disconnected");
      const timer = h.pending().find((item) => item.ms !== COALESCE_MS);
      expect(timer?.ms).toBe(expected);
      h.run(timer!.ms);
      expect(FakeSource.instances).toHaveLength(before + 1);
      expected = Math.min(expected * 2, BACKOFF_MAX_MS);
    }
    expect(expected).toBe(BACKOFF_MAX_MS);
    h.source().hello(["device/a"]);
    expect(h.client.connection).toBe("live");
    h.source().fail(2);
    expect(h.pending().find((item) => item.ms !== COALESCE_MS)?.ms).toBe(BACKOFF_MIN_MS);
  });

  test("while the browser retries by itself (CONNECTING) the client marks records stale and waits", () => {
    const h = harness();
    const seen: StoredRecord[] = [];
    h.client.subscribe("device/a", (item) => { seen.push(item); }, "live");
    h.run(COALESCE_MS);
    h.source().hello(["device/a"]);
    h.source().frame("state", record("device/a", 1));
    h.source().fail(0);
    expect(h.client.connection).toBe("disconnected");
    expect(seen.at(-1)?.stale).toBe(true);
    expect(h.pending()).toEqual([]);
    expect(FakeSource.instances).toHaveLength(1);
  });

  test("a too_many_streams frame reads as disconnected without an explicit reopen", () => {
    const h = harness();
    h.client.subscribe("device/a", () => {}, "live");
    h.run(COALESCE_MS);
    h.source().hello(["device/a"]);
    h.source().frame("error", { code: "too_many_streams", message: "full" });
    expect(h.client.connection).toBe("disconnected");
    h.source().fail(0);
    expect(h.pending()).toEqual([]);
  });

  test("hiding the page closes the stream and marks records stale; showing it reopens", () => {
    const h = harness();
    const seen: StoredRecord[] = [];
    h.client.subscribe("device/a", (item) => { seen.push(item); }, "live");
    h.run(COALESCE_MS);
    h.source().hello(["device/a"]);
    h.source().frame("state", record("device/a", 1));
    const first = h.source();
    h.document.hidden = true;
    h.document.fire("visibilitychange");
    expect(first.closed).toBe(true);
    expect(h.client.connection).toBe("hidden");
    expect(seen.at(-1)?.stale).toBe(true);
    h.document.hidden = false;
    h.document.fire("visibilitychange");
    h.run(COALESCE_MS);
    expect(FakeSource.instances).toHaveLength(2);
    expect(h.client.connection).toBe("connecting");
    h.source().hello(["device/a"]);
    expect(h.client.connection).toBe("live");
  });

  test("a client created on a hidden page does not connect until it is shown", () => {
    const h = harness({ hidden: true });
    expect(h.client.connection).toBe("hidden");
    h.client.subscribe("device/a", () => {}, "live");
    h.run(COALESCE_MS);
    expect(FakeSource.instances).toHaveLength(0);
    h.document.hidden = false;
    h.document.fire("visibilitychange");
    h.run(COALESCE_MS);
    expect(FakeSource.instances).toHaveLength(1);
  });

  test("pagehide closes and pageshow reopens", () => {
    const h = harness();
    h.client.subscribe("device/a", () => {}, "live");
    h.run(COALESCE_MS);
    const first = h.source();
    h.window.fire("pagehide");
    expect(first.closed).toBe(true);
    expect(h.client.connection).toBe("hidden");
    h.window.fire("pageshow");
    h.run(COALESCE_MS);
    expect(FakeSource.instances).toHaveLength(2);
  });

  test("releasing the last subscriber keeps one node-less stream", () => {
    const h = harness();
    const release = h.client.subscribe("device/a", () => {}, "live");
    h.run(COALESCE_MS);
    const first = h.source();
    first.hello(["device/a"]);
    release();
    h.run(COALESCE_MS);
    expect(first.closed).toBe(true);
    expect(FakeSource.instances).toHaveLength(2);
    expect(h.source().url).toBe("/api/state/stream?tier=glance");
    expect(h.client.connection).toBe("live");
  });

  test("a page with no elements still holds one stream and learns the worker generation", () => {
    const h = harness();
    expect(h.client.generation).toBeUndefined();
    h.run(COALESCE_MS);
    expect(FakeSource.instances).toHaveLength(1);
    expect(h.source().url).toBe("/api/state/stream?tier=glance");
    h.source().hello([], "glance", "session-1");
    expect(h.client.generation).toBe("session-1");
    expect(h.states).toEqual(["live"]);
  });

  test("a hello from a new worker generation notifies even while live", () => {
    const h = harness();
    h.run(COALESCE_MS);
    h.source().hello([], "glance", "session-1");
    h.client.subscribe("device/a", () => {}, "live");
    h.run(COALESCE_MS);
    h.source().hello(["device/a"], "live", "session-1");
    expect(h.states).toEqual(["live"]);
    h.source().hello(["device/a"], "live", "session-2");
    expect(h.client.generation).toBe("session-2");
    expect(h.states).toEqual(["live", "live"]);
  });

  test("close() stops everything", () => {
    const h = harness();
    h.client.subscribe("device/a", () => {}, "live");
    h.run(COALESCE_MS);
    h.client.close();
    expect(h.source().closed).toBe(true);
    h.client.subscribe("device/b", () => {}, "live");
    h.run(COALESCE_MS);
    expect(FakeSource.instances).toHaveLength(1);
  });
});

describe("state client invoke", () => {
  test("POSTs JSON through the capability route and resolves once the node's frame landed and the response is in", async () => {
    const h = harness();
    h.client.subscribe("device/a", () => {}, "live");
    h.run(COALESCE_MS);
    let done = false;
    const promise = h.client.invoke("device/a", "binarySwitch", "turnOn").then(() => { done = true; });
    expect(h.fetches).toHaveLength(1);
    expect(h.fetches[0]).toMatchObject({ url: "/api/devices/a/capabilities/binarySwitch/controls/turnOn", init: { method: "POST", body: "{}", cache: "no-store", credentials: "same-origin", headers: { accept: "application/json", "content-type": "application/json" } } });
    h.source().frame("state", record("device/a", 2));
    await tick();
    expect(done).toBe(false);
    h.fetches[0]!.respond(h.ok({ id: "a" }));
    await promise;
    expect(done).toBe(true);
    expect(h.pending().filter((timer) => timer.ms === SETTLE_MS)).toEqual([]);
  });

  test("a value travels as { value }", async () => {
    const h = harness();
    void h.client.invoke("device/lamp", "light", "setBrightness", 40);
    await tick();
    expect(h.fetches[0]?.init?.body).toBe(JSON.stringify({ value: 40 }));
  });

  test("a group's getState is a GET without a body", async () => {
    const h = harness();
    void h.client.invoke("group/g", "binarySwitch", "getState");
    await tick();
    expect(h.fetches[0]).toMatchObject({ url: "/api/device-groups/g/switch", init: { method: "GET" } });
    expect(h.fetches[0]?.init?.body).toBeUndefined();
    expect(h.fetches[0]?.init?.headers).toEqual({ accept: "application/json" });
  });

  test("refreshing a device switch reads its state without posting a control", async () => {
    const h = harness();
    void h.client.invoke("device/a", "binarySwitch", "getState");
    await tick();
    expect(h.fetches[0]).toMatchObject({ url: "/api/switches/a/state", init: { method: "GET", cache: "no-store" } });
    expect(h.fetches[0]?.init?.body).toBeUndefined();
    expect(h.fetches[0]?.init?.headers).toEqual({ accept: "application/json" });
  });

  test("without a frame the promise resolves 2 s after the response", async () => {
    const h = harness();
    let done = false;
    const promise = h.client.invoke("device/a", "binarySwitch", "turnOn").then(() => { done = true; });
    h.fetches[0]!.respond(h.ok());
    await tick();
    expect(done).toBe(false);
    const timer = h.pending().find((item) => item.ms === SETTLE_MS);
    expect(timer).toBeDefined();
    h.run(SETTLE_MS);
    await promise;
    expect(done).toBe(true);
  });

  test("a frame after the response resolves early and clears the settle timer", async () => {
    const h = harness();
    h.client.subscribe("device/a", () => {}, "live");
    h.run(COALESCE_MS);
    let done = false;
    const promise = h.client.invoke("device/a", "binarySwitch", "turnOn").then(() => { done = true; });
    h.fetches[0]!.respond(h.ok());
    await tick();
    const timer = h.pending().find((item) => item.ms === SETTLE_MS)!;
    h.source().frame("observed", { "device/a": LATER });
    await promise;
    expect(done).toBe(true);
    expect(timer.cleared).toBe(true);
  });

  test("a frame for another node does not settle the command", async () => {
    const h = harness();
    h.client.subscribe("device/a", () => {}, "live");
    h.client.subscribe("device/b", () => {}, "live");
    h.run(COALESCE_MS);
    let done = false;
    void h.client.invoke("device/a", "binarySwitch", "turnOn").then(() => { done = true; });
    h.fetches[0]!.respond(h.ok());
    await tick();
    h.source().frame("state", record("device/b", 2));
    await tick();
    expect(done).toBe(false);
  });

  test("an error response rejects with the API's message, and the fallback is the catalog's", async () => {
    const h = harness();
    const promise = h.client.invoke("device/a", "binarySwitch", "turnOn");
    h.fetches[0]!.respond(h.failed("Shelly did not answer at 10.77.0.228"));
    await expect(promise).rejects.toThrow("Shelly did not answer at 10.77.0.228");
    const bare = h.client.invoke("device/a", "binarySwitch", "turnOn");
    h.fetches[1]!.respond({ ok: false, json: async () => { throw new Error("not json"); } });
    await expect(bare).rejects.toThrow("t:feedback.requestFailed");
    expect(h.pending().filter((timer) => timer.ms === SETTLE_MS)).toEqual([]);
  });

  test("a network failure rejects with the fetch error", async () => {
    const h = harness();
    const promise = h.client.invoke("device/a", "binarySwitch", "turnOn");
    h.fetches[0]!.reject(new Error("Failed to fetch"));
    await expect(promise).rejects.toThrow("Failed to fetch");
  });
});
