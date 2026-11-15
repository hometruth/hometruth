import { UNNAMED } from "../tags/model";
import { postControlNames } from "../control-routes";
import { controlRequest } from "./controls";
import { cliCommands } from "./cli";
import { shellWord, type ElementCommand } from "../ht/commands";
/** One schema-derived contract feeds the element API views and downloadable OpenAPI document. */
import type { Site } from "../site";
import type { StateHub } from "../state/hub";
import type { GraphNode } from "../graph/types";
import { elementKey } from "../tags/identity";
import { COLLECTION_CAPABILITIES, rewriteSchema, buildOpenApiDocument, describedSite, type Json, type OpenApiDocument, type RegisteredRoute } from "../openapi/document";
import { CAPABILITY_KIND_SCHEMA_IDS } from "../schema-catalog";
import { properties, record, resolveSchema, sample, type Property, type Schema } from "./schema";
import { addressesFor } from "./addresses";
import { elementScope } from "../auth/element-scope";

export interface ApiOperation {
  key: string; method: string; path: string; description: string;
  parameters: Schema[]; request?: Schema; response: Schema; media: string;
  example: Json; cli?: ElementCommand;
}
export interface ElementApi {
  id: string; key: string; address: string; uuid?: string; name: string; kind: string; page: string;
  document: OpenApiDocument; properties: Property[]; operations: ApiOperation[]; commands: ElementCommand[];
}
const apiRef = (id: string, document: OpenApiDocument): Schema => {
  const found = Object.entries(record(document.components.schemas)).find(([, value]) => record(value)["x-hometruth-schema-id"] === id);
  return found ? { $ref: `#/components/schemas/${found[0]}` } : {};
};
const responseSchema = (operation: Schema): Schema => {
  const success = Object.entries(record(operation.responses)).find(([status]) => status.startsWith("2"))?.[1];
  const media = record(record(success).content);
  return record(record(media["application/json"]).schema);
};

export function elementForPage(site: Site, hub: StateHub, path: string): GraphNode | undefined {
  const graph = hub.data.topology();
  if (path.startsWith("/elements/")) {
    try { return addressesFor(hub).node(decodeURIComponent(path.split("/")[2]!)); }
    catch { return undefined; }
  }
  const match = site.pages().resolve(path);
  if (match) return graph.node(elementKey(match.entry.source, match.entry.id));
  return graph.byPage(path);
}

const contracts = new WeakMap<StateHub, { topology: ReturnType<StateHub["data"]["topology"]>; entries: Map<string, { bounds: string; api: ElementApi }> }>();

/** Contracts depend on configuration and action limits, not on each new measurement. */
export function buildElementApi(options: { site: Site; hub: StateHub; node: GraphNode; page: string; origin: string; routes: readonly RegisteredRoute[]; version: string; uuid?: string }): ElementApi {
  const { hub, node, site } = options;
  const topology = hub.data.topology();
  let cache = contracts.get(hub);
  if (!cache || cache.topology !== topology) {
    cache = { topology, entries: new Map() };
    contracts.set(hub, cache);
  }
  const id = node.ids[0] ?? "";
  const group = node.kind === "group" || node.kind === "group-switch" ? site.deviceGroups.find(group => group.id === id) : undefined;
  const bounds = JSON.stringify((group?.members ?? [id]).map(id => Object.entries(hub.data.device(id)?.capabilities ?? {}).map(([kind, value]) => [kind, record(value).actions])));
  const key = JSON.stringify([node.id, options.page, options.origin, options.version, options.routes.length, options.uuid]);
  const cached = cache.entries.get(key);
  if (cached?.bounds === bounds) return cached.api;
  const api = compileElementApi(options);
  if (cache.entries.size >= 256) cache.entries.delete(cache.entries.keys().next().value!);
  cache.entries.set(key, { bounds, api });
  return api;
}

