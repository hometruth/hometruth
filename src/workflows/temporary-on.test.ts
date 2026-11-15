import { expect, test } from "bun:test";
import { BinarySwitch, type BinarySwitchState } from "../models/binary-switch";
import { Device, type DeviceModel } from "../models/device";
import { workflowCatalog, type WorkflowTarget } from "./catalog";
import { deviceRuntime } from "./device-runtime";
import { WorkflowRunner } from "./runner";
import { validateWorkflow } from "./validation";
import { compileTemporaryOnWorkflow, MAX_TEMPORARY_ON_DURATION_MS, recognizeTemporaryOnWorkflow, timedSwitchTargets } from "./temporary-on";

class SyntheticSwitch extends BinarySwitch {
  calls: string[] = [];
  readFails = false;
  failControl?: string;
  constructor(id: string, public value: BinarySwitchState = "off") { super(id); }
  async getState() { if (this.readFails) throw new Error("No response"); return this.value; }
  async turnOn() { this.calls.push("on"); if (this.failControl === "on") throw new Error("On failed"); this.value = "on"; }
  async turnOff() { this.calls.push("off"); if (this.failControl === "off") throw new Error("Off failed"); this.value = "off"; }
  async toggle() { throw new Error("The recipe must use explicit On/Off"); }
}
class SyntheticDevice extends Device {
  readonly model = { id: "synthetic-relay", capabilities: ["binarySwitch"] } as unknown as DeviceModel;
  readonly capabilities;
  constructor(readonly switch_: SyntheticSwitch) { super(switch_.id, "Example relay", {}); this.capabilities = { binarySwitch: switch_ }; }
  async probe() { return {}; }
}
function fixture(initial: BinarySwitchState = "off", onlyIfOff = true) {
  const switch_ = new SyntheticSwitch("example-relay", initial), device = new SyntheticDevice(switch_);
  const catalog = workflowCatalog([device]);
  const workflow = compileTemporaryOnWorkflow({ name: "Example timed button", target: catalog[0]!, durationMs: 300_000, onlyIfOff });
  const runtime = deviceRuntime(new Map([[device.id, device]]));
  const waits: number[] = [];
  runtime.wait = async milliseconds => { waits.push(milliseconds); };
  return { switch_, catalog, workflow, runtime, waits };
}

test("the recipe uses typed power paths, qualified controls, and enough time for the delay", () => {
  const f = fixture();
  expect(() => validateWorkflow(f.workflow)).not.toThrow();
  expect(f.switch_.calls).toEqual([]);
  expect(f.workflow).toMatchObject({ runPolicy: "ignoreWhileRunning", limits: { maxSteps: 10, maxDurationMs: 360_000 } });
  expect(f.workflow.graph.nodes[0]).toMatchObject({ type: "condition", predicate: { path: "/capabilities/binarySwitch/state/value", value: "off" }, ifFalse: "done", onUnknown: "failed" });
  expect(recognizeTemporaryOnWorkflow(f.workflow, f.catalog)).toMatchObject({ name: f.workflow.name, durationMs: 300_000, onlyIfOff: true });
  const unconditional = compileTemporaryOnWorkflow({ name: "Always run", target: f.catalog[0]!, durationMs: 20, onlyIfOff: false });
  expect(() => validateWorkflow(unconditional)).not.toThrow();
  expect(unconditional.graph.entry).toBe("turn-on");
  expect(recognizeTemporaryOnWorkflow(unconditional, f.catalog)?.onlyIfOff).toBe(false);
});

test("only targets with matching typed readings and both power controls are offered", () => {
  const operation = (id: string) => ({ id, label: id, inputSchema: { type: "object" } });
  const light: WorkflowTarget = { id: "example-light", name: "Example light", statePaths: ["/capabilities/light/state/on"], operations: [operation("light.turnOn"), operation("light.turnOff")] };
  const unsupported = [
    { ...light, id: "write-only", statePaths: [] },
    { ...light, id: "missing-off", operations: [operation("light.turnOn")] },
    { ...light, id: "untyped", operations: [operation("turnOn"), operation("turnOff")] },
  ];
  expect(timedSwitchTargets([light, ...unsupported]).map(target => target.id)).toEqual(["example-light"]);
  expect(compileTemporaryOnWorkflow({ name: "Light", target: light, durationMs: 100 }).graph.nodes[0]).toMatchObject({ predicate: { path: "/capabilities/light/state/on", value: false } });
  for (const target of unsupported) expect(() => compileTemporaryOnWorkflow({ name: "Unsupported", target, durationMs: 100 })).toThrow();
});

