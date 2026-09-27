import { describe, expect, test } from "bun:test";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { BinarySwitch, type BinarySwitchState } from "../models/binary-switch";
import { Device, type DeviceIdentity } from "../models/device";
import type { HomeTruthObject } from "../schemas";
import { Site } from "../site";
import { StateHub, type StateHubOptions } from "../state/hub";
import type { ObserverTimers } from "../state/observer";
import { deviceNode, STREAM_LIMITS } from "../state/protocol";
import { Hono } from "hono";
import type { AppEnvironment } from "./http";
import { stateRoutes } from "./state-routes";
import { SseFrameReader } from "./test-sse";

class MemorySwitch extends BinarySwitch {
  constructor(id: string, private state: BinarySwitchState = "off") { super(id); }
  async turnOn() { this.state = "on"; }
  async turnOff() { this.state = "off"; }
  async toggle() { this.state = this.state === "on" ? "off" : "on"; }
  async getState() { return this.state; }
}

class SwitchDevice extends Device<{ host: string }> {
  readonly model = SHELLY_PLUS_1;
  readonly capabilities;
  constructor(id: string, name: string) {
    super(id, name, { host: "10.77.0.2" });
    this.capabilities = { binarySwitch: new MemorySwitch(id) };
  }
  async probe(): Promise<DeviceIdentity> { return {}; }
}

