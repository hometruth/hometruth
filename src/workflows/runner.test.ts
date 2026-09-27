import { describe, expect, test } from "bun:test";
import type { InvokeOptions } from "../models/capability";
import { Device, type DeviceIdentity, type DeviceModel } from "../models/device";
import { WorkflowRunner, type WorkflowDefinition } from "./runner";

const MODEL = {
  id: "workflow-test-device", title: "Workflow test device", manufacturer: "Test", product: "Target", capabilities: [],
  configSchema: { $id: "https://hometruth.local/test/workflow-device", type: "object", additionalProperties: false },
  objectSchemaId: "https://hometruth.ai/schemas/button",
} as unknown as DeviceModel;

class MemoryTarget extends Device {
  readonly model = MODEL;
  readonly capabilities = {};
  readonly calls: string[] = [];
  value: unknown = "off";
  constructor(id = "target") { super(id, id, {}); }
  async probe(): Promise<DeviceIdentity> { return {}; }
  override controls(): readonly string[] { return ["turnOn", "turnOff"]; }
  override async invokeControl(control: string, _value?: unknown, _options?: InvokeOptions): Promise<void> { this.calls.push(control); this.value = control === "turnOn" ? "on" : control === "turnOff" ? "off" : this.value; }
  override async describe(): Promise<any> { return { id: this.id, status: "online", capabilities: { target: { state: { value: this.value } } } }; }
}

class RecordingTarget extends MemoryTarget {
  readonly options: unknown[] = [];
  override async invokeControl(control: string, value?: unknown, options?: InvokeOptions): Promise<void> {
    this.options.push({ control, value, options });
    await super.invokeControl(control, value, options);
  }
}

async function settle(runner: WorkflowRunner): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (runner.status().status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("workflow did not settle");
}

describe("WorkflowRunner", () => {
  test("runs actions and delays in graph order", async () => {
    const target = new MemoryTarget();
    const workflow: WorkflowDefinition = {
      start: "on",
      nodes: [
        { id: "on", type: "action", device: target.id, control: "turnOn", next: "wait" },
        { id: "wait", type: "delay", durationMs: 2, next: "off" },
        { id: "off", type: "action", device: target.id, control: "turnOff", next: "done" },
        { id: "done", type: "end" },
      ],
    };
    const runner = new WorkflowRunner(workflow, new Map([[target.id, target]]));
    expect(runner.start().status).toBe("running");
    await settle(runner);
    expect(target.calls).toEqual(["turnOn", "turnOff"]);
    expect(runner.status()).toMatchObject({ status: "complete", steps: 4 });
  });

  test("takes the true or false edge from a live device document", async () => {
    const target = new MemoryTarget();
    const workflow: WorkflowDefinition = {
      start: "check",
      nodes: [
        { id: "check", type: "condition", device: target.id, path: "capabilities.target.state.value", operator: "equals", value: "off", ifTrue: "on", ifFalse: "done" },
        { id: "on", type: "action", device: target.id, control: "turnOn", next: "done" },
        { id: "done", type: "end" },
      ],
    };
    const runner = new WorkflowRunner(workflow, new Map([[target.id, target]]));
    runner.start();
    await settle(runner);
    expect(target.calls).toEqual(["turnOn"]);
    expect(runner.status()).toMatchObject({ status: "complete", steps: 3 });
  });

  test("passes explicit confirmation through an action node", async () => {
    const target = new RecordingTarget();
    const runner = new WorkflowRunner({ start: "action", nodes: [
      { id: "action", type: "action", device: target.id, control: "turnOn", confirmed: true, next: "done" },
      { id: "done", type: "end" },
    ] }, new Map([[target.id, target]]));
    runner.start();
    await settle(runner);
    expect(target.options).toEqual([{ control: "turnOn", value: undefined, options: { confirmed: true } }]);
  });

  test("cancels a delayed run when a replacing press starts", async () => {
    const target = new MemoryTarget();
    const workflow: WorkflowDefinition = { start: "wait", nodes: [{ id: "wait", type: "delay", durationMs: 100, next: "done" }, { id: "done", type: "end" }] };
    const runner = new WorkflowRunner(workflow, new Map([[target.id, target]]));
    const first = runner.start();
    const second = runner.start();
    await settle(runner);
    expect(first.id).not.toBe(second.id);
    expect(runner.history().map((run) => run.status)).toEqual(["complete", "cancelled"]);
  });
});
