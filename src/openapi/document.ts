/**
 * The OpenAPI description of one HomeTruth install, generated rather than
 * written.
 *
 * Nothing here is a copy of anything. The paths are the routes Hono actually
 * registered in *this* process, so a conditionally mounted automation appears
 * on a site that runs it and nowhere else. The security is `policy.ts`, read
 * back out. The bodies are `operations.ts`, which names schemas and no prose.
 * The schemas themselves are `schema-catalog.ts`, dropped in whole: OpenAPI
 * 3.1 speaks JSON Schema 2020-12, which is the dialect every document in this
 * project is already written in, so they need translating in exactly one
 * respect — a `$ref` to an absolute `$id` becomes a `$ref` into `components`.
 *
 * What makes it a description of *this* house rather than of the software is
 * the parameters. `{id}` on a light route enumerates the lights this install
 * has, `{control}` enumerates the controls its devices actually expose, and
 * each carries the names to show beside them. A caller narrowed by their token
 * sees the enumerations narrowed the same way, because the same principal that
 * answers "may I" answers "which".
 */
import { PERMISSIONS, type Permission } from "../auth/model";
import { postControlNames } from "../control-routes";
import { isPublicRoute, policyFor, type PolicyTarget } from "../auth/policy";
import { SESSION_COOKIE } from "../auth/guard";
import { CAPABILITY_KINDS, type CapabilityKind } from "../models/capability";
import { schemaCatalogEntries } from "../schema-catalog";
import { elementKey } from "../tags/identity";
import { OPERATIONS, type BodySchema, type InlineSchema, type Operation } from "./operations";

/** A JSON value, which is all an OpenAPI document ever is. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: Record<string, Json>;
  readonly servers: readonly Record<string, Json>[];
  readonly tags: readonly Record<string, Json>[];
  readonly paths: Record<string, Json>;
  readonly components: Record<string, Json>;
  readonly security?: readonly Record<string, Json>[];
}

/** One route as Hono registered it. */
export interface RegisteredRoute { readonly method: string; readonly path: string }

/** What the document needs to know about the house; narrow, so a test can hand over a literal. */
export interface DescribedSite {
  readonly devices: readonly {
    readonly id: string;
    readonly name: string;
    readonly capabilities: readonly CapabilityKind[];
    readonly controls: readonly string[];
  }[];
  readonly groups: readonly { readonly id: string; readonly name: string }[];
  readonly services: readonly { readonly id: string; readonly title: string }[];
}

export interface DocumentOptions {
  readonly routes: readonly RegisteredRoute[];
  readonly site: DescribedSite;
  /** Where this install answers, for the "try it" base URL. */
  readonly origin: string;
  /** The worker generation, which is the only version this software has. */
  readonly version: string;
  /** Whether a caller on a private address is admitted without a token. */
  readonly trustsLocalNetwork?: boolean;
  readonly generatedAt?: string;
}

export const EMPTY_SITE: DescribedSite = { devices: [], groups: [], services: [] };

// ---------------------------------------------------------------------------
// Words. The only English in this file, and all of it derived from an
// enumeration rather than written per route: three access levels, six targets,
// and a lexicon for the path segments that are not ordinary words.
// ---------------------------------------------------------------------------

const LEXICON: Readonly<Record<string, string>> = {
  api: "API", ir: "IR", rf: "RF", ptz: "PTZ", mjpeg: "MJPEG", mp3: "MP3", png: "PNG",
  json: "JSON", yaml: "YAML", url: "URL", dns: "DNS", id: "id", ui: "UI", nrf24: "nRF24",
  wav: "WAV", jpeg: "JPEG", sse: "SSE", mac: "MAC", openapi: "OpenAPI",
};

/** Whole path segments this project has its own name for. */
const SEGMENTS: Readonly<Record<string, string>> = {
  "ir-rf-blasters": "IR/RF blasters",
  "ir-rf-blaster": "IR/RF blaster",
  "openapi.json": "OpenAPI",
};

const PERMISSION_TEXT: Readonly<Record<Permission, string>> = {
  read: "read state, listings, media and events",
  write: "read and control the element",
  admin: "read, control and administer the element",
};