test("recognition refuses custom graph behavior, controls, limits, or repeated-press policies", () => {
  const f = fixture();
  for (const change of [
    (w: typeof f.workflow) => { w.runPolicy = "replaceAfterCleanup"; },
    (w: typeof f.workflow) => { w.limits.maxDurationMs = 60_000; },
    (w: typeof f.workflow) => { const n = w.graph.nodes[0]!; if (n.type === "condition") n.ifFalse = "turn-on"; },
    (w: typeof f.workflow) => { const n = w.graph.nodes[1]!; if (n.type === "action") n.action.operation = "binarySwitch.toggle"; },
    (w: typeof f.workflow) => { const n = w.graph.nodes[3]!; if (n.type === "action") n.onError = "done"; },
  ]) {
    const changed = structuredClone(f.workflow); change(changed);
    expect(recognizeTemporaryOnWorkflow(changed, f.catalog)).toBeUndefined();
  }
});

test("duration validation preserves execution headroom and defaults to initially-off protection", () => {
  const target = fixture().catalog[0]!;
  for (const name of ["", " ", "a".repeat(201)]) expect(() => compileTemporaryOnWorkflow({ name, target, durationMs: 100 })).toThrow();
  for (const durationMs of [0, -1, 1.5, NaN, Infinity, MAX_TEMPORARY_ON_DURATION_MS + 1]) expect(() => compileTemporaryOnWorkflow({ name: "Invalid", target, durationMs })).toThrow();
  const workflow = compileTemporaryOnWorkflow({ name: "Maximum", target, durationMs: MAX_TEMPORARY_ON_DURATION_MS });
  expect(workflow.limits.maxDurationMs).toBe(86_400_000);
  expect(workflow.graph.entry).toBe("check-off");
});

test("initially off runs On, waits five minutes, then Off; initially on sends nothing", async () => {
  for (const initial of ["off", "on"] as const) {
    const f = fixture(initial), runner = new WorkflowRunner(f.workflow, f.runtime);
    runner.start(); await runner.settled();
    expect(runner.status().status).toBe("complete");
    expect(f.switch_.calls).toEqual(initial === "off" ? ["on", "off"] : []);
    expect(f.waits).toEqual(initial === "off" ? [300_000] : []);
    expect(f.switch_.value).toBe(initial);
  }
});

test("unknown power state fails without an action or wait", async () => {
  const f = fixture(); f.switch_.readFails = true;
  const runner = new WorkflowRunner(f.workflow, f.runtime);
  runner.start(); await runner.settled();
  expect(runner.status().status).toBe("failed");
  expect(f.switch_.calls).toEqual([]); expect(f.waits).toEqual([]);
});

test("action errors fail and a failed On never schedules Off", async () => {
  for (const failControl of ["on", "off"] as const) {
    const f = fixture(); f.switch_.failControl = failControl;
    const runner = new WorkflowRunner(f.workflow, f.runtime);
    runner.start(); await runner.settled();
    expect(runner.status().status).toBe("failed");
    expect(f.switch_.calls).toEqual(failControl === "on" ? ["on"] : ["on", "off"]);
    expect(f.waits).toEqual(failControl === "on" ? [] : [300_000]);
  }
});

test("unconditional mode turns an already-on device off after the selected wait", async () => {
  const f = fixture("on", false), runner = new WorkflowRunner(f.workflow, f.runtime);
  runner.start(); await runner.settled();
  expect(runner.status().status).toBe("complete");
  expect(f.switch_.calls).toEqual(["on", "off"]); expect(f.waits).toEqual([300_000]);
});

test("repeated presses share the existing wait and keep its original deadline", async () => {
  const f = fixture();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  f.runtime.wait = async milliseconds => { f.waits.push(milliseconds); entered(); await new Promise<void>(resolve => { release = resolve; }); };
  const runner = new WorkflowRunner(f.workflow, f.runtime);
  const first = runner.start(); await waiting;
  expect(runner.start().id).toBe(first.id);
  expect(f.switch_.calls).toEqual(["on"]); expect(f.waits).toEqual([300_000]);
  release(); await runner.settled();
  expect(f.switch_.calls).toEqual(["on", "off"]); expect(runner.history()).toHaveLength(1);
});
