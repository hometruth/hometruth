#!/usr/bin/env bun
/** Require an explicit asset choice so schema updates cannot silently remove a demo. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildPublicSchemas } from "./build";

const root = resolve(import.meta.dir, "../..");

export function deploymentOptions(args: readonly string[]) {
  const { values } = parseArgs({ args: [...args], strict: true, options: {
    "demo-export": { type: "string" },
    "schemas-only": { type: "boolean" },
    output: { type: "string" },
    "schema-documents": { type: "string" },
    "dry-run": { type: "boolean" },
    env: { type: "string" },
  } });
  if (Boolean(values["demo-export"]) === Boolean(values["schemas-only"])) {
    throw new Error("Choose exactly one: --demo-export <directory> or --schemas-only. Schemas-only explicitly removes any hosted demo.");
  }
  if (values["demo-export"] && !values.output) throw new Error("Demo deployment requires --output <external-hosting-directory>.");
  if (values.env !== undefined && values.env !== "" && values.env !== "preview") throw new Error("Choose the production environment (empty) or preview.");
  return values;
}

if (import.meta.main) {
  try {
    const values = deploymentOptions(Bun.argv.slice(2));
    const output = resolve(values.output ?? resolve(root, "dist/schema-hosting"));
    const options: NonNullable<Parameters<typeof buildPublicSchemas>[1]> = {};
    if (values["demo-export"]) options.demoExport = values["demo-export"];
    if (values["schema-documents"]) {
      const documents: unknown = JSON.parse(await readFile(values["schema-documents"], "utf8"));
      if (!Array.isArray(documents)) throw new Error("Schema document input must be a JSON array");
      options.documents = documents;
    }
    await buildPublicSchemas(output, options);
    const command = [resolve(root, "node_modules/.bin/wrangler"), "deploy", "--config", resolve(output, "wrangler.jsonc"), "--env", values.env ?? ""];
    if (values["dry-run"]) command.push("--dry-run");
    const process = Bun.spawn(command, { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const code = await process.exited;
    if (code !== 0) throw new Error(`Public hosting deployment exited with status ${code}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Public hosting deployment failed");
    process.exitCode = 1;
  }
}