const TARGET_TEXT: Readonly<Record<PolicyTarget["kind"], string>> = {
  site: "and cover the whole site",
  device: "and reach the named device",
  group: "and reach every member of the named group",
  element: "and reach the named element",
  page: "and reach whatever the page shows",
  listing: "; the answer is narrowed to what it reaches",
};

/** `turn-on` → `Turn on`, `ir-rf-blasters` → `IR/RF blasters`. */
function humanize(segment: string): string {
  const named = SEGMENTS[segment];
  if (named) return named;
  const words = segment.split(/[-.]/u).filter(Boolean).map(word => LEXICON[word.toLowerCase()] ?? word);
  const [first = "", ...rest] = words;
  const head = LEXICON[first.toLowerCase()] ? first : first.charAt(0).toUpperCase() + first.slice(1);
  return [head, ...rest].join(" ");
}

/** `switches` → `switch`, `devices` → `device`. Naive on purpose; it only ever sees our own path segments. */
function singular(segment: string): string {
  if (/(?:s|x|ch|sh)es$/u.test(segment)) return segment.slice(0, -2);
  return segment.endsWith("s") ? segment.slice(0, -1) : segment;
}

/**
 * What to call an operation in a list. Mechanical: the last thing the path
 * names, singular when the path ends at one of them. The description under it
 * is the schema's own, which is where the real words live.
 */
function summaryFor(path: string, segments: readonly string[]): string {
  const last = segments.at(-1) ?? "";
  if (!last.startsWith("{")) return humanize(last.replace(/\.(mjpeg|mp3|json)$/u, ""));
  const owner = [...segments].reverse().find(segment => !segment.startsWith("{"));
  return owner ? humanize(singular(owner)) : humanize(path);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** `$id` → the name it is filed under in `components.schemas`. */
const COMPONENT_NAMES: ReadonlyMap<string, string> = new Map(
  schemaCatalogEntries.map(entry => [entry.schema.$id as string, entry.typeName]),
);

const COMPONENT_BY_KEY: ReadonlyMap<string, { typeName: string; schema: Readonly<Record<string, unknown>> }> = new Map(
  schemaCatalogEntries.map(entry => [entry.key, { typeName: entry.typeName, schema: entry.schema as Readonly<Record<string, unknown>> }]),
);

/**
 * The one translation between the dialect the project writes and the dialect
 * OpenAPI reads: an absolute `$ref` becomes a pointer into `components`, and a
 * document's own identity (`$schema`, `$id`) is dropped so it cannot change
 * how the refs beneath it resolve.
 */
export function rewriteSchema(value: unknown, top: boolean): Json {
  if (Array.isArray(value)) return value.map(item => rewriteSchema(item, false));
  if (value === null || typeof value !== "object") return value as Json;
  const result: Record<string, Json> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (top && (key === "$schema" || key === "$id")) continue;
    if (key === "$ref" && typeof nested === "string") {
      const name = COMPONENT_NAMES.get(nested);
      result.$ref = name ? `#/components/schemas/${name}` : nested;
      continue;
    }
    result[key] = rewriteSchema(nested, false);
  }
  return result;
}

/** Catalog schemas are immutable for this worker generation. Compile once. */
let compiledComponents: Record<string, Json> | undefined;
function componentSchemas(): Record<string, Json> {
  if (compiledComponents) return compiledComponents;
  const schemas: Record<string, Json> = {};
  for (const entry of schemaCatalogEntries) {
    schemas[entry.typeName] = {
      ...(rewriteSchema(entry.schema, true) as Record<string, Json>),
      title: entry.title,
      description: entry.description,
      "x-hometruth-schema-id": entry.schema.$id as string,
      "x-hometruth-category": entry.category,
      ...(schemaPage(entry.schema.$id as string) ? { "x-hometruth-page": schemaPage(entry.schema.$id as string)! } : {}),
    };
  }
  return compiledComponents = schemas;
}

function schemaPage(schemaId: string): string | undefined {
  try {
    const path = new URL(schemaId).pathname;
    return path.startsWith("/schemas/") && path !== "/schemas/" ? path : undefined;
  } catch {
    return undefined;
  }
}

