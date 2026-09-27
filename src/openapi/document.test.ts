import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { DogAnnouncer } from "../automations/dog-announcer";
import { DEFAULT_DOG_CONFIG } from "../automations/dog-config";
import { isPublicRoute, policyFor } from "../auth/policy";
import { schemaCatalogEntries } from "../schema-catalog";
import { createApp } from "../server/app";
import { Site } from "../site";
import { apiRoutes, buildOpenApiDocument, describedSite, EMPTY_SITE, openApiPath, type Json } from "./document";
import { OPERATIONS } from "./operations";

/**
 * Every route the app can register, built exactly as `policy.test.ts` builds
 * it: with the automation service running, because a conditionally mounted
 * route is the kind that gets forgotten.
 */
async function withApp<T>(use: (app: ReturnType<typeof createApp>, site: Site) => Promise<T> | T): Promise<T> {
  const announcer = new DogAnnouncer({
    store: { load: async () => DEFAULT_DOG_CONFIG, save: async () => {} },
    detect: async () => { throw new Error("not called"); },
    speak: async () => {}, validate: () => {},
  });
  try {
    const site = new Site([], undefined, new Map(), [announcer]);
    return await use(createApp(undefined, site), site);
  } finally { await announcer.stop(); }
}

const routesOf = (app: ReturnType<typeof createApp>) => app.routes.map(route => ({ method: route.method, path: route.path }));

const build = async () => withApp(app => buildOpenApiDocument({
  routes: routesOf(app), site: EMPTY_SITE, origin: "http://localhost:3000", version: "test",
}));

test("every API route describes what it carries", async () => {
  const unlisted = await withApp(app => apiRoutes(routesOf(app))
    .filter(route => !OPERATIONS[`${route.method} ${route.path}`])
    .map(route => `${route.method} ${route.path}`));
  // A route nobody described is a hole in the published API, and this fails the
  // build instead of quietly printing an operation with nothing in it.
  expect(unlisted).toEqual([]);
});

test("no description names a route that does not exist", async () => {
  const registered = await withApp(app => new Set(apiRoutes(routesOf(app)).map(route => `${route.method} ${route.path}`)));
  expect(Object.keys(OPERATIONS).filter(key => !registered.has(key)).sort()).toEqual([]);
});

test("every described route also has a policy or is deliberately public", async () => {
  const undecided = await withApp(app => apiRoutes(routesOf(app))
    .filter(route => !policyFor(route.method, route.path) && !isPublicRoute(route.method, route.path))
    .map(route => `${route.method} ${route.path}`));
  expect(undecided).toEqual([]);
});

test("only /api routes are described; pages are not an API", () => {
  expect(openApiPath("/devices/:slug")).toBeUndefined();
  expect(openApiPath("/ui/:version/*")).toBeUndefined();
  expect(openApiPath("/api/devices/:id/controls/:control")).toBe("/api/devices/{id}/controls/{control}");
});

test("the document is OpenAPI 3.1 and carries every catalog schema", async () => {
  const document = await build();
  expect(document.openapi).toBe("3.1.0");
  expect(document.info.version).toBe("test");
  expect(document.servers[0]?.url).toBe("http://localhost:3000");
  const schemas = document.components.schemas as Record<string, Json>;
  expect(Object.keys(schemas).sort()).toEqual([...schemaCatalogEntries].map(entry => entry.typeName).sort());
});

test("no schema reference dangles, and none points outside the document", async () => {
  const document = await build();
  const schemas = document.components.schemas as Record<string, Record<string, Json>>;
  const references: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key === "$ref" && typeof nested === "string") references.push(nested);
      else walk(nested);
    }
  };
  walk(document.paths);
  walk(schemas);
  expect(references.length).toBeGreaterThan(0);
  const dangling = [...new Set(references)].filter(reference =>
    !reference.startsWith("#/components/schemas/") || !(reference.slice("#/components/schemas/".length) in schemas));
  expect(dangling).toEqual([]);
});

