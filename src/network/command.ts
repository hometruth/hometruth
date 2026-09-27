/** Router scripts speak JSON on stdin/stdout; see docs/NETWORK_TOOLS.md. */
import { isIPv4 } from "node:net";
import { NetworkAdapterError, type NetworkAdapter, type NetworkAddressClient, type DnsRecordState, type PacketCaptureAdapter } from "./adapter";
import { validAdmissionMac, type AdmissionClient, type AdmissionWlan } from "./wifi-admission";

export const NETWORK_CAPABILITIES = ["addresses", "wifi", "dns", "internet", "capture", "admission"] as const;
export type NetworkCapability = typeof NETWORK_CAPABILITIES[number];
export interface NetworkScriptRequest { operation: string; input: Record<string, unknown> }
export interface CommandAdapterOptions {
  /** Executable and arguments, never evaluated by a shell. */
  readonly command: readonly string[];
  readonly capabilities: readonly NetworkCapability[];
  /** Stable router/site identity used to bind admission recovery snapshots. */
  readonly target?: string;
  readonly timeoutMs?: number;
  readonly env?: Record<string, string | undefined>;
  readonly run?: CommandRunner;
  readonly capture?: PacketCaptureAdapter;
}
export interface CommandResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string }
export type CommandRunner = (command: readonly string[], request: NetworkScriptRequest, timeoutMs: number,
  env: Record<string, string | undefined>) => Promise<CommandResult>;

export const runNetworkCommand: CommandRunner = async (command, request, timeoutMs, env) => {
  const proc = Bun.spawn([...command], { env, stdin: new Blob([JSON.stringify(request)]), stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (timedOut) throw new NetworkAdapterError(`Network script timed out during ${request.operation}; inspect the router before retrying a write`, "gateway_error");
    return { stdout, stderr, exitCode };
  } finally { clearTimeout(timer); }
};

function malformed(operation: string): never {
  throw new NetworkAdapterError(`Network script returned an invalid ${operation} result`, "gateway_error");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return malformed("object");
  return value as Record<string, unknown>;
}
function clients(value: unknown): NetworkAddressClient[] {
  if (!Array.isArray(value)) return malformed("clients.list");
  return value.map(value => {
    const row = object(value);
    if (typeof row.mac !== "string" || !validAdmissionMac(row.mac) || typeof row.address !== "string"
      || ["fixedAddress", "lastAddress", "hostname", "name", "apMac", "radio", "ssid", "network", "subnet"].some(key => row[key] !== undefined && typeof row[key] !== "string")
      || (row.connected !== undefined && typeof row.connected !== "boolean")
      || (row.vlan !== undefined && !Number.isInteger(row.vlan))) return malformed("clients.list");
    const optional = Object.fromEntries(["fixedAddress", "lastAddress", "hostname", "name", "apMac", "radio", "ssid", "network", "subnet", "vlan", "connected"]
      .flatMap(key => row[key] === undefined ? [] : [[key, row[key]]]));
    return { ...optional, mac: row.mac.toLowerCase(), address: row.connected === false ? "" : row.address };
  });
}
function state(value: unknown): DnsRecordState {
  if (value !== "on" && value !== "off" && value !== "missing") return malformed("status");
  return value;
}
function message(value: unknown): string {
  if (typeof value !== "string") return malformed("message");
  return value;
}
function wlans(value: unknown): AdmissionWlan[] {
  if (!Array.isArray(value)) return malformed("admission.wlans");
  return value.map(value => {
    const row = object(value);
    if (typeof row.id !== "string" || typeof row.ssid !== "string" || typeof row.enabled !== "boolean"
      || typeof row.filterEnabled !== "boolean" || typeof row.policy !== "string" || !Array.isArray(row.macs)
      || row.macs.some(mac => typeof mac !== "string" || !validAdmissionMac(mac))) return malformed("admission.wlans");
    return { id: row.id, ssid: row.ssid, enabled: row.enabled, filterEnabled: row.filterEnabled, policy: row.policy, macs: row.macs as string[] };
  });
}
function admissionClients(value: unknown): AdmissionClient[] {
  if (!Array.isArray(value)) return malformed("admission.clients");
  return value.map(value => {
    const row = object(value);
    if (typeof row.mac !== "string" || !validAdmissionMac(row.mac) || typeof row.ssid !== "string"
      || ["wlanId", "address", "name"].some(key => row[key] !== undefined && typeof row[key] !== "string")) return malformed("admission.clients");
    return { mac: row.mac.toLowerCase(), ssid: row.ssid,
      ...(typeof row.wlanId === "string" ? { wlanId: row.wlanId } : {}),
      ...(typeof row.address === "string" ? { address: row.address } : {}),
      ...(typeof row.name === "string" ? { name: row.name } : {}) };
  });
}

function commandCapture(options: CommandAdapterOptions): PacketCaptureAdapter {
  return { async start(client, sink, onEnd) {
    const proc = Bun.spawn([...options.command], { env: options.env ?? process.env,
      stdin: new Blob([JSON.stringify({ operation: "capture.start", input: { client } })]), stdout: "pipe", stderr: "pipe" });
    let stopping = false;
    const stderr = new Response(proc.stderr).text();
    const pump = (async () => {
      let failure: Error | undefined;
      try { for await (const chunk of proc.stdout) sink(chunk); }
      catch (error) { failure = error instanceof Error ? error : new Error(String(error)); proc.kill("SIGTERM"); }
      const code = await proc.exited;
      const detail = (await stderr).trim().slice(0, 300);
      if (!stopping) onEnd(failure ?? (code ? new Error(`Capture script exited ${code}: ${detail}`) : undefined));
    })();
    return { where: `${options.target ?? "network script"} (${client.mac})`, async stop() {
      stopping = true;
      proc.kill("SIGTERM");
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, 5000);
      try {
        await pump;
        if (timedOut) throw new NetworkAdapterError("Capture script did not finish cleanup; inspect the capture host", "gateway_error");
      } finally { clearTimeout(timer); }
    } };
  } };
}