/** A body, as OpenAPI wants it: a reference for a catalog schema, the schema itself otherwise. */
function bodySchema(body: BodySchema): Json {
  if (typeof body === "string") {
    const component = COMPONENT_BY_KEY.get(body);
    if (!component) throw new Error(`No schema in the catalog is keyed "${body}"`);
    return { $ref: `#/components/schemas/${component.typeName}` };
  }
  return rewriteSchema(body, true);
}

/** The words an operation says about itself: whatever its schema says about itself. */
function bodyDescription(body: BodySchema | undefined): string | undefined {
  if (body === undefined) return undefined;
  if (typeof body === "string") return COMPONENT_BY_KEY.get(body)?.schema.description as string | undefined;
  return typeof body.description === "string" ? body.description : undefined;
}

const ERROR_REF = { $ref: "#/components/schemas/ErrorResponse" } as const;

// ---------------------------------------------------------------------------
// Parameters, filled in from this install
// ---------------------------------------------------------------------------

/** Which capability a collection segment names, so `/api/lights/{id}` enumerates lights and not everything. */
export const COLLECTION_CAPABILITIES: Readonly<Record<string, readonly CapabilityKind[]>> = {
  switches: ["binarySwitch"],
  lights: ["light", "stringLight"],
  buttons: ["button"],
  cameras: ["camera"],
  "ir-rf-blasters": ["infraredBlaster", "radioFrequencyBlaster"],
  "radio-receivers": ["radioFrequencyReceiver"],
};

interface Choice { readonly value: string; readonly label: string }

function choices(site: DescribedSite, name: string, collection: string | undefined, target: PolicyTarget | undefined): readonly Choice[] {
  const devices = (kinds?: readonly CapabilityKind[]) => site.devices
    .filter(device => !kinds || kinds.some(kind => device.capabilities.includes(kind)))
    .map(device => ({ value: device.id, label: device.name }));

  if (name === "camera") return devices(["camera"]);
  if (name === "kind") return CAPABILITY_KINDS.map(kind => ({ value: kind, label: kind }));
  if (name === "control" || name === "controlId") {
    const controls = [...new Set(site.devices.flatMap(device => device.controls))].sort();
    return controls.map(control => ({ value: control, label: control }));
  }
  if (name === "key") {
    return [
      ...site.devices.map(device => ({ value: elementKey("device", device.id), label: device.name })),
      ...site.groups.map(group => ({ value: elementKey("group", group.id), label: group.name })),
      ...site.services.map(service => ({ value: elementKey("service", service.id), label: service.title })),
    ];
  }
  if (name !== "id") return [];
  if (collection === "services") return site.services.map(service => ({ value: service.id, label: service.title }));
  if (target?.kind === "group" || collection === "device-groups") return site.groups.map(group => ({ value: group.id, label: group.name }));
  // Only a route whose policy keys on a device names a device. `/api/camera/…`
  // also says "devices" in its path and means the vendor's own cloud serials;
  // enumerating this site's ids there would be a confident wrong answer.
  return target?.kind === "device" ? devices(collection ? COLLECTION_CAPABILITIES[collection] : undefined) : [];
}

function pathParameters(segments: readonly string[], site: DescribedSite, target: PolicyTarget | undefined): Json[] {
  const parameters: Json[] = [];
  for (const [index, segment] of segments.entries()) {
    if (!segment.startsWith("{")) continue;
    const name = segment.slice(1, -1);
    const collection = [...segments.slice(0, index)].reverse().find(part => !part.startsWith("{"));
    const options = choices(site, name, collection, target);
    const schema: Record<string, Json> = { type: "string" };
    if (options.length) schema.enum = options.map(option => option.value);
    // Labels only when they say something the value does not: a control is its
    // own name, a device id is not.
    const named = options.some(option => option.label !== option.value);
    parameters.push({
      name,
      in: "path",
      required: true,
      schema,
      ...(named ? { "x-hometruth-labels": Object.fromEntries(options.map(option => [option.value, option.label])) } : {}),
    });
  }
  return parameters;
}

