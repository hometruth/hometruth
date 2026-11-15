/**
 * The topology contract and the positioned scene shared by the API and page.
 *
 * These go in the schema catalog like every other contract, which means the
 * graph API is itself a node in the graph: opening the Graph tab on the graph
 * response schema shows what refers to it. That is a small piece of recursion
 * and a genuine self-test — a contract that cannot describe itself is one the
 * catalog does not really cover.
 */
import { ELEMENT_KINDS } from "../tags/identity";
import { RELATION_NAMES } from "./types";

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

const identity = { type: "string", minLength: 1, maxLength: 4096 } as const;
const count = { type: "integer", minimum: 0 } as const;
const coordinate = { type: "number" } as const;
const size = { type: "number", minimum: 0 } as const;
const point = {
  type: "object", additionalProperties: false,
  properties: { x: coordinate, y: coordinate }, required: ["x", "y"],
} as const;
const queryFields = {
  view: { enum: ["home", "dependencies", "model"] },
  focus: identity,
  selected: identity,
  q: { type: "string", maxLength: 200 },
  group: { enum: ["room", "kind"] },
  depth: { type: "integer", minimum: 0, maximum: 3 },
} as const;
const expansions = { type: "array", maxItems: 64, uniqueItems: true, items: identity } as const;

/** URL parameters; repeated expand/relation values are arrays in OpenAPI. */
export const graphQueryParameters = {
  ...queryFields,
  focus: { ...identity, description: "The current public element address, resolved to its canonical identity in the returned scene." },
  selected: { ...identity, description: "The current public address of the element selected in the scene." },
  expand: { ...expansions, description: 'Repeat for each public element address or home group descriptor to expand. Dependencies initially shows at most 12 nodes; each distinct reached element explicitly expanded reveals its one-hop neighbors and raises the limit by 12, up to 48. Depth alone does not raise this limit. Room descriptors use ["room","<current room address>"]; kind and unassigned descriptors retain their literal names.' },
  relation: { type: "array", uniqueItems: true, items: { enum: [...RELATION_NAMES] }, description: "Repeat to select relation types allowed by the current view. When omitted, Dependencies defaults to uses for ordinary elements, members and groupSwitch for groups, and services and sourcedBy for services. Explicit selections replace those defaults; Home and Model retain their view defaults when omitted." },
} as const;

export const graphResponseSchema = {
  $schema: dialect,
  $id: "https://hometruth.ai/schemas/graph-response",
  title: "Graph scene",
  description: "The bounded Home, Dependencies or Model scene drawn by the graph page, with its query, canonical elements, occurrences, omission counts and geometry.",
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "object", additionalProperties: false,
      properties: {
        ...queryFields,
        expanded: expansions,
        relations: graphQueryParameters.relation,
      },
      required: ["view", "q", "group", "depth", "expanded", "relations"],
    },
    nodes: {
      type: "array", maxItems: 400,
      items: {
        type: "object", additionalProperties: false,
        properties: {
          id: identity, node: { $ref: graphNodeSchema.$id }, group: identity, hidden: count,
          x: coordinate, y: coordinate, width: size, height: size,
          label: { type: "array", minItems: 1, maxItems: 3, items: { type: "string", maxLength: 400 } },
        },
        required: ["id", "node", "hidden", "x", "y", "width", "height", "label"],
      },
    },
    edges: {
      type: "array", maxItems: 2000,
      items: {
        type: "object", additionalProperties: false,
        properties: {
          id: identity, from: identity, to: identity, edge: { $ref: graphEdgeSchema.$id },
          sections: {
            type: "array", items: {
              type: "object", additionalProperties: false,
              properties: { startPoint: point, bendPoints: { type: "array", items: point }, endPoint: point },
              required: ["startPoint", "endPoint"],
            },
          },
          label: {
            type: "object", additionalProperties: false,
            properties: { x: coordinate, y: coordinate, width: size, height: size, text: { type: "string", maxLength: 400 } },
            required: ["x", "y", "width", "height", "text"],
          },
        },
        required: ["id", "from", "to", "edge", "sections"],
      },
    },
    groups: {
      type: "array", items: {
        type: "object", additionalProperties: false,
        properties: { id: identity, name: { type: "string", maxLength: 400 }, total: count, hidden: count, kind: { enum: ["room", "kind", "unassigned"] } },
        required: ["id", "name", "total", "hidden", "kind"],
      },
    },
    total: count, matched: count, omitted: count,
    width: size, height: size,
    generatedAt: { type: "string", format: "date-time" },
  },
  required: ["query", "nodes", "edges", "groups", "total", "matched", "omitted", "width", "height", "generatedAt"],
} as const;
