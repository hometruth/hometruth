import type { FromSchema } from "json-schema-to-ts";

const conditionId = "https://hometruth.ai/schemas/filter-condition";
const pointer = { type: "string", minLength: 1, maxLength: 500, pattern: "^(?:/(?:[^~/]|~[01])*)+$",
  description: "JSON Pointer into the Event envelope, including /data for type-specific payload fields." } as const;
const scalar = { anyOf: [{ type: "string", maxLength: 4000 }, { type: "number" }, { type: "boolean" }, { type: "null" }] } as const;
const children = { type: "array", minItems: 1, maxItems: 64, items: { $ref: conditionId } } as const;
const clockTime = { type: "string", pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" } as const;
const timestamp = {
  type: "object", additionalProperties: false,
  properties: { path: pointer, format: { enum: ["dateTime", "unixSeconds", "unixMilliseconds"] } },
  required: ["path", "format"],
} as const;
const timeWindow = {
  type: "object", additionalProperties: false,
  description: "Recurring local time window [start, end). An end before start crosses midnight. Equal endpoints are invalid. Defaults to Event.at; timestamp selects a source observation time.",
  properties: {
    start: clockTime, end: clockTime,
    timeZone: { type: "string", minLength: 1, maxLength: 100, description: "IANA time zone, such as America/Los_Angeles or UTC; never the server's implicit local zone." },
    timestamp,
  },
  required: ["start", "end", "timeZone"],
} as const;

export const filterConditionSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: conditionId,
  title: "Filter condition",
  description: "A boolean predicate over an Event. All comparisons are typed, missing fields do not match, and all/any/not compose conditions. Limited to 256 conditions and 16 levels at runtime.",
  type: "object",
  oneOf: [
    { type: "object", additionalProperties: false, properties: { all: { ...children, minItems: 0 } }, required: ["all"] },
    { type: "object", additionalProperties: false, properties: { any: children }, required: ["any"] },
    { type: "object", additionalProperties: false, properties: { not: { $ref: conditionId } }, required: ["not"] },
    { type: "object", additionalProperties: false, properties: { path: pointer, op: { enum: ["eq", "ne", "contains"] }, value: scalar }, required: ["path", "op", "value"] },
    { type: "object", additionalProperties: false, properties: { path: pointer, op: { enum: ["gt", "gte", "lt", "lte"] }, value: { type: "number" } }, required: ["path", "op", "value"] },
    { type: "object", additionalProperties: false, properties: { path: pointer, op: { const: "in" }, value: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: scalar } }, required: ["path", "op", "value"] },
    { type: "object", additionalProperties: false, properties: { path: pointer, op: { const: "exists" }, value: { type: "boolean" } }, required: ["path", "op", "value"] },
    { type: "object", additionalProperties: false, properties: { timeWindow }, required: ["timeWindow"] },
    { type: "object", additionalProperties: false, properties: { detectionLabels: {
      type: "array", minItems: 1, maxItems: 100, uniqueItems: true,
      items: { type: "string", minLength: 1, maxLength: 200, pattern: "^[^\\u0000-\\u001f\\u007f]+$" },
      description: "Any selected detection label in Event.data: label, subLabel, classification.label or detections[].label. Labels are trimmed, lowercased and underscores become spaces; human means person, blank means no detection, no CV result means unclassified. Empty detections match no detection.",
    } }, required: ["detectionLabels"] },
  ],
} as const;

export type FilterScalar = string | number | boolean | null;
// Recursive JSON Schemas cannot be inferred by json-schema-to-ts.
export type FilterCondition =
  | { readonly all: readonly FilterCondition[] }
  | { readonly any: readonly FilterCondition[] }
  | { readonly not: FilterCondition }
  | { readonly detectionLabels: readonly string[] }
  | { readonly path: string; readonly op: "eq" | "ne" | "contains"; readonly value: FilterScalar }
  | { readonly path: string; readonly op: "gt" | "gte" | "lt" | "lte"; readonly value: number }
  | { readonly path: string; readonly op: "in"; readonly value: readonly FilterScalar[] }
  | { readonly path: string; readonly op: "exists"; readonly value: boolean }
  | { readonly timeWindow: FromSchema<typeof timeWindow> };

export const filterSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://hometruth.ai/schemas/filter",
  title: "Filter",
  description: "Named criteria over an Event. The live evaluator emits a filter_matched Event for each matching saved Filter; selection and history reads are pure.",
  type: "object", additionalProperties: false,
  properties: {
    schemaId: { const: "https://hometruth.ai/schemas/filter" },
    id: { type: "string", pattern: "^[a-z][a-z0-9-]*$", maxLength: 100 },
    name: { type: "string", minLength: 1, maxLength: 200 },
    description: { type: "string", maxLength: 2000 },
    condition: { $ref: filterConditionSchema.$id },
  },
  required: ["schemaId", "id", "name", "condition"],
} as const;

export interface FilterDocument {
  readonly schemaId: typeof filterSchema.$id;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly condition: FilterCondition;
}

/** API inputs omit identity, which is assigned once when the Filter is saved. */
export const filterFieldsSchema = {
  type: "object", additionalProperties: false,
  properties: { name: filterSchema.properties.name, description: filterSchema.properties.description, condition: filterSchema.properties.condition },
  required: ["name", "condition"],
} as const;
export const filterUpdateSchema = {
  ...filterFieldsSchema,
  properties: { ...filterFieldsSchema.properties, revision: { type: "integer", minimum: 1 } },
  required: ["name", "condition", "revision"],
} as const;
export const savedFilterSchema = {
  type: "object", additionalProperties: false,
  properties: { filter: { $ref: filterSchema.$id }, revision: { type: "integer", minimum: 1 },
    slug: { type: "string", minLength: 1, description: "Current name-based slug for filter and editing-filter in page URLs. APIs use the Filter ID." } },
  required: ["filter", "revision", "slug"],
} as const;
