import { describe, expect, test } from "bun:test";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { BinarySwitch, type BinarySwitchState } from "../models/binary-switch";
import { Button, type ButtonPressOptions } from "../models/button";
import { Device, type DeviceIdentity, type DeviceModel } from "../models/device";
import { buttonSchema, cameraSchema, type HomeTruthObject } from "../schemas";
import { Site } from "../site";
import { Graph } from "./graph";
import { FLOORS_MS, Observer, readFault, TIER_MS, type ObserverBinding, type ObserverTimers } from "./observer";
import { deviceNode, groupNode, type GroupSwitch, type NodeId } from "./protocol";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Timers and a clock the test drives; each due timer runs and the reads it starts settle before the next fires. */
class FakeTimers implements ObserverTimers {
  readonly base = Date.parse("2026-09-14T12:00:00.000Z");
  #elapsed = 0;
  #next = 1;
  readonly #pending = new Map<number, { at: number; fn: () => void }>();
  readonly now = (): Date => new Date(this.base + this.#elapsed);
  get elapsed(): number { return this.#elapsed; }
  get pending(): number { return this.#pending.size; }
  set(fn: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#pending.set(id, { at: this.#elapsed + ms, fn });
    return id;
  }
  clear(handle: unknown): void {
    if (typeof handle === "number") this.#pending.delete(handle);
  }
  async advance(ms: number): Promise<void> {
    const end = this.#elapsed + ms;
    for (;;) {
      let nextId: number | undefined;
      let nextAt = Infinity;
      for (const [id, timer] of this.#pending) if (timer.at < nextAt) { nextAt = timer.at; nextId = id; }
      if (nextId === undefined || nextAt > end) break;
      const timer = this.#pending.get(nextId)!;
      this.#pending.delete(nextId);
      this.#elapsed = nextAt;
      timer.fn();
      await settle();
    }
    this.#elapsed = end;
  }
}

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

const CAMERA_MODEL: DeviceModel<{ host: string }> = {
  id: "test-camera",
  title: "Test camera",
  manufacturer: "HomeTruth",
  product: "Test camera",
  capabilities: ["camera", "treatDispenser"],
  connectionTypes: ["direct-local"],
  configSchema: { $id: "https://hometruth.local/test/camera-config", type: "object" },
  objectSchemaId: cameraSchema.$id,
  create() { throw new Error("not used"); },
};

class CameraDevice extends Device<{ host: string }> {
  readonly model = CAMERA_MODEL;
  readonly capabilities = {};
  constructor(id: string) { super(id, "Kitchen camera", { host: "10.78.0.147" }); }
  async probe(): Promise<DeviceIdentity> { return {}; }
}

/** A composite the site links to its members the way light-group / synthetic-switch are linked. */
function compositeModel(id: "synthetic-switch" | "light-group"): DeviceModel<{ members: string[] }> {
  return {
    id,
    title: id,
    manufacturer: "HomeTruth",
    product: id,
    capabilities: ["binarySwitch"],
    connectionTypes: ["direct-local"],
    configSchema: { $id: `https://hometruth.local/test/${id}-config`, type: "object" },
    objectSchemaId: SHELLY_PLUS_1.objectSchemaId,
    create() { throw new Error("not used"); },
  };
}

class CompositeDevice extends Device<{ members: string[] }> {
  readonly capabilities;
  constructor(readonly model: DeviceModel<{ members: string[] }>, id: string, members: string[]) {
    super(id, id, { members });
    this.capabilities = { binarySwitch: new MemorySwitch(id) };
  }
  async probe(): Promise<DeviceIdentity> { return {}; }
}

const BUTTON_MODEL: DeviceModel<Record<string, never>> = {
  id: "test-button",
  title: "Test button",
  manufacturer: "HomeTruth",
  product: "Test button",
  capabilities: ["button"],
  connectionTypes: ["direct-local"],
  configSchema: { $id: "https://hometruth.local/test/button-config", type: "object" },
  objectSchemaId: buttonSchema.$id,
  create() { throw new Error("not used"); },
};

class TestButton extends Button {
  protected async performPress(_options: ButtonPressOptions): Promise<void> {}
}

class ButtonDevice extends Device<Record<string, never>> {
  readonly model = BUTTON_MODEL;
  readonly capabilities;
  constructor(id: string) {
    super(id, id, {});
    this.capabilities = { button: new TestButton(id) };
  }
  async probe(): Promise<DeviceIdentity> { return {}; }
}

const PUSH_MODEL: DeviceModel<Record<string, never>> = {
  id: "test-push",
  title: "Test push device",
  manufacturer: "HomeTruth",
  product: "Test push device",
  capabilities: ["binarySwitch"],
  connectionTypes: ["local-hub"],
  configSchema: { $id: "https://hometruth.local/test/push-config", type: "object" },
  objectSchemaId: SHELLY_PLUS_1.objectSchemaId,
  create() { throw new Error("not used"); },
};

/** Stands in for a Matter-backed hub: it reports a change instead of waiting to be polled. */
class PushDevice extends Device<Record<string, never>> {
  readonly model = PUSH_MODEL;
  readonly capabilities;
  readonly listeners = new Set<() => void>();
  constructor(id: string) {
    super(id, id, {});
    this.capabilities = { binarySwitch: new MemorySwitch(id) };
  }
  override watch(onChange: () => void): () => void {
    this.listeners.add(onChange);
    return () => { this.listeners.delete(onChange); };
  }
  /** A report arriving from the device. */
  report(): void { for (const listener of [...this.listeners]) listener(); }
  async probe(): Promise<DeviceIdentity> { return {}; }
}

/** A `Site` whose devices can be swapped underneath, like the live site proxy does on a config reload. */
function liveSite(initial: Site): { site: Site; swap(next: Site): void } {
  let current = initial;
  const site = new Proxy({} as Site, {
    get(_target, property) {
      const value = Reflect.get(current, property, current) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(current) : value;
    },
  });
  return { site, swap: (next) => { current = next; } };
}

function objectFor(device: Device): HomeTruthObject {
  return { schemaVersion: 1, health: { status: "unknown", detail: "Not checked yet", checkedAt: null }, id: device.id, name: device.name, status: "online", manufacturer: "HomeTruth", model: device.model.product, capabilities: {} };
}

interface Harness {
  timers: FakeTimers;
  graph: Graph;
  observer: Observer;
  reads: string[];
  failing: Map<string, string>;
  hanging: Map<string, (object: HomeTruthObject) => void>;
  groups: Map<string, GroupSwitch>;
  binding: ObserverBinding;
}

function harness(site: Site, options: { random?: () => number; concurrency?: number } = {}): Harness {
  const timers = new FakeTimers();
  const graph = new Graph({ now: timers.now });
  const observer = new Observer(graph, { now: timers.now, timers, random: options.random ?? (() => 0.5), ...(options.concurrency ? { concurrency: options.concurrency } : {}) });
  const reads: string[] = [];
  const failing = new Map<string, string>();
  const hanging = new Map<string, (object: HomeTruthObject) => void>();
  const groups = new Map<string, GroupSwitch>();
  const binding: ObserverBinding = {
    site,
    async describe(device) {
      reads.push(device.id);
      const reason = failing.get(device.id);
      if (reason !== undefined) throw new Error(reason);
      if (hanging.has(device.id)) return await new Promise<HomeTruthObject>((resolve) => hanging.set(device.id, resolve));
      return objectFor(device);
    },
    async describeGroup(groupId) {
      reads.push(`group:${groupId}`);
      return groups.get(groupId);
    },
    async describeAutomation(automationId) {
      reads.push(`automation:${automationId}`);
      return undefined;
    },
  };
  observer.bind(binding);
  return { timers, graph, observer, reads, failing, hanging, groups, binding };
}

const RELAY = deviceNode("relay");

describe("Observer scheduling", () => {
  test("reads a newly retained node within 250 ms and publishes it", async () => {
    const { timers, graph, observer, reads } = harness(new Site([new SwitchDevice("relay", "Porch relay")]));
    observer.retain(RELAY, "live");
    expect(reads).toEqual([]);
    await timers.advance(250);
    expect(reads).toEqual(["relay"]);
    expect(graph.read(RELAY)).toMatchObject({ version: 1, value: { id: "relay" }, observedAt: new Date(timers.base + 125).toISOString() });
  });

  test("polls at the tier interval measured from completion", async () => {
    const { timers, observer, reads } = harness(new Site([new SwitchDevice("relay", "Porch relay"), new SwitchDevice("lamp", "Lamp")]));
    observer.retain(RELAY, "live");
    observer.retain(deviceNode("lamp"), "glance");
    // random = 0.5 staggers the first read to 125 ms; the cadence counts from that completion.
    await timers.advance(125);
    expect(reads).toEqual(["relay", "lamp"]);
    reads.length = 0;
    await timers.advance(TIER_MS.live - 1);
    expect(reads).toEqual([]);
    await timers.advance(1);
    expect(reads).toEqual(["relay"]);
    await timers.advance(TIER_MS.glance - TIER_MS.live);
    expect(reads.filter((id) => id === "relay")).toHaveLength(4);
    expect(reads.filter((id) => id === "lamp")).toHaveLength(1);
  });

  test("a model's floor wins over a faster tier", async () => {
    const { timers, observer, reads } = harness(new Site([new CameraDevice("cam")]));
    observer.retain(deviceNode("cam"), "live");
    await timers.advance(125);
    reads.length = 0;
    await timers.advance(FLOORS_MS.camera - 1);
    expect(reads).toEqual([]);
    await timers.advance(1);
    expect(reads).toEqual(["cam"]);
  });

  test("a faster retainer pulls the next read forward; releasing it does not push it back", async () => {
    const { timers, observer, reads } = harness(new Site([new SwitchDevice("relay", "Porch relay")]));
    observer.retain(RELAY, "glance");
    await timers.advance(125);
    reads.length = 0;
    await timers.advance(1_000);
    const release = observer.retain(RELAY, "live");
    await timers.advance(TIER_MS.live - 1_000);
    expect(reads).toEqual(["relay"]);
    release();
    reads.length = 0;
    await timers.advance(TIER_MS.live);
    expect(reads).toEqual(["relay"]);
    expect(observer.isRetained(RELAY)).toBe(true);
  });

  test("jitters each delay by ±10 %", async () => {
    for (const [random, expected] of [[0, 4_500], [1, 5_500]] as const) {
      // The first draw staggers the first read; every later draw jitters a delay.
      const draws = [0.5];
      const { timers, observer, reads } = harness(new Site([new SwitchDevice("relay", "Porch relay")]), { random: () => draws.shift() ?? random });
      observer.retain(RELAY, "live");
      await timers.advance(125);
      reads.length = 0;
      await timers.advance(expected - 1);
      expect(reads).toEqual([]);
      await timers.advance(1);
      expect(reads).toEqual(["relay"]);
    }
  });

  test("releasing the last retainer stops the polling", async () => {
    const { timers, observer, reads } = harness(new Site([new SwitchDevice("relay", "Porch relay")]));
    const release = observer.retain(RELAY, "live");
    await timers.advance(250);
    release();
    release();
    reads.length = 0;
    await timers.advance(60_000);
    expect(reads).toEqual([]);
    expect(observer.isRetained(RELAY)).toBe(false);
    expect(timers.pending).toBe(0);
  });

  test("nothing is read before bind, and bind reads what is retained from the new site", async () => {
    const timers = new FakeTimers();
    const graph = new Graph({ now: timers.now });
    const observer = new Observer(graph, { now: timers.now, timers, random: () => 0.5 });
    observer.retain(RELAY, "live");
    await timers.advance(10_000);
    expect(timers.pending).toBe(0);
    const reads: string[] = [];
    observer.bind({ site: new Site([new SwitchDevice("relay", "Porch relay")]), async describe(device) { reads.push(device.id); return objectFor(device); }, async describeGroup() { return undefined; }, async describeAutomation() { return undefined; } });
    await timers.advance(250);
    expect(reads).toEqual(["relay"]);
    observer.stop();
    expect(timers.pending).toBe(0);
  });
});

describe("Observer faults and backoff", () => {
  test("a timed out read faults as timeout with the device detail sentence", async () => {
    const { timers, graph, observer, failing } = harness(new Site([new SwitchDevice("relay", "Porch relay")]));
    failing.set("relay", "timed out");
    observer.retain(RELAY, "live");
    await timers.advance(250);
    expect(graph.read(RELAY)).toMatchObject({
      version: 1,
      fault: { code: "timeout", message: "Porch relay did not answer at 10.77.0.2 (timed out). If it has moved, use Find on network on its Settings tab." },
    });
    expect(graph.read(RELAY)?.value).toBeUndefined();
    failing.set("relay", "ECONNREFUSED");
    await timers.advance(TIER_MS.live * 2);
    expect(graph.read(RELAY)?.fault?.code).toBe("unreachable");
  });

  test("readFault classifies an invalid document and cuts a long reason", () => {
    const device = new SwitchDevice("relay", "Porch relay");
    expect(readFault(device, new Error("Invalid object document for relay: /status must be equal to one of the allowed values"))).toMatchObject({ code: "invalid" });
    const long = readFault(device, new Error("x".repeat(1_000)));
    expect(long.code).toBe("unreachable");
    expect(long.message.length).toBeLessThan(500);
  });

  test("backs off ×2 per failure up to 120 s and resets on success", async () => {
    const { timers, observer, reads, failing } = harness(new Site([new SwitchDevice("relay", "Porch relay")]));
    failing.set("relay", "timed out");
    observer.retain(RELAY, "live");
    await timers.advance(125);
    for (const delay of [10_000, 20_000, 40_000, 80_000, 120_000, 120_000]) {
      reads.length = 0;
      await timers.advance(delay - 1);
      expect(reads).toEqual([]);
      await timers.advance(1);
      expect(reads).toEqual(["relay"]);
    }
    failing.delete("relay");
    await timers.advance(120_000);
    reads.length = 0;
    await timers.advance(TIER_MS.live);
    expect(reads).toEqual(["relay"]);
  });

  test("a camera backs off to 300 s", async () => {
    const { timers, observer, reads, failing } = harness(new Site([new CameraDevice("cam")]));
    failing.set("cam", "timed out");
    observer.retain(deviceNode("cam"), "live");
    await timers.advance(250);
    for (const delay of [60_000, 120_000, 240_000, 300_000, 300_000]) {
      reads.length = 0;
      await timers.advance(delay);
      expect(reads).toEqual(["cam"]);
    }
  });

  test("invalidate forgets the backoff and pulls the next read forward", async () => {
    const { timers, observer, reads, failing } = harness(new Site([new SwitchDevice("relay", "Porch relay")]));
    failing.set("relay", "timed out");
    observer.retain(RELAY, "live");
    await timers.advance(250 + 10_000 + 20_000);
    reads.length = 0;
    observer.invalidate("relay");
    await timers.advance(TIER_MS.live);
    expect(reads).toEqual(["relay"]);
  });

  test("a disabled device faults as disabled without ever being read", async () => {
    const relay = new SwitchDevice("relay", "Relay");
    relay.enabled = false;
    const { timers, graph, observer, reads } = harness(new Site([relay]));
    observer.retain(RELAY, "live");
    await timers.advance(250);
    expect(graph.read(RELAY)).toMatchObject({ fault: { code: "disabled" } });
    expect(reads).toEqual([]);
    await timers.advance(TIER_MS.live);
    expect(reads).toEqual([]);
  });

  test("an unknown device faults as unconfigured without backing off", async () => {
    const { timers, graph, observer, reads } = harness(new Site([]));
    observer.retain(deviceNode("nope"), "live");
    await timers.advance(250);
    expect(graph.read(deviceNode("nope"))).toMatchObject({ version: 1, fault: { code: "unconfigured", message: "nope is not in devices.yml" } });
    expect(reads).toEqual([]);
    const before = graph.read(deviceNode("nope"));
    await timers.advance(TIER_MS.live);
    expect(graph.read(deviceNode("nope"))?.version).toBe(1);
    expect(graph.read(deviceNode("nope"))?.observedAt).toBe(before?.observedAt);
  });

  test("group nodes read through describeGroup and fault when no such group switch exists", async () => {
    const { timers, graph, observer, groups } = harness(new Site([]));
    const document: GroupSwitch = {
      id: "g", name: "Lamps", status: "online",
      capabilities: { binarySwitch: { id: "g", state: { availability: "online", value: "on", observedAt: timers.now().toISOString() }, actions: { turnOn: {}, turnOff: {}, toggle: {}, getState: {} } } },
      group: { mixed: false, canSwitch: true, members: [] },
    };
    groups.set("g", document);
    observer.retain(groupNode("g"), "live");
    observer.retain(groupNode("nope"), "live");
    await timers.advance(250);
    expect(graph.read(groupNode("g"))).toMatchObject({ version: 1, value: document });
    expect(graph.read(groupNode("nope"))).toMatchObject({ fault: { code: "unconfigured", message: "nope is not a group switch in devices.yml" } });
  });
});

describe("Observer concurrency and identity", () => {
  test("one read is in flight per node; a refresh meanwhile gets a follow-up, never the read that started before it", async () => {
    const { timers, observer, reads, hanging } = harness(new Site([new SwitchDevice("relay", "Porch relay")]));
    hanging.set("relay", () => {});
    const first = observer.refresh(RELAY);
    const second = observer.refresh(RELAY);
    const third = observer.refresh(RELAY);
    expect(second).not.toBe(first);
    expect(third).toBe(second);
    await settle();
    expect(reads).toEqual(["relay"]);
    hanging.get("relay")!(objectFor(new SwitchDevice("relay", "Porch relay")));
    const one = await first;
    expect(one.version).toBe(1);
    await settle();
    expect(reads).toEqual(["relay", "relay"]);
    hanging.get("relay")!(objectFor(new SwitchDevice("relay", "Porch relay")));
    const two = await second;
    expect(two.version).toBe(1);
    await timers.advance(0);
  });

  test("holds a slot until the read settles or 30 s pass", async () => {
    const site = new Site([new SwitchDevice("a", "A"), new SwitchDevice("b", "B")]);
    const { timers, observer, reads, hanging } = harness(site, { concurrency: 1 });
    hanging.set("a", () => {});
    void observer.refresh(deviceNode("a"));
    const pending = observer.refresh(deviceNode("b"));
    await settle();
    expect(reads).toEqual(["a"]);
    await timers.advance(29_999);
    expect(reads).toEqual(["a"]);
    await timers.advance(1);
    expect(reads).toEqual(["a", "b"]);
    expect((await pending).version).toBe(1);
    hanging.get("a")!(objectFor(site.get("a")!));
    await settle();
  });

  test("drops a result when the site swapped the device during the read", async () => {
    const original = new Site([new SwitchDevice("relay", "Porch relay")]);
    const live = liveSite(original);
    const { timers, graph, observer, hanging } = harness(live.site);
    hanging.set("relay", () => {});
    const pending = observer.refresh(RELAY);
    await settle();
    live.swap(new Site([new SwitchDevice("relay", "Porch relay (moved)")]));
    hanging.get("relay")!(objectFor(original.get("relay")!));
    const record = await pending;
    expect(record.version).toBe(0);
    expect(graph.read(RELAY)).toBeUndefined();
    await timers.advance(0);
  });

  test("bind drops in-flight results and clears the graph", async () => {
    const { timers, graph, observer, hanging, reads, binding } = harness(new Site([new SwitchDevice("relay", "Porch relay")]));
    observer.retain(RELAY, "live");
    await timers.advance(250);
    expect(graph.read(RELAY)?.version).toBe(1);
    hanging.set("relay", () => {});
    void observer.refresh(RELAY);
    await settle();
    observer.bind(binding);
    expect(graph.read(RELAY)).toBeUndefined();
    hanging.get("relay")!(objectFor(new SwitchDevice("relay", "Porch relay")));
    await settle();
    expect(graph.read(RELAY)).toBeUndefined();
    hanging.delete("relay");
    reads.length = 0;
    await timers.advance(250);
    expect(reads).toEqual(["relay"]);
    expect(graph.read(RELAY)?.version).toBe(1);
  });
});

describe("Observer invalidation", () => {
  test("publish records a route's read and counts the cadence from it", async () => {
    const { timers, graph, observer, reads } = harness(new Site([new SwitchDevice("relay", "Porch relay")]));
    observer.retain(RELAY, "live");
    await timers.advance(250);
    await timers.advance(3_000);
    observer.publish("relay", { ...objectFor(new SwitchDevice("relay", "Porch relay")), status: "offline" });
    expect(graph.read(RELAY)).toMatchObject({ version: 2, value: { status: "offline" } });
    reads.length = 0;
    await timers.advance(TIER_MS.live - 1);
    expect(reads).toEqual([]);
    await timers.advance(1);
    expect(reads).toEqual(["relay"]);
  });

  test("invalidate re-reads retained composites, members and group switches, not the device itself", async () => {
    const site = new Site(
      [
        new SwitchDevice("relay", "Porch relay"),
        new SwitchDevice("other", "Other"),
        new CompositeDevice(compositeModel("synthetic-switch"), "synth", ["relay"]),
        new CompositeDevice(compositeModel("light-group"), "lg", ["relay", "other"]),
      ],
      undefined, undefined, undefined, undefined, undefined,
      [{ id: "g", name: "Group", members: ["relay", "other"], asSwitch: true }],
      // Built by hand rather than provisioned, so the references a composite
      // would have recorded while resolving its members are declared here.
      [
        { from: "synth", to: "relay", relation: "uses" },
        { from: "lg", to: "relay", relation: "members" },
        { from: "lg", to: "other", relation: "members" },
      ],
    );
    const { timers, observer, reads, groups } = harness(site);
    groups.set("g", { id: "g", name: "Group", status: "unknown", capabilities: { binarySwitch: { id: "g", state: { availability: "unknown" }, actions: { turnOn: {}, turnOff: {}, toggle: {}, getState: {} } } }, group: { mixed: false, canSwitch: true, members: [] } });
    for (const node of [RELAY, deviceNode("other"), deviceNode("synth"), deviceNode("lg"), groupNode("g")] as NodeId[]) observer.retain(node, "glance");
    await timers.advance(250);
    reads.length = 0;

    observer.invalidate("relay");
    await settle();
    expect(reads.sort()).toEqual(["group:g", "lg", "synth"]);

    reads.length = 0;
    observer.invalidate("synth");
    await settle();
    expect(reads).toEqual(["relay"]);

    reads.length = 0;
    observer.invalidate("lg");
    await settle();
    expect(reads.sort()).toEqual(["other", "relay"]);
    await timers.advance(0);
  });

  test("attach subscribes to every button and invalidates what the button drives", async () => {
    const button = new ButtonDevice("btn");
    const site = new Site(
      [button, new CompositeDevice(compositeModel("synthetic-switch"), "synth", ["btn"])],
      undefined, undefined, undefined, undefined, undefined, undefined,
      [{ from: "synth", to: "btn", relation: "uses" }],
    );
    const { timers, observer, reads } = harness(site);
    observer.retain(deviceNode("synth"), "live");
    await timers.advance(250);
    reads.length = 0;
    await button.capabilities.button.press();
    await settle();
    expect(reads).toEqual(["synth"]);

    observer.stop();
    reads.length = 0;
    await button.capabilities.button.press();
    await settle();
    expect(reads).toEqual([]);
  });
});

describe("Observer reads that overlap a change", () => {
  test("a route's publish during an in-flight read wins; the read's older answer is dropped and the cadence continues", async () => {
    const relay = new SwitchDevice("relay", "Porch relay");
    const { timers, graph, observer, reads, hanging } = harness(new Site([relay]));
    hanging.set("relay", () => {});
    observer.retain(RELAY, "live");
    await timers.advance(125);
    expect(reads).toEqual(["relay"]);
    // The user acts while the poll is still out: the route describes and publishes the newer document.
    observer.publish("relay", { ...objectFor(relay), status: "degraded" });
    expect(graph.read(RELAY)).toMatchObject({ version: 1, value: { status: "degraded" } });
    // The older poll answers afterwards and must not overwrite what the route learned.
    hanging.get("relay")!(objectFor(relay));
    await settle();
    expect(graph.read(RELAY)).toMatchObject({ version: 1, value: { status: "degraded" } });
    hanging.delete("relay");
    await timers.advance(TIER_MS.live * 1.2);
    expect(reads.length).toBeGreaterThanOrEqual(2);
  });

  test("refresh() during an in-flight read waits for a follow-up read, which sees the change", async () => {
    const relay = new SwitchDevice("relay", "Porch relay");
    const { timers, graph, observer, reads, hanging } = harness(new Site([relay]));
    hanging.set("relay", () => {});
    observer.retain(RELAY, "live");
    await timers.advance(125);
    const again = observer.refresh(RELAY);
    expect(reads).toEqual(["relay"]);
    hanging.get("relay")!({ ...objectFor(relay), status: "offline" });
    await settle();
    // The follow-up started as soon as the first read settled.
    expect(reads).toEqual(["relay", "relay"]);
    hanging.get("relay")!({ ...objectFor(relay), status: "online" });
    const record = await again;
    expect(record).toMatchObject({ value: { status: "online" } });
    expect(graph.read(RELAY)).toMatchObject({ value: { status: "online" } });
  });

  test("invalidate() during an in-flight read discards its answer and reads again", async () => {
    const relay = new SwitchDevice("relay", "Porch relay");
    const { timers, graph, observer, reads, hanging } = harness(new Site([relay]));
    hanging.set("relay", () => {});
    observer.retain(RELAY, "live");
    await timers.advance(125);
    observer.invalidate("relay");
    hanging.get("relay")!({ ...objectFor(relay), status: "offline" });
    await settle();
    expect(graph.read(RELAY)).toBeUndefined();
    expect(reads).toEqual(["relay", "relay"]);
    hanging.get("relay")!(objectFor(relay));
    await settle();
    expect(graph.read(RELAY)).toMatchObject({ version: 1, value: { status: "online" } });
  });
});

describe("push sources", () => {
  test("a device that reports its own change is re-read at once, without waiting for a poll", async () => {
    const hub = new PushDevice("hub");
    const site = new Site([hub]);
    const { timers, observer, reads } = harness(site);
    observer.retain(deviceNode("hub"), "glance");
    await timers.advance(250);
    reads.length = 0;

    hub.report();
    await settle();
    expect(reads).toEqual(["hub"]);

    // Nothing else was waiting on a timer: the read came from the push.
    expect(timers.elapsed).toBeLessThan(TIER_MS.glance);
    observer.stop();
  });

  test("a push on a hub also re-reads the sensors bridged through it", async () => {
    const hub = new PushDevice("hub");
    const sensor = new PushDevice("door");
    const site = new Site(
      [hub, sensor],
      undefined, undefined, undefined, undefined, undefined, undefined,
      [{ from: "door", to: "hub", relation: "uses", capability: "hub" }],
    );
    const { timers, observer, reads } = harness(site);
    for (const node of [deviceNode("hub"), deviceNode("door")]) observer.retain(node, "glance");
    await timers.advance(250);
    reads.length = 0;

    hub.report();
    await settle();
    expect(reads.sort()).toEqual(["door", "hub"]);
    observer.stop();
  });

  test("detaching stops the push, so a swapped-out device cannot keep invalidating", async () => {
    const hub = new PushDevice("hub");
    const { timers, observer, reads } = harness(new Site([hub]));
    observer.retain(deviceNode("hub"), "glance");
    await timers.advance(250);
    observer.stop();
    reads.length = 0;

    hub.report();
    await settle();
    expect(reads).toEqual([]);
    expect(hub.listeners.size).toBe(0);
  });
});
