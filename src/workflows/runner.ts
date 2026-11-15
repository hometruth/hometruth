import { validateWorkflow } from "./validation";
import type { WorkflowAction, WorkflowDefinition, WorkflowGraph, WorkflowPredicate } from "./definition";

export type { WorkflowDefinition, WorkflowNode } from "./definition";
export { validateWorkflow, WorkflowValidationError } from "./validation";
export interface WorkflowRuntime {
  action(action: WorkflowAction, signal: AbortSignal): Promise<void>;
  predicate(predicate: WorkflowPredicate, signal: AbortSignal): Promise<boolean | undefined>;
  wait?(milliseconds: number, signal: AbortSignal): Promise<void>;
}
export type WorkflowRunStatus = "idle" | "running" | "complete" | "failed" | "cancelled";
export interface WorkflowTrace { node: string; phase: "entered" | "completed" | "failed"; detail?: string }
export interface WorkflowRunView {
  id: string; status: WorkflowRunStatus; activeNodeIds: string[]; steps: number; trace: WorkflowTrace[];
  startedAt?: string; finishedAt?: string; error?: string;
}
interface Run { view: WorkflowRunView; controller: AbortController; active: Set<string>; task: Promise<void> }

export function throwIfCancelled(signal: AbortSignal): void { if (signal.aborted) throw signal.reason ?? new Error("Workflow cancelled"); }
export async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal.removeEventListener("abort", cancel); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const cancel = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); reject(signal.reason ?? new Error("Workflow cancelled")); };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

/** The interpreter consumes only HomeTruth definitions and an injected runtime. */
export class WorkflowRunner {
  private readonly runs: Run[] = [];
  readonly workflow: WorkflowDefinition;
  constructor(workflow: WorkflowDefinition, private readonly runtime: WorkflowRuntime) {
    validateWorkflow(workflow); this.workflow = structuredClone(workflow);
  }
  start(): WorkflowRunView {
    const previous = this.runs.filter(r => r.view.status === "running");
    if (previous[0] && this.workflow.runPolicy === "ignoreWhileRunning") return this.view(previous[0]);
    for (const run of previous) run.controller.abort(new Error("Replaced by another run"));
    const run: Run = { view: { id: crypto.randomUUID(), status: "running", activeNodeIds: [], startedAt: new Date().toISOString(), steps: 0, trace: [] }, controller: new AbortController(), active: new Set(), task: Promise.resolve() };
    this.runs.unshift(run);
    run.task = this.execute(run, previous.map(r => r.task));
    while (this.runs.length > 20 && this.runs.at(-1)?.view.status !== "running") this.runs.pop();
    return this.view(run);
  }
  cancel(id?: string): boolean {
    const run = this.runs.find(r => r.view.status === "running" && (!id || r.view.id === id));
    if (!run) return false; run.controller.abort(new Error("Workflow cancelled")); return true;
  }
  async close(): Promise<void> { for (const run of this.runs) this.cancel(run.view.id); await Promise.all(this.runs.map(r => r.task)); }
  async settled(): Promise<void> { await Promise.all(this.runs.map(r => r.task)); }
  status(): WorkflowRunView { return this.runs[0] ? this.view(this.runs[0]) : { id: "", status: "idle", activeNodeIds: [], steps: 0, trace: [] }; }
  history(): WorkflowRunView[] { return this.runs.map(r => this.view(r)); }
  private view(run: Run): WorkflowRunView { return structuredClone({ ...run.view, activeNodeIds: [...run.active] }); }
  private trace(run: Run, event: WorkflowTrace) { run.view.trace.push(event); if (run.view.trace.length > 500) run.view.trace.shift(); }
  private async execute(run: Run, previous: Promise<void>[]): Promise<void> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    try {
      await Promise.all(previous); throwIfCancelled(run.controller.signal);
      deadline = setTimeout(() => { expired = true; run.controller.abort(new Error("Workflow time limit exceeded")); }, this.workflow.limits.maxDurationMs);
      await this.graph(this.workflow.graph, "root", run, run.controller.signal);
      throwIfCancelled(run.controller.signal); run.view.status = "complete";
    } catch (error) {
      run.view.status = run.controller.signal.aborted && !expired ? "cancelled" : "failed";
      run.view.error = error instanceof Error ? error.message : String(error);
    } finally { clearTimeout(deadline); run.active.clear(); run.view.finishedAt = new Date().toISOString(); }
  }
  private async graph(graph: WorkflowGraph, scope: string, run: Run, signal: AbortSignal): Promise<void> {
    const nodes = new Map(graph.nodes.map(n => [n.id, n])); let current = graph.entry;
    while (current) {
      throwIfCancelled(signal);
      if (++run.view.steps > this.workflow.limits.maxSteps) throw new Error("Workflow step limit exceeded");
      const node = nodes.get(current)!; const key = `${scope}/${node.id}`;
      run.active.add(key); this.trace(run, { node: key, phase: "entered" });
      try {
        if (node.type === "end") { if (node.outcome === "failure") throw new Error(`Workflow ended with failure at ${node.label || key}`); current = ""; }
        else if (node.type === "delay") { await (this.runtime.wait ?? wait)(node.durationMs, signal); current = node.next; }
        else if (node.type === "condition" || node.type === "waitFor") {
          let result = await this.runtime.predicate(node.predicate, signal);
          if (node.type === "condition") current = result === undefined ? node.onUnknown : result ? node.ifTrue : node.ifFalse;
          else {
            let remaining = node.timeoutMs;
            while (result === false && remaining > 0) {
              const interval = Math.min(250, remaining); await (this.runtime.wait ?? wait)(interval, signal); remaining -= interval;
              result = await this.runtime.predicate(node.predicate, signal);
            }
            current = result === undefined ? node.onUnknown : result ? node.onMatch : node.onTimeout;
          }
        } else {
          try {
            if (node.type === "action") await this.runtime.action(node.action, signal);
            else if (node.type === "repeat") for (let i = 0; i < node.count; i++) await this.graph(node.body, `${key}/body`, run, signal);
            else {
              const siblings = new AbortController(); const childSignal = AbortSignal.any([signal, siblings.signal]);
              const results = await Promise.allSettled(node.branches.map(async (branch, i) => {
                try { await this.graph(branch, `${key}/branch-${i + 1}`, run, childSignal); }
                catch (error) { siblings.abort(error); throw error; }
              }));
              const failure = results.find(r => r.status === "rejected"); if (failure?.status === "rejected") throw failure.reason;
            }
            throwIfCancelled(signal); current = node.next;
          } catch (error) {
            throwIfCancelled(signal);
            if (run.view.steps > this.workflow.limits.maxSteps) throw error;
            this.trace(run, { node: key, phase: "failed", detail: error instanceof Error ? error.message : String(error) });
            current = node.onError;
          }
        }
        this.trace(run, { node: key, phase: "completed" });
      } finally { run.active.delete(key); }
    }
  }
}