function compileElementApi(options: { site: Site; hub: StateHub; node: GraphNode; page: string; origin: string; routes: readonly RegisteredRoute[]; version: string; uuid?: string }): ElementApi {
  const { site, hub, node, page } = options;
  const addresses = addressesFor(hub);
  const address = addresses.address(node.id)!;
  const owner = elementScope(hub.data.topology(), node);
  const device = owner?.kind === "device" ? site.get(owner.id) : undefined;
  const group = owner?.kind === "group" ? site.deviceGroups.find(group => group.id === owner.id) : undefined;
  const tag = node.kind === "tag" ? hub.data.sources.tags.byPair(node.ids[1]!, node.ids[0] === UNNAMED ? "" : node.ids[0]!) : undefined;
  const service = node.kind === "service" ? site.services.find(service => service.id === node.ids[0]) : undefined;
  const base = buildOpenApiDocument({ routes: options.routes, site: describedSite(site, { reaches: id => id === device?.id || Boolean(group?.members.includes(id)), siteWide: false }), origin: options.origin, version: options.version });
  const components = { ...record(base.components.schemas) };
  const document: OpenApiDocument = { ...base, info: { ...base.info, title: `${node.name} API`, "x-hometruth-object-id": address }, components: { ...base.components, schemas: components }, paths: {} };
  let primary = `/api/elements/${node.id}`;
  const structuralGroupControls = group?.members.map(id => site.get(id)).filter(member => member !== undefined).map(member => member.controls().map(reference => {
    const { kind, controlId } = member.resolveControl(reference);
    return ["binarySwitch", "light", "stringLight"].includes(kind) && ["turnOn", "turnOff", "toggle"].includes(controlId) ? `power.${controlId}` : `${kind}.${controlId}`;
  })) ?? [];
  const sharedControls = structuralGroupControls[0]?.filter(control => structuralGroupControls.every(controls => controls.includes(control))) ?? [];
  const controls = device ? postControlNames(device).filter(control => {
    if (node.kind !== "capability" && node.kind !== "control") return true;
    const resolved = device.resolveControl(control);
    return resolved.kind === node.ids[1] && (node.kind !== "control" || resolved.controlId === node.ids[2]);
  }) : group ? sharedControls : [];
  // A switch's public document is the switch itself. Device details describe
  // its provisioning and capability composition, not the switch's properties.
  const publicSwitch = device && (node.kind === "device"
    ? device.model.objectSchemaId === CAPABILITY_KIND_SCHEMA_IDS.binarySwitch
    : ["capability", "control", "property"].includes(node.kind) && node.ids[1] === "binarySwitch");
  if (device) {
    primary = `/api/${publicSwitch ? "switches" : "devices"}/${encodeURIComponent(device.id)}`;
    const object = resolveSchema(apiRef("https://hometruth.ai/schemas/object", document), document);
    const caps = Object.fromEntries(device.model.capabilities.map(kind => [kind, apiRef(CAPABILITY_KIND_SCHEMA_IDS[kind]!, document)]));
    const detail = resolveSchema(apiRef("https://hometruth.ai/schemas/device-detail-response", document), document);
    const objectProperties = { ...record(object.properties) };
    if (!device.sensors.length) delete objectProperties.sensors;
    const { anyOf: _alternatives, ...baseObject } = object;
    const objectSchema = { ...baseObject, properties: { ...objectProperties, capabilities: { type: "object", additionalProperties: false, properties: caps, required: Object.keys(caps) } } } as Schema;
    const detailName = String(apiRef("https://hometruth.ai/schemas/device-detail-response", document).$ref).slice(21);
    components[detailName] = { ...detail, properties: { ...record(detail.properties), object: objectSchema, config: rewriteSchema(device.model.configSchema, true) } };
  } else if (group) primary = `/api/device-groups/${encodeURIComponent(group.id)}`;
  else if (service) primary = "/api/services";
  else if (tag) primary = `/api/tags/${tag.id}`;
  else if (node.kind === "tag-name" || node.kind === "catalog" && node.ids[0] === "tags") primary = "/api/tags";

  const additions: Record<string, Json> = {};
  for (const [path, item] of Object.entries(base.paths)) {
    for (const [method, value] of Object.entries(record(item))) {
      const operation = record(value);
      const params = Array.isArray(operation.parameters) ? operation.parameters.map(record) : [];
      const bindings: Record<string, string> = {};
      let include = node.side !== "tag" && (path === `/api/elements/{key}` || path.startsWith("/api/elements/{key}/"));
      if (include) bindings.key = node.id;
      if (device && operation["x-hometruth-target"] === "device") {
        if (path.startsWith("/api/aqara/") && !(path.endsWith("/pair")
          ? ["aqara-hub-m2", "aqara-presence-sensor-fp2"].includes(device.model.id)
          : device.model.id === "aqara-hub-m2")) continue;
        if (path.includes("/alarms/") && !device.model.capabilities.includes("camera")) continue;
        const capabilityKinds = COLLECTION_CAPABILITIES[path.split("/")[2]!];
        if (capabilityKinds && !capabilityKinds.some(kind => device.model.capabilities.includes(kind))) continue;
        const idParam = params.find(param => param.in === "path" && ["id", "deviceId"].includes(String(param.name)));
        const allowed = record(idParam?.schema).enum;
        if (idParam && (!Array.isArray(allowed) || allowed.includes(device.id))) { include = true; bindings[String(idParam.name)] = device.id; }
      }
      if (group && path.startsWith("/api/device-groups/{id}")) { include = true; bindings.id = group.id; }
      if (service && path.startsWith("/api/services/{id}/")) { include = true; bindings.id = service.id; }
      if (service && path === "/api/services") include = true;
      if (tag && path === "/api/tags/{id}") { include = true; bindings.id = tag.id; }
      if ((node.kind === "tag-name" || node.kind === "catalog" && node.ids[0] === "tags") && path.startsWith("/api/tags") && !path.includes("{")) include = true;
      if (node.kind === "schema" && path === "/api/schemas") include = true;
      if (node.kind === "model" && path === "/api/models") include = true;
      if (node.kind === "event-type" && path === "/api/event-types") include = true;
      if (node.kind === "dashboard" || node.kind === "widget") if (path.startsWith("/api/kindle")) include = true;
      if (node.kind === "automation" && path.startsWith(`/api/automations/${node.ids[0]}`)) include = true;
      const stateNode = node.stateNode ?? (device ? `device/${device.id}` : group ? `group/${group.id}` : undefined);
      if (stateNode && ["/api/state", "/api/state/stream"].includes(path)) include = true;
      if (node.kind === "site") include ||= !path.includes("{");
      if (node.kind === "catalog" && path === `/api/${node.ids[0]}`) include = true;
      if (!include) continue;
      // The device's flat namespace already disambiguates duplicate capability controls.
      if (path.includes("/capabilities/{kind}/controls/")) continue;
      const variants: Record<string, string>[] = path.endsWith("/controls/{control}") ? controls.map(control => ({ ...bindings, control }))
        : service && path.endsWith("/actions/{action}") ? service.actions.map(action => ({ ...bindings, action: action.id })) : [bindings];
      for (const binding of variants) {
        let bound = path;
        for (const [name, value] of Object.entries(binding)) bound = bound.replaceAll(`{${name}}`, encodeURIComponent(value));
        const parameters = params.filter(param => !Object.hasOwn(binding, String(param.name))).map(param => stateNode && param.name === "node" && path.startsWith("/api/state")
          ? { ...param, required: true, schema: { type: "string", enum: [stateNode] } } : param);
        const boundOperation: Schema = { ...operation, operationId: `${method}-${bound}`, parameters };
        if (binding.control) {
          boundOperation.summary = binding.control;
          const kind = device?.resolveControl(binding.control).kind;
          const control = device?.resolveControl(binding.control).controlId;
          const cached = record(record(hub.data.device(device?.id ?? "")?.capabilities)[kind ?? ""]);
          const bounds = control?.split(".").reduce<Json | undefined>((parent, key) => record(parent)[key], cached.actions);
          const groupAction = group ? hub.data.group(group.id)?.actions.find(action => action.id === binding.control) : undefined;
          const request = controlRequest(kind, control ?? binding.control.split(".").at(-1)!, record(bounds ?? groupAction?.bounds));
          boundOperation.requestBody = { required: true, content: { "application/json": { schema: request } } };
          boundOperation.description = `${binding.control}${bounds ? ` — current limits: ${JSON.stringify(bounds)}` : ""}. ${operation.description ?? ""}`;
        }
        additions[bound] = { ...record(additions[bound]), [method]: boundOperation };
      }
    }
  }
  Object.assign(document.paths, additions);
  const operations: ApiOperation[] = [];
  for (const [path, item] of Object.entries(document.paths)) for (const [method, value] of Object.entries(record(item))) {
    const operation = record(value);
    const content = record(record(operation.requestBody).content);
    const media = Object.keys(content)[0] ?? "application/json";
    const request = content[media] ? record(record(content[media]).schema) : undefined;
    const example = request ? sample(request, document) : null;
    const parameters = Array.isArray(operation.parameters) ? operation.parameters.map(record) : [];
    const control = path.includes("/controls/") && !path.includes("{") ? decodeURIComponent(path.split("/controls/")[1]!) : undefined;
    const key = control ?? (method === "get" && path === primary ? "read" : `${method.toUpperCase()} ${path}`);
    operations.push({ key, path, method: method.toUpperCase(), description: String(operation.description ?? operation.summary ?? ""), parameters, ...(request ? { request } : {}), response: responseSchema(operation), media, example });
  }
  const read = operations.find(operation => operation.method === "GET" && operation.path === primary);
  let fields = read ? properties(read.response, document) : [];
  // Schema pages document all declared fields even when no instances exist.
  const schemaId = node.kind === "schema" ? node.ids[0] : undefined;
  if (schemaId) fields = properties(apiRef(schemaId, document), document);
  if (node.kind === "capability" && device && !publicSwitch) fields = fields.filter(field => field.path.startsWith(`object.capabilities.${node.ids[1]}.`));
  if (node.kind === "property" && device) {
    const prefix = `${publicSwitch ? "" : `object.capabilities.${node.ids[1]}.`}state.${node.ids[2]}`;
    fields = fields.filter(field => field.path === prefix || field.path.startsWith(`${prefix}.`));
  }
  const id = node.kind === "device" ? device!.id : group ? group.id : service ? service.id : tag ? tag.id : node.id;
  const ordered = [...(read ? [read] : []), ...operations.filter(operation => operation !== read)];
  for (const operation of ordered) {
    const internalPath = operation.path;
    operation.path = addresses.publicPath(internalPath);
    if (operation.path !== internalPath && Object.hasOwn(document.paths, internalPath)) {
      document.paths[operation.path] = document.paths[internalPath]!;
      delete document.paths[internalPath];
    }
    if (operation.key.includes(internalPath)) operation.key = operation.key.replace(internalPath, operation.path);
    record(record(document.paths[operation.path])[operation.method.toLowerCase()]).operationId = `${operation.method.toLowerCase()}-${operation.path}`;
    for (const parameter of operation.parameters) {
      if (parameter.in === "query" && parameter.name === "node") {
        const schema = record(parameter.schema);
        if (Array.isArray(schema.enum)) schema.enum = schema.enum.map(value => addresses.stateAddress(String(value)) ?? value);
      }
    }
  }
  const bindings = [address, device && addresses.device(device.id), group && addresses.group(group.id), service && addresses.service(service.id)]
    .filter((value): value is string => Boolean(value));
  cliCommands(ordered, document, address, addresses.publicPath(primary), bindings);
  return { id, key: node.id, address, ...(options.uuid ? { uuid: options.uuid } : {}), name: node.name, kind: node.kind, page, document, properties: fields, operations: ordered, commands: [...new Map(ordered.map(operation => [operation.cli!.name, operation.cli!])).values()] };
}

