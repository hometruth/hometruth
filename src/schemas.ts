export { healthCheckSchema, healthReportSchema } from "./health/model";
import { healthValueSchema } from "./health/model";
import { eventSchema } from "./models/event-schema";
export { eventSchema, type Event } from "./models/event-schema";
export { filterSchema, filterConditionSchema, type FilterDocument, type FilterCondition } from "./models/filter-schema";
import { cooktopSchema } from "./models/cooktop-schema";
import { deviceConnectionTypeSchema } from "./models/device-connection";
export { cooktopSchema };
export { deviceConnectionTypeSchema };
export type { DeviceConnectionType } from "./models/device-connection";
export { tagSchema } from "./tags/model";
import { sensorDefinition, sensorSchema, temperatureSensorSchema, humiditySensorSchema, batterySensorSchema, sensorCollectionSchema, occupancySensorSchema, contactSensorSchema, hubSchema } from "./models/sensor-schemas";
export { sensorSchema, temperatureSensorSchema, humiditySensorSchema, batterySensorSchema, sensorCollectionSchema, occupancySensorSchema, contactSensorSchema, hubSchema };
import type { FromSchema } from "json-schema-to-ts";

const dialect = "https://json-schema.org/draft/2020-12/schema" as const;

export const appConfigSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/app-config",
  type: "object",
  additionalProperties: false,
  properties: {
    devHubEnabled: { type: "boolean" },
    hostname: { type: "string", minLength: 1, maxLength: 253 },
    preferredPort: { type: "integer", minimum: 0, maximum: 65535 },
    mode: { enum: ["development", "production", "test"] },
  },
  required: ["devHubEnabled", "hostname", "preferredPort", "mode"],
} as const;

export const hubDiscoverySchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/dev-hub-discovery",
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    url: { type: "string", format: "uri" },
    token: { type: "string", minLength: 32, maxLength: 256 },
    pid: { type: "integer", minimum: 1 },
    startedAt: { type: "string", format: "date-time" },
  },
  required: ["schemaVersion", "url", "token", "pid", "startedAt"],
} as const;

export const roomNameSchema = { type: "string", minLength: 1, maxLength: 100, pattern: "^\\S(?:[^\\r\\n]*\\S)?$" } as const;

export const automaticGroupCriteriaSchema = {
  type: "object", additionalProperties: false, minProperties: 1,
  properties: {
    room: roomNameSchema,
    schemaId: { type: "string", minLength: 1, maxLength: 500, pattern: "^https?://\\S+$" },
    tagIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", format: "uuid" } },
  },
} as const;
export type AutomaticGroupCriteria = FromSchema<typeof automaticGroupCriteriaSchema>;

export const deviceGroupConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 },
    name: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
    criteria: automaticGroupCriteriaSchema,
    members: { type: "array", minItems: 2, maxItems: 100, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 100 } },
    room: roomNameSchema,
    asSwitch: { type: "boolean" },
  },
  required: ["id", "name"],
  oneOf: [{ properties: { members: {} }, required: ["members"] }, { properties: { criteria: {} }, required: ["criteria"] }],
} as const;
export type DeviceGroupConfig = FromSchema<typeof deviceGroupConfigSchema>;
/** Runtime membership is resolved, never persisted for an automatic group. */
export type DeviceGroup = Omit<DeviceGroupConfig, "members"> & { members: string[]; builtIn?: boolean };

export const deviceGroupSettingsSchema = {
  type: "object", additionalProperties: false, minProperties: 1,
  properties: {
    criteria: automaticGroupCriteriaSchema,
    members: deviceGroupConfigSchema.properties.members,
    room: { anyOf: [roomNameSchema, { type: "null" }] },
    asSwitch: { type: "boolean" },
  },
} as const;
export type DeviceGroupSettings = FromSchema<typeof deviceGroupSettingsSchema>;

export const devicesConfigSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/devices-config",
  title: "Local devices configuration",
  description: "The site-specific device inventory kept in the private installation devices.yml file: each entry is an instance of a model (model id + that model's config), separate from the generic HomeTruth project.",
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 2 },
    rooms: { type: "array", maxItems: 400, uniqueItems: true, items: roomNameSchema },
    deviceGroups: { type: "array", maxItems: 400, items: deviceGroupConfigSchema },
    devices: {
      type: "array",
      maxItems: 400,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 },
          name: { type: "string", minLength: 1, maxLength: 200 },
          room: roomNameSchema,
          /** Stable LAN identity used to find the client even when DHCP gives it the wrong address. */
          mac: { type: "string", pattern: "^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}$" },
          /** A model id from the registry, e.g. shelly-plus-1. */
          model: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$", minLength: 1, maxLength: 100 },
          /** Validated against the model's own config schema when the site is provisioned. */
          config: { type: "object", maxProperties: 100 },
          /**
           * What this device looks like in a list or on the graph: an emoji, or
           * a local image under /icons. Overrides the model's own icon. Not part
           * of `config`, which is closed per model.
           */
          icon: {
            oneOf: [
              { type: "string", minLength: 1, maxLength: 16 },
              {
                type: "object", additionalProperties: false,
                properties: { image: { type: "string", minLength: 1, maxLength: 512 }, alt: { type: "string", maxLength: 200 } },
                required: ["image"],
              },
            ],
          },
          /** Kept in the inventory but not provisioned when false; defaults to true. */
          enabled: { type: "boolean" },
        },
        required: ["id", "model", "config"],
      },
    },
  },
  required: ["schemaVersion"],
  examples: [{
    schemaVersion: 2,
    devices: [
      { id: "kitchen-camera", name: "Kitchen pet camera", model: "tkenpro-2k-pet-camera-treat-dispenser", config: { host: "10.78.0.147" } },
      { id: "shelly-relay", name: "Shelly Plus 1 relay", model: "shelly-plus-1", config: { host: "10.77.0.228" } },
      { id: "desk-keylight", name: "Desk Key Light Air", mac: "02:00:00:79:a4:08", model: "elgato-key-light-air", config: { host: "10.77.0.153" } },
      { id: "living-room-blaster", name: "Living room IR/RF blaster", model: "broadlink-rm4-pro", config: { host: "10.77.0.154" } },
    ],
  }],
} as const;

/** The capability names a HomeTruth object may carry; see homeTruthObjectSchema. */
export const capabilityKindSchema = {
  enum: ["cooktop", "camera", "treatDispenser", "light", "stringLight", "binarySwitch", "infraredBlaster", "radioFrequencyBlaster", "radioFrequencyReceiver", "motionSensor", "speaker", "television", "button", "sensor", "occupancySensor", "contactSensor", "hub"],
} as const;

export const modelListResponseSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/model-list-response",
  title: "Model list",
  description: "Every device model HomeTruth can provision: its capabilities, connection types, the config schema an instance needs, and the object schema an instance describes itself with.",
  type: "object",
  additionalProperties: false,
  properties: {
    models: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$", minLength: 1, maxLength: 100 },
          title: { type: "string", minLength: 1, maxLength: 200 },
          manufacturer: { type: "string", minLength: 1, maxLength: 200 },
          product: { type: "string", minLength: 1, maxLength: 200 },
          capabilities: { type: "array", maxItems: 20, items: capabilityKindSchema },
          connectionTypes: { type: "array", minItems: 1, maxItems: 10, uniqueItems: true, items: { $ref: deviceConnectionTypeSchema.$id } },
          sensors: { type: "array", maxItems: 100, items: sensorDefinition },
          configSchema: { type: "object" },
          /** What an instance needs in the secrets file, when the model needs anything. */
          secretsSchema: { type: "object" },
          objectSchemaId: { type: "string", format: "uri" },
        },
        required: ["id", "title", "manufacturer", "product", "capabilities", "connectionTypes", "configSchema", "objectSchemaId"],
      },
    },
  },
  required: ["models"],
} as const;

export const deviceDetailResponseSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/device-detail-response",
  title: "Device detail",
  description: "One provisioned device: which model it is an instance of, how HomeTruth reaches it, the config that made it, and its current object document.",
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 },
    name: { type: "string", minLength: 1, maxLength: 200 },
    room: roomNameSchema,
    page: { type: "string", pattern: "^/(devices|switches|lights|string-lights|buttons|cameras|sensors|hubs|blasters|speakers|groups)/[A-Za-z0-9._:%-]+$" },
    model: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$", minLength: 1, maxLength: 100 },
        title: { type: "string", minLength: 1, maxLength: 200 },
        manufacturer: { type: "string", minLength: 1, maxLength: 200 },
        product: { type: "string", minLength: 1, maxLength: 200 },
        capabilities: { type: "array", maxItems: 20, items: capabilityKindSchema },
        connectionTypes: { type: "array", minItems: 1, maxItems: 10, uniqueItems: true, items: { $ref: deviceConnectionTypeSchema.$id } },
          sensors: { type: "array", maxItems: 100, items: sensorDefinition },
        objectSchemaId: { type: "string", format: "uri" },
      },
      required: ["id", "title", "manufacturer", "product", "capabilities", "connectionTypes", "objectSchemaId"],
    },
    config: { type: "object", maxProperties: 100 },
    /** Which secrets the instance has, by top-level key; never the values. */
    secrets: { type: "object", maxProperties: 50, additionalProperties: { type: "boolean" } },
    /** The device's control names, as POST /api/devices/{id}/controls/{control} accepts them: bare when one capability owns the control, `<capability>.<control>` when several do. */
    controls: { type: "array", maxItems: 200, items: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9]*(?:\\.[a-zA-Z][a-zA-Z0-9]*)*$", minLength: 1, maxLength: 100 } },
    /** False when the device is kept in the inventory but switched off: no controls, no background polling. */
    enabled: { type: "boolean" },
    object: { $ref: "https://hometruth.ai/schemas/object" },
  },
  required: ["id", "name", "page", "model", "config", "secrets", "controls", "enabled", "object"],
} as const;

export const deviceControlRequestSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/device-control-request",
  title: "Device control request",
  description: "Invoke one control of one capability on a device: the argument, if the control takes one, and whether a control that asks for confirmation has been confirmed.",
  type: "object",
  additionalProperties: false,
  properties: {
    value: {
      anyOf: [
        { type: "boolean" },
        { type: "string", maxLength: 4096 },
        { type: "number" },
        { type: "null" },
        { type: "array", maxItems: 100 },
        { type: "object", maxProperties: 100 },
      ],
    },
    confirmed: { type: "boolean" },
  },
} as const;

export const deviceRoomRequestSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/device-room-request",
  title: "Device room request",
  type: "object",
  additionalProperties: false,
  properties: { room: { anyOf: [roomNameSchema, { type: "null" }] } },
  required: ["room"],
} as const;

export const deviceEnabledSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/device-enabled",
  title: "Device enabled",
  description: "Whether this device is enabled in HomeTruth. Disabled devices remain in the inventory and refuse controls.",
  type: "boolean",
} as const;

export const deviceRenameRequestSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/device-rename-request",
  title: "Device rename request",
  description: "Changes the human-facing name of one configured device without changing its stable id.",
  type: "object",
  additionalProperties: false,
  properties: { name: { type: "string", minLength: 1, maxLength: 200 } },
  required: ["name"],
} as const;

