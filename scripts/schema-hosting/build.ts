import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicSchemaDocuments } from "./catalog";

const root = fileURLToPath(new URL("../../", import.meta.url));

export async function buildPublicSchemas(output = resolve(root, "dist/schema-hosting")): Promise<number> {
  const documents = publicSchemaDocuments();
  await mkdir(output, { recursive: true });
  const entry = join(output, "entry.ts");
  const handler = resolve(root, "src/public-schemas/worker.ts");
  await writeFile(entry, `import { createSchemaWorker } from ${JSON.stringify(handler)};\nexport default createSchemaWorker(${JSON.stringify(documents)});\n`);
  const build = await Bun.build({ entrypoints: [entry], target: "browser", minify: true });
  if (!build.success || build.outputs.length !== 1) throw new Error(`Schema Worker build failed: ${build.logs.join("\n")}`);
  await Bun.write(join(output, "worker.js"), build.outputs[0]!);
  await rm(entry);
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
  const count = await buildPublicSchemas();
  console.log(`Built ${count} public schemas and their Worker in dist/schema-hosting/`);
}
