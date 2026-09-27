import type { Device } from "../models/device";
import { CapabilityError } from "../models/capability";

export type WorkflowConcurrency = "parallel" | "replace" | "ignore";

export interface WorkflowActionNode {
  readonly id: string;
  readonly type: "action";
  readonly label?: string;
  readonly device: string;
  readonly control: string;
  readonly value?: unknown;
  readonly confirmed?: boolean;
  readonly next?: string;
}

export interface WorkflowDelayNode {
  readonly id: string;
  readonly type: "delay";
  readonly label?: string;
  readonly durationMs: number;
  readonly next?: string;
}

export type WorkflowComparison = "equals" | "notEquals" | "greaterThan" | "lessThan" | "contains" | "truthy" | "falsy";

export interface WorkflowConditionNode {
  readonly id: string;
  readonly type: "condition";
  readonly label?: string;
  readonly device: string;
  readonly path: string;
  readonly operator: WorkflowComparison;
  readonly value?: unknown;
  readonly ifTrue: string;
  readonly ifFalse: string;
}

export interface WorkflowEndNode {
  readonly id: string;
  readonly type: "end";
  readonly label?: string;
}

export type WorkflowNode = WorkflowActionNode | WorkflowDelayNode | WorkflowConditionNode | WorkflowEndNode;

export interface WorkflowDefinition {
  readonly start: string;
  readonly nodes: readonly WorkflowNode[];
  readonly maxSteps?: number;
  readonly concurrency?: WorkflowConcurrency;
}

export type WorkflowRunStatus = "idle" | "running" | "complete" | "failed" | "cancelled";

export interface WorkflowRunView {
  readonly id: string;
  readonly status: WorkflowRunStatus;
  readonly currentNodeId?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: string;
  readonly steps: number;
}

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowValidationError";
  }
}

/** Semantic checks that JSON Schema cannot express: ids and every graph edge must resolve. */
export function validateWorkflow(workflow: WorkflowDefinition): void {
  const nodes = new Map<string, WorkflowNode>();
  for (const node of workflow.nodes) {
    if (nodes.has(node.id)) throw new WorkflowValidationError(`Workflow node "${node.id}" is defined more than once`);
    nodes.set(node.id, node);
  }
  if (!nodes.has(workflow.start)) throw new WorkflowValidationError(`Workflow starts at missing node "${workflow.start}"`);
  const requireNode = (from: string, target: string | undefined, edge: string) => {
    if (target !== undefined && !nodes.has(target)) throw new WorkflowValidationError(`Workflow node "${from}" points to missing ${edge} node "${target}"`);
  };
  for (const node of workflow.nodes) {
    if (node.type === "action" || node.type === "delay") requireNode(node.id, node.next, "next");
    if (node.type === "condition") {
      requireNode(node.id, node.ifTrue, "true branch");
      requireNode(node.id, node.ifFalse, "false branch");
      const hasValue = Object.hasOwn(node, "value");
      if ((node.operator === "truthy" || node.operator === "falsy") && hasValue) {
        throw new WorkflowValidationError(`Condition node "${node.id}" does not take a comparison value for ${node.operator}`);
      }
      if (node.operator !== "truthy" && node.operator !== "falsy" && !hasValue) {
        throw new WorkflowValidationError(`Condition node "${node.id}" needs a comparison value for ${node.operator}`);
      }
    }
  }
  if ((workflow.maxSteps ?? 1000) < 1) throw new WorkflowValidationError("Workflow maxSteps must be at least 1");
}

interface WorkflowRun {
  readonly id: string;
  status: WorkflowRunStatus;
  currentNodeId: string | undefined;
  startedAt: string;
  finishedAt: string | undefined;
  error: string | undefined;
  steps: number;
  readonly controller: AbortController;
}

function valueAt(document: unknown, path: string): unknown {
  let current = document;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left && right && typeof left === "object" && typeof right === "object") {
    try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
  }
  return false;
}

function matches(left: unknown, operator: WorkflowComparison, right: unknown): boolean {
  switch (operator) {
    case "equals": return sameValue(left, right);
    case "notEquals": return !sameValue(left, right);
    case "greaterThan": return typeof left === "number" && typeof right === "number" && left > right;
    case "lessThan": return typeof left === "number" && typeof right === "number" && left < right;
    case "contains": return typeof left === "string" && typeof right === "string" ? left.includes(right)
      : Array.isArray(left) ? left.some((item) => sameValue(item, right)) : false;
    case "truthy": return Boolean(left);
    case "falsy": return !left;
  }
}