export const deviceRenameResponseSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/device-rename-response",
  title: "Device rename response",
  description: "The stable identity, new name, and page of a renamed device.",
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 },
    name: { type: "string", minLength: 1, maxLength: 200 },
    page: { type: "string", pattern: "^/(devices|switches|lights|string-lights|buttons|cameras|sensors|hubs|blasters|speakers|groups)/[A-Za-z0-9._:%-]+$" },
  },
  required: ["id", "name", "page"],
} as const;

export const deviceParentSchema = {
  type: "object", additionalProperties: false,
  properties: { id: { type: "string", minLength: 1, maxLength: 100 }, index: { type: "integer", minimum: 0, maximum: 999 } },
  required: ["id", "index"],
} as const;

export const deviceListResponseSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/device-list-response",
  title: "Device list",
  description: "Every device defined in devices.yml with its kind, connection types, the schema its page renders, and its last known availability.",
  type: "object",
  additionalProperties: false,
  properties: {
    devices: {
      type: "array",
      maxItems: 400,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 },
          name: { type: "string", minLength: 1, maxLength: 200 },
          room: roomNameSchema,
          parent: deviceParentSchema,
          kind: { enum: ["device", "binary-switch", "pet-camera", "camera", "light", "string-light", "ir-rf-blaster", "rf-receiver", "speaker", "speaker-group", "television", "button", "sensor", "hub"] },
          /** The model this device is an instance of. */
          model: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$", minLength: 1, maxLength: 100 },
          modelTitle: { type: "string", minLength: 1, maxLength: 200 },
          capabilities: { type: "array", maxItems: 20, items: capabilityKindSchema },
          connectionTypes: { type: "array", minItems: 1, maxItems: 10, uniqueItems: true, items: { $ref: deviceConnectionTypeSchema.$id } },
          // Virtual and cloud-backed devices can have no direct network host.
          sensors: { type: "array", maxItems: 100, items: sensorDefinition },
          host: { type: "string", maxLength: 253 },
          page: { type: "string", pattern: "^/(devices|switches|lights|string-lights|buttons|cameras|sensors|hubs|blasters|speakers|groups)/[A-Za-z0-9._:%-]+$" },
          schemaId: { type: "string", format: "uri" },
          availability: { enum: ["online", "offline", "degraded", "unknown"] },
          detail: { type: "string", minLength: 1, maxLength: 500 },
          groupLabel: { type: "string", minLength: 1, maxLength: 200 },
          /** False when the device is kept in the inventory but switched off: no controls, no background polling. */
          enabled: { type: "boolean" },
        },
        required: ["id", "name", "kind", "model", "modelTitle", "capabilities", "connectionTypes", "host", "page", "schemaId", "availability", "enabled"],
      },
    },
    generatedAt: { type: "string", format: "date-time" },
  },
  required: ["devices", "generatedAt"],
} as const;

export const serviceListResponseSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/service-list-response",
  title: "Service list",
  description: "Every shared, site-wide service running in this process (the embedded MQTT broker, and any that join it later), with its status and page.",
  type: "object",
  additionalProperties: false,
  properties: {
    services: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 },
          title: { type: "string", minLength: 1, maxLength: 200 },
          health: healthValueSchema,
          availability: { enum: ["online", "offline", "degraded", "unknown"] },
          detail: { type: "string", minLength: 1, maxLength: 500 },
          page: { type: "string", pattern: "^/services/[A-Za-z0-9._:%-]+$" },
          /**
           * The momentary actions this service offers, and when each one's
           * effect lapses while something is standing. Published so a client
           * that has never heard of this service can still offer its actions.
           */
          actions: {
            type: "array",
            maxItems: 50,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 },
                until: { type: "string", format: "date-time" },
              },
              required: ["id"],
            },
          },
          /**
           * What this service is joined to right now: `in` is something that
           * connected to it (a paired client), `out` is something it reaches
           * (an upstream). A service that fronts nothing publishes none.
           */
          endpoints: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                direction: { enum: ["in", "out"] },
                label: { type: "string", minLength: 1, maxLength: 200 },
                detail: { type: "string", maxLength: 200 },
                href: { type: "string", maxLength: 2000 },
                active: { type: "boolean" },
              },
              required: ["direction", "label"],
            },
          },
        },
        required: ["id", "title", "availability", "detail", "page", "actions", "endpoints", "health"],
      },
    },
    generatedAt: { type: "string", format: "date-time" },
  },
  required: ["services", "generatedAt"],
} as const;

export const eventTypeCatalogResponseSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/event-type-catalog-response",
  title: "Event type catalog",
  description: "Every event type HomeTruth records, with the schema of its data and how a page should present it.",
  type: "object",
  additionalProperties: false,
  properties: {
    types: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, maxLength: 100 },
          label: { type: "string", minLength: 1, maxLength: 100 },
          description: { type: "string", minLength: 1, maxLength: 500 },
          level: { enum: ["info", "warn", "error"] },
          view: { enum: ["plain", "thumbnail", "properties", "request", "network"] },
          payloadSchema: { type: "object" },
        },
        required: ["id", "label", "description", "level", "view", "payloadSchema"],
      },
    },
  },
  required: ["types"],
} as const;

export const serviceEventsResponseSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/service-events-response",
  title: "Service events",
  description: "The most recent events one service has recorded, newest first.",
  type: "object",
  additionalProperties: false,
  properties: {
    serviceId: { type: "string", minLength: 1, maxLength: 100 },
    nextCursor: { type: "string", maxLength: 256 },
    labels: { type: "array", items: { type: "string", minLength: 1, maxLength: 200 } },
    labelCounts: { type: "object", description: "Saved label event counts for the selected device, before label filtering and pagination.",
      propertyNames: { minLength: 1, maxLength: 200 }, additionalProperties: { type: "integer", minimum: 0 } },
    events: { type: "array", maxItems: 200, items: { $ref: eventSchema.$id } },
    /** Every device the kept events are about, so a page can offer a "filter by camera" menu. */
    subjects: { type: "array", maxItems: 200, items: { type: "string", minLength: 1, maxLength: 200 } },
    /** Every event type present among the kept events, for the type filter. */
    types: { type: "array", maxItems: 200, items: { type: "string", minLength: 1, maxLength: 100 } },
  },
  required: ["serviceId", "events"],
} as const;

export const deviceEventsResponseSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/device-events-response",
  title: "Device events",
  description: "The most recent events about one device across HomeTruth and its services, newest first.",
  type: "object",
  additionalProperties: false,
  properties: {
    deviceId: { type: "string", minLength: 1, maxLength: 100 },
    events: { type: "array", maxItems: 200, items: { $ref: eventSchema.$id } },
    types: { type: "array", maxItems: 200, items: { type: "string", minLength: 1, maxLength: 100 } },
  },
  required: ["deviceId", "events", "types"],
} as const;

export const eventsResponseSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/events-response",
  title: "Events",
  description: "The most recent events across HomeTruth, its devices, and its services, newest first.",
  type: "object",
  additionalProperties: false,
  properties: {
    events: { type: "array", maxItems: 200, items: { $ref: eventSchema.$id } },
    subjects: { type: "array", maxItems: 1000, items: { type: "string", minLength: 1, maxLength: 100 } },
    types: { type: "array", maxItems: 200, items: { type: "string", minLength: 1, maxLength: 100 } },
  },
  required: ["events", "subjects", "types"],
} as const;

export const devProjectSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/dev-project",
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    id: { type: "string", minLength: 3, maxLength: 200 },
    name: { type: "string", minLength: 1, maxLength: 120 },
    localHostname: {
      type: "string",
      pattern: "^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\\.localhost$",
      minLength: 11,
      maxLength: 253,
    },
    kind: { type: "string", pattern: "^[a-z][a-z0-9-]*$", maxLength: 80 },
    url: { type: "string", format: "uri" },
    healthUrl: { type: "string", format: "uri" },
    root: { type: "string", minLength: 1, maxLength: 4096 },
    pid: { type: "integer", minimum: 1 },
    startedAt: { type: "string", format: "date-time" },
    runtime: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string", pattern: "^[a-z][a-z0-9-]*$", maxLength: 80 },
        version: { type: "string", minLength: 1, maxLength: 40 },
      },
      required: ["name", "version"],
    },
  },
  required: [
    "schemaVersion",
    "id",
    "name",
    "kind",
    "url",
    "healthUrl",
    "root",
    "pid",
    "startedAt",
    "runtime"
  ],
} as const;

export const registrationResponseSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/dev-project-registration-response",
  type: "object",
  additionalProperties: false,
  properties: {
    accepted: { const: true },
    id: { type: "string", minLength: 3, maxLength: 200 },
    lastSeen: { type: "string", format: "date-time" },
    ttlMs: { type: "integer", minimum: 1000, maximum: 300000 },
  },
  required: ["accepted", "id", "lastSeen", "ttlMs"],
} as const;

export const unregisterRequestSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/dev-project-unregister-request",
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 3, maxLength: 200 },
  },
  required: ["id"],
} as const;

export const unregisterResponseSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/dev-project-unregister-response",
  type: "object",
  additionalProperties: false,
  properties: {
    removed: { type: "boolean" },
    id: { type: "string", minLength: 3, maxLength: 200 },
  },
  required: ["removed", "id"],
} as const;

export const healthResponseSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/health-response",
  type: "object",
  additionalProperties: false,
  properties: {
    status: { const: "ok" },
    runtime: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { const: "bun" },
        version: { type: "string", minLength: 1 },
      },
      required: ["name", "version"],
    },
    timestamp: { type: "string", format: "date-time" },
  },
  required: ["status", "runtime", "timestamp"],
} as const;

const availabilitySchema = {
  enum: ["online", "offline", "degraded", "unknown"],
} as const;

const observedCapabilityStateSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    availability: availabilitySchema,
    observedAt: { type: "string", format: "date-time" },
  },
  required: ["availability"],
} as const;

const emptyActionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
} as const;

const leasedMovementActionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    minLeaseMs: { type: "integer", minimum: 100, maximum: 60000 },
    maxLeaseMs: { type: "integer", minimum: 100, maximum: 60000 },
    defaultSpeedPercent: { type: "integer", minimum: 1, maximum: 100 },
  },
} as const;

const cameraStreamSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: "^[a-z][a-z0-9._-]*$", maxLength: 100 },
    role: { enum: ["main", "sub", "analysis"] },
    availability: availabilitySchema,
    uri: { type: "string", format: "uri", maxLength: 4096 },
    mediaTypes: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      items: { type: "string", pattern: "^[a-z0-9.+-]+/[a-z0-9.+-]+$", maxLength: 100 },
    },
    width: { type: "integer", minimum: 1, maximum: 32768 },
    height: { type: "integer", minimum: 1, maximum: 32768 },
    frameRate: { type: "number", exclusiveMinimum: 0, maximum: 1000 },
    videoCodec: { type: "string", minLength: 1, maxLength: 80 },
    audioCodec: { type: "string", minLength: 1, maxLength: 80 },
  },
  required: ["id", "availability", "mediaTypes"],
} as const;

