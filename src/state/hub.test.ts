import { describe, expect, test } from "bun:test";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { BinarySwitch, type BinarySwitchState } from "../models/binary-switch";
import { Device, type DeviceIdentity } from "../models/device";
import { Site } from "../site";
import { StateHub } from "./hub";
import type { ObserverBinding, ObserverTimers } from "./observer";
import { deviceNode, STREAM_LIMITS } from "./protocol";

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

/** Timers that never fire on their own; the test sees what was armed. */
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

function binding(site: Site, reads: string[]): ObserverBinding {
  return {
    site,
    async describe(device) {
      reads.push(device.id);
      return await device.describe();
    },
    async describeGroup() { return undefined; },
    async describeAutomation() { return undefined; },
  };
}

const RELAY = deviceNode("relay");

describe("StateHub", () => {
  test("defaults to the dev generation and the protocol limits", () => {
    const hub = new StateHub();
    expect(hub.generation).toBe("dev");
    expect(hub.limits).toEqual({ maxStreams: STREAM_LIMITS.maxStreams, maxNodes: STREAM_LIMITS.maxNodes });
    hub.stop();
  });

  test("bind closes every stream, clears the graph and re-reads what stays retained from the new site", async () => {
    const timers = new RecordingTimers();
    const hub = new StateHub({ generation: "g1", timers, random: () => 0.5 });
    const reads: string[] = [];
    hub.bind(binding(new Site([new SwitchDevice("relay", "Porch relay")]), reads));

    const closed: string[] = [];
    hub.streams.open(() => closed.push("one"));
    hub.streams.open(() => closed.push("two"));
    const release = hub.observer.retain(RELAY, "live");
    expect(timers.armed).toHaveLength(1);
    timers.fire(timers.armed[0]!);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(reads).toEqual(["relay"]);
    expect(hub.snapshot([RELAY])).toHaveLength(1);

    const nextReads: string[] = [];
    hub.bind(binding(new Site([new SwitchDevice("relay", "Porch relay again")]), nextReads));
    expect(closed).toEqual(["one", "two"]);
    expect(hub.streams.count).toBe(0);
    expect(hub.snapshot([RELAY])).toEqual([]);
    expect(hub.graph.read(RELAY)).toBeUndefined();
    expect(hub.observer.isRetained(RELAY)).toBe(true);
    expect(timers.armed).toHaveLength(1);
    timers.fire(timers.armed[0]!);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(nextReads).toEqual(["relay"]);
    expect(hub.graph.read(RELAY)).toMatchObject({ version: 1, value: { name: "Porch relay again" } });
    release();
    hub.stop();
  });

  test("stop closes streams, cancels timers and empties the graph", () => {
    const timers = new RecordingTimers();
    const hub = new StateHub({ timers });
    hub.bind(binding(new Site([new SwitchDevice("relay", "Porch relay")]), []));
    const closed: string[] = [];
    hub.streams.open(() => closed.push("one"));
    hub.observer.retain(RELAY, "glance");
    hub.observer.publish("relay", { schemaVersion: 1, health: { status: "unknown", detail: "Not checked yet", checkedAt: null }, id: "relay", name: "Porch relay", capabilities: {} });
    hub.stop();
    expect(closed).toEqual(["one"]);
    expect(timers.armed).toEqual([]);
    expect(hub.graph.read(RELAY)).toBeUndefined();
    expect(hub.observer.isRetained(RELAY)).toBe(false);
  });
});
