import { isIPv4 } from "node:net";
import { resolve } from "node:path";
import Ajv from "ajv";
import type { SecretsFile } from "../../schemas";

export interface LightPatch {
  on?: boolean;
  brightnessPercent?: number;
  color?: string;
  colorTemperatureKelvin?: number;
  transitionMs?: number;
}
export interface HueEvent {
  id: string;
  at: string;
  type: "light" | "resource" | "request";
  origin: "bridge" | "entertainment" | "proxy";
  source: string;
  state?: LightPatch;
  changed?: LightPatch;
  data?: unknown;
}
export interface Target {
  id: string;
  kind: "hometruth" | "wled" | "webhook" | "mqtt";
  url: string;
  deviceId?: string;
  segment?: number;
  tokenEnv?: string;
  usernameEnv?: string;
  passwordEnv?: string;
  topic?: string;
  minIntervalMs?: number;
}
export interface Route {
  id: string;
  sources: string[];
  targets: string[];
  /** Color-only is useful for lights whose power is controlled separately. */
  fields?: ("on" | "brightnessPercent" | "color" | "colorTemperatureKelvin")[];
  brightnessScale?: number;
  saturationGain?: number;
  gamma?: number;
  /** Fixed override, e.g. make a Hue light trigger an accent color. */
  color?: string;
}
export interface ProxyConfig {
  listen: { host: string; advertiseAddress: string; httpPort: number; httpsPort: number; discovery: boolean };
  bridge: { url: string; applicationKeyEnv?: string; clientKeyEnv?: string; verifyTls: boolean };
  name: string;
  stateDirectory: string;
  monitor: { enabled: boolean; pollIntervalMs: number; reconnectMs: number };
  entertainment: { enabled: boolean; port: number; upstreamPort: number; helperPath: string; idleTimeoutMs: number };
  targets: Target[];
  routes: Route[];
}

