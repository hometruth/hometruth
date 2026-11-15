const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object" as const, additionalProperties: false, properties, required });
const id = { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 };
const label = { type: "string", minLength: 1, maxLength: 200 };
const duration = { type: "integer", minimum: 1, maximum: 86400000 };
const graphRef = { $ref: "https://hometruth.ai/schemas/workflow#/$defs/graph" };
const predicate = object({ target: id, path: { type: "string", pattern: "^/", maxLength: 200 }, operator: { enum: ["equals", "notEquals", "greaterThan", "lessThan"] }, value: {} });
const node = (type: string, properties: Record<string, unknown>) => object({ id, type: { const: type }, label, ...properties }, ["id", "type", ...Object.keys(properties)]);

/** Canonical behavior only. Presentation and execution state have separate contracts. */
export const workflowSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema", $id: "https://hometruth.ai/schemas/workflow", title: "Workflow",
  description: "A portable HomeTruth state machine. Operations use typed catalog inputs; target references are configured device IDs. Saving does not execute it. Canvas and runtime data are not part of this document.",
  ...object({
    schemaVersion: { const: 1 }, name: label, description: { type: "string", maxLength: 10000 },
    runPolicy: { enum: ["ignoreWhileRunning", "replaceAfterCleanup"] },
    limits: object({ maxSteps: { type: "integer", minimum: 1, maximum: 10000 }, maxDurationMs: duration }), graph: graphRef,
  }),
  $defs: {
    graph: object({ entry: id, nodes: { type: "array", minItems: 1, maxItems: 200, items: {
      oneOf: [
        node("action", { action: object({ operation: { type: "string", minLength: 1, maxLength: 120 }, target: id, input: { type: "object" } }), next: id, onError: id }),
        node("delay", { durationMs: duration, next: id }),
        node("condition", { predicate, ifTrue: id, ifFalse: id, onUnknown: id }),
        node("parallel", { branches: { type: "array", minItems: 2, maxItems: 16, items: graphRef }, next: id, onError: id }),
        node("repeat", { count: { type: "integer", minimum: 1, maximum: 100 }, body: graphRef, next: id, onError: id }),
        node("waitFor", { predicate, timeoutMs: duration, onMatch: id, onTimeout: id, onUnknown: id }),
        node("end", { outcome: { enum: ["success", "failure"] } }),
      ],
    } } }),
  },
} as const;

export const workflowPresentationSchema = object({ positions: {
  type: "object", maxProperties: 200, propertyNames: { type: "string", maxLength: 1600 },
  additionalProperties: object({ x: { type: "number", minimum: -100000, maximum: 100000 }, y: { type: "number", minimum: -100000, maximum: 100000 } }),
} });
