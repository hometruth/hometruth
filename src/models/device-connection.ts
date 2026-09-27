import type { FromSchema } from "json-schema-to-ts";

const dialect = "https://json-schema.org/draft/2020-12/schema" as const;

/** A controlled vocabulary for the path HomeTruth uses to reach a device. */
export const deviceConnectionTypeSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/device-connection-type",
  title: "Device connection type",
  description: "A normalized way HomeTruth reaches a physical or logical device.",
  type: "string",
  enum: ["direct-local", "local-hub", "cloud", "bluetooth", "usb", "composed"],
} as const;

export type DeviceConnectionType = FromSchema<typeof deviceConnectionTypeSchema>;
