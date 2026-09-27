/**
 * JSON Schemas for what the state graph stores and what its stream sends:
 * the node record, the four stream frames, and the group switch document.
 * Validators are compiled here with the same Ajv setup as `src/validation.ts`
 * so `encodeFrame` can check every frame under test without a round trip
 * through the main registry.
 */
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { SWITCH_REQUIREMENTS } from "../models/device-group";
import { binarySwitchSchema } from "../schemas";
import { NODE_ID_PATTERN, type GroupSwitch, type NodeRecord, type StreamError, type StreamHello, type StreamObserved } from "./protocol";

const dialect = "https://json-schema.org/draft/2020-12/schema" as const;

const nodeIdSchema = { type: "string", pattern: NODE_ID_PATTERN.source, minLength: 7, maxLength: 207 } as const;
const availabilitySchema = { enum: ["online", "offline", "degraded", "unknown"] } as const;

export const nodeRecordSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/state-node-record",
  title: "State node record",
  description: "One node of the state graph as a `state` frame carries it: the last good value, the current fault if any, and when each was seen.",
  type: "object",
  additionalProperties: false,
  properties: {
    node: nodeIdSchema,
    version: { type: "integer", minimum: 0 },
    value: {},
    fault: {
      type: "object",
      additionalProperties: false,
      properties: {
        code: { enum: ["unreachable", "timeout", "invalid", "unconfigured", "disabled"] },
        message: { type: "string", minLength: 1, maxLength: 1000 },
      },
      required: ["code", "message"],
    },
    observedAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: ["node", "version", "updatedAt"],
  examples: [{
    node: "device/relay",
    version: 3,
    value: { schemaVersion: 1, id: "relay", name: "Porch relay", capabilities: {} },
    observedAt: "2026-09-14T12:00:00.000Z",
    updatedAt: "2026-09-14T11:59:40.000Z",
  }],
} as const;

export const streamHelloSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/state-stream-hello",
  title: "State stream hello",
  description: "The first frame of GET /api/state/stream: which worker generation answered, the tier it observes at, and the nodes it will send.",
  type: "object",
  additionalProperties: false,
  properties: {
    generation: { type: "string", minLength: 1, maxLength: 200 },
    tier: { enum: ["live", "glance"] },
    nodes: { type: "array", maxItems: 200, uniqueItems: true, items: nodeIdSchema },
    keepaliveMs: { type: "integer", minimum: 1000 },
  },
  required: ["generation", "tier", "nodes", "keepaliveMs"],
} as const;

export const streamObservedSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/state-stream-observed",
  title: "State stream observed",
  description: "Polls that changed nothing, coalesced per flush: node id to the newest observedAt.",
  type: "object",
  minProperties: 1,
  propertyNames: { type: "string", pattern: NODE_ID_PATTERN.source },
  additionalProperties: { type: "string", format: "date-time" },
} as const;

export const streamErrorSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/state-stream-error",
  title: "State stream error",
  description: "Why a stream is closing right after hello; the client retries after the retry hint.",
  type: "object",
  additionalProperties: false,
  properties: {
    code: { const: "too_many_streams" },
    message: { type: "string", minLength: 1, maxLength: 500 },
  },
  required: ["code", "message"],
} as const;

export const groupSwitchSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/group-switch",
  title: "Group switch",
  description: "A device group used as a switch, shaped like a device with a binarySwitch capability. The power value is present only while every member agrees.",
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$", minLength: 1, maxLength: 100 },
    name: { type: "string", minLength: 1, maxLength: 200 },
    status: availabilitySchema,
    capabilities: {
      type: "object",
      additionalProperties: false,
      properties: { binarySwitch: { $ref: binarySwitchSchema.$id } },
      required: ["binarySwitch"],
    },
    group: {
      type: "object",
      additionalProperties: false,
      properties: {
        mixed: { type: "boolean" },
        canSwitch: { type: "boolean" },
        members: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string", minLength: 1, maxLength: 100 },
              name: { type: "string", minLength: 1, maxLength: 200 },
              availability: availabilitySchema,
              properties: { type: "object" },
              error: { type: "string", minLength: 1 },
              missingForSwitch: { type: "array", uniqueItems: true, items: { enum: SWITCH_REQUIREMENTS } },
            },
            required: ["id", "name", "availability", "properties"],
          },
        },
      },
      required: ["mixed", "canSwitch", "members"],
    },
  },
  required: ["id", "name", "status", "capabilities", "group"],
} as const;

const ajv = new Ajv2020({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
});
addFormats(ajv);
ajv.addSchema(binarySwitchSchema);

export const stateValidators = {
  nodeRecord: ajv.compile<NodeRecord>(nodeRecordSchema),
  streamHello: ajv.compile<StreamHello>(streamHelloSchema),
  streamObserved: ajv.compile<StreamObserved>(streamObservedSchema),
  streamError: ajv.compile<StreamError>(streamErrorSchema),
  groupSwitch: ajv.compile<GroupSwitch>(groupSwitchSchema),
};
