import { describe, expect, test } from "bun:test";
import { BinarySwitch, type BinarySwitchState } from "../../../models/binary-switch";
import { Device, type DeviceIdentity, type DeviceModel, type DeviceInstance, type SiteServices } from "../../../models/device";
import { buttonSchema } from "../../../schemas";
import { parseDevicesConfig } from "../../../config/devices";
import { provision } from "../../../config/provision";
import { WorkflowButtonDevice, WORKFLOW_BUTTON } from "./index";

class MemorySwitch extends BinarySwitch {
  state: BinarySwitchState = "off";
  readonly calls: string[] = [];
  async turnOn(): Promise<void> { this.calls.push("turnOn"); this.state = "on"; }
  async turnOff(): Promise<void> { this.calls.push("turnOff"); this.state = "off"; }
  async toggle(): Promise<void> { this.calls.push("toggle"); this.state = this.state === "on" ? "off" : "on"; }
  async getState(): Promise<BinarySwitchState> { return this.state; }
}

const TARGET_MODEL: DeviceModel = {
  id: "workflow-target", title: "Workflow target", manufacturer: "Test", product: "Target", capabilities: ["binarySwitch"],
  connectionTypes: ["direct-local"],
  configSchema: { $id: "https://hometruth.local/test/workflow-target", type: "object", additionalProperties: false },
  objectSchemaId: buttonSchema.$id,
  create(instance: DeviceInstance, _config: Record<string, never>, _services: SiteServices) { return new TargetDevice(instance); },
};

class TargetDevice extends Device {
  readonly model = TARGET_MODEL;
  readonly switch = new MemorySwitch(this.id);
  readonly capabilities = { binarySwitch: this.switch };
  constructor(instance: DeviceInstance) { super(instance.id, instance.name, {}); }
  async probe(): Promise<DeviceIdentity> { return {}; }
  override controls(): readonly string[] { return ["turnOn", "turnOff", "toggle", "getState"]; }
}

describe("WorkflowButton device", () => {
  test("provisions forward references and reports availability walked from its target devices", async () => {
    const config = parseDevicesConfig(`
schemaVersion: 2
devices:
  - id: routine
    name: Turn it on, then off
    model: workflow-button
    config:
      workflow:
        start: on
        nodes:
          - { id: on, type: action, device: relay, control: turnOn, next: off }
          - { id: off, type: action, device: relay, control: turnOff, next: done }
          - { id: done, type: end }
  - { id: relay, model: workflow-target, config: {} }
`);
    const devices = provision(config, [WORKFLOW_BUTTON, TARGET_MODEL], {});
    const workflow = devices[0] as WorkflowButtonDevice;
    expect(workflow).toBeInstanceOf(WorkflowButtonDevice);
    expect((await workflow.button.describe()).state).toEqual({ availability: "online" });
    await workflow.button.press();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((devices[1] as TargetDevice).switch.calls).toEqual(["turnOn", "turnOff"]);
    expect(workflow.button.run.status).toBe("complete");
  });
});