function now(): string { return new Date().toISOString(); }

function abortError(): Error {
  const error = new Error("Workflow was cancelled");
  error.name = "WorkflowCancelledError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "WorkflowCancelledError";
}

/** Executes a validated workflow graph and retains a small in-memory run history for the UI. */
export class WorkflowRunner {
  private readonly nodes: ReadonlyMap<string, WorkflowNode>;
  private readonly runs: WorkflowRun[] = [];
  private runNumber = 0;

  constructor(
    readonly workflow: WorkflowDefinition,
    private readonly devices: ReadonlyMap<string, Device>,
  ) {
    validateWorkflow(workflow);
    this.nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  }

  start(): WorkflowRunView {
    const active = this.runs.filter((run) => run.status === "running");
    const concurrency = this.workflow.concurrency ?? "replace";
    if (concurrency === "ignore" && active[0]) return this.view(active[0]);
    if (concurrency === "replace") for (const run of active) this.cancel(run.id);
    const run: WorkflowRun = {
      id: `${Date.now().toString(36)}-${(++this.runNumber).toString(36)}`,
      status: "running",
      currentNodeId: undefined,
      startedAt: now(),
      finishedAt: undefined,
      error: undefined,
      steps: 0,
      controller: new AbortController(),
    };
    this.runs.unshift(run);
    this.runs.splice(20);
    void this.execute(run);
    return this.view(run);
  }

  cancel(id?: string): boolean {
    const run = id ? this.runs.find((candidate) => candidate.id === id) : this.runs.find((candidate) => candidate.status === "running");
    if (!run || run.status !== "running") return false;
    run.controller.abort();
    return true;
  }

  status(): WorkflowRunView {
    return this.runs[0] ? this.view(this.runs[0]) : { id: "", status: "idle", steps: 0 };
  }

  history(): readonly WorkflowRunView[] { return this.runs.map((run) => this.view(run)); }

  private view(run: WorkflowRun): WorkflowRunView {
    return {
      id: run.id,
      status: run.status,
      ...(run.currentNodeId ? { currentNodeId: run.currentNodeId } : {}),
      ...(run.startedAt ? { startedAt: run.startedAt } : {}),
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      ...(run.error ? { error: run.error } : {}),
      steps: run.steps,
    };
  }

  private async execute(run: WorkflowRun): Promise<void> {
    try {
      let current = this.workflow.start;
      const limit = this.workflow.maxSteps ?? 1000;
      while (current) {
        this.checkCancelled(run);
        if (run.steps >= limit) throw new WorkflowValidationError(`Workflow exceeded its ${limit}-step limit`);
        const node = this.nodes.get(current);
        if (!node) throw new WorkflowValidationError(`Workflow reached missing node "${current}"`);
        run.currentNodeId = node.id;
        run.steps += 1;
        if (node.type === "action") {
          const device = this.devices.get(node.device);
          if (!device) throw new CapabilityError(`Workflow target "${node.device}" is unavailable`, "not_supported");
          const options = node.confirmed === true ? { confirmed: true } : {};
          if (Object.hasOwn(node, "value")) await device.invokeControl(node.control, node.value, options);
          else await device.invokeControl(node.control, undefined, options);
          current = node.next ?? "";
        } else if (node.type === "delay") {
          await this.delay(node.durationMs, run.controller.signal);
          current = node.next ?? "";
        } else if (node.type === "condition") {
          const device = this.devices.get(node.device);
          if (!device) throw new CapabilityError(`Workflow target "${node.device}" is unavailable`, "not_supported");
          const document = await device.describe();
          current = matches(valueAt(document, node.path), node.operator, node.value) ? node.ifTrue : node.ifFalse;
        } else {
          current = "";
        }
      }
      run.currentNodeId = undefined;
      run.status = "complete";
      run.finishedAt = now();
    } catch (error) {
      run.currentNodeId = undefined;
      run.finishedAt = now();
      if (isAbortError(error)) {
        run.status = "cancelled";
        return;
      }
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
    }
  }

  private checkCancelled(run: WorkflowRun): void {
    if (run.controller.signal.aborted) throw abortError();
  }

  private async delay(durationMs: number, signal: AbortSignal): Promise<void> {
    if (durationMs === 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, durationMs);
      const cancel = () => { clearTimeout(timer); reject(abortError()); };
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", cancel, { once: true });
    });
  }
}