/**
 * A normalized camera component. Optional action keys are the feature
 * negotiation mechanism: if `actions.pan.left` is absent, callers must not
 * offer or invoke that movement.
 */
export const cameraSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/camera",
  title: "Camera",
  description: "A camera component's observable state, media streams, and supported actions.",
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 100 },
    state: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...observedCapabilityStateSchema.properties,
        streamAvailable: { type: "boolean" },
        snapshotAvailable: { type: "boolean" },
        privacyEnabled: { type: "boolean" },
        panDegrees: { type: "number", minimum: -360, maximum: 360 },
        tiltDegrees: { type: "number", minimum: -180, maximum: 180 },
        zoomPercent: { type: "number", minimum: 0, maximum: 100 },
        microphoneEnabled: { type: "boolean" },
        speakerEnabled: { type: "boolean" },
        recording: { type: "boolean" },
      },
      required: ["availability"],
    },
    streams: {
      type: "array",
      maxItems: 20,
      items: cameraStreamSchema,
    },
    actions: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      properties: {
        snapshot: {
          type: "object",
          additionalProperties: false,
          properties: {
            mediaTypes: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              uniqueItems: true,
              items: { type: "string", pattern: "^image/[a-z0-9.+-]+$", maxLength: 100 },
            },
          },
        },
        pan: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            left: leasedMovementActionSchema,
            right: leasedMovementActionSchema,
            home: emptyActionSchema,
          },
        },
        tilt: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            up: leasedMovementActionSchema,
            down: leasedMovementActionSchema,
            home: emptyActionSchema,
          },
        },
        stopMovement: emptyActionSchema,
        zoom: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            in: emptyActionSchema,
            out: emptyActionSchema,
            set: {
              type: "object",
              additionalProperties: false,
              properties: {
                minimumPercent: { type: "number", minimum: 0, maximum: 100 },
                maximumPercent: { type: "number", minimum: 0, maximum: 100 },
                stepPercent: { type: "number", exclusiveMinimum: 0, maximum: 100 },
              },
              required: ["minimumPercent", "maximumPercent"],
            },
          },
        },
        setPrivacy: emptyActionSchema,
        talk: {
          type: "object",
          additionalProperties: false,
          properties: {
            mediaTypes: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              uniqueItems: true,
              items: { type: "string", pattern: "^audio/[a-z0-9.+-]+$", maxLength: 100 },
            },
          },
        },
      },
    },
  },
  required: ["id", "state"],
} as const;

export const lightSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/light",
  title: "Light",
  description: "A light component with optional dimming, color temperature, color, and effect controls.",
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 100 },
    state: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...observedCapabilityStateSchema.properties,
        stateSource: { const: "commanded" },
        commandedAt: { type: "string", format: "date-time" },
        detail: { type: "string", minLength: 1, maxLength: 500 },
        on: { type: "boolean" },
        brightnessPercent: { type: "number", minimum: 0, maximum: 100 },
        colorTemperatureKelvin: { type: "integer", minimum: 1000, maximum: 40000 },
        color: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" },
        effect: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: ["availability"],
    },
    actions: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      properties: {
        turnOn: emptyActionSchema,
        turnOff: emptyActionSchema,
        toggle: emptyActionSchema,
        setBrightness: {
          type: "object",
          additionalProperties: false,
          properties: {
            minimumPercent: { type: "number", minimum: 0, maximum: 100 },
            maximumPercent: { type: "number", minimum: 0, maximum: 100 },
            stepPercent: { type: "number", exclusiveMinimum: 0, maximum: 100 },
            maximumTransitionMs: { type: "integer", minimum: 0, maximum: 86400000 },
          },
          required: ["minimumPercent", "maximumPercent"],
        },
        setColorTemperature: {
          type: "object",
          additionalProperties: false,
          properties: {
            minimumKelvin: { type: "integer", minimum: 1000, maximum: 40000 },
            maximumKelvin: { type: "integer", minimum: 1000, maximum: 40000 },
            stepKelvin: { type: "integer", minimum: 1, maximum: 10000 },
          },
          required: ["minimumKelvin", "maximumKelvin"],
        },
        setColor: {
          type: "object",
          additionalProperties: false,
          properties: {
            formats: {
              type: "array",
              minItems: 1,
              maxItems: 10,
              uniqueItems: true,
              items: { enum: ["hex", "rgb", "hsv", "cie-xy"] },
            },
          },
          required: ["formats"],
        },
        setEffect: {
          type: "object",
          additionalProperties: false,
          properties: {
            effects: {
              type: "array",
              minItems: 1,
              maxItems: 100,
              uniqueItems: true,
              items: { type: "string", minLength: 1, maxLength: 100 },
            },
          },
          required: ["effects"],
        },
      },
    },
  },
  required: ["id", "state"],
} as const;

/** A physical, ordered collection of independently identified Light devices. */
export const stringLightSchema = {
  ...lightSchema,
  $id: "https://hometruth.ai/schemas/string-light",
  title: "StringLight",
  description: "A linear array of Light devices, ordered from the controller, with whole-string controls.",
  properties: {
    ...lightSchema.properties,
    state: {
      ...lightSchema.properties.state,
      properties: {
        ...lightSchema.properties.state.properties,
        scenes: {
          type: "array", maxItems: 100,
          items: {
            type: "object", additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1, maxLength: 100 },
              name: { type: "string", minLength: 1, maxLength: 100 },
              pattern: { const: "repeat" },
              colors: { type: "array", minItems: 1, maxItems: 30, items: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" } },
            }, required: ["id", "name", "pattern", "colors"],
          },
        },
        scene: {
          type: "object", additionalProperties: false,
          properties: {
            status: { enum: ["idle", "submitted", "error"] },
            sceneId: { type: "string", minLength: 1, maxLength: 100 },
            appliedAt: { type: "string", format: "date-time" },
            detail: { type: "string", maxLength: 500 },
          }, required: ["status"],
        },
        presets: {
          type: "array", maxItems: 100,
          items: {
            type: "object", additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1, maxLength: 100 },
              name: { type: "string", minLength: 1, maxLength: 100 },
              category: { type: "string", minLength: 1, maxLength: 100 },
            }, required: ["id", "name", "category"],
          },
        },
        shows: {
          type: "array", maxItems: 100,
          items: {
            type: "object", additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1, maxLength: 100 },
              name: { type: "string", minLength: 1, maxLength: 100 },
              category: { type: "string", minLength: 1, maxLength: 100 },
              kind: { enum: ["animation", "sequence"] },
              steps: { type: "array", minItems: 1, maxItems: 100, items: { type: "string", minLength: 1, maxLength: 100 } },
            }, required: ["id", "name", "category", "kind"],
          },
        },
        show: {
          type: "object", additionalProperties: false,
          properties: {
            status: { enum: ["idle", "submitted", "running", "error"] },
            showId: { type: "string", minLength: 1, maxLength: 100 },
            effectId: { type: "string", minLength: 1, maxLength: 100 },
            presetId: { type: "string", minLength: 1, maxLength: 100 },
            startedAt: { type: "string", format: "date-time" },
            stepSeconds: { type: "integer", minimum: 10, maximum: 600 },
            detail: { type: "string", maxLength: 500 },
          }, required: ["status"],
        },
        layout: { const: "linear" },
        lightCount: { type: "integer", minimum: 1, maximum: 1000 },
        lights: {
          type: "array", minItems: 1, maxItems: 1000,
          items: {
            type: "object", additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1, maxLength: 100 },
              name: { type: "string", minLength: 1, maxLength: 200 },
              index: { type: "integer", minimum: 0, maximum: 999 },
            },
            required: ["id", "name", "index"],
          },
        },
      },
      required: ["availability", "layout", "lightCount", "lights"],
    },
    actions: {
      ...lightSchema.properties.actions,
      properties: { ...lightSchema.properties.actions.properties, getLights: emptyActionSchema, getScenes: emptyActionSchema, applyScene: emptyActionSchema, getShows: emptyActionSchema, playShow: emptyActionSchema, stopShow: emptyActionSchema, getPresets: emptyActionSchema, applyPreset: emptyActionSchema },
    },
  },
} as const;



export const binarySwitchSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/binary-switch",
  title: "Binary switch",
  description: "A two-state switch that is either on or off. Every implementation exposes the same four actions: turnOn, turnOff, toggle, and getState.",
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 100 },
    state: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...observedCapabilityStateSchema.properties,
        value: { enum: ["on", "off"] },
      },
      required: ["availability"],
      dependentRequired: {
        value: ["observedAt"],
      },
    },
    actions: {
      type: "object",
      additionalProperties: false,
      properties: {
        turnOn: emptyActionSchema,
        turnOff: emptyActionSchema,
        toggle: emptyActionSchema,
        getState: emptyActionSchema,
      },
      required: ["turnOn", "turnOff", "toggle", "getState"],
    },
  },
  required: ["id", "state", "actions"],
  examples: [{
    id: "shelly-relay",
    state: { availability: "online", value: "off", observedAt: "2026-09-03T20:00:00Z" },
    actions: { turnOn: {}, turnOff: {}, toggle: {}, getState: {} },
  }],
} as const;

export const buttonSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/button",
  title: "Button",
  description: "A stateless action that can be pressed once or, when advertised, held for a bounded duration. A successful press does not imply observable target state.",
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 100 },
    state: observedCapabilityStateSchema,
    actions: {
      type: "object",
      additionalProperties: false,
      properties: {
        press: {
          type: "object",
          additionalProperties: false,
          properties: {
            maximumDurationMs: { type: "integer", minimum: 0, maximum: 86400000 },
          },
        },
      },
      required: ["press"],
    },
  },
  required: ["id", "state", "actions"],
  examples: [{ id: "candles-on", state: { availability: "online" }, actions: { press: { maximumDurationMs: 60000 } } }],
} as const;

export const buttonPressRequestSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/button-press-request",
  title: "Button press request",
  description: "Press a stateless button once, optionally holding it for a bounded number of milliseconds.",
  type: "object",
  additionalProperties: false,
  properties: { durationMs: { type: "integer", minimum: 0, maximum: 86400000 } },
} as const;

const workflowNodeCommonProperties = {
  id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 },
  label: { type: "string", minLength: 1, maxLength: 200 },
  next: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 },
} as const;

