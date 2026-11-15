import type { WorkflowTarget } from "./catalog";
import type { WorkflowDefinition, WorkflowNode } from "./definition";

const EXECUTION_HEADROOM_MS = 60_000;
export const MAX_TEMPORARY_ON_DURATION_MS = 86_400_000 - EXECUTION_HEADROOM_MS;

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameJson(value, right[index]));
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && sameJson(a[key], b[key]));
}

export interface TemporaryOnTarget extends WorkflowTarget {
  readonly power: {
    readonly kind: "binarySwitch" | "light" | "stringLight";
    readonly path: string;
    readonly offValue: "off" | false;
    readonly onOperation: string;
    readonly offOperation: string;
  };
}

export interface TemporaryOnOptions {
  readonly name: string;
  readonly target: WorkflowTarget;
  readonly durationMs: number;
  readonly onlyIfOff?: boolean;
}

export interface TemporaryOnRecipe {
  readonly name: string;
  readonly target: TemporaryOnTarget;
  readonly durationMs: number;
  readonly onlyIfOff: boolean;
}

/** Only advertise devices with both power actions and a typed power reading. */
export function timedSwitchTargets(catalog: readonly WorkflowTarget[]): TemporaryOnTarget[] {
  return catalog.flatMap(target => {
    for (const kind of ["binarySwitch", "light", "stringLight"] as const) {
      const path = `/capabilities/${kind}/state/${kind === "binarySwitch" ? "value" : "on"}`;
      const onOperation = `${kind}.turnOn`, offOperation = `${kind}.turnOff`;
      if (target.statePaths.includes(path) && target.operations.some(op => op.id === onOperation) && target.operations.some(op => op.id === offOperation)) {
        return [{ ...target, power: { kind, path, offValue: kind === "binarySwitch" ? "off" as const : false as const, onOperation, offOperation } }];
      }
    }
    return [];
  });
}

/** Pure authoring: constructing or saving this definition never invokes a device. */
export function compileTemporaryOnWorkflow(options: TemporaryOnOptions): WorkflowDefinition {
  const target = timedSwitchTargets([options.target])[0];
  if (!target) throw new Error("Choose a device with readable power state and On/Off controls");
  const name = options.name.trim();
  if (!name || name.length > 200) throw new Error("Name must contain from 1 to 200 characters");
  if (!Number.isInteger(options.durationMs) || options.durationMs < 1 || options.durationMs > MAX_TEMPORARY_ON_DURATION_MS) {
    throw new Error(`Duration must be a whole number from 1 to ${MAX_TEMPORARY_ON_DURATION_MS} milliseconds`);
  }
  const onlyIfOff = options.onlyIfOff ?? true;
  const nodes: WorkflowNode[] = [];
  if (onlyIfOff) nodes.push({
    id: "check-off", type: "condition", label: "Check whether the device is off",
    // The device runtime reads fresh state and routes unavailable/missing state to onUnknown.
    predicate: { target: target.id, path: target.power.path, operator: "equals", value: target.power.offValue },
    ifTrue: "turn-on", ifFalse: "done", onUnknown: "failed",
  });
  nodes.push(
    { id: "turn-on", type: "action", label: "Turn on", action: { operation: target.power.onOperation, target: target.id, input: {} }, next: "wait", onError: "failed" },
    { id: "wait", type: "delay", label: "Wait", durationMs: options.durationMs, next: "turn-off" },
    { id: "turn-off", type: "action", label: "Turn off", action: { operation: target.power.offOperation, target: target.id, input: {} }, next: "done", onError: "failed" },
    { id: "done", type: "end", label: "Complete", outcome: "success" },
    { id: "failed", type: "end", label: "Could not complete", outcome: "failure" },
  );
  const workflow: WorkflowDefinition = {
    schemaVersion: 1,
    name,
    description: onlyIfOff
      ? "Turn on for the selected duration only when initially off; leave an already-on device unchanged."
      : "Turn on for the selected duration, then turn off.",
    runPolicy: "ignoreWhileRunning",
    limits: { maxSteps: 10, maxDurationMs: options.durationMs + EXECUTION_HEADROOM_MS },
    graph: { entry: onlyIfOff ? "check-off" : "turn-on", nodes },
  };
  return workflow;
}

/** Refuse to collapse a custom graph into a recipe that would discard its behavior. */
export function recognizeTemporaryOnWorkflow(workflow: WorkflowDefinition, catalog: readonly WorkflowTarget[]): TemporaryOnRecipe | undefined {
  const on = workflow.graph.nodes.find(node => node.id === "turn-on");
  const delay = workflow.graph.nodes.find(node => node.id === "wait");
  if (on?.type !== "action" || delay?.type !== "delay") return undefined;
  const target = timedSwitchTargets(catalog).find(target => target.id === on.action.target);
  if (!target) return undefined;
  const onlyIfOff = workflow.graph.entry === "check-off";
  const recipe = { name: workflow.name, target, durationMs: delay.durationMs, onlyIfOff };
  try { return sameJson(workflow, compileTemporaryOnWorkflow(recipe)) ? recipe : undefined; }
  catch { return undefined; }
}