function queryParameters(query: Readonly<Record<string, InlineSchema>> | undefined): Json[] {
  if (!query) return [];
  return Object.entries(query).map(([name, schema]) => ({ name, in: "query", required: false, schema: rewriteSchema(schema, true) }));
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function responses(operation: Operation, method: string, hasBody: boolean, isPublic: boolean, target: PolicyTarget | undefined): Record<string, Json> {
  const success: Record<string, Json> = {};
  const status = String(operation.status ?? 200);

  if (operation.frames) {
    success.description = "A server-sent event stream. Each frame names its own schema.";
    success.content = {
      "text/event-stream": {
        schema: { oneOf: Object.values(operation.frames).map(bodySchema) },
        "x-hometruth-frames": Object.fromEntries(Object.entries(operation.frames).map(([name, frame]) => [name, bodySchema(frame)])),
      },
    };
  } else if (operation.produces) {
    success.description = `A ${operation.produces.split(";")[0]} response.`;
    success.content = { [operation.produces]: { schema: { type: "string", format: "binary" } } };
  } else if (operation.response) {
    success.description = bodyDescription(operation.response) ?? "The result of this call.";
    success.content = { "application/json": { schema: bodySchema(operation.response) } };
  } else {
    success.description = operation.unspecified
      ? "A JSON body no schema document describes yet."
      : "The result of this call.";
    success.content = { "application/json": { schema: {} } };
  }

  const error = (description: string): Json => ({ description, content: { "application/json": { schema: ERROR_REF } } });
  const failures: Record<string, Json> = {};
  if (hasBody) failures["400"] = error("The request body does not match its schema.");
  if (!isPublic) {
    failures["401"] = error("No token was presented, and this network is not trusted.");
    failures["403"] = error("The token was accepted but does not hold this permission, or does not reach this thing.");
  }
  if (target && (target.kind === "device" || target.kind === "group" || target.kind === "element" || target.kind === "page")) {
    failures["404"] = error("Nothing here is named by that id.");
  }
  if (method !== "GET") failures["415"] = error("A change must be sent as application/json.");
  failures["500"] = error("An unexpected server error. The envelope is the same as every other failure.");

  return { [status]: success, ...failures };
}

function securityDescription(permission: Permission, target: PolicyTarget, trustsLocalNetwork: boolean): string {
  const local = trustsLocalNetwork
    ? " A caller on a private address is admitted with full authority and needs no token."
    : "";
  return `A token must hold \`${permission}\` (${PERMISSION_TEXT[permission]}) ${TARGET_TEXT[target.kind]}.${local}`;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/** The path as OpenAPI writes it, or undefined for a route it cannot describe. */
export function openApiPath(routePath: string): string | undefined {
  if (!routePath.startsWith("/api/") && routePath !== "/api") return undefined;
  if (routePath.includes("*")) return undefined;
  return routePath.split("/").map(part => (part.startsWith(":") ? `{${part.slice(1).replace(/[{?].*$/u, "")}}` : part)).join("/");
}

/** Every API route of this install, sorted and de-duplicated, as `METHOD /pattern`. */
export function apiRoutes(routes: readonly RegisteredRoute[]): RegisteredRoute[] {
  const seen = new Map<string, RegisteredRoute>();
  for (const route of routes) {
    if (route.method === "ALL" || !openApiPath(route.path)) continue;
    seen.set(`${route.method} ${route.path}`, { method: route.method, path: route.path });
  }
  return [...seen.values()].sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

export function buildOpenApiDocument(options: DocumentOptions): OpenApiDocument {
  const { routes, site, origin, version, trustsLocalNetwork = false } = options;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const paths: Record<string, Json> = {};
  const usedTags = new Map<string, string>();

  for (const route of apiRoutes(routes)) {
    const path = openApiPath(route.path)!;
    const segments = path.split("/").filter(Boolean);
    const operation = OPERATIONS[`${route.method} ${route.path}`];
    if (!operation) continue;

    const policy = policyFor(route.method, route.path);
    const isPublic = isPublicRoute(route.method, route.path);
    const group = segments[1] ?? "api";
    usedTags.set(group, humanize(group));

    const request = operation.consumes
      ? { required: true, content: { [operation.consumes]: { schema: { type: "string" } } } }
      : operation.request
        ? {
          required: true,
          description: bodyDescription(operation.request),
          content: { "application/json": { schema: bodySchema(operation.request) } },
        }
        : undefined;

    const described: Record<string, Json> = {
      operationId: [route.method.toLowerCase(), ...segments.map(segment => (segment.startsWith("{") ? `by-${segment.slice(1, -1)}` : segment))].join("-"),
      summary: summaryFor(path, segments),
      tags: [humanize(group)],
      parameters: [...pathParameters(segments, site, policy?.target), ...queryParameters(operation.query)],
      responses: responses(operation, route.method, Boolean(operation.request), isPublic, policy?.target),
    };

    const description = [
      bodyDescription(operation.request) ?? bodyDescription(operation.response),
      policy ? securityDescription(policy.permission, policy.target, trustsLocalNetwork) : "Public: no credential is required.",
    ].filter(Boolean).join("\n\n");
    if (description) described.description = description;
    if (request) described.requestBody = request as unknown as Json;
    if (policy) {
      described.security = [{ bearerAuth: [] }, { sessionCookie: [] }];
      described["x-hometruth-permission"] = policy.permission;
      described["x-hometruth-target"] = policy.target.kind;
    } else {
      described.security = [];
    }
    if (operation.unspecified) described["x-hometruth-unspecified"] = true;

    const existing = (paths[path] as Record<string, Json> | undefined) ?? {};
    paths[path] = { ...existing, [route.method.toLowerCase()]: described };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "HomeTruth",
      version,
      summary: "The local API of one HomeTruth install.",
      description: [
        `The enumerations in path parameters are this house: ${site.devices.length} device${site.devices.length === 1 ? "" : "s"}, ${site.groups.length} group${site.groups.length === 1 ? "" : "s"}, ${site.services.length} service${site.services.length === 1 ? "" : "s"}, as they stood at ${generatedAt}.`,
        trustsLocalNetwork
          ? "This install trusts its local network: a caller on a private address has full authority without a token. Everyone else presents `Authorization: Bearer ht_…`."
          : "Every call needs `Authorization: Bearer ht_…`, or the session cookie a browser gets by signing in.",
      ].join("\n\n"),
    },
    servers: [{ url: origin, description: "This install." }],
    tags: [...usedTags.values()].sort().map(name => ({ name })),
    paths,
    components: {
      schemas: componentSchemas(),
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: `An API token, issued on the Tokens page. Its access levels (${PERMISSIONS.join(" < ")}) apply only within its subject. Each level includes the levels below it.`,
        },
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: SESSION_COOKIE,
          description: "The same token, in the cookie a browser receives from POST /api/auth/sign-in.",
        },
      },
    },
    security: [{ bearerAuth: [] }, { sessionCookie: [] }],
  };
}

