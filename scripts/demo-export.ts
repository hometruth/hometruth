#!/usr/bin/env bun
/** Produce an offline playground from configuration, without starting the installation. */
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadDevicesConfig } from "../src/config/devices";
import { exportDemo } from "../src/demo/export";
import { FALLINGWATER_CONFIG } from "../src/demo/showcase";
import { runtimePaths } from "../src/runtime/paths";

const SOURCE = resolve(import.meta.dir, "..");
const MANIFEST = ".hometruth-demo-export.json";
export function demoExportOptions(args: readonly string[]) {
  let output = ".hometruth/demo-export";
  let basePath = "/demo";
  let includeNames = false;
  let showcase = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--include-names") includeNames = true;
    else if (flag === "--showcase") { showcase = true; includeNames = true; }
    else if (flag === "--output" || flag === "--base-path") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
      if (flag === "--output") output = value; else basePath = value;
    } else throw new Error("Usage: demo:export [--output directory] [--base-path /demo] [--include-names] [--showcase]");
  }
  if (!/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(basePath)) throw new Error("Use a base path such as /demo, without a trailing slash.");
  return { output, basePath, includeNames, showcase };
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

/** Check the real parent before creating anything; reject symlink aliases into source. */
export async function demoOutputPath(source: string, target: string): Promise<string> {
  const sourceReal = await realpath(source);
  const destination = resolve(target);
  let ancestor = destination;
  const missing: string[] = [];
  while (true) {
    try {
      const item = await lstat(ancestor);
      if (ancestor === destination && (item.isSymbolicLink() || !item.isDirectory())) throw new Error("The export destination must be a directory, not a file or symlink.");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.unshift(relative(dirname(ancestor), ancestor));
      ancestor = dirname(ancestor);
    }
  }
  const resolved = join(await realpath(ancestor), ...missing);
  if (within(sourceReal, resolved) || within(resolved, sourceReal)) throw new Error("Demo exports must stay outside the public source checkout.");
  await mkdir(dirname(resolved), { recursive: true });
  return resolved;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Hash every generated file, excluding only this manifest itself. */
async function outputManifest(directory: string) {
  const files: Record<string, string> = {};
  async function visit(path: string): Promise<void> {
    const item = await lstat(path);
    if (item.isSymbolicLink()) throw new Error("Demo output must not contain symlinks.");
    if (item.isDirectory()) {
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else if (item.isFile()) {
      const name = relative(directory, path).split(sep).join("/");
      if (name !== MANIFEST) files[name] = createHash("sha256").update(await readFile(path)).digest("hex");
    } else throw new Error("Demo output must contain only regular files and directories.");
  }
  await visit(directory);
  return { format: "hometruth-static-demo", version: 1, files };
}

async function verifyExistingOutput(directory: string): Promise<void> {
  let saved: unknown;
  try { saved = JSON.parse(await readFile(join(directory, MANIFEST), "utf8")); }
  catch { throw new Error("Existing directory is not a managed demo export. Choose a new output directory."); }
  const actual = await outputManifest(directory);
  if (JSON.stringify(saved) !== JSON.stringify(actual)) throw new Error("Existing demo export contains changed or unexpected files. Preserve those changes and choose a new output directory.");
}

/** Generate before replacing; an error leaves the previous successful export intact. */
export async function writeDemoOutput(source: string, target: string, generate: (directory: string) => Promise<void>): Promise<string> {
  const output = await demoOutputPath(source, target);
  const lock = `${output}.lock`;
  try { await mkdir(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Another export holds ${lock}. If an earlier process stopped, remove that empty lock directory before retrying.`);
    throw error;
  }
  let staging: string | undefined;
  try {
    if (await exists(output)) await verifyExistingOutput(output);
    staging = await mkdtemp(join(dirname(output), `.${basename(output)}.tmp-`));
    await generate(staging);
    await writeFile(join(staging, MANIFEST), JSON.stringify(await outputManifest(staging), null, 2) + "\n");
    if (await exists(output)) {
      await verifyExistingOutput(output);
      const backup = `${staging}.previous`;
      await rename(output, backup);
      try { await rename(staging, output); }
      catch (error) { await rename(backup, output); throw error; }
      staging = undefined;
      await rm(backup, { recursive: true });
    } else {
      await rename(staging, output);
      staging = undefined;
    }
    return output;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    runtimePaths(SOURCE, process.cwd());
    const options = demoExportOptions(process.argv.slice(2));
    let config = FALLINGWATER_CONFIG;
    if (!options.showcase) {
      const configPath = process.env.HOMETRUTH_DEVICES ?? resolve("devices.yml");
      try { config = await loadDevicesConfig(configPath); }
      catch { throw new Error("Could not read valid devices.yml; configuration contents are withheld."); }
    }
    const output = await writeDemoOutput(SOURCE, resolve(options.output), async output => { await exportDemo({ ...options, config, output }); });
    console.log(`Static demo exported to ${output}. Serve this directory with a static host and open ${options.showcase ? "/" : options.basePath}.`);
    console.log(options.showcase ? "Public synthetic showcase; all names, readings, and controls are simulated." : options.includeNames ? "Display names are included; review the export before publishing." : "Display names and identifiers are anonymized; all controls are simulated.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Demo export failed.");
    process.exitCode = 1;
  }
}
