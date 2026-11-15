import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { MODELS } from "../../src/registry";
import { schemaCatalogEntries } from "../../src/schema-catalog";
import { createPublicWorker, createSchemaWorker, DEMO_CONTENT_SECURITY_POLICY, SCHEMA_BASE_URL } from "../../src/public-schemas/worker";
import { buildPublicSchemas } from "./build";
import { deploymentOptions } from "./deploy";
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
  const deployed = (await import(pathToFileURL(join(temporary, "worker.js")).href)).default as ReturnType<typeof createPublicWorker>;
  for (const document of documents) {
    const serialized = JSON.parse(await readFile(join(temporary, new URL(document.$id).pathname), "utf8"));
    expect(await (await deployed.fetch(new Request(document.$id))).json()).toEqual(serialized);
  }
  await writeFile(join(temporary, "schemas/removed-schema"), "{}");
  await buildPublicSchemas(temporary);
  expect(await Bun.file(join(temporary, "schemas/removed-schema")).exists()).toBe(false);
});

test("demo pages and assets are static, canonical and disconnected, with unchanged schemas", async () => {
  const requests: string[] = [];
  const publicWorker = createPublicWorker(documents);
  const assets = {
    async fetch(input: RequestInfo | URL) {
      const request = new Request(input);
      requests.push(new URL(request.url).pathname);
      const path = new URL(request.url).pathname;
      if (path === "/demo/missing.html") return new Response("Not found", { status: 404 });
      return new Response(request.method === "HEAD" ? null : "static demo", { headers: { "Content-Type": path.endsWith(".js") ? "text/javascript" : "text/html", "Set-Cookie": "unexpected=true" } });
    },
  };
  const env = { ASSETS: assets };
  for (const [path, file] of [["/", "/demo/index.html"], ["/demo/devices/demo-device-1.html", "/demo/devices/demo-device-1.html"], ["/demo/schemas/light.html", "/demo/schemas/light.html"], ["/demo/assets/runtime.js", "/demo/assets/runtime.js"]]) {
    const response = await publicWorker.fetch(new Request(`https://hometruth.ai${path}?anything=value`), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("static demo");
    expect(requests.at(-1)).toBe(file);
    expect(response.headers.get("Content-Security-Policy")).toBe(DEMO_CONTENT_SECURITY_POLICY);
    expect(response.headers.get("Content-Security-Policy")).toContain("connect-src 'none'");
    expect(response.headers.get("Content-Security-Policy")).toContain("form-action 'none'");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300, must-revalidate, no-transform");
    expect(response.headers.has("Set-Cookie")).toBe(false);
  }
  const head = await publicWorker.fetch(new Request("https://hometruth.ai/", { method: "HEAD" }), env);
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  expect((await publicWorker.fetch(new Request("https://hometruth.ai/demo/missing.html"), env)).status).toBe(404);
  const before = requests.length;
  for (const path of ["/demo/", "/demo/index", "/demo/index.html", "/demo/devices/demo-device-1/", "/demo/devices/demo-device-1", "/demo/.env", "/demo/_headers", "/demo/assets/source.ts", "/demo/%61ssets/runtime.js", "/.hometruth-demo-export.json", "/api/devices", "/demo", "/demonstration"]) {
    const response = await publicWorker.fetch(new Request(`https://hometruth.ai${path}`), env);
    expect(response.status, path).toBe(404);
    expect(response.headers.has("Location")).toBe(false);
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    expect((await publicWorker.fetch(new Request("https://hometruth.ai/", { method }), env)).status).toBe(405);
  }
  expect(requests.length).toBe(before);
  expect((await publicWorker.fetch(new Request("https://hometruth.ai/"))).status).toBe(404);
  for (const path of ["/schemas/", "/schemas/light"]) {
    const request = new Request(`https://hometruth.ai${path}`);
    const expected = worker.fetch(request);
    const actual = await publicWorker.fetch(request, env);
    expect(actual.status).toBe(expected.status);
    expect([...actual.headers]).toEqual([...expected.headers]);
    expect(await actual.text()).toBe(await expected.text());
  }
});

test("demo hosting never forwards static asset redirects", async () => {
  const publicWorker = createPublicWorker([]);
  const response = await publicWorker.fetch(new Request("https://hometruth.ai/"), {
    ASSETS: { async fetch() { return Response.redirect("https://example.invalid", 301); } },
  });
  expect(response.status).toBe(404);
  expect(response.headers.has("Location")).toBe(false);
});

test("demo hosting stages outside source and can preserve an exact published schema set", async () => {
  const exported = join(temporary, "export");
  const output = join(temporary, "hosting");
  await mkdir(join(exported, "demo/assets"), { recursive: true });
  await writeFile(join(exported, "demo/index.html"), "<!doctype html><title>Synthetic home</title>");
  await writeFile(join(exported, "demo/assets/runtime.js"), "console.log('demo');");
  const published = [{ $id: "https://hometruth.ai/schemas/synthetic", $schema: "https://json-schema.org/draft/2020-12/schema", title: "Published synthetic definition" }];
  expect(await buildPublicSchemas(output, { demoExport: exported, documents: published })).toBe(1);
  const config = JSON.parse(await readFile(join(output, "wrangler.jsonc"), "utf8"));
  expect(config.assets.directory).toBe(await import("node:fs/promises").then(fs => fs.realpath(exported)));
  expect(config.assets.run_worker_first).toBe(true);
  expect(config.assets.html_handling).toBe("none");
  expect(config.assets.not_found_handling).toBe("none");
  expect(config.build).toBeUndefined();
  expect(await Bun.file(join(output, "assets/demo/index.html")).exists()).toBe(false);
  const deployed = (await import(pathToFileURL(join(output, "worker.js")).href)).default as ReturnType<typeof createPublicWorker>;
  expect(await (await deployed.fetch(new Request(published[0]!.$id))).json()).toEqual(published[0]);
  expect((await deployed.fetch(new Request("https://hometruth.ai/schemas/light"))).status).toBe(404);
  await expect(buildPublicSchemas(resolveSource("dist/forbidden-demo-hosting"), { demoExport: exported })).rejects.toThrow("outside public source");
  await writeFile(join(exported, "demo/private.yml"), "private: true");
  await expect(buildPublicSchemas(output, { demoExport: exported })).rejects.toThrow("nonstatic asset");
  await rm(join(exported, "demo/private.yml"));
  await symlink(join(exported, "demo/index.html"), join(exported, "demo/alias.html"));
  await expect(buildPublicSchemas(output, { demoExport: exported })).rejects.toThrow("symlinks");
});

test("hosting checks marked exports against their exact static file inventory", async () => {
  const exported = join(temporary, "marked-export");
  const output = join(temporary, "marked-hosting");
  const files = { "demo/index.html": "<!doctype html><title>Synthetic home</title>", "demo/assets/runtime.js": "console.log('demo');" };
  await mkdir(join(exported, "demo/assets"), { recursive: true });
  for (const [name, content] of Object.entries(files)) await writeFile(join(exported, name), content);
  const manifest = { format: "hometruth-static-demo", version: 1, files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, createHash("sha256").update(content).digest("hex")])) };
  const marker = join(exported, ".hometruth-demo-export.json");
  await writeFile(marker, JSON.stringify(manifest));
  expect(await buildPublicSchemas(output, { demoExport: exported, documents: [] })).toBe(0);
  await writeFile(join(exported, "demo/assets/runtime.js"), "edited");
  await expect(buildPublicSchemas(output, { demoExport: exported, documents: [] })).rejects.toThrow("contents do not match");
  await writeFile(join(exported, "demo/assets/runtime.js"), files["demo/assets/runtime.js"]);
  await writeFile(join(exported, "demo/extra.html"), "unexpected");
  await expect(buildPublicSchemas(output, { demoExport: exported, documents: [] })).rejects.toThrow("file list does not match");
  await rm(join(exported, "demo/extra.html"));
  await rm(join(exported, "demo/assets/runtime.js"));
  await expect(buildPublicSchemas(output, { demoExport: exported, documents: [] })).rejects.toThrow("file list does not match");
  await writeFile(join(exported, "demo/assets/runtime.js"), files["demo/assets/runtime.js"]);
  for (const value of [null, [], { ...manifest, format: "other" }, { ...manifest, version: 2 }, { ...manifest, files: [] }, { ...manifest, files: { ...manifest.files, "demo/index.html": "invalid" } }]) {
    await writeFile(marker, JSON.stringify(value));
    await expect(buildPublicSchemas(output, { demoExport: exported, documents: [] })).rejects.toThrow("Invalid demo export manifest");
  }
  await writeFile(marker, "malformed JSON");
  await expect(buildPublicSchemas(output, { demoExport: exported, documents: [] })).rejects.toThrow("Invalid demo export manifest");
  await rm(marker);
  await symlink(join(exported, "demo/index.html"), marker);
  await expect(buildPublicSchemas(output, { demoExport: exported, documents: [] })).rejects.toThrow("symlinks");
});

function resolveSource(path: string): string {
  return fileURLToPath(new URL(`../../${path}`, import.meta.url));
}

test("deployment requires an explicit choice to preserve or remove demo assets", () => {
  expect(() => deploymentOptions([])).toThrow("Choose exactly one");
  expect(() => deploymentOptions(["--dry-run"])).toThrow("Choose exactly one");
  expect(() => deploymentOptions(["--demo-export", "/tmp/export", "--schemas-only"])).toThrow("Choose exactly one");
  expect(() => deploymentOptions(["--demo-export", "/tmp/export"])).toThrow("requires --output");
  expect(() => deploymentOptions(["--schemas-only", "--env", "unknown"])).toThrow("production environment");
  expect(deploymentOptions(["--schemas-only", "--dry-run"])["schemas-only"]).toBe(true);
  expect(deploymentOptions(["--demo-export", "/tmp/export", "--output", "/tmp/hosting", "--schema-documents", "/tmp/schemas.json", "--env", "preview"])).toMatchObject({ "demo-export": "/tmp/export", output: "/tmp/hosting", "schema-documents": "/tmp/schemas.json", env: "preview" });
});