/** Timers the test fires by hand: the observer never polls and the keepalive never ticks unless asked. */
class RecordingTimers implements ObserverTimers {
  readonly armed: { id: number; fn: () => void; ms: number }[] = [];
  #next = 1;
  set(fn: () => void, ms: number): unknown {
    const id = this.#next++;
    this.armed.push({ id, fn, ms });
    return id;
  }
  clear(handle: unknown): void {
    const index = this.armed.findIndex((timer) => timer.id === handle);
    if (index >= 0) this.armed.splice(index, 1);
  }
  /** Run a timer the way the clock would: it leaves the armed list first. */
  fire(timer: { id: number; fn: () => void }): void {
    this.clear(timer.id);
    timer.fn();
  }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function object(id: string, name: string, extra: Partial<HomeTruthObject> = {}): HomeTruthObject {
  return { schemaVersion: 1, health: { status: "unknown", detail: "Not checked yet", checkedAt: null }, id, name, status: "online", manufacturer: "Shelly", model: "Plus 1", capabilities: {}, ...extra };
}

function fixture(options: StateHubOptions = {}) {
  const site = new Site([new SwitchDevice("relay", "Porch relay"), new SwitchDevice("lamp", "Lamp")]);
  const timers = new RecordingTimers();
  const hub = new StateHub({ generation: "g1", timers, random: () => 0.5, ...options });
  hub.bind({ site, describe: (device) => device.describe(), describeGroup: async () => undefined, describeAutomation: async () => undefined });
  // The route alone: createApp binds and mounts its own hub, and this test drives an injected one with fake timers.
  const app = new Hono<AppEnvironment>();
  app.route("/", stateRoutes(hub, { timers }));
  const open = (query: string, init: RequestInit = {}) => app.request(`/api/state/stream${query}`, init);
  return { site, hub, app, timers, open };
}

const RELAY = deviceNode("relay");
const LAMP = deviceNode("lamp");

describe("GET /api/state/stream", () => {
  test("says hello with the generation, tier and nodes, then the snapshot in request order", async () => {
    const { hub, open } = fixture();
    hub.observer.publish("lamp", object("lamp", "Lamp"));
    hub.observer.publish("relay", object("relay", "Porch relay"));
    const response = await open("?node=device/relay&node=device/lamp&node=device/unknown&tier=live");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = new SseFrameReader(response);
    const frames = await reader.next(3);
    await reader.close();
    expect(frames[0]).toEqual({ event: "hello", data: { generation: "g1", tier: "live", nodes: ["device/relay", "device/lamp", "device/unknown"], keepaliveMs: STREAM_LIMITS.keepaliveMs } });
    expect(frames.slice(1).map((frame) => [frame.event, (frame.data as { node: string; version: number }).node])).toEqual([["state", "device/relay"], ["state", "device/lamp"]]);
  });

  test("a request naming no nodes is a node-less stream that still says hello", async () => {
    const { open } = fixture();
    const response = await open("");
    expect(response.status).toBe(200);
    const reader = new SseFrameReader(response);
    const frames = await reader.next(1);
    await reader.close();
    expect(frames[0]).toEqual({ event: "hello", data: { generation: "g1", tier: "glance", nodes: [], keepaliveMs: STREAM_LIMITS.keepaliveMs } });
  });

  test("retains every node at the requested tier and the observer reads it", async () => {
    const { hub, open, timers } = fixture();
    const response = await open("?node=device/relay&tier=live");
    const reader = new SseFrameReader(response);
    await reader.next(1);
    expect(hub.observer.isRetained(RELAY)).toBe(true);
    expect(hub.graph.isRetained(RELAY)).toBe(true);
    const read = timers.armed.find((timer) => timer.ms <= 250);
    expect(read).toBeDefined();
    timers.fire(read!);
    const [frame] = await reader.next(1);
    await reader.close();
    expect(frame).toMatchObject({ event: "state", data: { node: RELAY, version: 1, value: { id: "relay", capabilities: { binarySwitch: { state: { value: "off" } } } } } });
  });

  test("sends exactly one state frame per changed node per flush", async () => {
    const { hub, open } = fixture();
    const response = await open("?node=device/relay");
    const reader = new SseFrameReader(response);
    expect(await reader.next(1)).toHaveLength(1);
    hub.observer.publish("relay", object("relay", "Porch relay", { status: "online" }));
    hub.observer.publish("relay", object("relay", "Porch relay", { status: "offline" }));
    hub.observer.publish("relay", object("relay", "Porch relay", { status: "degraded" }));
    const [burst] = await reader.next(1);
    expect(burst).toEqual({ event: "state", data: expect.objectContaining({ node: RELAY, version: 3, value: expect.objectContaining({ status: "degraded" }) }) });
    // A later change must be the very next frame: nothing from the burst was queued behind it.
    hub.observer.publish("relay", object("relay", "Porch relay", { status: "unknown" }));
    const [next] = await reader.next(1);
    await reader.close();
    expect(next).toEqual({ event: "state", data: expect.objectContaining({ node: RELAY, version: 4 }) });
  });

  test("reports an unchanged poll as an observed frame, not a state frame", async () => {
    const { hub, open } = fixture();
    hub.observer.publish("relay", object("relay", "Porch relay"));
    const response = await open("?node=device/relay&node=device/lamp");
    const reader = new SseFrameReader(response);
    expect(await reader.next(2)).toHaveLength(2);
    await settle();
    hub.observer.publish("relay", object("relay", "Porch relay"));
    const frames = await reader.next(1);
    await reader.close();
    const observedAt = hub.graph.read(RELAY)!.observedAt!;
    expect(frames).toEqual([{ event: "observed", data: { [RELAY]: observedAt } }]);
  });

  test("answers 400 for a malformed request", async () => {
    const { open } = fixture();
    for (const query of ["?node=relay", "?node=device/relay&tier=fast"]) {
      const response = await open(query);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
    const many = Array.from({ length: STREAM_LIMITS.maxNodes + 1 }, (_, index) => `node=device/d${index}`).join("&");
    expect((await open(`?${many}`)).status).toBe(400);
  });

  test("over capacity still answers 200: a long retry, hello, an error frame, then the end", async () => {
    const { hub, open } = fixture({ limits: { maxStreams: 1, maxNodes: STREAM_LIMITS.maxNodes } });
    const first = await open("?node=device/relay");
    const reader = new SseFrameReader(first);
    await reader.next(1);
    expect(hub.streams.count).toBe(1);

    const second = await open("?node=device/lamp&tier=live");
    expect(second.status).toBe(200);
    expect(second.headers.get("content-type")).toBe("text/event-stream");
    const body = await second.text();
    expect(body.startsWith(`retry: ${STREAM_LIMITS.retryWhenFullMs}\n\n`)).toBe(true);
    expect(body).toContain('event: hello\ndata: {"generation":"g1","tier":"live","nodes":["device/lamp"]');
    expect(body).toContain('event: error\ndata: {"code":"too_many_streams"');
    expect(hub.streams.count).toBe(1);
    expect(hub.observer.isRetained(LAMP)).toBe(false);
    await reader.close();
    await settle();
    expect(hub.streams.count).toBe(0);
  });

  test("aborting the request releases the nodes so the observer stops", async () => {
    const { hub, open, timers } = fixture();
    const controller = new AbortController();
    const response = await open("?node=device/relay&node=device/lamp", { signal: controller.signal });
    const reader = new SseFrameReader(response);
    await reader.next(1);
    expect(hub.observer.isRetained(RELAY)).toBe(true);
    expect(timers.armed.some((timer) => timer.ms === STREAM_LIMITS.keepaliveMs)).toBe(true);

    controller.abort();
    await settle();
    expect(hub.streams.count).toBe(0);
    expect(hub.observer.isRetained(RELAY)).toBe(false);
    expect(hub.observer.isRetained(LAMP)).toBe(false);
    expect(hub.graph.isRetained(RELAY)).toBe(false);
    expect(timers.armed).toEqual([]);
  });

  test("cancelling the body releases the nodes too", async () => {
    const { hub, open } = fixture();
    const response = await open("?node=device/relay");
    const reader = new SseFrameReader(response);
    await reader.next(1);
    await reader.close();
    await settle();
    expect(hub.streams.count).toBe(0);
    expect(hub.observer.isRetained(RELAY)).toBe(false);
  });

  test("keeps the connection warm with a comment on the injected timer and ends it when the hub closes streams", async () => {
    const { hub, open, timers } = fixture();
    const response = await open("?node=device/relay");
    const body = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const read = async (until: (text: string) => boolean) => {
      while (!until(text)) {
        const { value, done } = await body.read();
        if (done) return false;
        text += decoder.decode(value, { stream: true });
      }
      return true;
    };
    expect(await read((seen) => seen.includes("event: hello"))).toBe(true);
    expect(text.startsWith(`retry: ${STREAM_LIMITS.retryMs}\n\n`)).toBe(true);
    const keepalive = timers.armed.find((timer) => timer.ms === STREAM_LIMITS.keepaliveMs)!;
    timers.fire(keepalive);
    expect(await read((seen) => seen.includes(": keepalive\n\n"))).toBe(true);
    expect(timers.armed.filter((timer) => timer.ms === STREAM_LIMITS.keepaliveMs)).toHaveLength(1);

    hub.streams.closeAll();
    expect(await read(() => false)).toBe(false);
    expect(hub.observer.isRetained(RELAY)).toBe(false);
  });
});

test("snapshot returns all cached records or a selected subset without describing anything", async () => {
  const { app, hub } = fixture();
  hub.observer.publish("relay", object("relay", "Relay"));
  hub.observer.publish("lamp", object("lamp", "Lamp"));
  const all = await (await app.request("/api/state")).json();
  expect(all.records.map((record: { node: string }) => record.node)).toEqual(["device/relay", "device/lamp"]);
  const one = await (await app.request("/api/state?node=device%2Flamp")).json();
  expect(one.records.map((record: { node: string }) => record.node)).toEqual(["device/lamp"]);
  expect((await app.request("/api/state?node=bad")).status).toBe(400);
  hub.stop();
});

test("a full snapshot filters device, group and automation records through the caller's scope", async () => {
  const { Principal } = await import("../auth/scope");
  const hub = new StateHub();
  const site = { deviceGroups: [{ id: "allowed", name: "Allowed", members: ["relay"] }, { id: "mixed", name: "Mixed", members: ["relay", "lamp"] }], automaticGroupMembers: () => ["relay"] };
  const principal = new Principal({ kid: "test", name: "Scoped reader", createdAt: new Date().toISOString(), permissions: ["read"], subject: { group: "allowed" } }, site);
  const app = new Hono<AppEnvironment>();
  app.use("*", async (context, next) => { context.set("principal", principal); await next(); });
  app.route("/", stateRoutes(hub, { groupMembers: id => site.deviceGroups.find(group => group.id === id)?.members }));
  for (const node of ["device/relay", "device/lamp", "group/allowed", "group/mixed", "group/deleted", "automation/private"] as const) hub.graph.publish(node, { value: { test: node } });
  const snapshot = await (await app.request("/api/state")).json();
  expect(snapshot.records.map((record: { node: string }) => record.node)).toEqual(["device/relay", "group/allowed"]);
  hub.stop();
});
