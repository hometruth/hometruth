import { Speaker } from "../models/speaker";
import Ajv2020 from "ajv/dist/2020";
import { controlRequest } from "../element-api/controls";
import type { Schema } from "../element-api/schema";
import type { Device } from "../models/device";
import { Light } from "../models/light";
import { walkNodes, type WorkflowDefinition } from "./definition";
import { validateWorkflow, WorkflowValidationError } from "./validation";

export interface WorkflowOperation { id: string; label: string; inputSchema: Schema }
export interface WorkflowTarget { id: string; name: string; operations: WorkflowOperation[]; statePaths: string[] }
export const flashInputSchema: Schema = {
  type: "object", additionalProperties: false,
  properties: {
    colors: { type: "array", minItems: 1, maxItems: 16, items: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, default: ["#ff0000", "#ffff00"] },
    count: { type: "integer", minimum: 1, maximum: 100, default: 2 },
    onMs: { type: "integer", minimum: 100, maximum: 10000, default: 500 },
    offMs: { type: "integer", minimum: 100, maximum: 10000, default: 500 },
    brightnessPercent: { type: "number", minimum: 1, maximum: 100, default: 75 },
  }, required: ["colors", "count", "onMs", "offMs", "brightnessPercent"],
};
const STATE_FIELDS: Record<string, string[]> = {
  light: ["on", "brightnessPercent", "color", "colorTemperatureKelvin"], binarySwitch: ["value"],
  speaker: ["playback", "volumePercent", "muted"], contactSensor: ["open"], motionSensor: ["motion"],
};
export function workflowCatalog(devices: readonly Device[]): WorkflowTarget[] {
  // Reading this catalogue does not probe or operate devices.
  return devices.filter(d => d.model.id !== "workflow-button").map(device => {
    const operations: WorkflowOperation[] = [];
    const statePaths: string[] = [];
    for (const capability of Object.values(device.capabilities)) {
      if (!capability) continue;
      for (const control of capability.controlIds.filter(c => !/^(get|read|latest)/.test(c))) {
        const schema = structuredClone(controlRequest(capability.kind, control));
        delete (schema.properties as Schema).confirmed;
        // Arbitrary confirmation cannot be supplied by an imported or generated workflow.
        operations.push({ id: `${capability.kind}.${control}`, label: control.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase()), inputSchema: schema });
      }
      statePaths.push(...["availability", ...(STATE_FIELDS[capability.kind] ?? [])].map(field => `/capabilities/${capability.kind}/state/${field}`));
    }
    const speaker = device.capability("speaker");
    if (speaker instanceof Speaker && speaker.supportsSounds()) operations.unshift({ id: "speaker.playSound", label: "Play dinner bell (idle speaker)", inputSchema: {
      type: "object", additionalProperties: false, properties: { sound: { type: "string", enum: ["dinnerBell"] }, volumePercent: { type: "number", minimum: 0, maximum: 100, default: 50 } }, required: ["sound", "volumePercent"],
    } });
    const light = device.capability("light");
    if (light instanceof Light && light.supportsColor()) operations.unshift({ id: "light.flash", label: "Flash colors, then restore", inputSchema: flashInputSchema });
    return { id: device.id, name: device.name, operations, statePaths };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
export function validateWorkflowTargets(workflow: WorkflowDefinition, devices: readonly Device[], ownId?: string): void {
  validateWorkflow(workflow);
  const catalog = new Map(workflowCatalog(devices).map(t => [t.id, t]));
  for (const { node, key } of walkNodes(workflow.graph)) {
    const id = node.type === "action" ? node.action.target : node.type === "condition" || node.type === "waitFor" ? node.predicate.target : undefined;
    if (!id) continue;
    const target = catalog.get(id);
    if (!target || id === ownId) throw new WorkflowValidationError(`${key}: choose a configured target (nested workflow calls are not supported)`);
    if (node.type === "action") {
      const operation = target.operations.find(op => op.id === node.action.operation);
      if (!operation) throw new WorkflowValidationError(`${key}: ${target.name} does not support ${node.action.operation}`);
      const schemaKey = JSON.stringify(operation.inputSchema);
      let check = validators.get(schemaKey);
      if (!check) { check = ajv.compile(operation.inputSchema); validators.set(schemaKey, check); }
      if (!check(node.action.input)) throw new WorkflowValidationError(`${key}: ${ajv.errorsText(check.errors)}`);
    }
    if (node.type === "condition" || node.type === "waitFor") {
      const kind = node.predicate.path.split("/")[2];
      if (!target.statePaths.some(path => path.startsWith(`/capabilities/${kind}/state/`))) throw new WorkflowValidationError(`${key}: the target does not have the predicate capability`);
      if (["greaterThan", "lessThan"].includes(node.predicate.operator) && typeof node.predicate.value !== "number") throw new WorkflowValidationError(`${key}: numeric comparisons require a number`);
      if (!/^\/capabilities\/[^/]+\/state\/[^/]+/.test(node.predicate.path) || /~(?![01])/.test(node.predicate.path)) throw new WorkflowValidationError(`${key}: state path must be a JSON Pointer under /capabilities/<kind>/state/`);
    }
  }
}
