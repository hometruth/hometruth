import { expect, test } from "bun:test";
import { action, branch, definition, end } from "../../tests/fixtures/workflow";
import { WorkflowRunner, wait, type WorkflowRuntime } from "./runner";
import { validateWorkflow } from "./validation";
import { simulateWorkflow } from "./simulation";
const runtime = (overrides: Partial<WorkflowRuntime> = {}): WorkflowRuntime => ({ async action() {}, async predicate() { return true; }, ...overrides });
const predicate = { target: "relay", path: "/capabilities/binarySwitch/state/value", operator: "equals" as const, value: "on" };

test("executes repeat bodies and parallel joins before continuation", async () => {
  const calls: string[] = [];
  const inner = branch([action("inner"), end(), end("failed", "failure")]);
  const wf = definition([
    { id: "repeat", type: "repeat", count: 2, body: inner, next: "parallel", onError: "failed" },
    { id: "parallel", type: "parallel", branches: [inner, inner], next: "after", onError: "failed" },
    { ...action("after"), action: { target: "relay", operation: "after", input: {} } }, end(), end("failed", "failure"),
  ]);
  const runner = new WorkflowRunner(wf, runtime({ async action(a) { calls.push(a.operation); } }));
  runner.start(); await runner.settled();
  expect(runner.status().status).toBe("complete"); expect(calls).toEqual(["binarySwitch.turnOn", "binarySwitch.turnOn", "binarySwitch.turnOn", "binarySwitch.turnOn", "after"]);
  expect(runner.status().trace.some(e => e.node === "root/parallel/branch-2/inner")).toBe(true);
});

test("unknown conditions and timed-out waits have explicit paths", async () => {
  const wf = definition([{ id: "check", type: "condition", predicate, ifTrue: "done", ifFalse: "done", onUnknown: "failed" }, end(), end("failed", "failure")]);
  const runner = new WorkflowRunner(wf, runtime({ async predicate() { return undefined; } })); runner.start(); await runner.settled(); expect(runner.status().status).toBe("failed");
  const timed = definition([{ id: "wait", type: "waitFor", predicate, timeoutMs: 500, onMatch: "done", onUnknown: "failed", onTimeout: "failed" }, end(), end("failed", "failure")]);
  let waited = 0; const timeout = new WorkflowRunner(timed, runtime({ async predicate() { return false; }, async wait(ms) { waited += ms; } }));
  timeout.start(); await timeout.settled(); expect(waited).toBe(500); expect(timeout.status().status).toBe("failed");
  expect((await simulateWorkflow(wf, undefined)).run.status).toBe("failed");
});

test("parallel failure cancels siblings and waits for cleanup before the error path", async () => {
  const events: string[] = []; let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  const good = branch([{ ...action("holding"), action: { target: "relay", operation: "hold", input: {} } }, end(), end("failed", "failure")]);
  const bad = branch([{ ...action("broken"), action: { target: "relay", operation: "break", input: {} } }, end(), end("failed", "failure")]);
  const runner = new WorkflowRunner(definition([{ id: "parallel", type: "parallel", branches: [good, bad], next: "done", onError: "recover" }, { ...action("recover", "done", "done"), action: { target: "relay", operation: "recover", input: {} } }, end()]), runtime({ async action(a, signal) {
    if (a.operation === "hold") { began(); try { await wait(10000, signal); } finally { await new Promise(r => setTimeout(r, 2)); events.push("cleanup"); } }
    else if (a.operation === "break") { await started; throw new Error("broken"); }
    else events.push("recover");
  } }));
  runner.start(); await runner.settled(); expect(events).toEqual(["cleanup", "recover"]); expect(runner.status().status).toBe("complete");
});

test("replacement waits for cleanup; repeated presses default to ignore", async () => {
  const wf = definition([action("hold"), end(), end("failed", "failure")]);
  const events: string[] = []; let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  let call = 0;
  const runner = new WorkflowRunner({ ...wf, runPolicy: "replaceAfterCleanup" }, runtime({ async action(_a, signal) { if (++call === 1) { started(); try { await wait(10000, signal); } finally { await new Promise(r => setTimeout(r, 2)); events.push("cleanup"); } } else events.push("replacement"); } }));
  runner.start(); await ready; runner.start(); await runner.settled(); expect(events).toEqual(["cleanup", "replacement"]); expect(runner.history().map(r => r.status)).toEqual(["complete", "cancelled"]);
  const ignored = new WorkflowRunner(wf, runtime({ async action(_a, signal) { await wait(5, signal); } })); expect(ignored.start().id).toBe(ignored.start().id); await ignored.close();
});

test("bounds loops by steps and enforces the wall-clock limit", async () => {
  const loop = definition([{ id: "check", type: "condition", predicate, ifTrue: "check", ifFalse: "done", onUnknown: "done" }, end()]); loop.limits.maxSteps = 8;
  const runner = new WorkflowRunner(loop, runtime()); runner.start(); await runner.settled(); expect(runner.status().error).toContain("step limit");
  const slow = definition([{ id: "wait", type: "delay", durationMs: 1000, next: "done" }, end()]); slow.limits.maxDurationMs = 5;
  const timer = new WorkflowRunner(slow, runtime()); timer.start(); await timer.settled(); expect(timer.status().error).toContain("time limit"); expect(timer.status().status).toBe("failed");
});

test("rejects dangling transitions, unreachable nodes, duplicate IDs, and canvas data", () => {
  expect(() => validateWorkflow(definition([action("a", "missing"), end(), end("failed", "failure")]))).toThrow("missing node");
  expect(() => validateWorkflow(definition([end(), end("orphan")]))).toThrow("unreachable");
  expect(() => validateWorkflow(definition([end(), end()]))).toThrow("duplicate");
  expect(() => validateWorkflow({ ...definition([end()]), cells: [] })).toThrow();
  expect(() => validateWorkflow({ ...definition([end()]), graph: { entry: "done", nodes: [{ ...end(), position: { x: 1, y: 2 } }] } })).toThrow();
});
