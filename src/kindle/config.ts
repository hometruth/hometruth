import Ajv from "ajv/dist/2020.js";
import type { FromSchema } from "json-schema-to-ts";

const itemProperties = {
  source: { enum: ["device", "group"] },
  deviceId: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", maxLength: 100 },
  capability: { enum: ["auto", "cooktop", "camera", "treatDispenser", "light", "stringLight", "binarySwitch", "infraredBlaster", "radioFrequencyBlaster", "radioFrequencyReceiver", "occupancySensor", "sensor", "contactSensor", "hub", "motionSensor", "speaker", "television", "button"] },
  mode: { enum: ["auto", "status"] },
  label: { type: "string", maxLength: 80 },
} as const;

const frameProperties = {
  id: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
  x: { type: "integer", minimum: 0, maximum: 2400 },
  y: { type: "integer", minimum: 0, maximum: 2400 },
  width: { type: "integer", minimum: 8, maximum: 2400 },
  height: { type: "integer", minimum: 4, maximum: 2400 },
  fontSize: { type: "integer", minimum: 14, maximum: 120 },
  align: { enum: ["left", "center", "right"] },
  border: { type: "boolean" },
} as const;
const frameRequired = ["id", "kind", "x", "y", "width", "height", "fontSize", "align", "border"] as const;
export const canvasLayoutSchema = {
  type: "object", additionalProperties: false,
  properties: {
    width: { type: "integer", minimum: 300, maximum: 2400 },
    height: { type: "integer", minimum: 300, maximum: 2400 },
    grid: { type: "integer", minimum: 1, maximum: 64 },
    widgets: { type: "array", maxItems: 80, items: { anyOf: [
      { type: "object", additionalProperties: false, properties: { ...frameProperties, ...itemProperties, kind: { const: "device" }, showLabel: { type: "boolean" }, width: { type: "integer", minimum: 128, maximum: 2400 }, height: { type: "integer", minimum: 96, maximum: 2400 } }, required: [...frameRequired, "deviceId", "capability", "mode", "label", "showLabel"] },
      { type: "object", additionalProperties: false, properties: { ...frameProperties, kind: { const: "text" }, text: { type: "string", maxLength: 2000 } }, required: [...frameRequired, "text"] },
      { type: "object", additionalProperties: false, properties: { ...frameProperties, kind: { const: "clock" }, format: { enum: ["time", "dateTime"] } }, required: [...frameRequired, "format"] },
      { type: "object", additionalProperties: false, properties: { ...frameProperties, kind: { const: "rule" } }, required: frameRequired },
    ] } },
  }, required: ["width", "height", "grid", "widgets"],
} as const;

export const kindleConfigSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://hometruth.ai/schemas/kindle-config",
  title: "Kindle view configuration",
  type: "object", additionalProperties: false,
  properties: {
    version: { const: 1 },
    canvas: canvasLayoutSchema,
    title: { type: "string", minLength: 1, maxLength: 80 },
    refreshSeconds: { type: "integer", minimum: 15, maximum: 3600 },
    rowsPerPage: { type: "integer", minimum: 1, maximum: 8 },
    fontSize: { type: "integer", minimum: 18, maximum: 32 },
    selection: { enum: ["all", "custom"] },
    items: {
      type: "array", maxItems: 200,
      items: {
        type: "object", additionalProperties: false,
        properties: itemProperties,
        required: ["deviceId", "capability", "mode", "label"],
      },
    },
  },
  required: ["version", "title", "refreshSeconds", "rowsPerPage", "fontSize", "selection", "items"],
} as const;

export type KindleConfig = FromSchema<typeof kindleConfigSchema>;
export type CanvasLayout = FromSchema<typeof canvasLayoutSchema>;
export type CanvasWidget = CanvasLayout["widgets"][number];
export type DeviceWidget = Extract<CanvasWidget, { kind: "device" }>;
export type KindleItem = KindleConfig["items"][number];
export const DEFAULT_KINDLE_CONFIG: KindleConfig = {
  version: 1, title: "HomeTruth", refreshSeconds: 60, rowsPerPage: 4,
  fontSize: 22, selection: "all", items: [],
};
const validate = new Ajv({ allErrors: true }).compile<KindleConfig>(kindleConfigSchema);
export class KindleConfigError extends Error {
  constructor(message: string, readonly code: "invalid" | "conflict") { super(message); }
}
export function parseKindleConfig(value: unknown): KindleConfig {
  if (!validate(value)) throw new KindleConfigError("Invalid Kindle configuration", "invalid");
  if (!value.title.trim()) throw new KindleConfigError("A title is required", "invalid");
  if (value.canvas) {
    const ids = new Set<string>();
    for (const widget of value.canvas.widgets) {
      if (ids.has(widget.id)) throw new KindleConfigError("Widget IDs must be unique", "invalid");
      ids.add(widget.id);
      if (widget.x + widget.width > value.canvas.width || widget.y + widget.height > value.canvas.height) throw new KindleConfigError("Widgets must fit inside the canvas", "invalid");
    }
  }
  return structuredClone(value);
}
