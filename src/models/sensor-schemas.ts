const availability = { enum: ["online", "offline", "degraded", "unknown"] } as const;
const common = {
  availability,
  detail: { type: "string", maxLength: 500 },
  observedAt: { type: "string", format: "date-time" },
} as const;
const id = { type: "string", minLength: 1, maxLength: 100 } as const;
const dialect = "https://json-schema.org/draft/2020-12/schema";
const actions = { type: "object", additionalProperties: false } as const;

/** Identity of a sensor within its owning device; ids need not be unique across devices. */
export const sensorDefinition = {
  type: "object", additionalProperties: false,
  properties: { id, name: { type: "string", minLength: 1, maxLength: 100 }, schemaId: { type: "string", format: "uri" } },
  required: ["id", "name", "schemaId"],
} as const;

const sensorProperties = {
  id, name: sensorDefinition.properties.name,
} as const;
const observation = {
  type: "object", additionalProperties: false,
  properties: { ...common, value: { type: "number" }, source: { type: "string", maxLength: 100 } },
  required: ["availability"],
  dependentRequired: { value: ["observedAt"] },
  allOf: [
    { if: { properties: { availability: { const: "online" } }, required: ["availability"] }, then: { properties: { value: {}, observedAt: {} }, required: ["value", "observedAt"] } },
    { if: { properties: { availability: { enum: ["offline", "unknown"] } }, required: ["availability"] }, then: { not: { properties: { value: {} }, required: ["value"] } } },
  ],
} as const;

export const temperatureSensorSchema = {
  $schema: dialect, $id: "https://hometruth.ai/schemas/temperature-sensor", title: "Temperature sensor",
  description: "One temperature sensor owned by a device. Values are degrees Celsius.",
  type: "object", additionalProperties: false,
  properties: {
    ...sensorProperties,
    schemaId: { const: "https://hometruth.ai/schemas/temperature-sensor" },
    kind: { const: "temperature" }, unit: { const: "°C" },
    state: { ...observation, properties: { ...observation.properties, value: { type: "number", minimum: -273.15 } } },
  },
  required: ["id", "name", "schemaId", "kind", "unit", "state"],
} as const;

export const humiditySensorSchema = {
  $schema: dialect, $id: "https://hometruth.ai/schemas/humidity-sensor", title: "Humidity sensor",
  description: "One relative humidity sensor owned by a device. Values are percentages from 0 to 100.",
  type: "object", additionalProperties: false,
  properties: {
    ...sensorProperties,
    schemaId: { const: "https://hometruth.ai/schemas/humidity-sensor" },
    kind: { const: "humidity" }, unit: { const: "%" },
    state: { ...observation, properties: { ...observation.properties, value: { type: "number", minimum: 0, maximum: 100 } } },
  },
  required: ["id", "name", "schemaId", "kind", "unit", "state"],
} as const;

export const batterySensorSchema = {
  $schema: dialect, $id: "https://hometruth.ai/schemas/battery-sensor", title: "Battery sensor",
  description: "One battery charge sensor owned by a device. Values are percentages from 0 to 100.",
  type: "object", additionalProperties: false,
  properties: {
    ...sensorProperties,
    schemaId: { const: "https://hometruth.ai/schemas/battery-sensor" },
    kind: { const: "battery" }, unit: { const: "%" },
    state: { ...observation, properties: { ...observation.properties, value: { type: "number", minimum: 0, maximum: 100 } } },
  },
  required: ["id", "name", "schemaId", "kind", "unit", "state"],
} as const;

/** Each array entry is one sensor, validated by its own type's schema. */
export const sensorSchema = {
  $schema: dialect, $id: "https://hometruth.ai/schemas/sensor", title: "Sensor",
  type: "object",
  description: "One typed sensor belonging to a device, with its own identity, unit, state, and schema.",
  oneOf: [{ $ref: temperatureSensorSchema.$id }, { $ref: humiditySensorSchema.$id }, { $ref: batterySensorSchema.$id }],
} as const;

/** A device can expose several independently available measurements. */
export const sensorCollectionSchema = {
  $schema: dialect, $id: "https://hometruth.ai/schemas/sensor-collection", title: "Sensor collection",
  type: "object", additionalProperties: false,
  properties: {
    id, actions,
    state: {
      type: "object", additionalProperties: false,
      properties: {
        ...common,
        sensors: { type: "array", maxItems: 100, items: {
          type: "object", additionalProperties: false,
          properties: {
            id, name: { type: "string", minLength: 1, maxLength: 100 },
            quantity: { type: "string", minLength: 1, maxLength: 100 },
            unit: { type: "string", maxLength: 30 },
            ...common,
            value: { type: "number" },
            source: { type: "string", maxLength: 100 },
          },
          required: ["id", "name", "quantity", "unit", "availability"],
          dependentRequired: { value: ["observedAt"] },
        } },
      }, required: ["availability", "sensors"],
    },
  }, required: ["id", "state", "actions"],
} as const;

export const occupancySensorSchema = {
  $schema: dialect, $id: "https://hometruth.ai/schemas/occupancy-sensor", title: "Occupancy sensor",
  type: "object", additionalProperties: false,
  properties: {
    id, actions,
    state: {
      type: "object", additionalProperties: false,
      properties: {
        ...common, occupied: { type: "boolean" }, illuminanceLux: { type: "number", minimum: 0 },
        zones: { type: "array", maxItems: 100, items: {
          type: "object", additionalProperties: false,
          properties: { id, name: { type: "string" }, occupied: { type: "boolean" }, availability },
          required: ["id", "name", "availability"],
        } },
      },
      required: ["availability"], dependentRequired: { occupied: ["observedAt"], zones: ["observedAt"], illuminanceLux: ["observedAt"] },
    },
  }, required: ["id", "state", "actions"],
} as const;

export const contactSensorSchema = {
  $schema: dialect, $id: "https://hometruth.ai/schemas/contact-sensor", title: "Contact sensor",
  type: "object", additionalProperties: false,
  properties: {
    id, actions,
    state: {
      type: "object", additionalProperties: false,
      properties: {
        ...common, open: { type: "boolean" }, batteryPercent: { type: "number", minimum: 0, maximum: 100 }, tampered: { type: "boolean" },
      },
      required: ["availability"], dependentRequired: { open: ["observedAt"], batteryPercent: ["observedAt"] },
    },
  }, required: ["id", "state", "actions"],
} as const;

export const hubSchema = {
  $schema: dialect, $id: "https://hometruth.ai/schemas/hub", title: "Hub",
  type: "object", additionalProperties: false,
  properties: {
    id, actions,
    state: {
      type: "object", additionalProperties: false,
      properties: {
        ...common,
        securityState: { enum: ["stay", "away", "night", "disarmed", "triggered"] },
        accessories: { type: "array", maxItems: 200, items: {
          type: "object", additionalProperties: false,
          properties: { id, name: { type: "string" }, model: { type: "string" }, serialNumber: { type: "string" } },
          required: ["id", "name"],
        } },
      }, required: ["availability"], dependentRequired: { accessories: ["observedAt"], securityState: ["observedAt"] },
    },
  }, required: ["id", "state", "actions"],
} as const;
