import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import type { PublicSchemaDocument } from "../../src/public-schemas/worker";
import { publicSchemaDocuments } from "./catalog";

const root = fileURLToPath(new URL("../../", import.meta.url));

interface BuildOptions {
  demoExport?: string;
  documents?: readonly PublicSchemaDocument[];
}

function inside(directory: string, path: string): boolean {
  const name = relative(directory, path);
  return name === "" || (name !== ".." && !name.startsWith("../") && !name.startsWith("/"));
}

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

async function validateDemoExport(directory: string): Promise<void> {
  const rootFiles = await readdir(directory);
  const marker = ".hometruth-demo-export.json";
  if (!rootFiles.includes("demo") || rootFiles.some(name => name !== "demo" && name !== marker)) throw new Error("Demo export must contain only its demo/ directory and optional export manifest");
  const extensions = new Set([".html", ".js", ".css", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".mp3", ".wav", ".mp4"]);
  const actualFiles: string[] = [];
  async function inspect(path: string): Promise<void> {
    const item = await lstat(path);
    if (item.isSymbolicLink()) throw new Error("Demo export must not contain symlinks");
    if (item.isDirectory()) {
      for (const name of await readdir(path)) {
        if (name.startsWith(".") || name.startsWith("_")) throw new Error("Demo export must not contain hidden files or host configuration");
        await inspect(join(path, name));
      }
    } else if (!item.isFile() || !extensions.has(extname(path).toLowerCase())) {
      throw new Error("Demo export contains a nonstatic asset");
    } else {
      actualFiles.push(relative(directory, path).split(sep).join("/"));
    }
  }
  await inspect(join(directory, "demo"));
  if (!(await lstat(join(directory, "demo/index.html"))).isFile()) throw new Error("Demo export requires demo/index.html");
  if (rootFiles.includes(marker)) {
    const path = join(directory, marker);
    const item = await lstat(path);
    if (item.isSymbolicLink()) throw new Error("Demo export must not contain symlinks");
    if (!item.isFile()) throw new Error("Invalid demo export manifest");
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(path, "utf8")); }
    catch { throw new Error("Invalid demo export manifest"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid demo export manifest");
    const manifest = parsed as Record<string, unknown>;
    if (Object.keys(manifest).sort().join(",") !== "files,format,version" || manifest.format !== "hometruth-static-demo" || manifest.version !== 1 || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)) throw new Error("Invalid demo export manifest");
    const files = manifest.files as Record<string, unknown>;
    if (Object.keys(files).length !== actualFiles.length || actualFiles.some(name => !Object.hasOwn(files, name))) throw new Error("Demo export file list does not match its manifest");
    for (const name of actualFiles) {
      const expected = files[name];
      if (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) throw new Error("Invalid demo export manifest digest");
      const actual = createHash("sha256").update(await readFile(join(directory, name))).digest("hex");
      if (actual !== expected) throw new Error("Demo export contents do not match its manifest");
    }
  }
}

export async function buildPublicSchemas(output = resolve(root, "dist/schema-hosting"), options: BuildOptions = {}): Promise<number> {
  output = await canonicalPath(resolve(output));
  const demoExport = options.demoExport ? await realpath(resolve(options.demoExport)) : undefined;
  if (demoExport) {
    const sourceRoot = await realpath(root);
    if (inside(sourceRoot, demoExport) || inside(sourceRoot, output)) throw new Error("Demo exports and hosting output must stay outside public source");
    if (inside(demoExport, output) || inside(output, demoExport)) throw new Error("Demo export and hosting output must be separate directories");
    await validateDemoExport(demoExport);
  }
  const documents = options.documents ?? publicSchemaDocuments();
  const ids = new Set<string>();
  for (const document of documents) {
    if (!document || typeof document.$id !== "string" || !document.$id.startsWith("https://hometruth.ai/schemas/") || typeof document.$schema !== "string" || ids.has(document.$id)) {
      throw new Error("Public schema documents must have unique canonical IDs and a schema dialect");
    }
    const url = new URL(document.$id);
    if (url.href !== document.$id || url.search || url.hash || !/^\/schemas\/[a-zA-Z0-9_/-]+$/.test(url.pathname) || url.pathname.slice(1).split("/").some(part => !part)) throw new Error("Invalid public schema ID");
    ids.add(document.$id);
  }
  await mkdir(output, { recursive: true });
  const entry = join(output, "entry.ts");
  const handler = resolve(root, "src/public-schemas/worker.ts");
  await writeFile(entry, `import { createPublicWorker } from ${JSON.stringify(handler)};\nexport default createPublicWorker(${JSON.stringify(documents)});\n`);
  const build = await Bun.build({ entrypoints: [entry], target: "browser", minify: true });
  if (!build.success || build.outputs.length !== 1) throw new Error(`Schema Worker build failed: ${build.logs.join("\n")}`);
  await Bun.write(join(output, "worker.js"), build.outputs[0]!);
  await rm(entry);
  const assets = join(output, "assets");
  await rm(assets, { recursive: true, force: true });
  await mkdir(assets);
  const configuration = JSON.parse(await readFile(resolve(root, "scripts/schema-hosting/wrangler.jsonc"), "utf8"));
  delete configuration.build;
  configuration.$schema = resolve(root, "node_modules/wrangler/config-schema.json");
  configuration.main = "./worker.js";
  configuration.assets.directory = demoExport ?? assets;
  await writeFile(join(output, "wrangler.jsonc"), JSON.stringify(configuration, null, 2) + "\n");
  // A plain JSON export is useful for inspection or a different static host.
  // Start with a fresh export tree so removed schemas cannot survive a rebuild.
  await rm(join(output, "schemas"), { recursive: true, force: true });
  for (const document of documents) {
    const destination = join(output, new URL(document.$id).pathname.slice(1));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, JSON.stringify(document, null, 2) + "\n");
  }
  return documents.length;
}

if (import.meta.main) {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: {
    output: { type: "string" },
    "demo-export": { type: "string" },
    "schema-documents": { type: "string" },
  }, strict: true });
  const output = resolve(values.output ?? (values["demo-export"] ? `${resolve(values["demo-export"])}-hosting` : join(root, "dist/schema-hosting")));
  const options: BuildOptions = {};
  if (values["demo-export"]) options.demoExport = values["demo-export"];
  if (values["schema-documents"]) {
    const documents: unknown = JSON.parse(await readFile(values["schema-documents"], "utf8"));
    if (!Array.isArray(documents)) throw new Error("Schema document input must be a JSON array");
    options.documents = documents;
  }
  const count = await buildPublicSchemas(output, options);
  console.log(`Built ${count} public schemas and their Worker in ${output}/`);
  if (options.demoExport) console.log(`Demo hosting configuration: ${join(output, "wrangler.jsonc")}`);
}
