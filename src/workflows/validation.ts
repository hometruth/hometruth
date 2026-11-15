import Ajv2020 from "ajv/dist/2020";
import { workflowSchema } from "./schema";
import { childGraphs, transitions, type WorkflowDefinition, type WorkflowGraph } from "./definition";

const shape = new Ajv2020({ allErrors: true, strict: false }).compile(workflowSchema);
export class WorkflowValidationError extends Error { constructor(message: string) { super(message); this.name = "WorkflowValidationError"; } }

export function validateWorkflowShape(input: unknown): asserts input is WorkflowDefinition {
  const pending: Array<{ graph: unknown; depth: number }> = [{ graph: (input as WorkflowDefinition | null)?.graph, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const { graph, depth } = pending.pop()!;
    if (depth > 8) throw new WorkflowValidationError("Workflow nesting exceeds 8 levels");
    if (!graph || typeof graph !== "object" || !Array.isArray((graph as WorkflowGraph).nodes)) continue;
    for (const node of (graph as WorkflowGraph).nodes) {
      if (++count > 200) throw new WorkflowValidationError("Workflow exceeds 200 nodes");
      if (!node || typeof node !== "object") continue;
      if (node.type === "parallel" && Array.isArray(node.branches)) for (const branch of node.branches) pending.push({ graph: branch, depth: depth + 1 });
      if (node.type === "repeat") pending.push({ graph: node.body, depth: depth + 1 });
    }
  }
  if (!shape(input)) throw new WorkflowValidationError(shape.errors?.slice(0, 4).map(e => `${e.instancePath || "/"} ${e.message}`).join("; ") ?? "Invalid workflow");
}

export function validateWorkflow(input: unknown): asserts input is WorkflowDefinition {
  validateWorkflowShape(input);
  const check = (graph: WorkflowGraph, scope: string) => {
    const nodes = new Map(graph.nodes.map(node => [node.id, node]));
    if (nodes.size !== graph.nodes.length) throw new WorkflowValidationError(`${scope}: duplicate node IDs`);
    if (!nodes.has(graph.entry)) throw new WorkflowValidationError(`${scope}: missing entry node ${graph.entry}`);
    for (const node of graph.nodes) {
      for (const edge of transitions(node)) if (!nodes.has(edge.target)) throw new WorkflowValidationError(`${scope}/${node.id}: ${edge.outlet} points to missing node ${edge.target}`);
      for (const child of childGraphs(node)) check(child.graph, `${scope}/${node.id}/${child.key}`);
    }
    const reachable = new Set<string>(); const visit = [graph.entry];
    while (visit.length) { const id = visit.pop()!; if (reachable.has(id)) continue; reachable.add(id); visit.push(...transitions(nodes.get(id)!).map(e => e.target)); }
    const unreachable = graph.nodes.filter(n => !reachable.has(n.id));
    if (unreachable.length) throw new WorkflowValidationError(`${scope}: unreachable nodes: ${unreachable.map(n => n.label || n.id).join(", ")}`);
    const ends = new Set(graph.nodes.filter(n => n.type === "end").map(n => n.id));
    let changed = true;
    while (changed) { changed = false; for (const node of graph.nodes) if (!ends.has(node.id) && transitions(node).some(e => ends.has(e.target))) { ends.add(node.id); changed = true; } }
    if (ends.size !== nodes.size) throw new WorkflowValidationError(`${scope}: every node must have a path to an end`);
  };
  check(input.graph, "root");
}