/** One state in a configured Button workflow. Edges are node ids, so a workflow can branch or loop. */
const workflowNodeShape = {
  oneOf: [
    {
      type: "object", additionalProperties: false,
      properties: { ...workflowNodeCommonProperties, type: { const: "action" }, device: { type: "string", minLength: 1, maxLength: 100 }, control: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9]*(?:\\.[a-zA-Z][a-zA-Z0-9]*)*$", minLength: 1, maxLength: 100 }, value: {}, confirmed: { type: "boolean" } },
      required: ["id", "type", "device", "control"],
    },
    {
      type: "object", additionalProperties: false,
      properties: { ...workflowNodeCommonProperties, type: { const: "delay" }, durationMs: { type: "integer", minimum: 0, maximum: 86400000 } },
      required: ["id", "type", "durationMs"],
    },
    {
      type: "object", additionalProperties: false,
      properties: {
        ...workflowNodeCommonProperties,
        type: { const: "condition" },
        device: { type: "string", minLength: 1, maxLength: 100 },
        path: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9]*(?:\\.[a-zA-Z][a-zA-Z0-9]*)*$", minLength: 1, maxLength: 200 },
        operator: { enum: ["equals", "notEquals", "greaterThan", "lessThan", "contains", "truthy", "falsy"] },
        value: {},
        ifTrue: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 },
        ifFalse: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 },
      },
      required: ["id", "type", "device", "path", "operator", "ifTrue", "ifFalse"],
    },
    {
      type: "object", additionalProperties: false,
      properties: { id: workflowNodeCommonProperties.id, label: workflowNodeCommonProperties.label, type: { const: "end" } },
      required: ["id", "type"],
    },
  ],
} as const;

const workflowDefinitionShape = {
  type: "object", additionalProperties: false,
  properties: {
    start: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 },
    nodes: { type: "array", minItems: 1, maxItems: 200, items: workflowNodeShape },
    maxSteps: { type: "integer", minimum: 1, maximum: 10000 },
    concurrency: { enum: ["parallel", "replace", "ignore"] },
  },
  required: ["start", "nodes"],
} as const;

export const workflowSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/workflow",
  title: "Workflow",
  description: "A directed state-machine graph of device actions, delays, conditions, and terminal nodes.",
  ...workflowDefinitionShape,
  examples: [{
    start: "turn-on",
    nodes: [
      { id: "turn-on", type: "action", device: "lamp", control: "turnOn", next: "wait" },
      { id: "wait", type: "delay", durationMs: 300000, next: "turn-off" },
      { id: "turn-off", type: "action", device: "lamp", control: "turnOff", next: "done" },
      { id: "done", type: "end" },
    ],
  }],
} as const;

export const workflowButtonCreateRequestSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/workflow-button-create-request",
  title: "Workflow Button create request",
  type: "object", additionalProperties: false,
  properties: {
    id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 },
    name: { type: "string", minLength: 1, maxLength: 200 },
    room: roomNameSchema,
    workflow: workflowDefinitionShape,
  },
  required: ["id", "name"],
} as const;

export const workflowButtonUpdateRequestSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/workflow-button-update-request",
  title: "Workflow Button update request",
  type: "object", additionalProperties: false,
  properties: { workflow: workflowDefinitionShape },
  required: ["workflow"],
} as const;

export const optimisticSwitchCreateRequestSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/optimistic-switch-create-request",
  title: "Optimistic switch create request",
  description: "Build a stateful switch from on and off Button devices (the same Button for both makes a power-button toggle), with an optional initial optimistic state.",
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 },
    name: { type: "string", minLength: 1, maxLength: 200 },
    room: roomNameSchema,
    /** Opaque selection reference: a configured Button id or a saved Broadlink command offered by the server. */
    onButton: { type: "string", minLength: 1, maxLength: 500 },
    offButton: { type: "string", minLength: 1, maxLength: 500 },
    initialState: { enum: ["on", "off"] },
  },
  required: ["id", "name", "onButton", "offButton"],
} as const;

export const optimisticSwitchCreateResponseSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/optimistic-switch-create-response",
  title: "Optimistic switch create response",
  description: "The identity and device page of a newly configured optimistic switch.",
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 },
    page: { type: "string", pattern: "^/(devices|switches|lights|string-lights|buttons|cameras|sensors|hubs|blasters|speakers|groups)/[A-Za-z0-9._:%-]+$" },
  },
  required: ["id", "page"],
} as const;

export const motionSensorSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/motion-sensor",
  title: "Motion sensor",
  description: "A motion sensor's latest observation and its optional configuration controls.",
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 100 },
    state: {
      type: "object",
      additionalProperties: false,
      properties: {
        availability: availabilitySchema,
        motion: { type: "boolean" },
        observedAt: { type: "string", format: "date-time" },
        lastMotionAt: { type: "string", format: "date-time" },
        sensitivityPercent: { type: "number", minimum: 0, maximum: 100 },
        clearAfterMs: { type: "integer", minimum: 0, maximum: 86400000 },
        illuminanceLux: { type: "number", minimum: 0 },
        batteryPercent: { type: "number", minimum: 0, maximum: 100 },
        tampered: { type: "boolean" },
      },
      required: ["availability"],
      dependentRequired: {
        motion: ["observedAt"],
        observedAt: ["motion"],
      },
    },
    actions: {
      type: "object",
      additionalProperties: false,
      properties: {
        setSensitivity: {
          type: "object",
          additionalProperties: false,
          properties: {
            minimumPercent: { type: "number", minimum: 0, maximum: 100 },
            maximumPercent: { type: "number", minimum: 0, maximum: 100 },
            stepPercent: { type: "number", exclusiveMinimum: 0, maximum: 100 },
          },
          required: ["minimumPercent", "maximumPercent"],
        },
        setClearAfter: {
          type: "object",
          additionalProperties: false,
          properties: {
            minimumMs: { type: "integer", minimum: 0, maximum: 86400000 },
            maximumMs: { type: "integer", minimum: 0, maximum: 86400000 },
            stepMs: { type: "integer", minimum: 1, maximum: 86400000 },
          },
          required: ["minimumMs", "maximumMs"],
        },
      },
    },
  },
  required: ["id", "state"],
} as const;

const infraredChannelSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 100 },
    carrierFrequencyHz: { type: "integer", minimum: 1000, maximum: 1000000 },
    formats: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      items: { type: "string", pattern: "^[a-z][a-z0-9._-]*$", maxLength: 80 },
    },
  },
  required: ["id", "formats"],
} as const;

const radioFrequencyChannelSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 100 },
    centerFrequencyHz: { type: "integer", minimum: 100000, maximum: 10000000000 },
    bandwidthHz: { type: "integer", exclusiveMinimum: 0, maximum: 1000000000 },
    modulations: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      uniqueItems: true,
      items: { type: "string", pattern: "^[a-z][a-z0-9._-]*$", maxLength: 80 },
    },
    formats: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      items: { type: "string", pattern: "^[a-z][a-z0-9._-]*$", maxLength: 80 },
    },
  },
  required: ["id", "centerFrequencyHz", "formats"],
} as const;

const signalSendActionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    maxPulseCount: { type: "integer", minimum: 1, maximum: 1000000 },
    minRepeatCount: { type: "integer", minimum: 1, maximum: 1000 },
    maxRepeatCount: { type: "integer", minimum: 1, maximum: 1000 },
    /** Longest hold a send accepts via durationMs, in milliseconds. */
    maxDurationMs: { type: "integer", minimum: 0, maximum: 600000 },
  },
} as const;

const signalReceivedEventSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    includesRawPulsesMicroseconds: { type: "boolean" },
    includesDecodedPayload: { type: "boolean" },
  },
} as const;

const signalLearnActionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    minCaptureMs: { type: "integer", minimum: 1, maximum: 300000 },
    maxCaptureMs: { type: "integer", minimum: 1, maximum: 300000 },
  },
} as const;

export const infraredBlasterSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/infrared-blaster",
  title: "Infrared blaster",
  description: "An infrared transmitter and the channels and signal formats it can send.",
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 100 },
    state: observedCapabilityStateSchema,
    channels: { type: "array", minItems: 1, maxItems: 100, items: infraredChannelSchema },
    actions: {
      type: "object",
      additionalProperties: false,
      properties: { send: signalSendActionSchema },
      required: ["send"],
    },
  },
  required: ["id", "state", "channels", "actions"],
} as const;

export const infraredReceiverSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/infrared-receiver",
  title: "Infrared receiver",
  description: "An infrared receiver and the signal events and learning action it exposes.",
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 100 },
    state: observedCapabilityStateSchema,
    channels: { type: "array", minItems: 1, maxItems: 100, items: infraredChannelSchema },
    events: {
      type: "object",
      additionalProperties: false,
      properties: { signalReceived: signalReceivedEventSchema },
      required: ["signalReceived"],
    },
    actions: {
      type: "object",
      additionalProperties: false,
      properties: { learn: signalLearnActionSchema },
      required: ["learn"],
    },
  },
  required: ["id", "state", "channels", "events"],
} as const;

export const radioFrequencyBlasterSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/radio-frequency-blaster",
  title: "Radio-frequency blaster",
  description: "A radio-frequency transmitter and the channels and signal formats it can send.",
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 100 },
    state: observedCapabilityStateSchema,
    channels: { type: "array", minItems: 1, maxItems: 100, items: radioFrequencyChannelSchema },
    actions: {
      type: "object",
      additionalProperties: false,
      properties: { send: signalSendActionSchema },
      required: ["send"],
    },
  },
  required: ["id", "state", "channels", "actions"],
} as const;

export const radioFrequencyReceiverSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/radio-frequency-receiver",
  title: "Radio-frequency receiver",
  description: "A radio-frequency receiver and the signal events and learning action it exposes.",
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 100 },
    state: observedCapabilityStateSchema,
    channels: { type: "array", minItems: 1, maxItems: 100, items: radioFrequencyChannelSchema },
    events: {
      type: "object",
      additionalProperties: false,
      properties: { signalReceived: signalReceivedEventSchema },
      required: ["signalReceived"],
    },
    actions: {
      type: "object",
      additionalProperties: false,
      properties: { learn: signalLearnActionSchema },
      required: ["learn"],
    },
  },
  required: ["id", "state", "channels", "events"],
} as const;

const signalChannelSchema = { enum: ["infrared", "radio-frequency"] } as const;
const signalCodeValueSchema = { type: "string", minLength: 1, maxLength: 20000 } as const;
const rfFrequencyHzSchema = { type: "integer", minimum: 100000, maximum: 10000000000 } as const;
/** How long to keep transmitting a code by repeating it; 0 or absent sends it once, as learned. */
const sendDurationMsSchema = { type: "integer", minimum: 0, maximum: 60000 } as const;

/** A learned signal kept under a user-chosen name so it can be sent as a button. */
const savedSignalCodeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 },
    name: { type: "string", minLength: 1, maxLength: 100 },
    channel: signalChannelSchema,
    code: signalCodeValueSchema,
    frequencyHz: rfFrequencyHzSchema,
    /** The button's default hold; a send may override it per press. */
    durationMs: sendDurationMsSchema,
    learnedAt: { type: "string", format: "date-time" },
  },
  required: ["id", "name", "channel", "code", "learnedAt"],
} as const;

/**
 * A combined IR/RF blaster device page model: one physical Broadlink-style
 * transmitter reported as both an InfraredBlaster and a RadioFrequencyBlaster
 * capability (it shares a single learn action across both channels), plus
 * the named signals saved for it.
 */
export const irRfBlasterDeviceSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/ir-rf-blaster-device",
  title: "IR/RF blaster device",
  description: "A dual-channel infrared and radio-frequency blaster's combined capability documents and its saved, named signals.",
  type: "object",
  additionalProperties: false,
  properties: {
    infrared: { $ref: infraredBlasterSchema.$id },
    radioFrequency: { $ref: radioFrequencyBlasterSchema.$id },
    codes: { type: "array", maxItems: 200, items: savedSignalCodeSchema },
  },
  required: ["infrared", "radioFrequency", "codes"],
} as const;

export const irRfBlasterSendRequestSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/ir-rf-blaster-send-request",
  title: "IR/RF blaster send request",
  description: "A previously captured signal code to transmit on one channel. durationMs keeps it transmitting (by repeating the code) for that long; 0 or absent sends it once.",
  type: "object",
  additionalProperties: false,
  properties: {
    channel: signalChannelSchema,
    code: signalCodeValueSchema,
    durationMs: sendDurationMsSchema,
  },
  required: ["channel", "code"],
} as const;

export const irRfBlasterSendCodeRequestSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/ir-rf-blaster-send-code-request",
  title: "IR/RF blaster send saved code request",
  description: "Presses a saved button. durationMs overrides the button's default hold for this press only.",
  type: "object",
  additionalProperties: false,
  properties: {
    durationMs: sendDurationMsSchema,
  },
} as const;

export const irRfBlasterUpdateCodeRequestSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/ir-rf-blaster-update-code-request",
  title: "IR/RF blaster update code request",
  description: "Changes a saved button's defaults; currently its default hold in milliseconds (0 sends once).",
  type: "object",
  additionalProperties: false,
  properties: {
    durationMs: sendDurationMsSchema,
  },
  required: ["durationMs"],
} as const;

export const irRfBlasterLearnRequestSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/ir-rf-blaster-learn-request",
  title: "IR/RF blaster learn request",
  description: "Starts learning on one channel and waits for a captured signal. RF learning detects the carrier first unless frequencyHz is given; timeoutMs bounds each phase.",
  type: "object",
  additionalProperties: false,
  properties: {
    channel: signalChannelSchema,
    timeoutMs: { type: "integer", minimum: 1000, maximum: 60000 },
    frequencyHz: rfFrequencyHzSchema,
  },
  required: ["channel"],
} as const;

export const irRfBlasterLearnResponseSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/ir-rf-blaster-learn-response",
  title: "IR/RF blaster learn response",
  description: "The signal code captured by a learn request, with the RF carrier it was captured on when relevant.",
  type: "object",
  additionalProperties: false,
  properties: {
    code: signalCodeValueSchema,
    frequencyHz: rfFrequencyHzSchema,
  },
  required: ["code"],
} as const;

export const irRfBlasterSaveCodeRequestSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/ir-rf-blaster-save-code-request",
  title: "IR/RF blaster save code request",
  description: "Names a captured signal so it appears as a button on the device page; durationMs becomes the button's default hold.",
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    channel: signalChannelSchema,
    code: signalCodeValueSchema,
    frequencyHz: rfFrequencyHzSchema,
    durationMs: sendDurationMsSchema,
  },
  required: ["name", "channel", "code"],
} as const;

export const secretsFileSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/secrets-file",
  title: "Secrets file",
  description: "The site's credentials (.hometruth/secrets.yml, mode 0600): per-device secrets keyed by device id and validated against each model's secrets schema, per-vendor shared secrets, network adapter secrets, and the API tokens this machine presents to its own server. Values are never served.",
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    devices: { type: "object", maxProperties: 400, additionalProperties: { type: "object", maxProperties: 50 } },
    vendors: { type: "object", maxProperties: 50, additionalProperties: { type: "object", maxProperties: 50 } },
    network: { type: "object", maxProperties: 50, additionalProperties: { type: "object", maxProperties: 50 } },
    api: { type: "object", maxProperties: 50, additionalProperties: { type: "object", maxProperties: 50 } },
  },
  required: ["schemaVersion"],
  examples: [{
    schemaVersion: 1,
    devices: { "kitchen-camera": { onvif: { username: "admin", password: "…" } } },
    vendors: { tkenpro: { account: { email: "owner@example.com", password: "…" } } },
    network: { unifi: { apiKey: "…" } },
    api: { cli: { token: "ht_…" } },
  }],
} as const;

export const irRfCodesFileSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/ir-rf-codes-file",
  title: "Saved IR/RF codes",
  description: "The git-ignored .hometruth/ir-rf-codes.json catalog of named signals learned per device, keyed by device id.",
  type: "object",
  additionalProperties: false,
  properties: {
    version: { const: 1 },
    devices: {
      type: "object",
      maxProperties: 200,
      propertyNames: { pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", maxLength: 100 },
      additionalProperties: { type: "array", maxItems: 200, items: savedSignalCodeSchema },
    },
  },
  required: ["version", "devices"],
} as const;

const normalizedCoordinateSchema = { type: "number", minimum: 0, maximum: 1 } as const;

export const sourceRegionSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/source-region",
  title: "Source region",
  description: "A polygon drawn over a camera's snapshot, marking the pixels a light-sync rule should sample. Points are normalized 0..1 against the snapshot's own width/height so the same region stays valid across stream resolutions.",
  type: "object",
  additionalProperties: false,
  properties: {
    points: {
      type: "array",
      minItems: 3,
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        properties: { x: normalizedCoordinateSchema, y: normalizedCoordinateSchema },
        required: ["x", "y"],
      },
    },
  },
  required: ["points"],
} as const;

export const cameraRegionResponseSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/camera-region-response",
  title: "Camera region response",
  description: "The light-sync source region currently saved for a camera, or none if it has never been set.",
  type: "object",
  additionalProperties: false,
  properties: {
    region: { anyOf: [sourceRegionSchema, { type: "null" }] },
  },
  required: ["region"],
} as const;

export const treatDispenserSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/treat-dispenser",
  title: "Treat dispenser",
  description: "A treat dispenser's observable state and bounded dispensing actions.",
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 100 },
    state: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...observedCapabilityStateSchema.properties,
        foodLevelPercent: { type: "number", minimum: 0, maximum: 100 },
        lowFood: { type: "boolean" },
        jammed: { type: "boolean" },
        lastDispensedAt: { type: "string", format: "date-time" },
        lastPortions: { type: "integer", minimum: 1, maximum: 1000 },
      },
      required: ["availability"],
    },
    actions: {
      type: "object",
      additionalProperties: false,
      properties: {
        dispense: {
          type: "object",
          additionalProperties: false,
          properties: {
            minimumPortions: { type: "integer", minimum: 1, maximum: 1000 },
            maximumPortions: { type: "integer", minimum: 1, maximum: 1000 },
            step: { type: "integer", minimum: 1, maximum: 1000 },
            portionSizeGrams: { type: "number", exclusiveMinimum: 0, maximum: 10000 },
            confirmation: { enum: ["none", "confirm"] },
          },
          required: ["minimumPortions", "maximumPortions", "step"],
        },
        playCall: emptyActionSchema,
        setSchedule: {
          type: "object",
          additionalProperties: false,
          properties: {
            maxEntries: { type: "integer", minimum: 1, maximum: 1000 },
          },
          required: ["maxEntries"],
        },
      },
      required: ["dispense"],
    },
  },
  required: ["id", "actions"],
} as const;

export const speakerSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/speaker",
  title: "Speaker",
  description: "A network audio speaker (e.g. Sonos): playback transport, volume/mute, arbitrary URI playback, an optional spoken/announcement shortcut, and group membership for whole-home audio.",
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 100 },
    state: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...observedCapabilityStateSchema.properties,
        playback: { enum: ["playing", "paused", "stopped", "transitioning", "unknown"] },
        volumePercent: { type: "number", minimum: 0, maximum: 100 },
        muted: { type: "boolean" },
        track: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", minLength: 1, maxLength: 500 },
            artist: { type: "string", minLength: 1, maxLength: 500 },
            album: { type: "string", minLength: 1, maxLength: 500 },
            uri: { type: "string", minLength: 1, maxLength: 2000 },
            durationSeconds: { type: "number", minimum: 0 },
            positionSeconds: { type: "number", minimum: 0 },
          },
        },
        group: {
          type: "object",
          additionalProperties: false,
          properties: {
            coordinatorHost: { type: "string", minLength: 1, maxLength: 253 },
            isCoordinator: { type: "boolean" },
            memberHosts: {
              type: "array",
              items: { type: "string", minLength: 1, maxLength: 253 },
              maxItems: 32,
            },
          },
          required: ["coordinatorHost", "isCoordinator"],
        },
      },
      required: ["availability"],
    },
    actions: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      properties: {
        play: emptyActionSchema,
        pause: emptyActionSchema,
        stop: emptyActionSchema,
        setVolume: {
          type: "object",
          additionalProperties: false,
          properties: {
            minimumPercent: { type: "number", minimum: 0, maximum: 100 },
            maximumPercent: { type: "number", minimum: 0, maximum: 100 },
          },
          required: ["minimumPercent", "maximumPercent"],
        },
        setMute: emptyActionSchema,
        playUri: emptyActionSchema,
        say: {
          type: "object",
          additionalProperties: false,
          properties: {
            maxLength: { type: "integer", minimum: 1, maximum: 5000 },
          },
        },
        joinGroup: emptyActionSchema,
        leaveGroup: emptyActionSchema,
        getState: emptyActionSchema,
      },
      required: ["play", "pause", "stop", "setVolume", "setMute", "playUri", "joinGroup", "leaveGroup", "getState"],
    },
  },
  required: ["id", "state", "actions"],
  examples: [{
    id: "living-room-sonos",
    state: {
      availability: "online",
      observedAt: "2026-09-06T20:00:00Z",
      playback: "playing",
      volumePercent: 35,
      muted: false,
      track: { title: "Example Track", artist: "Example Artist", positionSeconds: 42, durationSeconds: 210 },
      group: { coordinatorHost: "10.77.0.170", isCoordinator: true, memberHosts: ["10.77.0.170"] },
    },
    actions: {
      play: {},
      pause: {},
      stop: {},
      setVolume: { minimumPercent: 0, maximumPercent: 100 },
      setMute: {},
      playUri: {},
      say: { maxLength: 500 },
      joinGroup: {},
      leaveGroup: {},
      getState: {},
    },
  }],
} as const;

/**
 * The generic television capability: a networked TV set, whatever protocol
 * reaches it. Power is `on` or `standby` — a set that answers nothing is
 * offline, not a third power state — and the navigation keys are a generic
 * remote vocabulary every vendor maps onto its own key names.
 *
 * Absolute volume, input selection, app launching, and art mode are declared
 * only by the products that really have them, so a page never offers a control
 * the set cannot perform.
 */
export const televisionKeySchema = {
  enum: [
    "up", "down", "left", "right", "select", "back", "home", "menu", "info", "exit",
    "play", "pause", "stop", "rewind", "fastForward",
    "channelUp", "channelDown", "source",
  ],
} as const;

const televisionSourceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 100 },
    name: { type: "string", minLength: 1, maxLength: 200 },
  },
  required: ["id"],
} as const;