const str = { type: "string", minLength: 1, maxLength: 2048 };
const port = { type: "integer", minimum: 1, maximum: 65535 };
const milliseconds = { type: "integer", minimum: 100, maximum: 600_000 };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", additionalProperties: false, properties, required });
const validate = new Ajv({ allErrors: true, useDefaults: true }).compile(object({
  name: { ...str, maxLength: 32, default: "HomeTruth Hue" },
  stateDirectory: { ...str, default: ".hometruth/hue-proxy" },
  listen: { ...object({ host: { ...str, default: "0.0.0.0" }, advertiseAddress: str, httpPort: { ...port, default: 80 }, httpsPort: { ...port, default: 443 }, discovery: { type: "boolean", default: true } }, ["advertiseAddress"]), default: {} },
  bridge: object({ url: str, applicationKeyEnv: str, clientKeyEnv: str, verifyTls: { type: "boolean", default: false } }, ["url"]),
  monitor: { ...object({ enabled: { type: "boolean", default: true }, pollIntervalMs: { ...milliseconds, minimum: 1000, default: 10_000 }, reconnectMs: { ...milliseconds, default: 2000 } }), default: {} },
  entertainment: { ...object({ enabled: { type: "boolean", default: true }, port: { ...port, default: 2100 }, upstreamPort: { ...port, default: 2100 }, helperPath: { ...str, default: ".hometruth/hue-proxy/dtls" }, idleTimeoutMs: { ...milliseconds, minimum: 5000, default: 15_000 } }), default: {} },
  targets: { type: "array", maxItems: 100, default: [], items: object({ id: str, kind: { enum: ["hometruth", "wled", "webhook", "mqtt"] }, url: str, deviceId: str, segment: { type: "integer", minimum: 0, maximum: 255 }, tokenEnv: str, usernameEnv: str, passwordEnv: str, topic: str, minIntervalMs: { type: "integer", minimum: 0, maximum: 60_000 } }, ["id", "kind", "url"]) },
  routes: { type: "array", maxItems: 100, default: [], items: object({ id: str, sources: { type: "array", minItems: 1, maxItems: 256, items: str }, targets: { type: "array", minItems: 1, items: str }, fields: { type: "array", minItems: 1, uniqueItems: true, items: { enum: ["on", "brightnessPercent", "color", "colorTemperatureKelvin"] } }, brightnessScale: { type: "number", minimum: 0, maximum: 10 }, saturationGain: { type: "number", minimum: 0, maximum: 5 }, gamma: { type: "number", minimum: 0.1, maximum: 5 }, color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" } }, ["id", "sources", "targets"]) },
}, ["bridge", "listen"]));

export function parseProxyConfig(input: unknown): ProxyConfig {
  const candidate = structuredClone(input);
  if (!validate(candidate)) throw new Error(`Invalid Hue proxy config: ${new Ajv().errorsText(validate.errors)}`);
  const config = candidate as unknown as ProxyConfig;
  if (!isIPv4(config.listen.advertiseAddress) || !isIPv4(config.listen.host)) throw new Error("Hue proxy listen and advertised addresses must be IPv4 addresses");
  if (config.listen.httpPort === config.listen.httpsPort) throw new Error("Hue proxy HTTP and HTTPS ports must differ");
  const bridge = new URL(config.bridge.url);
  if (!["http:", "https:"].includes(bridge.protocol) || bridge.username || bridge.password || bridge.pathname !== "/" || bridge.search || bridge.hash) throw new Error("bridge.url must be an HTTP(S) origin without credentials");
  if (!isIPv4(bridge.hostname) || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/u.test(bridge.hostname)) throw new Error("bridge.url must use the real bridge's private IPv4 address");
  if ([config.listen.host, config.listen.advertiseAddress, "127.0.0.1"].includes(bridge.hostname) && [config.listen.httpPort, config.listen.httpsPort].includes(Number(bridge.port || (bridge.protocol === "https:" ? 443 : 80)))) throw new Error("The upstream bridge points back at the proxy");
  const ids = new Set<string>();
  for (const target of config.targets) {
    if (ids.has(target.id)) throw new Error(`Duplicate target: ${target.id}`);
    ids.add(target.id);
    const url = new URL(target.url);
    if (!(target.kind === "mqtt" ? ["mqtt:", "mqtts:"] : ["http:", "https:"]).includes(url.protocol) || url.username || url.password || url.hash) throw new Error(`Invalid URL for target ${target.id}; use environment variables for credentials`);
    if (url.origin === bridge.origin && target.kind !== "mqtt") throw new Error(`Target ${target.id} points at the source bridge and would create a feedback loop`);
    if (target.kind === "hometruth" && !target.deviceId) throw new Error(`Target ${target.id} needs deviceId`);
    if (target.kind === "mqtt" && (!target.topic || /[+#\0]/u.test(target.topic))) throw new Error(`Target ${target.id} needs a publish topic without wildcards`);
  }
  const routes = new Set<string>();
  for (const route of config.routes) {
    if (routes.has(route.id)) throw new Error(`Duplicate route: ${route.id}`);
    routes.add(route.id);
    for (const id of route.targets) if (!ids.has(id)) throw new Error(`Route ${route.id} references unknown target ${id}`);
    for (const source of route.sources) if (!/^(\*|(?:light|light-v1|entertainment|resource|request)\/[^\s]+)$/u.test(source)) throw new Error(`Invalid source in route ${route.id}`);
  }
  config.bridge.url = bridge.origin;
  return config;
}

export async function loadProxyConfig(path: string): Promise<ProxyConfig> {
  return parseProxyConfig(Bun.YAML.parse(await Bun.file(path).text()));
}
export function environmentSecret(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const value = process.env[name];
  if (!value) throw new Error(`Required environment variable ${name} is missing`);
  return value;
}
export async function bridgeCredentials(config: ProxyConfig, secrets?: SecretsFile): Promise<{ applicationKey: string; clientKey?: string }> {
  let saved: Readonly<Record<string, unknown>> = {};
  if (!config.bridge.applicationKeyEnv) {
    const { FileSecretStore, secretsFor } = await import("../../config/secrets");
    saved = secretsFor(secrets ?? await new FileSecretStore().load(), "vendors", "hue");
  }
  const applicationKey = environmentSecret(config.bridge.applicationKeyEnv) ?? (typeof saved.applicationKey === "string" ? saved.applicationKey : undefined);
  // A client key is tied to one username, never borrow it for an env-supplied key.
  const clientKey = environmentSecret(config.bridge.clientKeyEnv) ?? (typeof saved.clientKey === "string" ? saved.clientKey : undefined);
  if (!applicationKey || /[\r\n]/u.test(applicationKey)) throw new Error("Set bridge.applicationKeyEnv or vendors.hue.applicationKey in the HomeTruth secrets file");
  if (!config.bridge.applicationKeyEnv && saved.host !== new URL(config.bridge.url).hostname) throw new Error("The saved Hue credentials belong to a different host; set bridge.applicationKeyEnv explicitly");
  if (clientKey && !/^[a-f\d]{32}$/iu.test(clientKey)) throw new Error("The Hue client key must be 32 hexadecimal characters");
  config.stateDirectory = resolve(config.stateDirectory);
  return { applicationKey, ...(clientKey ? { clientKey } : {}) };
}
