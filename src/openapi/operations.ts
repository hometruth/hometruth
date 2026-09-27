import { nodeRecordSchema } from "../state/schemas";
import { eventSchema } from "../models/event-schema";
import { filterConditionSchema, filterFieldsSchema, filterUpdateSchema, savedFilterSchema } from "../models/filter-schema";
/**
 * Which schema each API route carries, and nothing else.
 *
 * This is the second table of the pair `policy.ts` started, and it exists for
 * the same reason: a route nobody wrote down looks exactly like a route with
 * nothing to say. `policy.ts` answers "who may call this"; this answers "what
 * goes in and what comes back". Together they are the whole description of the
 * HTTP surface, and `document.ts` turns them into OpenAPI without either of
 * them knowing what OpenAPI is.
 *
 * There is deliberately no prose here — no summaries, no descriptions, no
 * hand-written parameter notes. Every word the generated document says about
 * an operation comes out of the schema it names, which is where this project
 * already keeps its titles and descriptions (see `schema-catalog.ts`, and the
 * `/schemas` pages that render the same words). Adding an English sentence
 * here would make it the second place a contract is written down, and the
 * second place is always the one that goes stale.
 *
 * A route whose body has no schema document says so with `unspecified`. That
 * is a worse answer than a schema and it is meant to look like one: it prints
 * as an undescribed body in the document, and the completeness test refuses a
 * route that is in neither state, so the decision gets made when the route is
 * written.
 */
import { tokenCreateSchema } from "../auth/model";
import { graphEdgeSchema, graphNodeSchema } from "../graph/schemas";
import { kindleConfigSchema } from "../kindle/config";
import { schemaCatalogEntries } from "../schema-catalog";
import { binarySwitchSchema, deviceGroupConfigSchema, deviceGroupSettingsSchema, roomNameSchema, workflowSchema } from "../schemas";
import { tagAssignmentSchema, tagCreateSchema, tagSchema, tagUpdateSchema } from "../tags/model";

/** A schema the catalog already carries, named by its catalog key. */
export type SchemaKey = (typeof schemaCatalogEntries)[number]["key"];

/**
 * A JSON Schema written at the point of use, for a body no catalog document
 * describes. It may `$ref` a catalog schema by `$id` exactly as the catalog's
 * own documents do, so a composed body still links to the real thing.
 */
export type InlineSchema = Readonly<Record<string, unknown>>;

export type BodySchema = SchemaKey | InlineSchema;

export interface Operation {
  /** The JSON request body. */
  readonly request?: BodySchema;
  /** The successful response body. */
  readonly response?: BodySchema;
  /** The success status, when it is not 200. */
  readonly status?: number;
  /** A request that is not JSON: raw audio, a YAML export. */
  readonly consumes?: string;
  /** A response that is not JSON: a picture, an MJPEG stream, a file. */
  readonly produces?: string;
  /** Server-sent event frames, by the `event:` name each is sent under. */
  readonly frames?: Readonly<Record<string, BodySchema>>;
  /** Query parameters, as the JSON Schema of each value. */
  readonly query?: Readonly<Record<string, InlineSchema>>;
  /** The body is real, and no schema document describes it yet. */
  readonly unspecified?: true;
}

const unspecified = { unspecified: true } as const;
const text = (maxLength = 200) => ({ type: "string", maxLength } as const);
const id = { type: "string", minLength: 1, maxLength: 100 } as const;
const stamp = { type: "string", format: "date-time" } as const;
const flag = { type: "boolean" } as const;
const eventWhere = { type: "string", maxLength: 16_384, contentMediaType: "application/json", contentSchema: { $ref: filterConditionSchema.$id },
  description: "JSON-encoded Filter condition, applied before limits and to both backlog and live events." } as const;
const ref = (schema: { readonly $id: string }) => ({ $ref: schema.$id } as const);
const list = (items: InlineSchema) => ({ type: "array", items } as const);

/** An object body written here because no catalog document describes it. */
function object(
  title: string,
  description: string,
  properties: Readonly<Record<string, InlineSchema>>,
  required?: readonly string[],
): InlineSchema {
  return { title, description, type: "object", properties, ...(required ? { required: [...required] } : {}) };
}