export function createCommandAdapter(options: CommandAdapterOptions): NetworkAdapter {
  if (!options.command.length || options.command.some(part => typeof part !== "string" || !part.trim())) {
    throw new NetworkAdapterError("Network command must be a nonempty JSON array of executable and arguments", "not_configured");
  }
  if (!options.capabilities.length || options.capabilities.some(cap => !NETWORK_CAPABILITIES.includes(cap))) {
    throw new NetworkAdapterError(`Choose network capabilities from ${NETWORK_CAPABILITIES.join(", ")}`, "not_configured");
  }
  if (options.capabilities.includes("admission") && !options.target?.trim()) {
    throw new NetworkAdapterError("Admission requires HOMETRUTH_NETWORK_TARGET to identify the router and site", "not_configured");
  }
  const call = async (operation: string, input: Record<string, unknown> = {}): Promise<unknown> => {
    const result = await (options.run ?? runNetworkCommand)(options.command, { operation, input }, options.timeoutMs ?? 30_000, options.env ?? process.env);
    if (result.exitCode !== 0) throw new NetworkAdapterError(`Network script failed during ${operation} (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 300)}`, "gateway_error");
    try { return JSON.parse(result.stdout); } catch { return malformed(operation); }
  };
  const list = async () => clients(await call("clients.list"));
  const has = (cap: NetworkCapability) => options.capabilities.includes(cap);
  return {
    name: "command",
    ...(has("addresses") ? { addresses: { list, async reserve(mac: string, address: string) {
      if (!validAdmissionMac(mac) || !isIPv4(address)) throw new NetworkAdapterError("Provide a valid MAC and IPv4 address", "not_supported");
      mac = mac.toLowerCase();
      const result = object(await call("addresses.reserve", { mac, address }));
      if (result.undo === undefined || result.undo === null) return malformed("addresses.reserve undo token");
      const undo = async () => { await call("addresses.restore", { mac, undo: result.undo }); };
      try {
        if ((await list()).find(client => client.mac === mac.toLowerCase())?.fixedAddress !== address) {
          throw new NetworkAdapterError("The router did not retain the requested reservation", "gateway_error");
        }
      } catch (error) {
        try { await undo(); } catch { throw new NetworkAdapterError("Reservation verification and restoration failed; inspect this device on the router", "gateway_error"); }
        throw error;
      }
      return undo;
    } } } : {}),
    ...(has("wifi") ? { wifi: {
      async findClientByMac(mac: string) { return (await list()).find(client => client.mac === mac.toLowerCase()); },
      async findClientByAddress(address: string) { return (await list()).find(client => [client.address, client.fixedAddress, client.lastAddress].includes(address)); },
      async kickClient(client) { await call("wifi.kick", { client }); },
    } satisfies NonNullable<NetworkAdapter["wifi"]> } : {}),
    ...(has("dns") ? { dns: {
      async describe(target) { return state(await call("dns.status", { ...target })); },
      async set(target, action) { return message(await call("dns.set", { ...target, action })); },
    } satisfies NonNullable<NetworkAdapter["dns"]> } : {}),
    ...(has("internet") ? { internet: {
      async describe(target) { return state(await call("internet.status", { ...target })); },
      async set(target, action) { return message(await call("internet.set", { ...target, action })); },
    } satisfies NonNullable<NetworkAdapter["internet"]> } : {}),
    ...(has("capture") ? { capture: options.capture ?? commandCapture(options) } : {}),
    ...(has("admission") ? { admission: { target: options.target!, api: {
      async listWlans() { return wlans(await call("admission.wlans")); },
      async listAdmissionClients() { return admissionClients(await call("admission.clients")); },
      async setMacFilter(id: string, enabled: boolean, macs?: string[]) { await call("admission.set-filter", { id, enabled, ...(macs ? { macs } : {}) }); },
    } } } : {}),
  };
}

export function commandOptionsFromEnv(env: Record<string, string | undefined> = process.env): CommandAdapterOptions {
  let command: unknown;
  try { command = JSON.parse(env.HOMETRUTH_NETWORK_COMMAND ?? ""); } catch { /* report configuration error below */ }
  if (!Array.isArray(command) || !command.length || command.some(part => typeof part !== "string" || !part.trim())) {
    throw new NetworkAdapterError("Set HOMETRUTH_NETWORK_COMMAND to a JSON array, e.g. [\"python3\",\"/path/to/router.py\"]", "not_configured");
  }
  const capabilities = (env.HOMETRUTH_NETWORK_CAPABILITIES ?? "").split(",").map(value => value.trim()) as NetworkCapability[];
  const timeoutMs = Number(env.HOMETRUTH_NETWORK_COMMAND_TIMEOUT_MS ?? 30_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new NetworkAdapterError("Network command timeout must be a positive integer", "not_configured");
  return { command, capabilities, timeoutMs, env, ...(env.HOMETRUTH_NETWORK_TARGET ? { target: env.HOMETRUTH_NETWORK_TARGET } : {}) };
}
