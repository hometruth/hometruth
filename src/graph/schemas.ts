/**
 * What `GET /api/graph` and `GET /api/graph/:key` answer with.
 *
 * These go in the schema catalog like every other contract, which means the
 * graph API is itself a node in the graph: opening the Graph tab on the graph
 * response schema shows what refers to it. That is a small piece of recursion
 * and a genuine self-test — a contract that cannot describe itself is one the
 * catalog does not really cover.
 */
import { ELEMENT_KINDS } from "../tags/identity";
import { ALL_RELATION_NAMES, RELATION_NAMES } from "./types";

const dialect = "https://json-schema.org/draft/2020-12/schema" as const;

const iconSchema = {
  type: "object",
  oneOf: [
    { additionalProperties: false, properties: { kind: { const: "emoji" }, value: { type: "string", minLength: 1, maxLength: 16 } }, required: ["kind", "value"] },
    { additionalProperties: false, properties: { kind: { const: "image" }, src: { type: "string", minLength: 1, maxLength: 512 }, alt: { type: "string", maxLength: 200 } }, required: ["kind", "src"] },
  ],
} as const;

export const graphNodeSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/graph-node",
  title: "Graph node",
  description: "One element in the system graph: what it is, where it lives, and the schema it is an instance of.",
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1, maxLength: 512 },
    side: { enum: ["schema", "instance", "tag"] },
    kind: { enum: [...ELEMENT_KINDS] },
    name: { type: "string", minLength: 1, maxLength: 400 },
    context: { type: "string", maxLength: 400 },
    page: { type: "string", maxLength: 512 },
    icon: iconSchema,
    ids: { type: "array", maxItems: 8, items: { type: "string", maxLength: 512 } },
    schema: { type: "string", maxLength: 512 },
    stateNode: { type: "string", maxLength: 256 },
    present: { type: "boolean" },
  },
  required: ["id", "side", "kind", "name", "context", "page", "icon", "ids"],
} as const;

export const graphEdgeSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/graph-edge",
  title: "Graph edge",
  description: "One connection, stored once in its canonical direction, with the role it plays and where the edge came from.",
  type: "object",
  additionalProperties: false,
  properties: {
    from: { type: "string", minLength: 1, maxLength: 512 },
    to: { type: "string", minLength: 1, maxLength: 512 },
    relation: { enum: [...RELATION_NAMES] },
    label: { type: "string", maxLength: 100 },
    via: { type: "string", maxLength: 100 },
    origin: { enum: ["structure", "resolution", "site", "schema", "source"] },
  },
  required: ["from", "to", "relation", "origin"],
} as const;

export const graphResponseSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/graph-response",
  title: "Graph response",
  description: "An element's own connections and one level beyond, already positioned for drawing.",
  type: "object",
  additionalProperties: false,
  properties: {
    focus: { type: "string", minLength: 1, maxLength: 512 },
    depth: { type: "integer", minimum: 0, maximum: 3 },
    nodes: {
      type: "array",
      maxItems: 400,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          node: { $ref: graphNodeSchema.$id },
          depth: { type: "integer", minimum: 0, maximum: 3 },
          via: { enum: [...ALL_RELATION_NAMES] },
          x: { type: "number" },
          y: { type: "number" },
          label: { type: "string", maxLength: 400 },
          angle: { type: "number" },
          anchor: { enum: ["start", "middle", "end"] },
        },
        required: ["node", "depth", "x", "y", "label", "angle", "anchor"],
      },
    },
    edges: { type: "array", maxItems: 2000, items: { $ref: graphEdgeSchema.$id } },
    truncated: {
      type: "array",
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          from: { type: "string", maxLength: 512 },
          relation: { type: "string", maxLength: 64 },
          hidden: { type: "integer", minimum: 1 },
          x: { type: "number" }, y: { type: "number" }, angle: { type: "number" },
          anchor: { enum: ["start", "middle", "end"] },
        },
        required: ["from", "relation", "hidden", "x", "y", "angle", "anchor"],
      },
    },
    viewBox: { type: "array", minItems: 4, maxItems: 4, items: { type: "number" } },
    generatedAt: { type: "string", format: "date-time" },
  },
  required: ["focus", "depth", "nodes", "edges", "truncated", "viewBox", "generatedAt"],
} as const;