export const televisionSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/television",
  title: "Television",
  description: "A networked television set: power, a generic remote key vocabulary, volume and mute, and — where the product has them — absolute volume, input selection, app launching, and an art/gallery idle mode.",
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 100 },
    state: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...observedCapabilityStateSchema.properties,
        power: { enum: ["on", "standby"] },
        input: televisionSourceSchema,
        app: televisionSourceSchema,
        volumePercent: { type: "number", minimum: 0, maximum: 100 },
        muted: { type: "boolean" },
        artMode: { enum: ["on", "off"] },
      },
      required: ["availability"],
      dependentRequired: {
        power: ["observedAt"],
      },
    },
    actions: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      properties: {
        turnOn: emptyActionSchema,
        turnOff: emptyActionSchema,
        press: {
          type: "object",
          additionalProperties: false,
          properties: {
            keys: { type: "array", minItems: 1, maxItems: 64, items: televisionKeySchema },
          },
          required: ["keys"],
        },
        volumeUp: emptyActionSchema,
        volumeDown: emptyActionSchema,
        toggleMute: emptyActionSchema,
        setVolume: {
          type: "object",
          additionalProperties: false,
          properties: {
            minimumPercent: { type: "number", minimum: 0, maximum: 100 },
            maximumPercent: { type: "number", minimum: 0, maximum: 100 },
          },
          required: ["minimumPercent", "maximumPercent"],
        },
        setInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            inputs: { type: "array", minItems: 1, maxItems: 32, items: televisionSourceSchema },
          },
          required: ["inputs"],
        },
        launchApp: {
          type: "object",
          additionalProperties: false,
          properties: {
            apps: { type: "array", minItems: 1, maxItems: 64, items: televisionSourceSchema },
          },
          required: ["apps"],
        },
        setArtMode: emptyActionSchema,
        getState: emptyActionSchema,
      },
      required: ["turnOn", "turnOff", "press", "volumeUp", "volumeDown", "toggleMute", "getState"],
    },
  },
  required: ["id", "state", "actions"],
  examples: [{
    id: "living-room-tv",
    state: {
      availability: "online",
      observedAt: "2026-09-18T20:00:00Z",
      power: "on",
      artMode: "off",
    },
    actions: {
      turnOn: {},
      turnOff: {},
      press: { keys: ["up", "down", "left", "right", "select", "back", "home", "menu", "play", "pause"] },
      volumeUp: {},
      volumeDown: {},
      toggleMute: {},
      setArtMode: {},
      getState: {},
    },
  }],
} as const;

export const homeTruthObjectSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/object",
  title: "HomeTruth object",
  description: "A physical or logical home object composed from capabilities and individually typed sensors.",
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 200 },
    name: { type: "string", minLength: 1, maxLength: 200 },
    parent: deviceParentSchema,
    status: availabilitySchema,
    health: healthValueSchema,
    manufacturer: { type: "string", minLength: 1, maxLength: 200 },
    model: { type: "string", minLength: 1, maxLength: 200 },
    serialNumber: { type: "string", minLength: 1, maxLength: 200 },
    firmwareVersion: { type: "string", minLength: 1, maxLength: 200 },
    location: { type: "string", minLength: 1, maxLength: 200 },
    sensors: { type: "array", minItems: 1, maxItems: 100, items: { $ref: sensorSchema.$id } },
    capabilities: {
      type: "object",
      additionalProperties: false,
      properties: {
        cooktop: { $ref: cooktopSchema.$id },
        camera: { $ref: cameraSchema.$id },
        light: { $ref: lightSchema.$id },
        stringLight: { $ref: stringLightSchema.$id },
        binarySwitch: { $ref: binarySwitchSchema.$id },
        button: { $ref: buttonSchema.$id },
        motionSensor: { $ref: motionSensorSchema.$id },
        sensor: { $ref: sensorCollectionSchema.$id },
        occupancySensor: { $ref: occupancySensorSchema.$id },
        contactSensor: { $ref: contactSensorSchema.$id },
        hub: { $ref: hubSchema.$id },
        infraredBlaster: { $ref: infraredBlasterSchema.$id },
        infraredReceiver: { $ref: infraredReceiverSchema.$id },
        radioFrequencyBlaster: { $ref: radioFrequencyBlasterSchema.$id },
        radioFrequencyReceiver: { $ref: radioFrequencyReceiverSchema.$id },
        treatDispenser: { $ref: treatDispenserSchema.$id },
        speaker: { $ref: speakerSchema.$id },
        television: { $ref: televisionSchema.$id },
      },
    },
  },
  required: ["schemaVersion", "id", "name", "capabilities", "health"],
  anyOf: [
    { properties: { sensors: {} }, required: ["sensors"] },
    { properties: { capabilities: { type: "object", minProperties: 1 } } },
  ],
} as const;

/** A device composed of N independently typed sensors, optionally alongside other capabilities. */
export const sensorDeviceSchema = {
  $schema: dialect, $id: "https://hometruth.ai/schemas/sensor-device", title: "Device with sensors",
  description: "A device containing one or more individually typed sensors. Multiple sensors of the same type are allowed.",
  type: "object",
  allOf: [
    { $ref: homeTruthObjectSchema.$id },
    { type: "object", properties: { sensors: { type: "array", minItems: 1 } }, required: ["sensors"] },
  ],
} as const;

export const petTreatDispenserCameraSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/pet-treat-dispenser-camera",
  title: "Pet treat dispenser camera",
  description: "A HomeTruth object that must combine Camera and TreatDispenser capabilities; a MotionSensor when the product's on-device detection reaches HomeTruth.",
  type: "object",
  allOf: [
    { $ref: homeTruthObjectSchema.$id },
    {
      type: "object",
      properties: {
        capabilities: {
          type: "object",
          properties: {
            camera: {},
            treatDispenser: {},
          },
          required: ["camera", "treatDispenser"],
        },
      },
      required: ["capabilities"],
    },
  ],
  examples: [{
    schemaVersion: 1,
    id: "kitchen-pet-camera",
    name: "Kitchen treat camera",
    capabilities: {
      camera: {
        id: "main",
        state: {
          availability: "online",
          streamAvailable: true,
          snapshotAvailable: true,
        },
        actions: {
          snapshot: { mediaTypes: ["image/jpeg"] },
          pan: {
            left: { minLeaseMs: 100, maxLeaseMs: 3000 },
            right: { minLeaseMs: 100, maxLeaseMs: 3000 },
          },
          stopMovement: {},
        },
      },
      treatDispenser: {
        id: "treats",
        state: { availability: "online" },
        actions: {
          dispense: {
            minimumPortions: 1,
            maximumPortions: 1,
            step: 1,
            confirmation: "confirm",
          },
        },
      },
    },
  }],
} as const;

export const cameraMotionSensorSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/camera-motion-sensor",
  title: "Camera with motion sensor",
  description: "A HomeTruth object that must combine Camera and MotionSensor capabilities.",
  type: "object",
  allOf: [
    { $ref: homeTruthObjectSchema.$id },
    {
      type: "object",
      properties: {
        capabilities: {
          type: "object",
          properties: {
            camera: {},
            motionSensor: {},
          },
          required: ["camera", "motionSensor"],
        },
      },
      required: ["capabilities"],
    },
  ],
  examples: [{
    schemaVersion: 1,
    id: "porch-camera",
    name: "Porch camera",
    capabilities: {
      camera: {
        id: "camera",
        state: {
          availability: "online",
          streamAvailable: true,
          snapshotAvailable: true,
        },
        actions: {
          snapshot: { mediaTypes: ["image/jpeg"] },
        },
      },
      motionSensor: {
        id: "motion",
        state: {
          availability: "online",
          motion: false,
          observedAt: "2026-09-05T22:00:00.000Z",
        },
        actions: {},
      },
    },
  }],
} as const;

/**
 * A Samsung Frame: a HomeTruth object whose television capability also has the
 * art/gallery idle mode the Frame is built around, so a page can rely on
 * `artMode` being both reported and settable rather than testing for it.
 */
export const samsungFrameSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/samsung-frame",
  title: "Samsung Frame",
  description: "A HomeTruth object that must carry a Television capability declaring the art-mode action; the art-first television the Frame is.",
  type: "object",
  allOf: [
    { $ref: homeTruthObjectSchema.$id },
    {
      type: "object",
      properties: {
        capabilities: {
          type: "object",
          properties: {
            television: {
              type: "object",
              properties: {
                // Ajv strict mode wants every required name declared beside
                // the requirement; the shape itself comes from the $ref above.
                actions: { type: "object", properties: { setArtMode: {} }, required: ["setArtMode"] },
              },
              required: ["actions"],
            },
          },
          required: ["television"],
        },
      },
      required: ["capabilities"],
    },
  ],
  examples: [{
    schemaVersion: 1,
    id: "living-room-frame",
    name: "Living room Frame",
    capabilities: {
      television: {
        id: "living-room-frame",
        state: {
          availability: "online",
          observedAt: "2026-09-18T20:00:00Z",
          power: "on",
          artMode: "on",
        },
        actions: {
          turnOn: {},
          turnOff: {},
          press: { keys: ["up", "down", "left", "right", "select", "back", "home", "menu", "play", "pause"] },
          volumeUp: {},
          volumeDown: {},
          toggleMute: {},
          setArtMode: {},
          getState: {},
        },
      },
    },
  }],
} as const;

const cameraCapabilitySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 100 },
    category: {
      enum: [
        "video",
        "privacy",
        "audio",
        "detection",
        "storage",
        "feeding",
        "movement",
        "onvif",
        "advanced",
      ],
    },
    label: { type: "string", minLength: 1, maxLength: 120 },
    description: { type: "string", minLength: 1, maxLength: 500 },
    kind: {
      enum: [
        "toggle",
        "select",
        "range",
        "text",
        "color",
        "action",
        "momentary",
        "status",
        "json",
        "ptz",
        "treat",
        "schedule",
        "region",
        "polygon-region",
        "presets",
      ],
    },
    availability: { enum: ["available", "unavailable", "unknown"] },
    value: {
      anyOf: [
        { type: "boolean" },
        { type: "string" },
        { type: "number" },
        { type: "null" },
      ],
    },
    options: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          value: { type: "string", maxLength: 100 },
          label: { type: "string", minLength: 1, maxLength: 120 },
        },
        required: ["value", "label"],
      },
    },
    min: { type: "number" },
    max: { type: "number" },
    step: { type: "number", exclusiveMinimum: 0 },
    unit: { type: "string", maxLength: 40 },
    readOnly: { type: "boolean" },
    confirmation: { enum: ["none", "confirm", "type-device-name"] },
    dangerous: { type: "boolean" },
    presets: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, maxLength: 100 },
          label: { type: "string", minLength: 1, maxLength: 120 },
        },
        required: ["id", "label"],
      },
    },
    schedule: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: {
          enum: [
            "weekly-intervals",
            "deployment-intervals",
            "daily-window",
            "patrol-times",
            "feed-times",
            "tease-times",
          ],
        },
        maxEntries: { type: "integer", minimum: 1, maximum: 100 },
        entries: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean" },
              time: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
              startTime: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
              endTime: { type: "string", pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" },
              days: {
                type: "array",
                uniqueItems: true,
                maxItems: 7,
                items: { type: "string", pattern: "^(?:sun|mon|tue|wed|thu|fri|sat)$" },
              },
              once: { type: "boolean" },
              portions: { type: "integer", minimum: 1, maximum: 10 },
              sound: { type: "boolean" },
              mode: { type: "integer", minimum: 0, maximum: 10 },
              auto: { type: "boolean" },
            },
            required: ["enabled"],
          },
        },
      },
      required: ["mode", "entries", "maxEntries"],
    },
    region: {
      type: "object",
      additionalProperties: false,
      properties: {
        width: { const: 16 },
        height: { const: 9 },
        selectedCells: {
          type: "array",
          uniqueItems: true,
          maxItems: 144,
          items: { type: "integer", minimum: 0, maximum: 143 },
        },
      },
      required: ["width", "height", "selectedCells"],
    },
    polygonRegion: {
      type: "object",
      additionalProperties: false,
      properties: {
        maxPolygons: { const: 6 },
        pointCount: { const: 8 },
        polygons: {
          type: "array",
          maxItems: 6,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { type: "integer", minimum: 1, maximum: 3 },
              vId: { type: "integer", minimum: 0, maximum: 4 },
              aiTypes: {
                type: "array",
                uniqueItems: true,
                items: { type: "integer", minimum: 0, maximum: 65535 },
              },
              points: {
                type: "array",
                minItems: 8,
                maxItems: 8,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    x: { type: "integer", minimum: 0, maximum: 100 },
                    y: { type: "integer", minimum: 0, maximum: 100 },
                  },
                  required: ["x", "y"],
                },
              },
            },
            required: ["type", "points"],
          },
        },
      },
      required: ["maxPolygons", "pointCount", "polygons"],
    },
  },
  required: ["id", "category", "label", "kind", "availability"],
} as const;

