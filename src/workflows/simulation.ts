import type { WorkflowDefinition } from "./definition";
import { WorkflowRunner, throwIfCancelled, type WorkflowRunView } from "./runner";

/** A counterfactual trace. No Device or production runtime is reachable from here. */
export async function simulateWorkflow(workflow: WorkflowDefinition, result: boolean | undefined): Promise<{ run: WorkflowRunView; elapsedMs: number; actions: string[] }> {
  let elapsedMs = 0; const actions: string[] = [];
  // Keep preview cost bounded even when an authored graph contains a loop.
  const preview = structuredClone(workflow); preview.limits.maxSteps = Math.min(preview.limits.maxSteps, 500);
  const runner = new WorkflowRunner(preview, {
    async action(action, signal) { throwIfCancelled(signal); actions.push(`${action.target}: ${action.operation} ${JSON.stringify(action.input)}`); },
    async predicate(_predicate, signal) { throwIfCancelled(signal); return result; },
    async wait(ms, signal) { throwIfCancelled(signal); elapsedMs += ms; if (elapsedMs > workflow.limits.maxDurationMs) throw new Error("Simulation exceeds the workflow time limit"); },
  });
  runner.start(); await runner.settled(); return { run: runner.status(), elapsedMs, actions };
}
