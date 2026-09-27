#!/usr/bin/env bun
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { UniFiClient } from "../../network/unifi";
import { emulatorDirectory, initialize, readConfig, savePrivate, type ZephyrConfig } from "./files";
import { ZephyrRouting, type RouteReceipt } from "./routing";
import { lookupGatewayDns, verifyDnsEventually } from "./dns";

const usage = `Zephyr local cloud emulator
  init <hood-mac> <hood-ip> <mac-lan-ip>    Generate private config and lab certificate (no server)
  serve [--route]                        Start TLS MQTT + loopback control API; --route redirects DNS
  status                                 Read connection stages, shadow, and actual device reports
  set '{"fan":1}'                        Send a manual command; model limits are not yet verified
  route on|off|status                     Manage only the captured cloud hostname

The user must run serve in their own terminal. No service or watcher is installed.
ZEPHYR_EMULATOR_DIR overrides the private configuration directory.
`;

async function admin(config: ZephyrConfig, path = "/status", patch?: unknown): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${config.adminPort}${path}`, {
    method: patch === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${config.adminToken}`, "Content-Type": "application/json" },
    ...(patch === undefined ? {} : { body: JSON.stringify(patch) }), signal: AbortSignal.timeout(5000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`Emulator HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function router(directory: string, config: ZephyrConfig): Promise<ZephyrRouting> {
  const secrets = Bun.YAML.parse(await readFile(process.env.HOMETRUTH_SECRETS ?? ".hometruth/secrets.yml", "utf8")) as any;
  const unifi = secrets.network?.unifi;
  if (typeof unifi?.apiKey !== "string") throw new Error("UniFi API key is required in network.unifi in the secrets file");
  const api = new UniFiClient({ apiKey: unifi.apiKey,
    ...(typeof unifi.baseUrl === "string" ? { baseUrl: unifi.baseUrl } : {}),
    ...(typeof unifi.siteId === "string" ? { siteId: unifi.siteId } : {}),
    ...(typeof unifi.siteName === "string" ? { siteName: unifi.siteName } : {}),
    skipTlsVerify: unifi.skipTlsVerify === true,
  });
  const receiptFile = join(directory, "route.json");
  return new ZephyrRouting({ api, config,
    load: async () => {
      try { return JSON.parse(await readFile(receiptFile, "utf8")) as RouteReceipt; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    },
    save: receipt => receipt ? savePrivate(receiptFile, receipt) : rm(receiptFile, { force: true }),
    verifyResolution: async () => {
      const gateway = new URL(unifi.baseUrl ?? "https://192.168.1.1").hostname;
      await verifyDnsEventually(() => lookupGatewayDns(gateway, config.cloudHost), config.listenIp);
    },
    preflight: async () => {
      if (!Object.values(networkInterfaces()).flat().some(iface => iface?.address === config.listenIp)) throw new Error("This Mac's LAN IP changed; correct config.json before routing");
      const status = await admin(config);
      if (status.service !== "zephyr-emulator" || !status.listening || status.listenIp !== config.listenIp || status.deviceIp !== config.deviceIp || status.mqttPort !== 8883) throw new Error("Start the matching Zephyr emulator before enabling DNS");
      const clients = await api.listClients();
      const hood = clients.find(client => client.mac.toLowerCase() === config.deviceMac);
      if (hood?.address !== config.deviceIp) throw new Error("Router does not currently associate the configured hood MAC with its expected IP; refresh config first");
    },
  });
}

export async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "help") { console.log(usage); return; }
  const directory = emulatorDirectory();
  if (command === "init" && rest.length === 3) {
    await initialize(directory, rest[0]!.toLowerCase(), rest[1]!, rest[2]!);
    console.log(`Prepared ${directory}. Lab certificate trust is unverified. No listener or DNS change started.`);
    return;
  }
  const config = await readConfig(directory);
  if (command === "status" && !rest.length) { console.log(JSON.stringify(await admin(config), null, 2)); return; }
  if (command === "set" && rest.length === 1) { console.log(JSON.stringify(await admin(config, "/command", JSON.parse(rest[0]!)), null, 2)); return; }
  if (command === "route" && rest.length === 1 && ["on", "off", "status"].includes(rest[0]!)) {
    const routing = await router(directory, config);
    if (rest[0] === "status") console.log(JSON.stringify(await routing.status(), null, 2));
    else { await routing[rest[0] as "on" | "off"](); console.log(`Zephyr DNS route ${rest[0]}`); }
    return;
  }
  if (command !== "serve" || rest.length > 1 || (rest.length && rest[0] !== "--route")) throw new Error(usage);
  const routing = rest[0] === "--route" ? await router(directory, config) : undefined;
  const { startZephyrServer } = await import("./server");
  const server = await startZephyrServer(directory, config);
  let stopping = false;
  let activating = Promise.resolve();
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    // Restore DNS while the listener is still available; then close listeners.
    await activating.catch(() => undefined);
    try { await routing?.off(); }
    catch (error) { console.error(`DNS restore failed; run 'route off': ${String(error)}`); process.exitCode = 1; }
    await server.close();
  };
  const onSignal = () => { void stop().catch(error => { console.error(String(error)); process.exitCode = 1; }); };
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
  try {
    activating = routing?.on() ?? Promise.resolve();
    await activating;
    if (stopping) return;
    console.log(`Zephyr TLS MQTT listening on ${config.listenIp}:8883; local API on 127.0.0.1:${config.adminPort}.`);
    console.log(`Private connection and MQTT journal: ${join(directory, "traffic.jsonl")}`);
    console.log(routing ? "DNS redirected. Existing cloud sessions may persist until the hood reconnects. Ctrl-C restores DNS." : "DNS unchanged. Enable with 'route on' after verifying the listener.");
    console.log("Waiting for the hood. A self-signed certificate may be rejected before MQTT; status will show the connection stage.");
  } catch (error) { await stop(); throw error; }
}

if (import.meta.main) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