/** How one camera is reached right now, with plain-language problems. */
export const cameraConnectionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    via: { enum: ["local", "onvif", "cloud", "none"] },
    onvif: {
      type: "object",
      additionalProperties: false,
      properties: {
        state: { enum: ["connected", "unavailable"] },
        detail: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["state"],
    },
    local: {
      type: "object",
      additionalProperties: false,
      properties: {
        state: { enum: ["connected", "waiting", "unavailable"] },
        detail: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["state"],
    },
    cloud: {
      type: "object",
      additionalProperties: false,
      properties: {
        state: { enum: ["online", "offline", "unknown", "unavailable"] },
        detail: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["state"],
    },
    problems: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 500 } },
  },
  required: ["via", "problems"],
} as const;

/** The shared DNS-override state: local emulator vs vendor cloud. */
export const cameraNetworkStatusSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { enum: ["local", "cloud", "unknown"] },
    dnsOverride: { enum: ["on", "off", "missing", "unavailable"] },
    domain: { type: "string", minLength: 1, maxLength: 253 },
    overrideIp: { type: "string", minLength: 7, maxLength: 45 },
    resolvedTo: { type: "string", minLength: 7, maxLength: 45 },
    detail: { type: "string", minLength: 1, maxLength: 1000 },
    checkedAt: { type: "string", minLength: 20, maxLength: 40 },
    canToggle: { type: "boolean" },
    /** Present when the status is one camera's own isolation state rather than the shared DNS view. */
    deviceId: { type: "string", minLength: 1, maxLength: 200 },
    /** Whether this camera is wanted isolated (its own gateway rule, the shared DNS records, a capture). */
    isolated: { type: "boolean" },
    /** The camera's per-device internet block on the gateway. */
    internetBlock: { enum: ["on", "off", "missing", "unavailable"] },
    /** The packet capture at the camera's access point. */
    capture: { enum: ["running", "stopped", "unavailable"] },
    /** Every vendor hostname HomeTruth stands in for while the camera is isolated. */
    hostnames: { type: "array", items: { type: "string", minLength: 1, maxLength: 253 }, maxItems: 32 },
  },
  required: ["mode", "dnsOverride", "domain", "overrideIp", "checkedAt", "canToggle"],
} as const;

export const cameraDashboardModelSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/camera-dashboard-model",
  type: "object",
  additionalProperties: false,
  properties: {
    setup: {
      type: "object",
      additionalProperties: false,
      properties: {
        configured: { type: "boolean" },
        profile: { enum: ["tkenpro", "cloudedge", null] },
        accountHint: { type: "string", minLength: 1, maxLength: 200 },
      },
      required: ["configured", "profile"],
    },
    discovery: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { enum: ["idle", "searching", "ready", "error"] },
        message: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["status"],
    },
    devices: {
      type: "array",
      maxItems: 256,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1, maxLength: 200 },
          name: { type: "string", minLength: 1, maxLength: 200 },
          host: { type: "string", minLength: 1, maxLength: 253 },
          model: { type: "string", minLength: 1, maxLength: 200 },
          firmware: { type: "string", minLength: 1, maxLength: 200 },
          status: { enum: ["online", "offline", "connecting", "unknown"] },
          stream: { enum: ["available", "unavailable", "unknown"] },
          snapshot: { enum: ["available", "unavailable", "unknown"] },
          capabilities: { type: "array", maxItems: 500, items: cameraCapabilitySchema },
          connection: cameraConnectionSchema,
        },
        required: ["id", "name", "status", "stream", "snapshot", "capabilities"],
      },
    },
    selectedDeviceId: {
      anyOf: [
        { type: "string", minLength: 1, maxLength: 200 },
        { type: "null" },
      ],
    },
    network: cameraNetworkStatusSchema,
  },
  required: ["setup", "discovery", "devices", "selectedDeviceId"],
} as const;

export const cameraNetworkToggleRequestSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/camera-network-toggle-request",
  type: "object",
  additionalProperties: false,
  properties: {
    action: { enum: ["on", "off"] },
    /** Kick the cameras' Wi-Fi afterwards so they follow the record at once (default true when the gateway allows it). */
    reconnect: { type: "boolean" },
    /** One camera's device id to isolate or release on its own; every camera when omitted. */
    deviceId: { type: "string", minLength: 1, maxLength: 200 },
  },
  required: ["action"],
} as const;

export const cameraNetworkReconnectRequestSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/camera-network-reconnect-request",
  type: "object",
  additionalProperties: false,
  properties: {
    /** One camera's dashboard id; every bootstrapped camera when omitted. */
    deviceId: { type: "string", minLength: 1, maxLength: 200 },
  },
} as const;

export const cameraRebootRequestSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/camera-reboot-request",
  type: "object",
  additionalProperties: false,
  properties: {
    /** The camera's dashboard id. */
    deviceId: { type: "string", minLength: 1, maxLength: 200 },
    /** Or the camera's configured LAN address. */
    host: { type: "string", pattern: "^[A-Za-z0-9.-]+$", minLength: 1, maxLength: 253 },
    /** How long to wait for the camera to answer at that address again; 120 by default. */
    timeoutSeconds: { type: "integer", minimum: 10, maximum: 600 },
  },
} as const;

export const cameraSetupRequestSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/camera-setup-request",
  type: "object",
  additionalProperties: false,
  properties: {
    profile: { enum: ["tkenpro", "cloudedge"] },
    countryCode: { type: "string", pattern: "^[A-Z]{2}$" },
    phoneCode: { type: "string", pattern: "^\\+?[0-9]{1,4}$" },
    email: { type: "string", minLength: 3, maxLength: 320 },
    password: { type: "string", minLength: 1, maxLength: 1024 },
    onvifUsername: { type: "string", minLength: 1, maxLength: 128 },
    onvifPassword: { type: "string", minLength: 1, maxLength: 1024 },
  },
  required: ["profile"],
} as const;

export const cameraDiscoverRequestSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/camera-discover-request",
  type: "object",
  additionalProperties: false,
  properties: {
    hosts: {
      type: "array",
      uniqueItems: true,
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: 253 },
    },
    cidrs: {
      type: "array",
      uniqueItems: true,
      maxItems: 16,
      items: { type: "string", pattern: "^(?:10|127|169\\.254|172\\.(?:1[6-9]|2\\d|3[01])|192\\.168)(?:\\.[0-9]{1,3}){2}/(?:[8-9]|[12]\\d|3[0-2])$" },
    },
  },
} as const;

export const cameraSelectRequestSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/camera-select-request",
  type: "object",
  additionalProperties: false,
  properties: {
    deviceId: { type: "string", minLength: 1, maxLength: 200 },
  },
  required: ["deviceId"],
} as const;

export const cameraControlRequestSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/camera-control-request",
  type: "object",
  additionalProperties: false,
  properties: {
    deviceId: { type: "string", minLength: 1, maxLength: 200 },
    capabilityId: { type: "string", minLength: 1, maxLength: 100 },
    value: {
      anyOf: [
        { type: "boolean" },
        { type: "string", maxLength: 4096 },
        { type: "number" },
        { type: "null" },
        { type: "array", maxItems: 100 },
        { type: "object", maxProperties: 100 },
      ],
    },
    confirmed: { type: "boolean" },
  },
  required: ["deviceId", "capabilityId", "value"],
} as const;

export const cameraPtzRequestSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/camera-ptz-request",
  type: "object",
  additionalProperties: false,
  properties: {
    deviceId: { type: "string", minLength: 1, maxLength: 200 },
    action: { enum: ["start", "stop"] },
    direction: { enum: ["left", "right", "up", "down"] },
    leaseMs: { type: "integer", minimum: 100, maximum: 3000 },
    commandId: { type: "string", minLength: 1, maxLength: 100 },
  },
  required: ["deviceId", "action", "commandId"],
} as const;

export const cameraActionResponseSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/camera-action-response",
  type: "object",
  additionalProperties: false,
  properties: {
    ok: { const: true },
    message: { type: "string", minLength: 1, maxLength: 500 },
    state: { $ref: cameraDashboardModelSchema.$id },
  },
  required: ["ok", "state"],
} as const;

export const schemaDocumentSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/schema-document",
  type: "object",
  additionalProperties: true,
  properties: {
    $schema: { type: "string", format: "uri" },
    $id: { type: "string", format: "uri" },
    type: { type: "string", minLength: 1 },
  },
  required: ["$schema", "$id", "type"],
} as const;

export const schemaCatalogEntrySchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/schema-catalog-entry",
  type: "object",
  additionalProperties: false,
  properties: {
    key: { type: "string", pattern: "^[a-z][a-zA-Z0-9]*$" },
    title: { type: "string", minLength: 1, maxLength: 120 },
    typeName: { type: "string", pattern: "^[A-Z][a-zA-Z0-9]*$" },
    category: { enum: ["business", "api", "system"] },
    description: { type: "string", minLength: 1, maxLength: 500 },
    schemaId: { type: "string", format: "uri" },
    schema: { $ref: schemaDocumentSchema.$id },
    page: { type: "string", minLength: 1, maxLength: 500 },
  },
  required: ["key", "title", "typeName", "category", "description", "schemaId", "schema"],
} as const;