/** Who the description is for, so it enumerates only what that caller could call. */
export interface DescribedFor {
  /** Whether one device is in reach. */
  readonly reaches?: (id: string) => boolean;
  /**
   * Whether this caller reaches the site itself. Groups and services are
   * site-wide listings — a narrow token is refused `GET /api/services`, so its
   * description must not name the services either.
   */
  readonly siteWide?: boolean;
}

/** The narrow view of a live site the document needs, kept to what one caller reaches. */
export function describedSite(
  site: {
    list(): readonly { id: string; name: string; capabilities: CapabilityKind[] }[];
    listGroups(): readonly { id: string; name: string }[];
    listServices(): readonly { id: string; title: string }[];
    get(id: string): Parameters<typeof postControlNames>[0] | undefined;
  },
  { reaches = () => true, siteWide = true }: DescribedFor = {},
): DescribedSite {
  return {
    devices: site.list().filter(device => reaches(device.id)).map(device => {
      const configured = site.get(device.id);
      return {
        id: device.id,
        name: device.name,
        capabilities: device.capabilities,
        controls: configured ? [...postControlNames(configured)] : [],
      };
    }),
    groups: siteWide ? site.listGroups().map(group => ({ id: group.id, name: group.name })) : [],
    services: siteWide ? site.listServices().map(service => ({ id: service.id, title: service.title })) : [],
  };
}
