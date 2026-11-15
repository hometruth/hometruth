import { emptyWorkflow, type WorkflowDefinition, type WorkflowGraph, type WorkflowNode } from "../../src/workflows/definition";
export const end = (id = "done", outcome: "success" | "failure" = "success"): Extract<WorkflowNode, {type: "end"}> => ({ id, type: "end", outcome });
export const action = (id: string, next = "done", onError = "failed"): Extract<WorkflowNode, {type: "action"}> => ({ id, type: "action", action: { target: "relay", operation: "binarySwitch.turnOn", input: {} }, next, onError });
export function definition(nodes: WorkflowNode[], entry = nodes[0]!.id): WorkflowDefinition { return { ...emptyWorkflow("Example workflow"), graph: { entry, nodes } }; }
export function branch(nodes: WorkflowNode[]): WorkflowGraph { return { entry: nodes[0]!.id, nodes }; }
