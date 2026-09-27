import type { FromSchema } from "json-schema-to-ts";

/** The common event envelope. `data` is checked separately against its type's PayloadSchema. */
export const eventSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://hometruth.ai/schemas/event",
  title: "Event",
  description: "A recorded fact with a timestamp, catalogued type, optional device subject, and a payload in data described by that type's PayloadSchema.",
  type: "object",
  additionalProperties: false,
  properties: {
    at: { type: "string", format: "date-time", description: "Envelope timestamp: recording time for live logs, or a preserved source time for imports. Payloads can carry their own observation times." },
    level: { enum: ["info", "warn", "error"] },
    type: { type: "string", minLength: 1, maxLength: 100 },
    message: { type: "string", minLength: 1, maxLength: 1000 },
    subject: { type: "string", minLength: 1, maxLength: 200 },
    data: { type: "object", maxProperties: 30 },
  },
  required: ["at", "level", "type", "message"],
} as const;

export type Event = FromSchema<typeof eventSchema>;
