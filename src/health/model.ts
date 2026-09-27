import type { FromSchema } from "json-schema-to-ts";
import type { Availability } from "../models/capability";

export const healthValueSchema = {
  type: "object", additionalProperties: false,
  properties: {
    status: { enum: ["healthy", "degraded", "unhealthy", "unknown", "disabled"] },
    detail: { type: "string", minLength: 1, maxLength: 300 },
    checkedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
  },
  required: ["status", "detail", "checkedAt"],
  anyOf: [
    { properties: { status: { const: "unknown" } } },
    { properties: { checkedAt: { type: "string", format: "date-time" } } },
  ],
} as const;

export const healthCheckSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://hometruth.ai/schemas/health-check", title: "Health check",
  description: "The mandatory answer to are you OK. Unknown and disabled are not evidence of uptime; checkedAt is null until an observation exists.",
  ...healthValueSchema,
} as const;

export type HealthCheck = FromSchema<typeof healthValueSchema>;
export type HealthStatus = HealthCheck["status"];
export type HealthResult = Omit<HealthCheck, "checkedAt">;
export type HealthKind = "device" | "service";
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;
export const ERROR_REPEAT_MS = 5 * 60 * 1000;
export const ERROR_RECHECK_MS = 5 * 60 * 1000;

export function availabilityHealth(availability: Availability): HealthResult {
  switch (availability) {
    case "online": return { status: "healthy", detail: "Responding normally" };
    case "offline": return { status: "unhealthy", detail: "Not responding" };
    case "degraded": return { status: "degraded", detail: "Some functions are unavailable" };
    case "unknown": return { status: "unknown", detail: "No reliable health observation" };
  }
}

export const isProblem = (status: HealthStatus): boolean => status === "unhealthy" || status === "degraded";

const entityProperties = { key: { type: "string" }, kind: { enum: ["device", "service"] }, id: { type: "string" }, name: { type: "string" } } as const;
const nullableTime = { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] } as const;
export const healthReportSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema", $id: "https://hometruth.ai/schemas/health-report",
  title: "Health report", description: "Observed availability and recent problems. Uptime is healthy time divided by known enabled time. Unknown, unmonitored and disabled time are excluded; this is not hardware boot uptime.",
  type: "object", additionalProperties: false,
  properties: {
    since: { type: "string", format: "date-time" }, until: { type: "string", format: "date-time" }, pollIntervalMs: { type: "number", minimum: 1 },
    entities: { type: "array", items: { type: "object", additionalProperties: false, properties: {
      ...entityProperties, health: healthValueSchema, healthySince: nullableTime,
      uptimePercent: { anyOf: [{ type: "number", minimum: 0, maximum: 100 }, { type: "null" }] },
      observedMs: { type: "number", minimum: 0 }, unknownMs: { type: "number", minimum: 0 }, disabledMs: { type: "number", minimum: 0 },
    }, required: ["key", "kind", "id", "name", "health", "healthySince", "uptimePercent", "observedMs", "unknownMs", "disabledMs"] } },
    problems: { type: "array", items: { type: "object", additionalProperties: false, properties: {
      ...entityProperties, detail: { type: "string" }, startedAt: { type: "string", format: "date-time" }, lastAt: { type: "string", format: "date-time" },
      resolvedAt: nullableTime, occurrences: { type: "integer", minimum: 1 },
    }, required: ["key", "kind", "id", "name", "detail", "startedAt", "lastAt", "resolvedAt", "occurrences"] } },
  }, required: ["since", "until", "pollIntervalMs", "entities", "problems"],
} as const;

/** Device and service implementations can report failures without waiting for the hourly check. */
export abstract class HealthReporter {
  #latest: HealthCheck = { status: "unknown", detail: "Not checked yet", checkedAt: null };
  private readonly healthListeners = new Set<(health: HealthCheck) => void>();
  get health(): HealthCheck { return this.#latest; }
  abstract checkHealth(): Promise<HealthCheck>;

  /** Use a credential-free, human-facing description; never pass an upstream error body. */
  reportHealth(result: HealthResult): HealthCheck {
    this.#latest = { status: result.status, detail: result.detail, checkedAt: new Date().toISOString() };
    for (const listener of this.healthListeners) {
      try { listener(this.#latest); }
      catch { console.warn(JSON.stringify({ event: "health_report_delivery_failed" })); }
    }
    return this.#latest;
  }

  subscribeHealth(listener: (health: HealthCheck) => void): () => void {
    this.healthListeners.add(listener);
    return () => { this.healthListeners.delete(listener); };
  }
}
