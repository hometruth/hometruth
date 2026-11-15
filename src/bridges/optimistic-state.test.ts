import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTION_BUTTON } from "../devices/composites/action-button";
import { OptimisticSwitchDevice, SqliteOptimisticSwitchStateStore } from "../devices/composites/optimistic-switch";
import { MemoryKindleConfigStore } from "../kindle/store";
import { Button } from "../models/button";
import { Device } from "../models/device";
import { MemorySignalCodeStore } from "../signal-code-store";
import { Site } from "../site";
import { StateHub } from "../state/hub";
import { deviceNode } from "../state/protocol";
import { elementKey } from "../tags/identity";
import { TagStore } from "../tags/store";
import { BridgeAdapter } from "./adapter";

class SyntheticButton extends Button {
  presses = 0;
  protected async performPress() { this.presses++; }
}

class SyntheticButtonDevice extends Device {
  readonly model = ACTION_BUTTON;
  readonly button: SyntheticButton;
  readonly capabilities;
  constructor(id: string) {
    super(id, id, {});
    this.button = new SyntheticButton(id);
    this.capabilities = { button: this.button };
    this.reportAvailability("online");
  }
  async probe() { return {}; }
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });

function storagePath() {
  const directory = mkdtempSync(join(tmpdir(), "hometruth-bridge-state-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "switches.sqlite");
}

function open(path: string, initialState?: "on" | "off") {
  const store = new SqliteOptimisticSwitchStateStore(path);
  const on = new SyntheticButtonDevice("example-on"), off = new SyntheticButtonDevice("example-off");
  const device = new OptimisticSwitchDevice({ id: "example-switch", name: "Example switch" }, {
    onButton: on.id, offButton: off.id, ...(initialState ? { initialState } : {}),
  }, { optimisticSwitchStates: store }, { device: id => id === on.id ? on : off });
  const site = new Site([on, off, device]), hub = new StateHub(), tags = new TagStore();
  hub.configure({ site, tags, signals: new MemorySignalCodeStore(), kindle: new MemoryKindleConfigStore() });
  const adapter = new BridgeAdapter(site, hub);
  const accessory = adapter.exports({ id: "synthetic-bridge", name: "Synthetic bridge", protocol: "homekit",
    enabled: true, port: 0, revision: 1, members: [{ element: elementKey("device", device.id), mappings: [] }] })[0]!;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    hub.stop(); device.switch.close(); tags.close(); store.close();
  };
  cleanups.push(close);
  return { device, on, off, close, snapshot: async () => {
    const document = await device.describe();
    hub.graph.publish(deviceNode(device.id), { value: document });
    return { state: document.capabilities.binarySwitch!.state, snapshot: adapter.snapshot(accessory) };
  } };
}

test("a restored command exports to HomeKit without another press or a fabricated observation", async () => {
  const path = storagePath(), first = open(path);
  await first.device.turnOn();
  const commandedAt = (await first.snapshot()).state.commandedAt!;
  expect(commandedAt).toBeDefined();
  first.close();

  const restored = open(path);
  const reading = await restored.snapshot();
  expect(reading.state).toEqual({ availability: "online", value: "on", stateSource: "commanded", commandedAt });
  expect(reading.state.observedAt).toBeUndefined();
  expect(reading.snapshot).toMatchObject({ reachable: true, values: { On: true } });
  expect(restored.on.button.presses + restored.off.button.presses).toBe(0);

  for (const availability of ["offline", "unknown"] as const) {
    restored.on.reportAvailability(availability); restored.off.reportAvailability(availability);
    expect((await restored.snapshot()).snapshot).toMatchObject({ reachable: false, values: {} });
  }
  expect(restored.on.button.presses + restored.off.button.presses).toBe(0);
});

test("restarting a switch that has never been commanded leaves HomeKit state unavailable", async () => {
  const path = storagePath(), first = open(path);
  expect((await first.snapshot()).snapshot.reachable).toBe(false);
  first.close();
  const restored = open(path);
  const reading = await restored.snapshot();
  expect(reading.state).toEqual({ availability: "online" });
  expect(reading.snapshot).toMatchObject({ reachable: false, values: {} });
  expect(restored.on.button.presses + restored.off.button.presses).toBe(0);
});

test("an explicit starting assumption exports without claiming a physical observation", async () => {
  const fixture = open(storagePath(), "off");
  const reading = await fixture.snapshot();
  expect(reading.state).toMatchObject({ availability: "online", value: "off", stateSource: "assumed" });
  expect(reading.state.assumedAt).toBeDefined();
  expect(reading.state.observedAt).toBeUndefined();
  expect(reading.snapshot).toMatchObject({ reachable: true, values: { On: false } });
  expect(fixture.on.button.presses + fixture.off.button.presses).toBe(0);
});
