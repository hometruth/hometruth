/**
 * The schema graph: the abstract half. Types, not things.
 *
 * Nodes are schemas, device models, event types, and the control and property
 * *definitions* a capability schema declares. Edges are definitional:
 * `references` from a `$ref`, `implements` from a model's capability list,
 * `declares` for a model's own config and secrets schemas, `defines` for the
 * controls and properties a schema documents.
 *
 * It is identical on every install and never changes while the process runs,
 * so it is built once and cached. Nothing here reads a device, a config file,
 * or the network.
 *
 * A capability kind is not a node of its own: the capability's schema *is* the
 * kind's definition, and `CAPABILITY_KIND_SCHEMA_IDS` already maps one to the
 * other. Definition nodes are keyed by the schema's `$id` rather than a device
 * id, which is what keeps them distinct from the per-device occurrences of the
 * same control or property in the instance graph.
 */
import { MODELS } from "../registry";
import { CAPABILITY_KIND_SCHEMA_IDS, schemaCatalogEntries, schemaPagePath } from "../schema-catalog";
import { EVENT_TYPES } from "../models/event-types";
import { eventSchema } from "../models/event-schema";
import { filterSchema } from "../models/filter-schema";
import { elementKey } from "../tags/identity";
import { iconFor, parseIcon } from "./icons";
import type { GraphEdge, GraphNode, NodeId } from "./types";

export const schemaNode = (schemaId: string): NodeId => elementKey("schema", schemaId);
export const modelNode = (modelId: string): NodeId => elementKey("model", modelId);
export const eventTypeNode = (eventId: string): NodeId => elementKey("event-type", eventId);
export const controlDefNode = (schemaId: string, controlId: string): NodeId => elementKey("control", schemaId, controlId);
export const propertyDefNode = (schemaId: string, path: string): NodeId => elementKey("property", schemaId, path);

/** The capability schema a kind is documented by, e.g. `light` → the Light schema. */
export function schemaIdForCapability(kind: string): string | undefined {
  return CAPABILITY_KIND_SCHEMA_IDS[kind];
}

interface SchemaLike { readonly properties?: Readonly<Record<string, unknown>> }

/** Every leaf path under a schema's own `state` object, dotted. */
export function propertyPaths(schema: unknown, prefix = ""): string[] {
  const object = schema as SchemaLike | undefined;
  return Object.entries(object?.properties ?? {}).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    const nested = propertyPaths(child, path);
    return nested.length ? nested : [path];
  });
}

/** Every `$ref` anywhere inside a schema document. */
export function refsIn(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) refsIn(entry, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$ref" && typeof child === "string") found.add(child);
    else refsIn(child, found);
  }
  return found;
}

function modelIcon(model: (typeof MODELS)[number]) {
  const declared = parseIcon(model.icon);
  return iconFor({ kind: "device", capabilities: model.capabilities, ...(declared ? { override: declared } : {}) });
}

function build(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const known = new Set<string>(schemaCatalogEntries.map((entry) => entry.schema.$id as string));
  const add = (node: GraphNode) => { nodes.push(node); };
  const link = (from: NodeId, to: NodeId, relation: GraphEdge["relation"], label?: string) => {
    edges.push({ from, to, relation, origin: "schema", ...(label ? { label } : {}) });
  };

  for (const entry of schemaCatalogEntries) {
    const schemaId = entry.schema.$id;
    const id = schemaNode(schemaId);
    add({
      id, side: "schema", kind: "schema", name: entry.title, context: entry.category,
      page: schemaPagePath(schemaId) ?? "/schemas", icon: iconFor({ kind: "schema" }), ids: [schemaId],
    });

    for (const ref of refsIn(entry.schema)) {
      if (ref === schemaId || !known.has(ref)) continue;
      link(id, schemaNode(ref), "references");
    }

    const document = entry.schema as unknown as { properties?: { actions?: SchemaLike; state?: SchemaLike } };
    for (const control of Object.keys(document.properties?.actions?.properties ?? {})) {
      const controlId = controlDefNode(schemaId, control);
      add({
        id: controlId, side: "schema", kind: "control", name: control, context: entry.title,
        page: schemaPagePath(schemaId) ?? "/schemas", icon: iconFor({ kind: "control" }), ids: [schemaId, control],
      });
      link(id, controlId, "defines");
    }
    for (const path of propertyPaths(document.properties?.state)) {
      const propertyId = propertyDefNode(schemaId, path);
      add({
        id: propertyId, side: "schema", kind: "property", name: path, context: entry.title,
        page: schemaPagePath(schemaId) ?? "/schemas", icon: iconFor({ kind: "property" }), ids: [schemaId, path],
      });
      link(id, propertyId, "defines");
    }
  }

  link(schemaNode(filterSchema.$id), schemaNode(eventSchema.$id), "references", "selects");

  // A model's own config and secrets schemas are real documents with `$id`s,
  // but they are not curated catalog entries, so they need registering before
  // anything can point at them.
  for (const model of MODELS) {
    for (const [schema, role] of [[model.configSchema, "config"], [model.secretsSchema, "secrets"]] as const) {
      const schemaId = schema?.$id;
      if (!schemaId || known.has(schemaId)) continue;
      known.add(schemaId);
      add({
        id: schemaNode(schemaId), side: "schema", kind: "schema",
        name: typeof schema.title === "string" ? schema.title : `${model.title} ${role}`,
        context: `${model.title} · ${role}`, page: "/models",
        icon: iconFor({ kind: "schema" }), ids: [schemaId],
      });
    }
  }

  for (const model of MODELS) {
    const id = modelNode(model.id);
    add({
      id, side: "schema", kind: "model", name: model.title,
      context: `${model.manufacturer} ${model.product}`.trim(),
      page: "/models", icon: modelIcon(model),
      ids: [model.id],
    });
    if (known.has(model.objectSchemaId)) link(id, schemaNode(model.objectSchemaId), "describesAs");
    for (const kind of model.capabilities) {
      const capabilitySchema = schemaIdForCapability(kind);
      if (capabilitySchema && known.has(capabilitySchema)) link(id, schemaNode(capabilitySchema), "implements", kind);
    }
    for (const declared of [model.configSchema?.$id, model.secretsSchema?.$id]) {
      if (declared && known.has(declared)) link(id, schemaNode(declared), "declares");
    }
    for (const sensor of model.sensors ?? []) {
      if (known.has(sensor.schemaId)) link(id, schemaNode(sensor.schemaId), "declares", sensor.name);
    }
  }

  for (const event of EVENT_TYPES) {
    add({
      id: eventTypeNode(event.id), side: "schema", kind: "event-type", name: event.label,
      context: event.level, page: "/schemas", icon: iconFor({ kind: "event-type" }), ids: [event.id],
    });
    link(eventTypeNode(event.id), schemaNode(eventSchema.$id), "describesAs");
    link(eventTypeNode(event.id), schemaNode(event.payloadSchema.$id), "declares", "PayloadSchema");
  }

  return { nodes, edges };
}

let cached: { nodes: GraphNode[]; edges: GraphEdge[] } | undefined;

/** The schema graph, built once per process. */
export function schemaGraph(): { readonly nodes: readonly GraphNode[]; readonly edges: readonly GraphEdge[] } {
  cached ??= build();
  return cached;
}

/** Test seam: forget the cache so a test can rebuild after stubbing a catalog. */
export function resetSchemaGraph(): void {
  cached = undefined;
}
