import { describe, expect, test } from "bun:test";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { BinarySwitch, type BinarySwitchState } from "../models/binary-switch";
import { Device, type DeviceIdentity } from "../models/device";
import { isGroupSwitch, SelectedDeviceGroup, type GroupSnapshot } from "../models/device-group";
import type { DeviceGroup } from "../schemas";
import { groupSwitchDocument } from "./group-switch";
import { stateValidators } from "./schemas";

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
  constructor(id: string, name: string, state: BinarySwitchState) {
    super(id, name, { host: "10.77.0.2" });
    this.capabilities = { binarySwitch: new MemorySwitch(id, state) };
  }
  async probe(): Promise<DeviceIdentity> { return {}; }
}

const GROUP: DeviceGroup = { id: "lamps", name: "Lamps", members: ["a", "b"], asSwitch: true };
const AT = "2026-09-14T12:00:00.000Z";
const POWER_ACTIONS: GroupSnapshot["actions"] = ["turnOn", "turnOff", "toggle"].map((control) => ({ id: `power.${control}`, control, input: "none" as const, bounds: {}, confirmation: false }));

function snapshot(power: GroupSnapshot["properties"][number] | undefined, actions = POWER_ACTIONS): GroupSnapshot {
  return {
    availability: "online",
    members: [
      { id: "a", name: "Lamp A", availability: "online", properties: { "power.on": true } },
      { id: "b", name: "Lamp B", availability: "online", properties: { "power.on": true }, ...(actions.length < 3 ? { missingForSwitch: ["power.toggle"] } : {}) },
    ],
    properties: power ? [power] : [],
    actions,
    switchEligible: true,
  };
}

/** What `switchResponse` in device-group-routes.ts answers today for the same snapshot. */
function switchResponse(group: DeviceGroup, snap: GroupSnapshot) {
  const power = snap.properties.find((property) => property.id === "power.on")!;
  return {
    id: group.id,
    state: { availability: snap.availability, ...(power.status === "shared" && typeof power.value === "boolean" ? { value: power.value ? "on" as const : "off" as const } : {}) },
    mixed: power.status === "mixed",
  };
}

describe("groupSwitchDocument", () => {
  test("carries the shared power value the way the switch route does, dated by the read", () => {
    const snap = snapshot({ id: "power.on", status: "shared", value: true });
    const document = groupSwitchDocument(GROUP, snap, AT);
    const expected = switchResponse(GROUP, snap);
    expect(document.capabilities.binarySwitch).toEqual({
      id: "lamps",
      state: { ...expected.state, observedAt: AT },
      actions: { turnOn: {}, turnOff: {}, toggle: {}, getState: {} },
    });
    expect(document).toMatchObject({ id: "lamps", name: "Lamps", status: "online", group: { mixed: expected.mixed, canSwitch: true } });
    expect(document.group.members).toBe(snap.members);
    expect(stateValidators.groupSwitch(document)).toBe(true);
  });

  test("a mixed group has no value and says so", () => {
    const snap = snapshot({ id: "power.on", status: "mixed" });
    const document = groupSwitchDocument(GROUP, snap, AT);
    expect(document.capabilities.binarySwitch.state).toEqual({ availability: "online" });
    expect(document.group).toMatchObject({ mixed: true, canSwitch: true });
    expect(switchResponse(GROUP, snap)).toMatchObject({ state: { availability: "online" }, mixed: true });
    expect(stateValidators.groupSwitch(document)).toBe(true);
  });

  test("an unknown power reading leaves the value out without calling the group mixed", () => {
    const document = groupSwitchDocument(GROUP, snapshot({ id: "power.on", status: "unknown" }), AT);
    expect(document.capabilities.binarySwitch.state).toEqual({ availability: "online" });
    expect(document.group.mixed).toBe(false);
  });

  test("a group that lost a switch control keeps availability only and says which member lacks what", () => {
    const snap = snapshot({ id: "power.on", status: "shared", value: false }, POWER_ACTIONS.slice(0, 2));
    expect(isGroupSwitch(snap)).toBe(false);
    const document = groupSwitchDocument(GROUP, snap, AT);
    expect(document.capabilities.binarySwitch.state).toEqual({ availability: "online" });
    expect(document.capabilities.binarySwitch.actions).toEqual({ turnOn: {}, turnOff: {}, toggle: {}, getState: {} });
    expect(document.group.canSwitch).toBe(false);
    expect(document.group.members[1]?.missingForSwitch).toEqual(["power.toggle"]);
    expect(stateValidators.groupSwitch(document)).toBe(true);
  });

  test("folds a real selected group the same way the route does", async () => {
    const a = new SwitchDevice("a", "Lamp A", "off");
    const b = new SwitchDevice("b", "Lamp B", "off");
    const group = new SelectedDeviceGroup([a, b]);
    const off = await group.describe();
    const offDocument = groupSwitchDocument(GROUP, off, AT);
    expect(offDocument.capabilities.binarySwitch.state).toEqual({ ...switchResponse(GROUP, off).state, observedAt: AT });
    expect(offDocument.capabilities.binarySwitch.state.value).toBe("off");
    expect(offDocument.group).toMatchObject({ mixed: false, canSwitch: true });
    expect(stateValidators.groupSwitch(offDocument)).toBe(true);

    await a.capabilities.binarySwitch.turnOn();
    const mixed = await group.describe();
    const mixedDocument = groupSwitchDocument(GROUP, mixed, AT);
    expect(mixedDocument.capabilities.binarySwitch.state).toEqual({ availability: "online" });
    expect(mixedDocument.group.mixed).toBe(switchResponse(GROUP, mixed).mixed);
    expect(mixedDocument.group.mixed).toBe(true);
    expect(stateValidators.groupSwitch(mixedDocument)).toBe(true);
  });
});