export const schemaCatalogResponseSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/schema-catalog-response",
  type: "object",
  additionalProperties: false,
  properties: {
    schemas: {
      type: "array",
      items: { $ref: schemaCatalogEntrySchema.$id },
      minItems: 1,
      maxItems: 500,
    },
    counts: {
      type: "object",
      additionalProperties: false,
      properties: {
        business: { type: "integer", minimum: 0 },
        api: { type: "integer", minimum: 0 },
        system: { type: "integer", minimum: 0 },
      },
      required: ["business", "api", "system"],
    },
    generatedAt: { type: "string", format: "date-time" },
  },
  required: ["schemas", "counts", "generatedAt"],
} as const;

export const errorResponseSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/error-response",
  type: "object",
  additionalProperties: false,
  properties: {
    error: {
      type: "object",
      additionalProperties: false,
      properties: {
        code: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
        message: { type: "string", minLength: 1, maxLength: 500 },
        // Underlying failure (e.g. the camera's own response) when one exists.
        detail: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["code", "message"],
    },
  },
  required: ["error"],
} as const;

export type AppConfig = FromSchema<typeof appConfigSchema>;
export type HubDiscovery = FromSchema<typeof hubDiscoverySchema>;
export type DevicesConfig = FromSchema<typeof devicesConfigSchema>;
export type DeviceListResponse = FromSchema<typeof deviceListResponseSchema, { references: [typeof deviceConnectionTypeSchema] }>;
export type ModelListResponse = FromSchema<typeof modelListResponseSchema, { references: [typeof deviceConnectionTypeSchema] }>;
export type ServiceListResponse = FromSchema<typeof serviceListResponseSchema>;
export type ServiceEventsResponse = FromSchema<typeof serviceEventsResponseSchema, { references: [typeof eventSchema] }>;
export type DeviceEventsResponse = FromSchema<typeof deviceEventsResponseSchema, { references: [typeof eventSchema] }>;
export type EventsResponse = FromSchema<typeof eventsResponseSchema, { references: [typeof eventSchema] }>;
export type EventTypeCatalogResponse = FromSchema<typeof eventTypeCatalogResponseSchema>;
export type DeviceControlRequest = FromSchema<typeof deviceControlRequestSchema>;
export type DeviceEnabled = FromSchema<typeof deviceEnabledSchema>;
export type DeviceRenameRequest = FromSchema<typeof deviceRenameRequestSchema>;
export type DeviceRenameResponse = FromSchema<typeof deviceRenameResponseSchema>;
export type DevProject = FromSchema<typeof devProjectSchema>;
export type RegistrationResponse = FromSchema<typeof registrationResponseSchema>;
export type UnregisterRequest = FromSchema<typeof unregisterRequestSchema>;
export type UnregisterResponse = FromSchema<typeof unregisterResponseSchema>;
export type HealthResponse = FromSchema<typeof healthResponseSchema>;
export type Camera = FromSchema<typeof cameraSchema>;
export type Light = FromSchema<typeof lightSchema>;
export type StringLightDocument = FromSchema<typeof stringLightSchema>;
export type BinarySwitch = FromSchema<typeof binarySwitchSchema>;
export type Button = FromSchema<typeof buttonSchema>;
export type ButtonPressRequest = FromSchema<typeof buttonPressRequestSchema>;
export type Workflow = FromSchema<typeof workflowSchema>;
export type WorkflowButtonCreateRequest = FromSchema<typeof workflowButtonCreateRequestSchema>;
export type WorkflowButtonUpdateRequest = FromSchema<typeof workflowButtonUpdateRequestSchema>;
export type OptimisticSwitchCreateRequest = FromSchema<typeof optimisticSwitchCreateRequestSchema>;
export type OptimisticSwitchCreateResponse = FromSchema<typeof optimisticSwitchCreateResponseSchema>;
export type MotionSensor = FromSchema<typeof motionSensorSchema>;
export type InfraredBlaster = FromSchema<typeof infraredBlasterSchema>;
export type InfraredReceiver = FromSchema<typeof infraredReceiverSchema>;
export type RadioFrequencyBlaster = FromSchema<typeof radioFrequencyBlasterSchema>;
export type RadioFrequencyReceiver = FromSchema<typeof radioFrequencyReceiverSchema>;
export type TreatDispenser = FromSchema<typeof treatDispenserSchema>;
export type Speaker = FromSchema<typeof speakerSchema>;
export type Television = FromSchema<typeof televisionSchema>;
export type IrRfBlasterDocument = FromSchema<
  typeof irRfBlasterDeviceSchema,
  { references: [typeof infraredBlasterSchema, typeof radioFrequencyBlasterSchema] }
>;
export type IrRfBlasterSendRequest = FromSchema<typeof irRfBlasterSendRequestSchema>;
export type IrRfBlasterSendCodeRequest = FromSchema<typeof irRfBlasterSendCodeRequestSchema>;
export type IrRfBlasterUpdateCodeRequest = FromSchema<typeof irRfBlasterUpdateCodeRequestSchema>;
export type IrRfBlasterLearnRequest = FromSchema<typeof irRfBlasterLearnRequestSchema>;
export type IrRfBlasterLearnResponse = FromSchema<typeof irRfBlasterLearnResponseSchema>;
export type SavedSignalCode = FromSchema<typeof savedSignalCodeSchema>;
export type IrRfBlasterSaveCodeRequest = FromSchema<typeof irRfBlasterSaveCodeRequestSchema>;
export type IrRfCodesFile = FromSchema<typeof irRfCodesFileSchema>;
export type SourceRegion = FromSchema<typeof sourceRegionSchema>;
export type CameraRegionResponse = FromSchema<typeof cameraRegionResponseSchema>;
export type SecretsFile = FromSchema<typeof secretsFileSchema>;
export type HomeTruthObject = FromSchema<
  typeof homeTruthObjectSchema,
  {
    references: [
      typeof cameraSchema,
      typeof lightSchema,
      typeof stringLightSchema,
      typeof binarySwitchSchema,
      typeof buttonSchema,
      typeof motionSensorSchema,
      typeof cooktopSchema,
      typeof sensorCollectionSchema,
      typeof sensorSchema,
      typeof temperatureSensorSchema,
      typeof humiditySensorSchema,
      typeof batterySensorSchema,
      typeof occupancySensorSchema,
      typeof contactSensorSchema,
      typeof hubSchema,
      typeof infraredBlasterSchema,
      typeof infraredReceiverSchema,
      typeof radioFrequencyBlasterSchema,
      typeof radioFrequencyReceiverSchema,
      typeof treatDispenserSchema,
      typeof speakerSchema,
      typeof televisionSchema
    ];
  }
>;
export type PetTreatDispenserCamera = FromSchema<
  typeof petTreatDispenserCameraSchema,
  {
    references: [
      typeof homeTruthObjectSchema,
      typeof cameraSchema,
      typeof lightSchema,
      typeof stringLightSchema,
      typeof binarySwitchSchema,
      typeof buttonSchema,
      typeof motionSensorSchema,
      typeof cooktopSchema,
      typeof sensorCollectionSchema,
      typeof sensorSchema,
      typeof temperatureSensorSchema,
      typeof humiditySensorSchema,
      typeof batterySensorSchema,
      typeof occupancySensorSchema,
      typeof contactSensorSchema,
      typeof hubSchema,
      typeof infraredBlasterSchema,
      typeof infraredReceiverSchema,
      typeof radioFrequencyBlasterSchema,
      typeof radioFrequencyReceiverSchema,
      typeof treatDispenserSchema,
      typeof speakerSchema,
      typeof televisionSchema
    ];
  }
>;
export type CameraMotionSensor = FromSchema<
  typeof cameraMotionSensorSchema,
  {
    references: [
      typeof homeTruthObjectSchema,
      typeof cameraSchema,
      typeof lightSchema,
      typeof stringLightSchema,
      typeof binarySwitchSchema,
      typeof buttonSchema,
      typeof motionSensorSchema,
      typeof cooktopSchema,
      typeof sensorCollectionSchema,
      typeof sensorSchema,
      typeof temperatureSensorSchema,
      typeof humiditySensorSchema,
      typeof batterySensorSchema,
      typeof occupancySensorSchema,
      typeof contactSensorSchema,
      typeof hubSchema,
      typeof infraredBlasterSchema,
      typeof infraredReceiverSchema,
      typeof radioFrequencyBlasterSchema,
      typeof radioFrequencyReceiverSchema,
      typeof treatDispenserSchema,
      typeof speakerSchema,
      typeof televisionSchema
    ];
  }
>;
export type SamsungFrame = FromSchema<
  typeof samsungFrameSchema,
  {
    references: [
      typeof homeTruthObjectSchema,
      typeof cameraSchema,
      typeof lightSchema,
      typeof stringLightSchema,
      typeof binarySwitchSchema,
      typeof buttonSchema,
      typeof motionSensorSchema,
      typeof cooktopSchema,
      typeof sensorCollectionSchema,
      typeof sensorSchema,
      typeof temperatureSensorSchema,
      typeof humiditySensorSchema,
      typeof batterySensorSchema,
      typeof occupancySensorSchema,
      typeof contactSensorSchema,
      typeof hubSchema,
      typeof infraredBlasterSchema,
      typeof infraredReceiverSchema,
      typeof radioFrequencyBlasterSchema,
      typeof radioFrequencyReceiverSchema,
      typeof treatDispenserSchema,
      typeof speakerSchema,
      typeof televisionSchema
    ];
  }
>;
export type CameraDashboardModelContract = FromSchema<typeof cameraDashboardModelSchema>;
export type CameraSetupRequest = FromSchema<typeof cameraSetupRequestSchema>;
export type CameraNetworkToggleRequest = FromSchema<typeof cameraNetworkToggleRequestSchema>;
export type CameraNetworkReconnectRequest = FromSchema<typeof cameraNetworkReconnectRequestSchema>;
export type CameraRebootRequest = FromSchema<typeof cameraRebootRequestSchema>;
export type CameraConnectionView = FromSchema<typeof cameraConnectionSchema>;
export type CameraNetworkStatusView = FromSchema<typeof cameraNetworkStatusSchema>;
export type CameraDiscoverRequest = FromSchema<typeof cameraDiscoverRequestSchema>;
export type CameraSelectRequest = FromSchema<typeof cameraSelectRequestSchema>;
export type CameraControlRequest = FromSchema<typeof cameraControlRequestSchema>;
export type CameraPtzRequest = FromSchema<typeof cameraPtzRequestSchema>;
export type CameraActionResponse = FromSchema<
  typeof cameraActionResponseSchema,
  { references: [typeof cameraDashboardModelSchema] }
>;
export type ErrorResponse = FromSchema<typeof errorResponseSchema>;
export type SchemaDocument = FromSchema<typeof schemaDocumentSchema>;
export type SchemaCatalogEntry = FromSchema<
  typeof schemaCatalogEntrySchema,
  { references: [typeof schemaDocumentSchema] }
>;
export type SchemaCatalogResponse = FromSchema<
  typeof schemaCatalogResponseSchema,
  { references: [typeof schemaDocumentSchema, typeof schemaCatalogEntrySchema] }
>;

export type DeviceRoomRequest = FromSchema<typeof deviceRoomRequestSchema>;
export { kindleConfigSchema } from "./kindle/config";
export type { KindleConfig, KindleItem } from "./kindle/config";