/** A single installation-wide skill; the current element belongs in the user's request. */
export function skillMarkdown(origin: string): string {
  const base = new URL(origin).origin;
  return `---
name: hometruth
description: Discover, inspect and control devices, groups, services and other elements in a HomeTruth installation using its MCP server, REST API or ht CLI.
---

# HomeTruth

Installation: ${base}
MCP endpoint: ${base}/mcp
Skill source: ${base}/SKILL.md

This skill covers the entire installation. The user's current element of interest is task context, not a restriction on the skill. Follow the user's requested scope and the connection's permissions.

## Connect and discover

Use the HomeTruth MCP server at the endpoint above with Streamable HTTP. The agent's runtime must be able to reach this installation; a cloud agent may not be able to reach a local network address. Use the installation's existing access setup. When authentication is required, configure an existing HomeTruth API token through the agent's protected connection settings. Trusted LAN installations may allow access without a token. Keep credentials out of prompts, copied commands and this skill. Existing read, write and admin permissions still apply.

List the MCP tools and read their input schemas. Discover the current inventory, then inspect the selected element's contract before reading or changing it. Match the user's friendly name against the inventory's name, address and context. Use the returned friendly address; names and addresses can change after renaming, and internal IDs or UUIDs are not API selectors. Resolve ambiguous matches before an action.

## Read and control

Use the available read operation to inspect current state and availability. Discover methods and their input schemas from the live contract; do not infer controls from a device name or reuse another model's arguments. Supply only the requested values within the current limits. An unavailable reading may be absent rather than zero or false.

Perform changes only within the user's request. Honor explicit confirmation requirements exposed by a control's schema. After a change, read the state or returned result to verify the outcome. Report an unavailable device or rejected permission; do not broaden credentials or repeatedly retry a hardware action.

## REST and CLI

If MCP is unavailable, the same installation exposes REST endpoints with bearer-token authentication when required. Read \`${base}/api/inventory\`, then \`${base}/api/inventory/{address}\` for an element's properties, methods, transports and schemas. The complete route reference is \`${base}/api/openapi.json\`. Use the paths, methods and request schemas returned by those documents; URL-encode friendly addresses in path segments. Permission checks are the same as for MCP.

If the \`ht\` CLI is already installed, set \`HOMETRUTH_URL=${shellWord(base)}\` and provide \`HOMETRUTH_TOKEN\` through secure environment configuration when required. Use \`ht find <text>\` to find elements, \`ht <address> help\` for current commands and flags, and \`ht <address> status\` to read an element. For controls requiring confirmation, pass \`--confirm\` only after the user confirms. CLI availability is a prerequisite for this option; MCP and REST require no local HomeTruth checkout or installation files.
`;
}
