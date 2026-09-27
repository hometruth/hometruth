#!/usr/bin/env bun
/** Validate a private installation, or run an explicitly requested command with its config. */
import { resolve } from "node:path";
import { lstat } from "node:fs/promises";
import { assertCredentialFree } from "../src/config/repository-safety";
import { parseDevicesConfig } from "../src/config/devices";
import { parseProxyConfig } from "../src/integrations/hue-proxy/config";
import { parseKindleConfig } from "../src/kindle/config";
import { parseDogConfig } from "../src/automations/dog-config";
import { runtimePaths } from "../src/runtime/paths";
import { parsePublicOrigin } from "../src/runtime/listener-config";

const SOURCE_ROOT = resolve(import.meta.dir, "..");
const COMMANDS: Record<string, { entry: string; args?: string[] }> = {
  dev: { entry: "src/index.ts", args: ["--watch"] },
  start: { entry: "src/index.ts" },
  ht: { entry: "src/ht/index.ts" },
  "local-action": { entry: "scripts/local-action.ts" },
  camera: { entry: "src/vendors/tkenpro/cli.ts" },
  network: { entry: "scripts/network.ts" },
  "hue:discover": { entry: "src/vendors/hue/discover.ts" },
  "ring:discover": { entry: "src/vendors/ring/discover.ts" },
  reveal: { entry: "src/vendors/reveal/cli.ts" },
  "matter:status": { entry: "src/integrations/matter/service.ts", args: ["status"] },
  "matter:pair": { entry: "src/integrations/matter/service.ts", args: ["pair"] },
  "hue:proxy": { entry: "src/integrations/hue-proxy/main.ts" },
  "hue:proxy:build": { entry: "src/integrations/hue-proxy/build-dtls.ts" },
};

export const SITE_ENVIRONMENT_KEYS = new Set([
  "HOST", "PORT", "NODE_ENV", "DEV_HUB", "HOMETRUTH_THEME", "HOMETRUTH_SCHEME", "HOMETRUTH_LOCALE",
  "MQTT_HOST", "MQTT_PORT",
  "HOMETRUTH_TRUST_LAN", "HOMETRUTH_PUBLIC_ORIGIN", "HOMETRUTH_MATTER_ENABLED", "HOMETRUTH_MATTER_PORT", "HOMETRUTH_MATTER_POLL_MS",
  "HOMETRUTH_LOCAL_CLOUD_ADDRESS", "HOMETRUTH_NETWORK_ADAPTER", "UNIFI_BASE_URL", "UNIFI_SITE_ID",
  "HOMETRUTH_ISOLATION_LISTEN_HOST", "HOMETRUTH_ISOLATION_RECONCILE_ON_START",
  "UNIFI_SITE_NAME", "UNIFI_SKIP_TLS_VERIFY",
]);
const CONFIG_PATHS: Record<string, string> = {
  "devices.yml": "HOMETRUTH_DEVICES", "hue-proxy.yml": "HUE_PROXY_CONFIG",
  "kindle.json": "HOMETRUTH_KINDLE_CONFIG", "dog-announcer.json": "HOMETRUTH_DOG_CONFIG",
};

export async function siteEnvironment(directory: string): Promise<Record<string, string>> {
  const root = runtimePaths(SOURCE_ROOT, directory).installation;
  const env: Record<string, string> = {};
  for (const name of ["site.json", ...Object.keys(CONFIG_PATHS)]) {
    const file = Bun.file(resolve(root, name));
    if (!(await file.exists())) {
      if (name === "site.json" || name === "devices.yml") throw new Error(`Missing ${name}`);
      continue;
    }
    if ((await lstat(file.name!)).isSymbolicLink()) throw new Error(`${name} must not be a symlink`);
    let value: unknown;
    try { value = name.endsWith(".json") ? await file.json() : Bun.YAML.parse(await file.text()); }
    catch { throw new Error(`Invalid ${name}; file contents are withheld`); }
    assertCredentialFree(value, name);
    if (name === "site.json") {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "environment")) throw new Error("site.json must contain only environment");
      const environment = (value as { environment?: unknown }).environment;
      if (!environment || typeof environment !== "object" || Array.isArray(environment)) throw new Error("site.json requires environment");
      for (const [key, setting] of Object.entries(environment)) {
        if (!SITE_ENVIRONMENT_KEYS.has(key) || typeof setting !== "string" || /[\r\n\0]/.test(setting)) throw new Error(`Unsupported site environment setting: ${key}`);
        env[key] = setting;
      }
    } else {
      try {
        if (name === "devices.yml") parseDevicesConfig(await file.text());
        if (name === "hue-proxy.yml") parseProxyConfig(value);
        if (name === "kindle.json") parseKindleConfig(value);
        if (name === "dog-announcer.json") parseDogConfig(value);
      } catch { throw new Error(`Invalid ${name}; file contents are withheld`); }
      env[CONFIG_PATHS[name]!] = resolve(root, name);
    }
  }
  parsePublicOrigin(env.HOMETRUTH_PUBLIC_ORIGIN);
  return env;
}

/** Build a launch request without running any service; useful for validation and tooling. */
export async function siteCommand(directory: string, command: string, args: string[] = []) {
  const target = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!target) throw new Error(`Unknown installation command: ${command}`);
  const cwd = runtimePaths(SOURCE_ROOT, directory).installation;
  const env = await siteEnvironment(cwd);
  return { cwd, env, argv: [process.execPath, resolve(SOURCE_ROOT, target.entry), ...(target.args ?? []), ...args] };
}

if (import.meta.main) {
  try {
    const [directory, command = "check", ...args] = process.argv.slice(2);
    if (!directory || (command !== "check" && !Object.hasOwn(COMMANDS, command))) throw new Error(`Usage: bun run site <private-repo> <check|${Object.keys(COMMANDS).join("|")}> [arguments]`);
    if (command === "check") {
      await siteEnvironment(directory);
      console.log("Installation configuration is valid; no credential fields or credential-bearing URLs found.");
    }
    else {
      const launch = await siteCommand(directory, command, args);
      const child = Bun.spawn(launch.argv, {
        cwd: launch.cwd, env: { ...process.env, ...launch.env }, stdin: "inherit", stdout: "inherit", stderr: "inherit",
      });
      for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
      process.exit(await child.exited);
    }
  } catch (error) { console.error(error instanceof Error ? error.message : "Installation check failed"); process.exitCode = 1; }
}
