/** bun src/vendors/hue/discover.ts [--apply] */
import { readFile, writeFile, rename } from "node:fs/promises";
import { parseDevicesConfig } from "../../config/devices";
import { FileSecretStore, secretsFor } from "../../config/secrets";
import { HueClipClient } from "./clip-client";
import { discoverHueDevices } from "./discovery";
import { Site } from "../../site";
import { createHueSiteService } from "./site-service";

const path = process.env.HOMETRUTH_DEVICES ?? "devices.yml";
const original = await readFile(path, "utf8");
const config = parseDevicesConfig(original, path);
const secrets = await new FileSecretStore().load();
const hue = secretsFor(secrets, "vendors", "hue");
if (typeof hue.host !== "string" || typeof hue.applicationKey !== "string") throw new Error("Configure vendors.hue.host and applicationKey first");
const clip = new HueClipClient({ host: hue.host, applicationKey: hue.applicationKey });
const inventory = await discoverHueDevices(clip, config.devices);
const additions = inventory.filter(item => !item.configured && item.entry).map(item => item.entry!);
if (process.argv.includes("--apply") && additions.length) {
  // Append entries to the final devices list, retaining comments and existing ids.
  // Confirm the parsed result before replacing the file; refuse unexpected YAML layouts.
  const updated = original.trimEnd() + "\n\n  # Discovered from the Hue bridge\n" + additions.map(entry => `  - ${JSON.stringify(entry)}\n`).join("");
  const parsed = parseDevicesConfig(updated, path);
  if (JSON.stringify(parsed.devices) !== JSON.stringify([...(config.devices ?? []), ...additions])) throw new Error("Cannot safely append to this YAML layout");
  const service = createHueSiteService(secrets);
  const validation = Site.fromConfig({ schemaVersion: 2, devices: additions }, service ? { hue: service } : {}, secrets);
  if (validation.devices.length !== additions.length) throw new Error("Hue device validation failed");
  if (await readFile(path, "utf8") !== original) throw new Error("Device config changed during discovery; rerun");
  const temporary = `${path}.hue-${process.pid}.tmp`;
  await writeFile(temporary, updated, { mode: 0o600 });
  await rename(temporary, path);
}
console.log(JSON.stringify({ added: process.argv.includes("--apply") ? additions.length : 0, discovered: inventory.length, devices: inventory }, null, 2));