const tagWithPage = object("Tag", "One tag and the page that lists what carries it.", {
  tag: ref(tagSchema),
  page: text(400),
}, ["tag", "page"]);

const elementWithTags = object("Element tags", "One element and every tag now attached to it.", {
  element: { type: "object" },
  tags: list(ref(tagSchema)),
}, ["element", "tags"]);

const groupSwitchDocumentRef = "groupSwitchSchema" satisfies SchemaKey;
const networkRuleState = { enum: ["on", "off", "missing", "unavailable"] } as const;

/**
 * `METHOD /route/pattern` → the schemas it carries, keyed exactly as Hono
 * registers the route so the completeness test can compare the two lists.
 * Only `/api` routes appear: the rest of the site serves HTML pages, which an
 * API description has nothing useful to say about.
 */
export const OPERATIONS: Readonly<Record<string, Operation>> = {
  "GET /api/health/report": { response: "healthReportSchema", query: { period: { enum: ["24h", "7d", "30d"], default: "24h" } } },
  "GET /api/devices/:id/health": { response: "healthCheckSchema" },
  "POST /api/devices/:id/health/check": { response: "healthCheckSchema" },
  "GET /api/services/:id/health": { response: "healthCheckSchema" },
  "POST /api/services/:id/health/check": { response: "healthCheckSchema" },
  // ---- Session ------------------------------------------------------------
  "POST /api/auth/sign-in": {
    request: object("Sign-in request", "Exchanges an API token for the session cookie a browser carries.", { token: { type: "string", minLength: 1, maxLength: 512 } }, ["token"]),
    response: object("Sign-in response", "The token that was accepted, named, with the verbs it holds.", { name: text(), permissions: list(text(32)) }, ["name", "permissions"]),
  },
  "POST /api/auth/sign-out": {
    response: object("Sign-out response", "The session cookie has been cleared.", { signedOut: flag }, ["signedOut"]),
  },
  "GET /api/auth/whoami": {
    response: object("Caller identity", "Who this request is, how it got in, and everything it reaches.", {
      kid: id, name: text(), origin: { enum: ["token", "local-network"] },
      permissions: list(text(32)),
      reaches: text(400),
      devices: { oneOf: [{ const: "all" }, list(id)] },
    }, ["kid", "name", "origin", "permissions", "reaches", "devices"]),
  },

  // ---- Tokens -------------------------------------------------------------
  "GET /api/tokens": {
    response: object("Token list", "Every token this site accepts, without the secrets themselves.", { tokens: list({ type: "object" }) }, ["tokens"]),
  },
  "POST /api/tokens": {
    request: tokenCreateSchema,
    response: object("Issued token", "The new token's one and only appearance in plain text, with its public record.", { token: { type: "string" } }, ["token"]),
    status: 201,
  },
  "POST /api/tokens/:kid/revoke": { response: object("Revoked token", "The token's public record, now revoked.", { kid: id, revokedAt: stamp }, ["kid"]) },

  // ---- Catalogs -----------------------------------------------------------
  "GET /api/health": { response: "healthResponseSchema" },
  "GET /api/inventory": {
    response: object("Element inventory", "Every element the caller can inspect, with its UUID, object ID and page.", {
      elements: list(object("Inventory element", "An addressable element of this HomeTruth install.", {
        uuid: { type: "string", format: "uuid" }, key: text(2000), id: text(2000), name: text(400), kind: text(100),
        side: { enum: ["instance", "schema", "tag"] }, page: text(2000), deviceId: text(),
      }, ["uuid", "key", "id", "name", "kind", "side", "page"])),
    }, ["elements"]),
  },
  "GET /api/inventory/:uuid": {
    response: object("Element contract", "An element's identity, properties and callable methods for the shared client.", {
      element: { type: "object" }, properties: list({ type: "object" }), methods: list({ type: "object" }),
    }, ["element", "properties", "methods"]),
  },
  "POST /api/playground": {
    request: object("TypeScript playground", "Compile a program that imports the shared ht library. Execution happens in the browser.", { code: { type: "string", maxLength: 65536 } }, ["code"]),
    response: object("Compiled playground", "JavaScript for the sandboxed browser playground.", { code: { type: "string" } }, ["code"]),
  },
  "GET /api/models": { response: "modelListResponseSchema" },
  "GET /api/schemas": { response: "schemaCatalogResponseSchema" },
  "GET /api/event-types": { response: "eventTypeCatalogResponseSchema" },
  "GET /api/filters": { response: object("Saved Filters", "Named predicates over Events.", { filters: list(savedFilterSchema) }, ["filters"]) },
  "GET /api/filters/:id": { response: savedFilterSchema },
  "POST /api/filters": { request: filterFieldsSchema, response: savedFilterSchema, status: 201 },
  "PUT /api/filters/:id": { request: filterUpdateSchema, response: savedFilterSchema },
  "DELETE /api/filters/:id": { query: { revision: { type: "integer", minimum: 1 } }, response: object("Deleted Filter", "The Filter was deleted.", { deleted: { const: true } }, ["deleted"]) },
  "GET /api/openapi.json": {
    response: object("OpenAPI document", "This document: every API route of this install, described with the schemas it carries.", { openapi: text(16) }, ["openapi"]),
  },

  // ---- Devices ------------------------------------------------------------
  "GET /api/devices": { response: "deviceListResponseSchema" },
  "GET /api/devices/:id": { response: "deviceDetailResponseSchema" },
  "GET /api/rooms": {
    response: object("Room list", "Every room in the ontology, and whether this install can add to it.", { rooms: list(roomNameSchema), writable: flag }, ["rooms", "writable"]),
  },
  "POST /api/devices/:id/room": {
    request: "deviceRoomRequestSchema",
    response: object("Device room", "The device and the room it is now in, or none.", { id, room: roomNameSchema }, ["id"]),
  },
  "POST /api/devices/:id/name": { request: "deviceRenameRequestSchema", response: "deviceRenameResponseSchema" },
  "GET /api/devices/:id/enabled": { response: "deviceEnabledSchema" },
  "POST /api/devices/:id/enable": { response: "deviceEnabledSchema" },
  "POST /api/devices/:id/disable": { response: "deviceEnabledSchema" },
  "POST /api/devices/:id/controls/:control": { request: "deviceControlRequestSchema", response: "deviceDetailResponseSchema" },
  "POST /api/devices/:id/capabilities/:kind/controls/:controlId": { request: "deviceControlRequestSchema", response: "deviceDetailResponseSchema" },
  "POST /api/devices/:id/reboot": { response: "deviceDetailResponseSchema" },
  "POST /api/aqara/:id/pair": {
    request: object("Aqara pairing request", "The HomeKit pairing code printed on this hub or sensor.", { pin: { type: "string", pattern: "^\\d{3}-\\d{2}-\\d{3}$", examples: ["123-45-678"] } }, ["pin"]),
    response: object("Aqara pairing result", "What pairing with the hub achieved, and the accessories it can now see.", { paired: flag }, []),
  },
  "POST /api/aqara/:id/sync": {
    response: object("Aqara sync result", "The sensors added to the device configuration from the hub's inventory.", {
      added: list(object("Added device", "One newly configured device.", { id, name: text(), page: text(400) }, ["id", "name", "page"])),
    }, ["added"]),
  },

  // ---- All events ---------------------------------------------------------
  "GET /api/events": {
    response: "eventsResponseSchema",
    query: { limit: { type: "integer", minimum: 1, maximum: 200 }, subject: id, type: text(400), label: text(), where: eventWhere, filter: id },
  },
  "GET /api/events/stream": {
    frames: { "service-event": ref(eventSchema) },
    query: { subject: id, type: text(400), label: text(), where: eventWhere, filter: id },
  },

  // ---- Device events ------------------------------------------------------
  "GET /api/devices/:id/events": {
    response: "deviceEventsResponseSchema",
    query: { limit: { type: "integer", minimum: 1, maximum: 500 }, subject: id, type: text(400), label: text(), where: eventWhere, filter: id },
  },
  "GET /api/devices/:id/events/stream": {
    frames: { "service-event": ref(eventSchema) },
    query: { subject: id, type: text(400), label: text(), where: eventWhere, filter: id },
  },
  "GET /api/devices/:id/alarms/:file": { produces: "image/jpeg" },

  // ---- Device network -----------------------------------------------------
  "GET /api/devices/:id/network": {
    response: object("Device network status", "Association, addressing, and freshly inspected HomeTruth-managed isolation rules. Does not audit unrelated firewall, VLAN, or Wi-Fi isolation policies.", {
      deviceId: id,
      adapter: text(),
      configuredAddress: text(),
      configuredMac: text(),
      associated: flag,
      mac: text(),
      currentAddress: text(),
      addressMatches: flag,
      isolated: { type: ["boolean", "null"], description: "Whether the HomeTruth internet block is on; null when it cannot be inspected. DNS redirection alone does not imply internet isolation." },
      isolation: object("HomeTruth isolation", "Observed provider rules, separate from the isolation service's desired setting.", {
        scope: { const: "hometruth" },
        requested: { ...flag, description: "Desired isolation setting, when the isolation service is available." },
        internetBlock: networkRuleState,
        methods: { type: "array", uniqueItems: true, items: { enum: ["internet-block", "dns-override"] }, description: "Active mechanisms: a direct internet block retaining LAN access, and shared vendor DNS redirection to HomeTruth." },
        dns: list(object("Vendor DNS override", "One model-declared vendor hostname; shared records may be active even when this device is not isolated.", {
          domain: text(253), overrideIp: text(), state: networkRuleState, detail: { type: "string" },
        }, ["domain", "state"])),
        detail: { type: "string" },
      }, ["scope", "internetBlock", "methods", "dns"]),
      message: { type: "string" },
    }, ["deviceId", "adapter", "configuredAddress", "associated", "isolated", "isolation", "message"]),
  },
  "POST /api/devices/:id/network/reconnect": { ...unspecified },
  "GET /api/devices/:id/network/settings": { ...unspecified },
  "POST /api/devices/:id/network/settings": {
    request: object("Device network settings", "Reserve an IPv4 address for the device's MAC address and save it in HomeTruth.", {
      address: { type: "string", format: "ipv4", examples: ["10.77.0.50"] },
      mac: { type: "string", pattern: "^[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}$", examples: ["00:11:22:33:44:55"] },
    }, ["address", "mac"]),
    response: object("Saved device network settings", "The saved address, device identity and reconnect result.", { address: text(), mac: text(), message: text(1000) }, ["address", "mac", "message"]),
  },
  "POST /api/devices/:id/network/rescan": { ...unspecified },
  "POST /api/network/rescan": { ...unspecified },
  "GET /api/isolation": { ...unspecified, query: { refresh: { enum: ["1"] } } },
  "GET /api/devices/:id/isolation": { ...unspecified },
  "POST /api/devices/:id/isolation": {
    request: object("Device isolation request", "Cuts this device off from the internet, or lets it back on.", { isolated: flag }, ["isolated"]),
    unspecified: true,
  },
  "GET /api/network/commands/accept-next": { ...unspecified },
  "GET /api/network/commands/accept-next/options": { ...unspecified },
  "POST /api/network/commands/accept-next": { ...unspecified },
  "POST /api/network/commands/accept-next/:id/cancel": { ...unspecified },

  // ---- Switches -----------------------------------------------------------
  "POST /api/switches": { request: "optimisticSwitchCreateRequestSchema", response: "optimisticSwitchCreateResponseSchema", status: 201 },
  "GET /api/switches/:id": { response: "binarySwitchSchema" },
  "GET /api/switches/:id/state": { response: binarySwitchSchema.properties.state },
  "POST /api/switches/:id/turn-on": { response: "binarySwitchSchema" },
  "POST /api/switches/:id/turn-off": { response: "binarySwitchSchema" },
  "POST /api/switches/:id/toggle": { response: "binarySwitchSchema" },

  // ---- Buttons ------------------------------------------------------------
  "POST /api/buttons": {
    request: "workflowButtonCreateRequestSchema",
    response: object("Created button", "The new Workflow Button and its device page.", { id, page: text(400) }, ["id", "page"]),
    status: 201,
  },
  "GET /api/buttons/:id": { response: "buttonSchema" },
  "POST /api/buttons/:id/press": { request: "buttonPressRequestSchema", response: "buttonSchema" },
  "GET /api/buttons/:id/workflow": {
    response: object("Button workflow", "The workflow graph this button runs, and the devices it may drive.", { workflow: ref(workflowSchema) }, ["workflow"]),
  },
  "PUT /api/buttons/:id/workflow": {
    request: "workflowButtonUpdateRequestSchema",
    response: object("Button workflow", "The workflow graph now saved for this button.", { workflow: ref(workflowSchema) }, ["workflow"]),
  },

  // ---- Lights -------------------------------------------------------------
  "GET /api/lights/:id": { response: "lightSchema" },
  "POST /api/lights/:id/turn-on": { response: "lightSchema" },
  "POST /api/lights/:id/turn-off": { response: "lightSchema" },
  "POST /api/lights/:id/toggle": { response: "lightSchema" },
  "POST /api/lights/:id/brightness": {
    request: object("Brightness request", "A brightness for this light, in percent of its own range.", { percent: { type: "number", minimum: 0, maximum: 100 } }, ["percent"]),
    response: "lightSchema",
  },
  "POST /api/lights/:id/color-temperature": {
    request: object("Color temperature request", "A white point for this light, in kelvin within its own range.", { kelvin: { type: "number", minimum: 1000, maximum: 10000 } }, ["kelvin"]),
    response: "lightSchema",
  },
  "POST /api/lights/:id/color": {
    request: object("Color request", "A color for this light, as #rrggbb.", { hex: { type: "string", pattern: "^#[0-9A-Fa-f]{6}$" } }, ["hex"]),
    response: "lightSchema",
  },

  // ---- Device groups ------------------------------------------------------
  "GET /api/device-groups": {
    response: object("Device group list", "Every group in this site, fixed and automatic, and whether this install can write them.", {
      groups: list(deviceGroupConfigSchema), writable: flag,
    }, ["groups", "writable"]),
  },
  "POST /api/device-groups": {
    request: deviceGroupConfigSchema,
    response: object("Created group", "The new group and its page.", { id, page: text(400) }, ["id", "page"]),
    status: 201,
  },
  "POST /api/device-groups/preview": {
    request: deviceGroupSettingsSchema,
    response: object("Group membership preview", "Which devices the proposed membership gathers, and whether they agree enough to be one switch, before anything is saved.", {
      members: list({ type: "object" }), canSwitch: flag,
    }, ["members", "canSwitch"]),
  },
  "GET /api/device-groups/:id": { response: deviceGroupConfigSchema },
  "POST /api/device-groups/:id/settings": { request: deviceGroupSettingsSchema, response: deviceGroupConfigSchema },
  "POST /api/device-groups/:id/controls/:control": { request: "deviceControlRequestSchema", response: groupSwitchDocumentRef },
  "GET /api/device-groups/:id/switch": { response: groupSwitchDocumentRef },
  "POST /api/device-groups/:id/switch/turn-on": { response: groupSwitchDocumentRef },
  "POST /api/device-groups/:id/switch/turn-off": { response: groupSwitchDocumentRef },
  "POST /api/device-groups/:id/switch/toggle": { response: groupSwitchDocumentRef },

  // ---- Cameras ------------------------------------------------------------
  "GET /api/cameras/:id/snapshot": { produces: "image/jpeg" },
  "GET /api/cameras/:id/stream.mjpeg": { produces: "multipart/x-mixed-replace; boundary=frame" },
  "GET /api/cameras/:id/photos": {
    response: object("Saved photo page", "One page of a camera's saved photo history, newest or oldest first.", {
      photos: list({ type: "object" }), cursor: text(200),
    }, ["photos"]),
    query: { order: { enum: ["newest", "oldest"] }, cursor: text(200) },
  },
  "GET /api/cameras/:id/photos/:photoId": { produces: "image/jpeg" },
  "POST /api/cameras/:id/photos/sync": {
    response: object("Photo import queued", "The import of the camera's own photo history has started.", { queued: flag }, ["queued"]),
    status: 202,
  },
  "GET /api/cameras/:id/light-sync/region": { response: "cameraRegionResponseSchema" },
  "PUT /api/cameras/:id/light-sync/region": { request: "sourceRegionSchema", response: "cameraRegionResponseSchema" },
  "DELETE /api/cameras/:id/light-sync/region": { response: "cameraRegionResponseSchema" },

  // ---- IR/RF blasters -----------------------------------------------------
  "GET /api/ir-rf-blasters/:id": { response: "irRfBlasterDeviceSchema" },
  "POST /api/ir-rf-blasters/:id/send": { request: "irRfBlasterSendRequestSchema", response: "irRfBlasterDeviceSchema" },
  "POST /api/ir-rf-blasters/:id/learn": { request: "irRfBlasterLearnRequestSchema", response: "irRfBlasterLearnResponseSchema" },
  "POST /api/ir-rf-blasters/:id/codes": { request: "irRfBlasterSaveCodeRequestSchema", response: "irRfBlasterDeviceSchema" },
  "POST /api/ir-rf-blasters/:id/codes/:codeId/send": { request: "irRfBlasterSendCodeRequestSchema", response: "irRfBlasterDeviceSchema" },
  "POST /api/ir-rf-blasters/:id/codes/:codeId/update": { request: "irRfBlasterUpdateCodeRequestSchema", response: "irRfBlasterDeviceSchema" },
  "POST /api/ir-rf-blasters/:id/codes/:codeId/delete": { response: "irRfBlasterDeviceSchema" },

  // ---- nRF24 radio receivers ---------------------------------------------
  "GET /api/radio-receivers/:id": { ...unspecified },
  "POST /api/radio-receivers/:id/quiet": { ...unspecified, status: 202 },
  "POST /api/radio-receivers/:id/start": {
    request: object("Listener request", "How to listen: energy sweep, one raw channel, or a timed sweep.", {
      mode: { enum: ["energy", "raw", "sweep"] },
      channel: { type: "integer", minimum: 5, maximum: 75 },
      crcBytes: { enum: [1, 2] },
      durationMs: { const: 30000 },
      note: text(1000),
    }),
    unspecified: true,
  },
  "POST /api/radio-receivers/:id/stop": { ...unspecified },
  "POST /api/radio-receivers/:id/codes": {
    request: object("Save packet request", "Names one captured packet so it becomes a button on the device page.", { name: text(100), sequence: { type: "integer", minimum: 0 } }, ["name", "sequence"]),
    unspecified: true,
  },
  "POST /api/radio-receivers/:id/codes/:codeId/send": {
    request: object("Replay request", "Replays a saved packet, optionally more than once.", { repeatCount: { type: "integer", minimum: 1, maximum: 20 } }),
    unspecified: true,
  },
  "POST /api/radio-receivers/:id/codes/:codeId/delete": { ...unspecified },

  // ---- Services -----------------------------------------------------------
  "GET /api/services": { response: "serviceListResponseSchema" },
  "GET /api/services/:id/events": {
    response: "serviceEventsResponseSchema",
    query: { limit: { type: "integer", minimum: 1, maximum: 500 }, subject: id, type: text(400), label: text(), where: eventWhere, filter: id },
  },
  "GET /api/services/:id/stream": {
    frames: { "service-event": ref(eventSchema) },
    query: { subject: id, type: text(400), label: text(), where: eventWhere, filter: id },
  },
  "POST /api/services/:id/actions/:action": {
    request: { type: "object", additionalProperties: false, properties: {} },
    response: object("Service action result", "The action performed and its current deadline, when it opens a temporary window.", {
      serviceId: id, action: id, detail: text(1000), until: stamp,
    }, ["serviceId", "action", "detail"]),
  },
  "GET /api/services/frigate/frames/:camera/:objectId": { produces: "image/jpeg", query: { at: { type: "number", minimum: 0 } } },
  "GET /api/services/frigate/previews/:camera/:objectId": { ...unspecified },

  // ---- The state stream ---------------------------------------------------
  "GET /api/state": {
    response: object("State snapshot", "Cached state records visible to this caller, optionally filtered by repeated node parameters.", {
      generation: text(200), records: list(ref(nodeRecordSchema)),
    }, ["generation", "records"]),
    query: { node: { type: "string", minLength: 7, maxLength: 207 } },
  },
  "GET /api/state/stream": {
    frames: {
      hello: "streamHelloSchema",
      state: "nodeRecordSchema",
      observed: "streamObservedSchema",
      error: "streamErrorSchema",
    },
    query: { node: { type: "string", minLength: 7, maxLength: 207 } },
  },

  // ---- Tags and elements --------------------------------------------------
  "GET /api/tags": {
    response: object("Tag list", "Every tag, the names they are grouped under, and how many elements carry each.", {
      tags: list(ref(tagSchema)), names: list(text(100)), counts: { type: "object" },
    }, ["tags", "names", "counts"]),
  },
  "POST /api/tags": { request: tagCreateSchema, response: tagWithPage, status: 201 },
  "GET /api/tags/:id": { response: tagWithPage },
  "PATCH /api/tags/:id": { request: tagUpdateSchema, response: tagWithPage },
  "GET /api/tags/export": { produces: "text/yaml" },
  "POST /api/tags/import": {
    consumes: "text/yaml",
    response: object("Tag import result", "What the export put back: tags created, tags matched, assignments restored.", { created: { type: "integer" }, attached: { type: "integer" } }),
  },
  "GET /api/elements": {
    response: object("Element list", "Everything taggable in this site — devices, groups, services, sensors — with its tags.", {
      elements: list({ type: "object" }), total: { type: "integer" }, kinds: list(text(64)), tags: list(ref(tagSchema)),
    }, ["elements", "total", "kinds", "tags"]),
    query: { path: text(400), q: text(200), kind: text(64), tagId: { type: "string", format: "uuid" }, limit: { type: "integer", minimum: 1, maximum: 200 }, offset: { type: "integer", minimum: 0 } },
  },
  "GET /api/elements/:key": {
    response: object("Element", "One taggable element and its tags.", { element: { type: "object" } }, ["element"]),
  },
  "GET /api/elements/:key/tags": { response: elementWithTags },
  "POST /api/elements/:key/tags": { request: tagAssignmentSchema, response: elementWithTags },
  "DELETE /api/elements/:key/tags/:id": { response: elementWithTags },

  // ---- The graph ----------------------------------------------------------
  "GET /api/graph": {
    response: object("Graph", "Every element and every connection, unpositioned.", {
      nodes: list(ref(graphNodeSchema)), edges: list(ref(graphEdgeSchema)), generatedAt: stamp,
    }, ["nodes", "edges", "generatedAt"]),
    query: { side: { enum: ["schema", "instance"] }, kind: text(64) },
  },
  "GET /api/graph/:key": { response: "graphResponseSchema", query: { depth: { type: "integer", minimum: 0, maximum: 3 } } },

  // ---- The Kindle view ----------------------------------------------------
  "GET /api/kindle/catalog": {
    response: object("Kindle catalog", "Everything the e-ink view could show: elements, devices, and the controls each capability offers.", {
      elements: list({ type: "object" }), devices: list({ type: "object" }), capabilities: list({ type: "object" }),
    }, ["elements", "devices", "capabilities"]),
  },
  "GET /api/kindle/config": {
    response: object("Saved Kindle view", "The saved e-ink view and the revision a write must quote.", { config: ref(kindleConfigSchema), revision: text(100) }, ["config", "revision"]),
  },
  "PUT /api/kindle/config": {
    request: object("Kindle view write", "A new e-ink view, with the revision it is replacing.", { config: ref(kindleConfigSchema), revision: text(100) }, ["config", "revision"]),
    response: object("Saved Kindle view", "The saved e-ink view and its new revision.", { config: ref(kindleConfigSchema), revision: text(100) }, ["config", "revision"]),
  },
  "GET /api/kindle/snapshot": { ...unspecified },
  "POST /api/kindle/preview": { request: ref(kindleConfigSchema), unspecified: true },
  "GET /api/kindle/images/:image": { produces: "image/png" },

  // ---- Automations --------------------------------------------------------
  "GET /api/automations/dog-announcer": { ...unspecified },
  "PUT /api/automations/dog-announcer": { ...unspecified },
  "PUT /api/automations/dog-announcer/enabled": {
    request: object("Automation enabled request", "Runs the automation, or stops it, without forgetting its settings.", { enabled: flag }, ["enabled"]),
    unspecified: true,
  },
  "POST /api/automations/dog-announcer/preview": { ...unspecified },
  "GET /api/automations/dog-announcer/stream.mjpeg": { produces: "multipart/x-mixed-replace; boundary=frame", query: { cameraId: id } },
  "GET /api/automations/dog-announcer/switch": { response: ref(binarySwitchSchema) },
  "POST /api/automations/dog-announcer/switch/turn-on": { response: ref(binarySwitchSchema) },
  "POST /api/automations/dog-announcer/switch/turn-off": { response: ref(binarySwitchSchema) },
  "POST /api/automations/dog-announcer/switch/toggle": { response: ref(binarySwitchSchema) },

  // ---- The raw camera service --------------------------------------------
  "GET /api/camera/state": { response: "cameraDashboardModelSchema" },
  "GET /api/camera/network": { response: "cameraDashboardModelSchema" },
  "POST /api/camera/setup": { request: "cameraSetupRequestSchema", response: "cameraActionResponseSchema" },
  "POST /api/camera/disconnect": { response: "cameraActionResponseSchema" },
  "POST /api/camera/discover": { request: "cameraDiscoverRequestSchema", response: "cameraActionResponseSchema" },
  "POST /api/camera/select": { request: "cameraSelectRequestSchema", response: "cameraActionResponseSchema" },
  "POST /api/camera/control": { request: "cameraControlRequestSchema", response: "cameraActionResponseSchema" },
  "POST /api/camera/ptz": { request: "cameraPtzRequestSchema", response: "cameraActionResponseSchema" },
  "POST /api/camera/reboot": { request: "cameraRebootRequestSchema", response: "cameraActionResponseSchema" },
  "POST /api/camera/network/dns-override": { request: "cameraNetworkToggleRequestSchema", response: "cameraActionResponseSchema" },
  "POST /api/camera/network/reconnect": { request: "cameraNetworkReconnectRequestSchema", response: "cameraActionResponseSchema" },
  "GET /api/camera/devices/:id/snapshot": { produces: "image/jpeg" },
  "GET /api/camera/devices/:id/stream.mjpeg": { produces: "multipart/x-mixed-replace; boundary=frame" },
  "GET /api/camera/devices/:id/playback.mjpeg": { produces: "multipart/x-mixed-replace; boundary=frame" },
  "GET /api/camera/devices/:id/audio.mp3": { produces: "audio/mpeg" },
  "POST /api/camera/devices/:id/playback/pause": { ...unspecified },
  "POST /api/camera/devices/:id/playback/resume": { ...unspecified },
  "POST /api/camera/devices/:id/playback/seek": { ...unspecified },
  "POST /api/camera/devices/:id/playback/stop": { ...unspecified },
  "POST /api/camera/devices/:id/talkback/start": { ...unspecified },
  "POST /api/camera/devices/:id/talkback/stop": { ...unspecified },
  "POST /api/camera/devices/:id/talkback/audio": { consumes: "application/octet-stream", unspecified: true },
  "POST /api/camera/devices/:id/local-command": { ...unspecified },
  "POST /api/camera/devices/:id/local-iot": { ...unspecified },
};

/** The schemas an operation names, or undefined for a route with no description. */
export function operationFor(method: string, routePath: string): Operation | undefined {
  return OPERATIONS[`${method} ${routePath}`];
}
