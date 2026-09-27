const empty = { type: "object", additionalProperties: false } as const;
export const cooktopSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://hometruth.ai/schemas/cooktop", title: "Cooktop",
  type: "object", additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 100 },
    state: {
      type: "object", additionalProperties: false,
      properties: {
        availability: { enum: ["online", "offline", "degraded", "unknown"] },
        observedAt: { type: "string", format: "date-time" },
        detail: { type: "string", maxLength: 500 },
        power: { enum: ["on", "off"] }, childLocked: { type: "boolean" },
        timerSeconds: { type: "integer", minimum: 0, maximum: 5940 },
        remoteControl: { type: "boolean" },
        zones: { type: "array", maxItems: 10, items: {
          type: "object", additionalProperties: false,
          properties: {
            id: { type: "string", maxLength: 50 },
            position: { enum: ["frontLeft", "rearLeft", "rearRight", "frontRight", "leftCombined"] },
            state: { enum: ["off", "active", "hot", "unavailable", "unknown"] },
            level: { type: "number", minimum: 0, maximum: 9 },
            mode: { enum: ["normal", "keepWarm", "boost", "shortBoost"] },
          }, required: ["id", "position", "state"],
        } },
      }, required: ["availability"],
      dependentRequired: { power: ["observedAt"], childLocked: ["observedAt"], timerSeconds: ["observedAt"], zones: ["observedAt"] },
    },
    actions: { type: "object", additionalProperties: false, properties: { getState: empty, setChildLock: empty, setTimer: empty } },
  }, required: ["id", "state", "actions"],
} as const;
