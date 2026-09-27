import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MODELS } from "../../src/registry";
import { schemaCatalogEntries } from "../../src/schema-catalog";
import { createSchemaWorker, SCHEMA_BASE_URL } from "../../src/public-schemas/worker";
import { buildPublicSchemas } from "./build";
import { publicSchemaDocuments } from "./catalog";

const documents = publicSchemaDocuments();
const worker = createSchemaWorker(documents);
const temporary = await mkdtemp(join(tmpdir(), "hometruth-schemas-"));
afterAll(() => rm(temporary, { recursive: true, force: true }));

test("publishes every catalog and model definition at its exact public ID", async () => {
  for (const schema of [
    ...schemaCatalogEntries.map(entry => entry.schema),
    ...MODELS.flatMap(model => model.secretsSchema ? [model.configSchema, model.secretsSchema] : [model.configSchema]),
  ]) {
    const response = worker.fetch(new Request(schema.$id));
    expect(response.status, schema.$id).toBe(200);
    expect(response.headers.get("Content-Type")).toStartWith("application/schema+json");
    expect(await response.json()).toEqual({ $schema: "https://json-schema.org/draft/2020-12/schema", ...schema });
  }
});

test("no declared production schema is missing from the publication", async () => {
  const ids = new Set(documents.map(document => document.$id));
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: fileURLToPath(new URL("../../src/", import.meta.url)), absolute: true })) {
    if (file.endsWith(".test.ts")) continue;
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/\$id:\s*"(https:\/\/(?:hometruth\.[^/]+|example\.local)\/schemas\/[^\"]+)"/g)) {
      expect(ids.has(match[1]!), `${file}: ${match[1]}`).toBe(true);
    }
  }
});

test("the public catalog is complete, deduplicated, and stable", async () => {
  const response = worker.fetch(new Request(SCHEMA_BASE_URL));
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toStartWith("application/json");
  const catalog = await response.json() as { schemas: { $id: string }[] };
  expect(catalog.schemas.map(schema => schema.$id)).toEqual(documents.map(document => document.$id));
  expect(new Set(catalog.schemas.map(schema => schema.$id)).size).toBe(documents.length);
  expect(catalog.schemas.some(schema => schema.$id === `${SCHEMA_BASE_URL}tag-name`)).toBe(true);
});

test("supports browser reads and HEAD without content negotiation or redirects", async () => {
  const url = `${SCHEMA_BASE_URL}models/broadlink-rm4-pro/config`;
  const get = worker.fetch(new Request(url, { headers: { Accept: "text/html" } }));
  expect(get.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect((await get.json() as { $id: string }).$id).toBe(url);
  const head = worker.fetch(new Request(url, { method: "HEAD" }));
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  expect(head.headers.get("Content-Type")).toBe(get.headers.get("Content-Type"));
  const options = worker.fetch(new Request(url, { method: "OPTIONS" }));
  expect(options.status).toBe(204);
  expect(options.headers.get("Access-Control-Allow-Methods")).toBe("GET, HEAD, OPTIONS");
  expect(worker.fetch(new Request(url, { method: "POST" })).status).toBe(405);
  for (const path of ["/", "/schemas", "/schemas/missing", "/schemas/light/", "/schemas/light.json", "/api/schemas", "/.env.local"]) {
    const response = worker.fetch(new Request(new URL(path, SCHEMA_BASE_URL)));
    expect(response.status, path).toBe(404);
    expect(response.headers.has("Location")).toBe(false);
  }
});

test("the deployable bundle serves the export and rebuilding removes obsolete schemas", async () => {
  const count = await buildPublicSchemas(temporary);
  expect(count).toBe(documents.length);
  const deployed = (await import(pathToFileURL(join(temporary, "worker.js")).href)).default as ReturnType<typeof createSchemaWorker>;
  for (const document of documents) {
    const serialized = JSON.parse(await readFile(join(temporary, new URL(document.$id).pathname), "utf8"));
    expect(await deployed.fetch(new Request(document.$id)).json()).toEqual(serialized);
  }
  await writeFile(join(temporary, "schemas/removed-schema"), "{}");
  await buildPublicSchemas(temporary);
  expect(await Bun.file(join(temporary, "schemas/removed-schema")).exists()).toBe(false);
});
