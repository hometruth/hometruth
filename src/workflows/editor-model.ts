import { childGraphs, emptyGraph, OUTLETS, transitions, walkNodes, type Json, type WorkflowDefinition, type WorkflowGraph, type WorkflowNode, type WorkflowPresentation } from "./definition";
import type { WorkflowTarget } from "./catalog";

export const NODE_TITLES = { action: "Action", delay: "Delay", condition: "Decision", parallel: "Parallel", repeat: "Repeat", waitFor: "Wait for", end: "End" };
export function graphAt(workflow: WorkflowDefinition, scope: string): WorkflowGraph {
  if (scope === "root") return workflow.graph;
  for (const { node, key } of walkNodes(workflow.graph)) for (const child of childGraphs(node)) if (`${key}/${child.key}` === scope) return child.graph;
  throw new Error("This branch no longer exists");
}
export function connect(graph: WorkflowGraph, source: string, outlet: string, target: string): void {
  const node = graph.nodes.find(n => n.id === source);
  if (!node || !(OUTLETS[node.type] as readonly string[]).includes(outlet) || !graph.nodes.some(n => n.id === target)) throw new Error("Choose a valid node and output in this branch");
  (node as unknown as Record<string, unknown>)[outlet] = target;
}
export function defaultInput(schema: Record<string, unknown>): Record<string, Json> {
  const result: Record<string, Json> = {};
  for (const [key, raw] of Object.entries((schema.properties ?? {}) as Record<string, Record<string, unknown>>)) {
    const value = raw.default ?? (raw.examples as Json[] | undefined)?.[0] ?? (raw.enum as Json[] | undefined)?.[0];
    if (value !== undefined) result[key] = value as Json;
    else if ((schema.required as string[] | undefined)?.includes(key)) result[key] = raw.type === "boolean" ? false : raw.type === "number" || raw.type === "integer" ? Number(raw.minimum ?? 0) : raw.type === "array" ? [] : raw.type === "object" ? {} : "";
  }
  return result;
}
export function insertNode(graph: WorkflowGraph, type: WorkflowNode["type"], before: string, targets: readonly WorkflowTarget[]): WorkflowNode {
  let suffix = 1; while (graph.nodes.some(n => n.id === `${type}-${suffix}`)) suffix++;
  const id = `${type}-${suffix}`; const next = graph.nodes.some(n => n.id === before) ? before : graph.entry;
  const base = { id, label: NODE_TITLES[type] };
  let failure = graph.nodes.find(n => n.type === "end" && n.outcome === "failure")?.id;
  if (!["delay", "end"].includes(type) && !failure) {
    failure = `failed-${id}`; graph.nodes.push({ id: failure, type: "end", outcome: "failure", label: "Failed" });
  }
  const target = targets.find(t => t.operations.length); const operation = target?.operations[0];
  const predicate = { target: target?.id ?? "unresolved", path: target?.statePaths[0] ?? "/capabilities/light/state/on", operator: "equals" as const, value: true };
  let node: WorkflowNode;
  switch (type) {
    case "action": node = { ...base, type, action: { target: target?.id ?? "unresolved", operation: operation?.id ?? "unresolved", input: operation ? defaultInput(operation.inputSchema) : {} }, next, onError: failure! }; break;
    case "delay": node = { ...base, type, durationMs: 1000, next }; break;
    case "condition": node = { ...base, type, predicate, ifTrue: next, ifFalse: next, onUnknown: failure! }; break;
    case "waitFor": node = { ...base, type, predicate, timeoutMs: 30000, onMatch: next, onTimeout: failure!, onUnknown: failure! }; break;
    case "parallel": node = { ...base, type, branches: [emptyGraph(), emptyGraph()], next, onError: failure! }; break;
    case "repeat": node = { ...base, type, count: 2, body: emptyGraph(), next, onError: failure! }; break;
    case "end": node = { ...base, type, outcome: "success" }; break;
  }
  graph.nodes.push(node);
  if (type !== "end") {
    for (const existing of graph.nodes.filter(n => n !== node)) for (const edge of transitions(existing)) if (edge.target === next) connect(graph, existing.id, edge.outlet, id);
    if (graph.entry === next) graph.entry = id;
  }
  return node;
}
export interface EditorSnapshot { workflow: WorkflowDefinition; presentation: WorkflowPresentation }
/** Undo uses our documents; X6 cells never enter saved behavior or history. */
export class EditorHistory {
  private past: EditorSnapshot[] = []; private future: EditorSnapshot[] = [];
  push(snapshot: EditorSnapshot) { this.past.push(structuredClone(snapshot)); if (this.past.length > 50) this.past.shift(); this.future = []; }
  undo(current: EditorSnapshot): EditorSnapshot | undefined { const previous = this.past.pop(); if (previous) this.future.push(structuredClone(current)); return previous; }
  redo(current: EditorSnapshot): EditorSnapshot | undefined { const next = this.future.pop(); if (next) this.past.push(structuredClone(current)); return next; }
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
}
