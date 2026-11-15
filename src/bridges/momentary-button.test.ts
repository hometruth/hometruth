import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ACTION_BUTTON } from "../devices/composites/action-button";
import { MemoryKindleConfigStore } from "../kindle/store";
import { Button, type ButtonPressOptions } from "../models/button";
import type { Availability, CapabilityKind, InvokeOptions } from "../models/capability";
import { Device } from "../models/device";
import { DeviceEventLogs } from "../models/device-event-log";
import { MemorySignalCodeStore } from "../signal-code-store";
import { Site } from "../site";
import { StateHub } from "../state/hub";
import { deviceNode } from "../state/protocol";
import { elementKey } from "../tags/identity";
import { TagStore } from "../tags/store";
import { BridgeAdapter } from "./adapter";
import type { AccessoryMapping, BridgeDefinition, CharacteristicBinding } from "./model";
import { profileFor, validateMapping } from "./profiles";
import { assertMembers, BridgeStore } from "./store";

class SyntheticButton extends Button {
  status: Availability = "online";
  fail = false;
  attempts = 0;
  readonly presses: ButtonPressOptions[] = [];
  protected override async availability() { return this.status; }
  protected async performPress(options: ButtonPressOptions) {
    this.attempts++;
    if (this.fail) throw new Error("Synthetic press failed");
    this.presses.push(options);
  }
}

class SyntheticButtonDevice extends Device {
  readonly model = ACTION_BUTTON;
  readonly button = new SyntheticButton("example-button");
  readonly capabilities = { button: this.button };
  readonly calls: { kind: CapabilityKind; control: string; value: unknown }[] = [];
  constructor() { super("example-button", "Example button", {}); }
  async probe() { return {}; }
  override async invoke(kind: CapabilityKind, control: string, value?: unknown, options?: InvokeOptions) {
    this.calls.push({ kind, control, value });
    return super.invoke(kind, control, value, options);
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });

async function fixture() {
  const device = new SyntheticButtonDevice(), site = new Site([device]);
  const hub = new StateHub(), tags = new TagStore(), store = new BridgeStore(), logs = new DeviceEventLogs();
  hub.configure({ site, tags, signals: new MemorySignalCodeStore(), kindle: new MemoryKindleConfigStore() });
  hub.bind({ site, describe: device => device.describe(), async describeGroup() { return undefined; }, async describeAutomation() { return undefined; } });
  cleanups.push(() => { hub.stop(); tags.close(); store.close(); });
  const adapter = new BridgeAdapter(site, hub, logs);
  const element = elementKey("device", device.id), source = elementKey("capability", device.id, "button");
  const bridge: BridgeDefinition = { ...store.create("Synthetic bridge", "homekit"), members: [{ element, mappings: [] }] };
  const publish = async () => hub.observer.publish(device.id, await device.describe());
  await publish();
  const accessory = adapter.exports(bridge)[0]!;
  const custom = (binding: CharacteristicBinding): AccessoryMapping => ({ id: "example-trigger", name: "Example trigger", profile: "MomentarySwitch", characteristics: { On: binding } });
  const validate = (mapping: AccessoryMapping) => validateMapping(mapping, "homekit", (key, control) => adapter.exists(key, control));
  return { adapter, device, hub, logs, store, bridge, element, source, accessory, publish, custom, validate };
}

test("automatic HomeKit buttons keep their identity and configuring them never invokes an action", async () => {
  const f = await fixture();
  expect(profileFor("MomentarySwitch")).toMatchObject({ name: "Button (tap to run)", service: "Switch", protocols: ["homekit"],
    characteristics: [{ key: "On", format: "bool", required: true, readable: true, writable: true }] });
  expect(f.accessory).toMatchObject({ profile: "MomentarySwitch", characteristics: { On: { trigger: { element: f.source } } } });
  expect(f.accessory.id).toBe(createHash("sha256").update(JSON.stringify([f.element, "button"])).digest("hex").slice(0, 28));
  f.validate(f.accessory);
  f.store.update(f.bridge.id, { revision: 1, members: f.bridge.members });
  expect(f.adapter.snapshot(f.accessory)).toMatchObject({ reachable: true, values: { On: false } });
  expect(f.device.calls).toEqual([]);
  expect(() => f.adapter.exports({ ...f.bridge, protocol: "matter" })).toThrow("custom mapping");
});

test("On presses once, Off is a no-op, and repeated taps each return to idle", async () => {
  const f = await fixture();
  expect(await f.adapter.write(f.accessory, "On", false)).toMatchObject({ reachable: true, values: { On: false } });
  expect(f.device.calls).toEqual([]);
  expect(await f.adapter.write(f.accessory, "On", true)).toMatchObject({ reachable: true, values: { On: false } });
  await f.adapter.write(f.accessory, "On", false);
  const repeated = await Promise.all([f.adapter.write(f.accessory, "On", true), f.adapter.write(f.accessory, "On", true)]);
  expect(repeated.every(result => result.values.On === false)).toBe(true);
  expect(f.device.button.presses).toEqual([{}, {}, {}]);
  expect(f.device.calls).toEqual(Array.from({ length: 3 }, () => ({ kind: "button", control: "press", value: undefined })));
  expect(f.logs.recent(f.device.id).filter(event => event.data?.outcome === "succeeded")).toHaveLength(3);
  await expect(f.adapter.write(f.accessory, "On", 1)).rejects.toThrow("true or false");
  expect(f.device.button.attempts).toBe(3);
});

