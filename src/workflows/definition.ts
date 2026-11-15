/** HomeTruth's portable workflow model. No UI or execution-library types belong here. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface WorkflowAction { operation: string; target: string; input: Record<string, Json> }
export interface WorkflowPredicate { target: string; path: string; operator: "equals" | "notEquals" | "greaterThan" | "lessThan"; value: Json; }
interface NodeBase { id: string; label?: string }
export type WorkflowNode =
  | (NodeBase & { type: "action"; action: WorkflowAction; next: string; onError: string })
  | (NodeBase & { type: "delay"; durationMs: number; next: string })
  | (NodeBase & { type: "condition"; predicate: WorkflowPredicate; ifTrue: string; ifFalse: string; onUnknown: string })
  | (NodeBase & { type: "parallel"; branches: WorkflowGraph[]; next: string; onError: string })
  | (NodeBase & { type: "repeat"; count: number; body: WorkflowGraph; next: string; onError: string })
  | (NodeBase & { type: "waitFor"; predicate: WorkflowPredicate; timeoutMs: number; onMatch: string; onTimeout: string; onUnknown: string })
  | (NodeBase & { type: "end"; outcome: "success" | "failure" });
export interface WorkflowGraph { entry: string; nodes: WorkflowNode[] }
export interface WorkflowDefinition {
  schemaVersion: 1;
  name: string;
  description: string;
  runPolicy: "ignoreWhileRunning" | "replaceAfterCleanup";
  limits: { maxSteps: number; maxDurationMs: number };
  graph: WorkflowGraph;
}
export interface WorkflowPresentation { positions: Record<string, { x: number; y: number }> }
export const OUTLETS = {
  action: ["next", "onError"], delay: ["next"], condition: ["ifTrue", "ifFalse", "onUnknown"],
  parallel: ["next", "onError"], repeat: ["next", "onError"], waitFor: ["onMatch", "onTimeout", "onUnknown"], end: [],
} as const;
export const OUTLET_LABELS: Record<string, string> = { next: "Done", onError: "Error", ifTrue: "Yes", ifFalse: "No", onUnknown: "Unknown", onMatch: "Matched", onTimeout: "Timed out" };
export function transitions(node: WorkflowNode): Array<{ outlet: string; target: string }> {
  return OUTLETS[node.type].map(outlet => ({ outlet, target: (node as unknown as Record<string, string>)[outlet]! }));
}
export function childGraphs(node: WorkflowNode): Array<{ key: string; graph: WorkflowGraph }> {
  if (node.type === "parallel") return node.branches.map((graph, i) => ({ key: `branch-${i + 1}`, graph }));
  return node.type === "repeat" ? [{ key: "body", graph: node.body }] : [];
}
export function walkNodes(graph: WorkflowGraph, scope = "root"): Array<{ node: WorkflowNode; scope: string; key: string; graph: WorkflowGraph }> {
  return graph.nodes.flatMap(node => [{ node, scope, key: `${scope}/${node.id}`, graph }, ...childGraphs(node).flatMap(child => walkNodes(child.graph, `${scope}/${node.id}/${child.key}`))]);
}
export function workflowTargets(workflow: WorkflowDefinition): string[] {
  return [...new Set(walkNodes(workflow.graph).flatMap(({ node }) => node.type === "action" ? [node.action.target] : node.type === "condition" || node.type === "waitFor" ? [node.predicate.target] : []))];
}
export function emptyGraph(): WorkflowGraph { return { entry: "done", nodes: [{ id: "done", type: "end", outcome: "success" }] }; }
export function emptyWorkflow(name = "Workflow"): WorkflowDefinition {
  return { schemaVersion: 1, name, description: "", runPolicy: "ignoreWhileRunning", limits: { maxSteps: 1000, maxDurationMs: 60000 }, graph: emptyGraph() };
}
