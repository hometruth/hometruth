import type { FromSchema } from "json-schema-to-ts";
import { healthValueSchema } from "./model";

const timestamp = { type: "string", format: "date-time" } as const;
const entity = {
  type: "object", additionalProperties: false,
  properties: { key: { type: "string" }, kind: { enum: ["device", "service"] }, id: { type: "string" }, name: { type: "string" } },
  required: ["key", "kind", "id", "name"],
} as const;

/** Claude's review of an investigation, present only when an Anthropic API key is configured. */
export const adviceSchema = {
  type: "object", additionalProperties: false,
  properties: {
    status: { enum: ["complete", "skipped", "failed"] },
    note: { type: "string" },
    model: { type: "string" },
    costUsd: { type: "number", minimum: 0 },
    summary: { type: "string" },
    likelyCause: { type: "string" },
    confidence: { enum: ["low", "medium", "high"] },
    proposals: { type: "array", items: {
      type: "object", additionalProperties: false,
      properties: { title: { type: "string" }, rationale: { type: "string" }, steps: { type: "array", items: { type: "string" } }, changesDevice: { type: "boolean" } },
      required: ["title", "rationale", "steps", "changesDevice"],
    } },
  },
  required: ["status", "note", "model", "costUsd"],
} as const;
export type HealthAdvice = FromSchema<typeof adviceSchema>;

export const investigationSummarySchema = {
  title: "Health investigation", description: "A saved investigation created immediately when an executed action fails.",
  type: "object", additionalProperties: false,
  properties: {
    id: { type: "string", format: "uuid" }, title: { type: "string" }, href: { type: "string" },
    status: { enum: ["starting", "checking", "complete", "interrupted"] },
    createdAt: timestamp, updatedAt: timestamp,
  },
  required: ["id", "title", "href", "status", "createdAt", "updatedAt"],
} as const;

export const investigationListSchema = {
  title: "Recent health investigations", type: "array", items: investigationSummarySchema,
} as const;

export const investigationSchema = {
  ...investigationSummarySchema,
  properties: {
    ...investigationSummarySchema.properties,
    entity, trigger: healthValueSchema, progress: { type: "string" },
    observations: { type: "array", items: {
      type: "object", additionalProperties: false,
      properties: { entity, health: healthValueSchema }, required: ["entity", "health"],
    } },
    summary: { type: "string" }, likelyCause: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
    advice: adviceSchema,
  },
  required: [...investigationSummarySchema.required, "entity", "trigger", "progress", "observations", "summary", "likelyCause", "steps"],
} as const;

export type HealthInvestigation = FromSchema<typeof investigationSchema>;
export type InvestigationSummary = FromSchema<typeof investigationSummarySchema>;

export function investigationSummary(value: HealthInvestigation): InvestigationSummary {
  const { id, title, href, status, createdAt, updatedAt } = value;
  return { id, title, href, status, createdAt, updatedAt };
}
