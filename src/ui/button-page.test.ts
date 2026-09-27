import { describe, expect, test } from "bun:test";
import { buttonSchema } from "../schemas";
import type { RegisteredDevice } from "../site";
import type { WorkflowDefinition } from "../workflows/runner";
import { renderButtonPage, renderWorkflowGraphForTest, workflowSteps } from "./button-page";
import { testPageContext } from "./test-context";

const device: RegisteredDevice = {
  id: "candles-on",
  name: "Candles on",
  kind: "button",
  model: "action-button",
  modelTitle: "Device action button",
  capabilities: ["button"],
  host: "action on Living room blaster",
  page: "/devices/candles-on",
  schemaId: buttonSchema.$id,
  enabled: true,
};

describe("button page", () => {
  test("mounts the button element on the device node with the checking fallback", () => {
    const html = renderButtonPage({ ctx: testPageContext(), device });
    expect(html).toContain('<ht-button node="device/candles-on">');
    expect(html).toContain("Checking…");
    expect(html).toContain('id="ht-state"');
    expect(html).not.toContain('id="press"');
    expect(html).not.toContain("/api/buttons/:id/press");
    expect(html).not.toContain("data-button-page");
  });

  test("keeps the workflow run line and editor script for a workflow button", () => {
    const workflow: WorkflowDefinition = { start: "done", nodes: [{ id: "done", type: "end" }] };
    const html = renderButtonPage({ ctx: testPageContext(), device, workflow, canEditWorkflow: true });
    expect(html).toContain('<ht-button node="device/candles-on">');
    expect(html).toContain('data-button-page data-device-id="candles-on"');
    expect(html).not.toContain("data-api=");
    expect(html).toContain("data-workflow-run");
    expect(html).toContain("/api/buttons/:id/workflow");
    expect(html).toContain('attributeFilter: ["aria-busy"]');
    expect(html).toContain("data-workflow-editor");
  });

  test("renders branches, cycles, and unreachable nodes in the workflow view", () => {
    const workflow: WorkflowDefinition = { start: "check", nodes: [
      { id: "check", type: "condition", device: "relay", path: "state", operator: "truthy", ifTrue: "loop", ifFalse: "done" },
      { id: "loop", type: "delay", durationMs: 1000, next: "loop" },
      { id: "done", type: "end" },
      { id: "unused", type: "end" },
    ] };
    const html = renderWorkflowGraphForTest(workflow);
    expect(html).toContain('aria-label="Workflow state machine"');
    expect(html).toContain("true");
    expect(html).toContain("false");
    expect(html).toContain("↺ loop");
    expect(html).toContain("Unreachable nodes");
    expect(html).toContain("unused");
  });

  test("reads a chain of actions and waits as steps, and anything branching as a state machine", () => {
    const timer: WorkflowDefinition = { start: "on", nodes: [
      { id: "on", type: "action", device: "lamp", control: "turnOn", next: "wait" },
      { id: "wait", type: "delay", durationMs: 300000, next: "off" },
      { id: "off", type: "action", device: "lamp", control: "turnOff", next: "done" },
      { id: "done", type: "end" },
    ] };
    expect(workflowSteps(timer)?.map((step) => step.type)).toEqual(["action", "wait", "action"]);
    expect(workflowSteps({ start: "done", nodes: [{ id: "done", type: "end" }] })).toEqual([]);
    expect(workflowSteps({ start: "loop", nodes: [{ id: "loop", type: "delay", durationMs: 1, next: "loop" }] })).toBeUndefined();
    expect(workflowSteps({ start: "done", nodes: [{ id: "done", type: "end" }, { id: "stray", type: "end" }] })).toBeUndefined();
    expect(workflowSteps({ start: "check", nodes: [
      { id: "check", type: "condition", device: "lamp", path: "on", operator: "truthy", ifTrue: "done", ifFalse: "done" },
      { id: "done", type: "end" },
    ] })).toBeUndefined();
  });

  test("edits a simple workflow as steps, with waits in the largest whole unit", () => {
    const workflow: WorkflowDefinition = { start: "on", nodes: [
      { id: "on", type: "action", device: "lamp", control: "turnOn", next: "wait" },
      { id: "wait", type: "delay", durationMs: 300000, next: "off" },
      { id: "off", type: "action", device: "lamp", control: "turnOff" },
    ] };
    const html = renderButtonPage({ ctx: testPageContext(), device, workflow, canEditWorkflow: true, workflowRun: { id: "r", status: "running", currentNodeId: "wait", steps: 2 },
      workflowTargets: [{ id: "lamp", name: "Lamp", room: "Den", controls: ["turnOn", "turnOff", "toggle"] }, { id: "candles-on", name: "Candles on", controls: ["press"] }] });
    expect(html).toContain("data-steps-editor");
    expect(html).toContain('<optgroup label="Den"><option value="lamp" selected>Lamp</option></optgroup>');
    expect(html).toContain('<option value="turnOff" selected>Turn off</option>');
    expect(html).toContain('<li aria-current="step" class="workflow-step" data-step="wait"');
    expect(html).toContain('value="5" aria-label="Duration"');
    expect(html).toContain('<option value="60000" selected>minutes</option>');
    expect(html).toContain("Add on, wait, off");
    expect(html).not.toContain('value="candles-on"');
    expect(html).not.toContain('aria-label="Workflow state machine"');
  });
});