test("the schemas are still the documents the server validates against", async () => {
  const document = await build();
  const schemas = document.components.schemas as Record<string, Record<string, Json>>;
  // OpenAPI 3.1 is JSON Schema 2020-12, so the whole components map must
  // compile in the same Ajv the server uses. It cannot if the rewrite bent one.
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  const base = "https://hometruth.ai/schemas/openapi-components";
  ajv.addSchema({ $id: base, components: { schemas } });
  for (const name of Object.keys(schemas)) {
    expect(() => ajv.compile({ $ref: `${base}#/components/schemas/${name}` })).not.toThrow();
  }
});

test("a read operation says what it returns and how it is authorized", async () => {
  const document = await build();
  const light = (document.paths["/api/lights/{id}"] as Record<string, Record<string, Json>>).get!;
  expect(light.summary).toBe("Light");
  expect(light.tags).toEqual(["Lights"]);
  expect(light["x-hometruth-permission"]).toBe("read");
  expect(light["x-hometruth-target"]).toBe("device");
  const responses = light.responses as Record<string, Record<string, Json>>;
  expect((((responses["200"]!.content as Record<string, Record<string, Json>>)["application/json"]!).schema as Record<string, Json>).$ref)
    .toBe("#/components/schemas/Light");
  // The envelope is the same for every failure, so a client writes one handler.
  for (const status of ["401", "403", "404", "500"]) {
    expect((((responses[status]!.content as Record<string, Record<string, Json>>)["application/json"]!).schema as Record<string, Json>).$ref)
      .toBe("#/components/schemas/ErrorResponse");
  }
});

test("a public route asks for no credential", async () => {
  const document = await build();
  const health = (document.paths["/api/health"] as Record<string, Record<string, Json>>).get!;
  expect(health.security).toEqual([]);
  expect(Object.keys(health.responses as Record<string, Json>)).not.toContain("401");
});

test("a route with no schema document says so rather than inventing one", async () => {
  const document = await build();
  const network = (document.paths["/api/devices/{id}/network/settings"] as Record<string, Record<string, Json>>).get!;
  expect(network["x-hometruth-unspecified"]).toBe(true);
});

test("device network status documents observed isolation and its mechanisms", async () => {
  const document = await build();
  const network = (document.paths["/api/devices/{id}/network"] as Record<string, Record<string, Json>>).get!;
  expect(network["x-hometruth-unspecified"]).toBeUndefined();
  const responses = network.responses as Record<string, Record<string, Json>>;
  const content = (responses["200"]!.content as Record<string, Record<string, Json>>)["application/json"]!;
  const schema = content.schema as Record<string, Json>;
  expect(schema.required).toContain("isolated");
  expect(schema.required).toContain("isolation");
  const properties = schema.properties as Record<string, Record<string, Json>>;
  expect(properties.isolated!.type).toEqual(["boolean", "null"]);
  const isolation = properties.isolation!.properties as Record<string, Record<string, Json>>;
  expect(isolation.scope!.const).toBe("hometruth");
  expect(isolation.internetBlock!.enum).toEqual(["on", "off", "missing", "unavailable"]);
  expect((isolation.methods!.items as Record<string, Json>).enum).toEqual(["internet-block", "dns-override"]);
});

test("a stream names the schema of each frame it sends", async () => {
  const document = await build();
  const stream = (document.paths["/api/state/stream"] as Record<string, Record<string, Json>>).get!;
  const responses = stream.responses as Record<string, Record<string, Json>>;
  const content = (responses["200"]!.content as Record<string, Record<string, Json>>)["text/event-stream"]!;
  expect(Object.keys(content["x-hometruth-frames"] as Record<string, Json>)).toEqual(["hello", "state", "observed", "error"]);
});

