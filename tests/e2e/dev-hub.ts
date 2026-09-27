import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testValidators } from "./validation";

export async function resolveDevHubURL(): Promise<string> {
  if (process.env.DEV_HUB_URL) return process.env.DEV_HUB_URL.replace(/\/$/, "");

  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const discoveryFile = process.env.DEV_HUB_DISCOVERY_FILE
    ?? join(tmpdir(), `bun-hono-dev-hub-${uid}`, "hub.json");
  const value: unknown = JSON.parse(await readFile(discoveryFile, "utf8"));

  if (!testValidators.hubDiscovery(value)) {
    throw new Error(`Invalid Dev Hub discovery document: ${discoveryFile}`);
  }
  return value.url.replace(/\/$/, "");
}
