import { expect, test } from "bun:test";
import { emptyWorkflow, type WorkflowNode } from "./definition";
import { connect, EditorHistory, graphAt, insertNode } from "./editor-model";
import { validateWorkflow } from "./validation";
const targets = [{ id: "relay", name: "Example relay", statePaths: ["/capabilities/binarySwitch/state/value"], operations: [{ id: "binarySwitch.turnOn", label: "Turn on", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] }];
test("inserts typed nodes into a portable graph and rewires selected inputs", () => {
  const workflow = emptyWorkflow();
  const node = insertNode(workflow.graph, "action", "done", targets);
  expect(workflow.graph.entry).toBe(node.id); expect(workflow.graph.nodes).toHaveLength(3);
  expect(() => validateWorkflow(workflow)).not.toThrow();
  const delay = insertNode(workflow.graph, "delay", node.id, targets);
  expect(workflow.graph.entry).toBe(delay.id);
  expect(() => validateWorkflow(workflow)).not.toThrow();
  expect(JSON.stringify(workflow)).not.toMatch(/cells|position|ports|shape/);
});
test("all nested graph types and connections survive editing without X6 types", () => {
  for (const type of ["parallel", "repeat", "condition", "waitFor"] as WorkflowNode["type"][]) {
    const workflow = emptyWorkflow(); const node = insertNode(workflow.graph, type, "done", targets);
    expect(() => validateWorkflow(workflow)).not.toThrow();
    if (type === "repeat") expect(graphAt(workflow, `root/${node.id}/body`).entry).toBe("done");
    if (type === "parallel") expect(graphAt(workflow, `root/${node.id}/branch-2`).entry).toBe("done");
    expect(() => connect(workflow.graph, node.id, "missing-port", "done")).toThrow();
  }
});
test("undo and redo include presentation without mixing it into behavior", () => {
  const history = new EditorHistory(); const before = { workflow: emptyWorkflow(), presentation: { positions: {} } };
  history.push(before); const after = structuredClone(before); after.workflow.name = "Edited";
  expect(history.undo(after)).toEqual(before); expect(history.redo(before)).toEqual(after);
});
