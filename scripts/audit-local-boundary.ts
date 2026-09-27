#!/usr/bin/env bun
/** Compare release trees against locally known secrets/identifiers without printing values. */
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const [source, publicDirectory, privateDirectory] = process.argv.slice(2);
if (!source || !publicDirectory || !privateDirectory) throw new Error("Usage: audit-local-boundary.ts <private-installation> <public-tree> <private-tree>");
const credentials = new Set<string>();
const identities = new Set<string>();
// Public firmware defaults are already protocol documentation, not private values.
const factoryDefaults = new Set(["admin", "thingino"]);
function collect(value: unknown, key = "", sensitive = false) {
  if (Array.isArray(value)) value.forEach(item => collect(item, key, sensitive));
  else if (value && typeof value === "object") {
    for (const [name, item] of Object.entries(value)) collect(item, name, sensitive || /password|passwd|secret|token|key|credential|^psk$|^pin$/i.test(name));
  } else if (typeof value === "string" && value.length >= 4) {
    if (sensitive && !/Path$/.test(key) && !factoryDefaults.has(value)) credentials.add(value);
    if (/^(mac|serialNumber|peripheralId|homekitId|locationId|zid|lightId|cameraId|IOT_WIFI_NETWORK)$/.test(key) && value.length >= 8) identities.add(value);
  }
}
async function read(path: string) {
  const file = Bun.file(resolve(source!, path));
  if (!(await file.exists())) return;
  let value: unknown;
  try {
    const text = await file.text();
    value = path.startsWith(".env") ? parseEnv(text) : path.endsWith(".json") ? JSON.parse(text) : Bun.YAML.parse(text);
  } catch { throw new Error(`Cannot safely parse ${path}; contents withheld`); }
  collect(value);
}
for (const path of [".env", ".env.local", "devices.yml", ".hometruth/secrets.yml", ".hometruth/local-camera-auth.json", ".hometruth/camera-setup.json"]) await read(path);
const failures: string[] = [];
async function inspect(root: string, directory: string, personal: boolean) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    // Installed dependencies are not release content; the index gate rejects them.
    if (item.name === ".git" || item.name === "node_modules") continue;
    const path = resolve(directory, item.name);
    if (item.isSymbolicLink()) throw new Error("Symlinks are not permitted in release trees");
    if (item.isDirectory()) await inspect(root, path, personal);
    else if (item.isFile()) {
      const text = await Bun.file(path).text();
      const credential = [...credentials].some(value => text.includes(value));
      const identity = personal && [...identities].some(value => text.includes(value));
      if (credential || identity) failures.push(`${personal ? "public" : "private"}/${path.slice(root.length + 1)}: known local ${credential ? "credential" : "device identity"}`);
    }
  }
}
for (const [directory, personal] of [[publicDirectory, true], [privateDirectory, false]] as const) await inspect(resolve(directory), resolve(directory), personal);
if (failures.length) { console.error(failures.join("\n")); process.exitCode = 1; }
else console.log(`Local comparison passed (${credentials.size} credential values, ${identities.size} device identities; values withheld).`);