test("path parameters enumerate this install, with the names to show beside them", async () => {
  const site: Parameters<typeof buildOpenApiDocument>[0]["site"] = {
    devices: [
      { id: "porch", name: "Porch light", capabilities: ["light"], controls: ["turnOn", "setBrightness"] },
      { id: "relay", name: "Gate relay", capabilities: ["binarySwitch"], controls: ["turnOn", "toggle"] },
    ],
    groups: [{ id: "mantle", name: "Mantle" }],
    services: [{ id: "broker", title: "MQTT broker" }],
  };
  const document = await withApp(app => buildOpenApiDocument({
    routes: routesOf(app), site, origin: "http://localhost:3000", version: "test",
  }));

  const parameter = (path: string, method: string, name: string) => {
    const operation = (document.paths[path] as Record<string, Record<string, Json>>)[method]!;
    return (operation.parameters as Record<string, Json>[]).find(entry => entry.name === name)!;
  };

  // A light route enumerates lights, not the whole installation.
  const light = parameter("/api/lights/{id}", "get", "id");
  expect((light.schema as Record<string, Json>).enum).toEqual(["porch"]);
  expect(light["x-hometruth-labels"]).toEqual({ porch: "Porch light" });

  expect(((parameter("/api/switches/{id}", "get", "id").schema) as Record<string, Json>).enum).toEqual(["relay"]);
  expect(((parameter("/api/devices/{id}", "get", "id").schema) as Record<string, Json>).enum).toEqual(["porch", "relay"]);
  expect(((parameter("/api/device-groups/{id}", "get", "id").schema) as Record<string, Json>).enum).toEqual(["mantle"]);
  expect(((parameter("/api/services/{id}/events", "get", "id").schema) as Record<string, Json>).enum).toEqual(["broker"]);
  // The raw camera service keys on vendor cloud serials, not on site ids, so
  // that `{id}` is left open rather than filled with a confident wrong answer.
  expect((parameter("/api/camera/devices/{id}/snapshot", "get", "id").schema as Record<string, Json>).enum).toBeUndefined();

  // Controls come from what the devices actually expose.
  const control = parameter("/api/devices/{id}/controls/{control}", "post", "control");
  expect((control.schema as Record<string, Json>).enum).toEqual(["setBrightness", "toggle", "turnOn"]);
  // A control is its own name, so it gets no label map.
  expect(control["x-hometruth-labels"]).toBeUndefined();

  expect(document.info.description).toContain("2 devices, 1 group, 1 service");
});

test("a narrowed caller is shown a narrowed house", async () => {
  const site = {
    list: () => [
      { id: "porch", name: "Porch light", capabilities: ["light" as const] },
      { id: "hall", name: "Hall light", capabilities: ["light" as const] },
    ],
    listGroups: () => [{ id: "mantle", name: "Mantle" }],
    listServices: () => [{ id: "broker", title: "MQTT broker" }],
    get: (id: string) => ({ id, controls: () => (id === "porch" ? ["turnOn"] : ["turnOff"]), resolveControl: (controlId: string) => ({ kind: "light", controlId }) }),
  };
  const all = describedSite(site);
  expect(all.devices.map(device => device.id)).toEqual(["porch", "hall"]);
  const narrowed = describedSite(site, { reaches: id => id === "porch", siteWide: false });
  expect(narrowed.devices.map(device => device.id)).toEqual(["porch"]);
  expect(narrowed.devices[0]?.controls).toEqual(["turnOn"]);
  // Groups and services are site-wide listings a narrow token is refused, so
  // its description does not name them either.
  expect(all.groups).toHaveLength(1);
  expect(narrowed.groups).toEqual([]);
  expect(narrowed.services).toEqual([]);
});

test("query parameters are described where a route reads them", async () => {
  const document = await build();
  const events = (document.paths["/api/devices/{id}/events"] as Record<string, Record<string, Json>>).get!;
  const query = (events.parameters as Record<string, Json>[]).filter(parameter => parameter.in === "query");
  expect(query.map(parameter => parameter.name).sort()).toEqual(["filter", "label", "limit", "subject", "type", "where"]);
  const where = query.find(parameter => parameter.name === "where")!.schema as Record<string, Json>;
  expect(where.contentMediaType).toBe("application/json");
  expect(where.contentSchema).toEqual({ $ref: "#/components/schemas/FilterCondition" });
  expect(query.every(parameter => parameter.required === false)).toBe(true);
});