test("a failed press propagates without retries or a false powered-on state", async () => {
  const f = await fixture();
  f.device.button.fail = true;
  await expect(f.adapter.write(f.accessory, "On", true)).rejects.toThrow("Synthetic press failed");
  expect(f.device.button.attempts).toBe(1);
  expect(f.device.button.presses).toEqual([]);
  expect(f.adapter.snapshot(f.accessory).values.On).toBe(false);
  expect(f.logs.recent(f.device.id).some(event => event.data?.outcome === "failed")).toBe(true);
  f.device.button.fail = false;
  await f.adapter.write(f.accessory, "On", true);
  expect(f.device.button.attempts).toBe(2);
  expect(f.device.button.presses).toEqual([{}]);
});

test("unavailable or stale button state prevents presses while Off remains a no-op", async () => {
  const f = await fixture();
  for (const availability of ["offline", "unknown", "degraded"] as const) {
    f.device.button.status = availability;
    await f.publish();
    expect(f.adapter.snapshot(f.accessory)).toMatchObject({ reachable: false, values: { On: false } });
    await expect(f.adapter.write(f.accessory, "On", true)).rejects.toThrow("unavailable");
    await f.adapter.write(f.accessory, "On", false);
  }
  f.device.button.status = "online";
  await f.publish();
  f.hub.graph.publish(deviceNode(f.device.id), { value: await f.device.describe() }, "2000-01-01T00:00:00.000Z");
  await expect(f.adapter.write(f.accessory, "On", true)).rejects.toThrow("unavailable");
  const document = await f.device.describe();
  f.hub.graph.publish(deviceNode(f.device.id), { value: { ...document, capabilities: { button: { ...document.capabilities.button, state: {} } } } });
  await expect(f.adapter.write(f.accessory, "On", true)).rejects.toThrow("unavailable");
  await f.publish();
  f.device.enabled = false;
  await expect(f.adapter.write(f.accessory, "On", true)).rejects.toThrow("unavailable");
  expect(f.device.calls).toEqual([]);
});

test("trigger bindings require one existing button capability and cannot mix state or controls", async () => {
  const f = await fixture(), trigger = { element: f.source };
  expect(() => f.validate(f.custom({ trigger }))).not.toThrow();
  for (const mixed of [
    { read: { element: f.source, path: "" } }, { write: { element: elementKey("control", f.device.id, "button", "press") } },
    { commands: {} }, { constant: false }, { event: { element: f.source } },
  ]) expect(() => f.validate(f.custom({ trigger, ...mixed }))).toThrow("sole On binding");
  for (const element of [
    "invalid", f.element, elementKey("capability", "missing-button", "button"),
    elementKey("capability", f.device.id, "binarySwitch"), elementKey("control", f.device.id, "button", "press"),
    elementKey("capability", f.device.id, "button", "extra"),
  ]) expect(() => f.validate(f.custom({ trigger: { element } }))).toThrow("button capability");
  expect(() => f.validate(f.custom({ constant: false }))).toThrow("button trigger");
  expect(() => f.validate({ ...f.custom({ trigger }), profile: "Switch" })).toThrow("sole On binding");
  expect(() => f.validate({ ...f.custom({ constant: false }), profile: "Switch" })).toThrow("observed state");
  expect(() => f.validate({ ...f.custom({ trigger }), characteristics: { Other: { trigger } } })).toThrow();
  expect(() => validateMapping(f.custom({ trigger }), "matter", () => true)).toThrow("homekit");
  expect(() => validateMapping(f.custom({ trigger }), "homekit", (_key, control) => !control)).toThrow("button capability");
  expect(f.device.calls).toEqual([]);
});

test("membership schema accepts only a trigger element and forbids mixed bindings", async () => {
  const f = await fixture();
  const members = (binding: unknown) => [{ element: f.element, mappings: [f.custom(binding as CharacteristicBinding)] }];
  expect(() => assertMembers(members({ trigger: { element: f.source } }))).not.toThrow();
  for (const binding of [
    { trigger: {} }, { trigger: { element: f.source, value: true } }, { trigger: { element: f.source }, constant: false },
    { trigger: { element: f.source }, commands: {} }, { trigger: null },
  ]) expect(() => assertMembers(members(binding))).toThrow();
});

test("programmable events remain an explicit custom mapping without making a press", async () => {
  const f = await fixture();
  const mapping: AccessoryMapping = { id: "remote-event", name: "Example remote", profile: "StatelessProgrammableSwitch",
    characteristics: { ProgrammableSwitchEvent: { event: { element: f.source } } } };
  const accessory = f.adapter.exports({ ...f.bridge, members: [{ element: f.element, mappings: [mapping] }] })[0]!;
  expect(accessory.profile).toBe("StatelessProgrammableSwitch");
  expect(f.adapter.snapshot(accessory)).toMatchObject({ reachable: true, values: {} });
  expect(f.device.calls).toEqual([]);
});
