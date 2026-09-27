import { open } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { FileSecretStore } from "../config/secrets";
import { createNetworkAdapter, NetworkAdapterError, type NetworkAdapter, type WifiClient } from "./index";
import { networkEnvironment } from "./config";
import { NETWORK_CAPABILITIES } from "./command";
import { validAdmissionMac } from "./wifi-admission";

export const NETWORK_TOOLS_HELP = `Network Tools — run from the HomeTruth checkout with bun run network
  capabilities                                      configured provider and supported operations
  clients                                           wired and wireless client inventory
  find <mac-or-ip>                                   one client by stable MAC or IP
  reserve <mac> <ip>                                 save and verify a router DHCP reservation
  save <device-id> <mac> <ip>                         save router + HomeTruth settings via the running server
  reconnect <mac-or-ip>                              reconnect a Wi-Fi client
  dns status|on|off <hostname> <server-ip>             inspect or change a DNS override
  internet status|on|off <mac> <label>                 inspect or change an internet block
  capture <mac-or-ip> <seconds> <output.pcap>         bounded packet capture (1..600 seconds)
  accept-next <ssid> [--timeout <seconds>] [--dry-run] admit one new Wi-Fi client
  accept-next <ssid> --recover                       restore a saved admission window
All commands print JSON. Provider selection and custom script contract: docs/NETWORK_TOOLS.md.
`;
export interface NetworkToolsDependencies {
  adapter?: NetworkAdapter;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}
function required<T>(value: T | undefined, capability: string): T {
  if (!value) throw new NetworkAdapterError(`This network provider does not support ${capability}`, "not_supported");
  return value;
}
function count(args: string[], expected: number): void {
  if (args.length !== expected) throw new Error(`Expected ${expected} arguments. Use bun run network help.`);
}
function mac(value: string): string {
  if (!validAdmissionMac(value)) throw new Error("Provide a valid unicast MAC address");
  return value.toLowerCase();
}
function ip(value: string): string {
  if (!isIPv4(value)) throw new Error("Provide a valid IPv4 address");
  return value;
}
async function find(adapter: NetworkAdapter, identity: string): Promise<WifiClient> {
  const isMac = validAdmissionMac(identity);
  if (!isMac) ip(identity);
  const matches = adapter.addresses ? (await adapter.addresses.list()).filter(client => isMac
    ? client.mac.toLowerCase() === identity.toLowerCase()
    : [client.address, client.fixedAddress, client.lastAddress].includes(identity)) : [];
  if (matches.length > 1) throw new Error("Multiple clients match this address; use a MAC address");
  let client = matches[0];
  if (!adapter.addresses) {
    const wifi = required(adapter.wifi, "client lookup");
    client = isMac ? await required(wifi.findClientByMac?.bind(wifi), "MAC lookup")(identity) : await wifi.findClientByAddress(identity);
  }
  if (!client) throw new Error(`No network client matches ${identity}`);
  return client;
}

/** Shared script entrypoint; never starts HomeTruth or requires a device model. */
export async function runNetworkTools(argv: string[], dependencies: NetworkToolsDependencies = {}): Promise<unknown> {
  const [command = "help", ...args] = argv;
  if (command === "help" || command === "--help") return NETWORK_TOOLS_HELP;
  const env = dependencies.env ?? process.env;
  // Saving an enrolled device uses the exact same transactional path as Settings.
  if (command === "save") {
    count(args, 3);
    const [id, identity, address] = args as [string, string, string];
    const body = { mac: mac(identity), address: ip(address) };
    const base = (env.HOMETRUTH_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
    const response = await (dependencies.fetch ?? fetch)(`${base}/api/devices/${encodeURIComponent(id)}/network/settings`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
    });
    const result = await response.json() as { message?: string; error?: { message?: string } };
    if (!response.ok) throw new Error(result.error?.message ?? result.message ?? `HomeTruth settings save failed (${response.status})`);
    return result;
  }
  if (command === "accept-next") {
    const ssid = args.shift();
    if (!ssid?.trim()) throw new Error("Provide an SSID");
    let timeoutMs = 180_000, dryRun = false, recover = false;
    while (args.length) {
      const flag = args.shift();
      if (flag === "--timeout") timeoutMs = Number(args.shift()) * 1000;
      else if (flag === "--dry-run") dryRun = true;
      else if (flag === "--recover") recover = true;
      else throw new Error(`Unknown admission option: ${flag}`);
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 600_000 || (dryRun && recover)) throw new Error("Use a timeout of 10..600 seconds; --recover and --dry-run are separate operations");
    return (await import("./wifi-admission-command")).runWifiAdmissionCommand({ ssid, timeoutMs, dryRun, recover }, env, console.error, dependencies.signal);
  }
  if (!["capabilities", "clients", "find", "reserve", "reconnect", "dns", "internet", "capture"].includes(command)) throw new Error(`Unknown network tool: ${command}`);
  const adapter = dependencies.adapter ?? createNetworkAdapter(networkEnvironment(await new FileSecretStore(env.HOMETRUTH_SECRETS).load(), env));
  switch (command) {
    case "capabilities": count(args, 0); return { provider: adapter.name, capabilities: NETWORK_CAPABILITIES.filter(cap => Boolean(adapter[cap])) };
    case "clients": count(args, 0); return required(adapter.addresses, "client inventory").list();
    case "find": count(args, 1); return find(adapter, args[0]!);
    case "reserve": {
      count(args, 2);
      const identity = mac(args[0]!), address = ip(args[1]!);
      await required(adapter.addresses, "DHCP reservations").reserve(identity, address);
      return { mac: identity, address, message: "DHCP reservation saved and verified. The client will use it after renewing its lease." };
    }
    case "reconnect": {
      count(args, 1);
      const wifi = required(adapter.wifi, "Wi-Fi reconnect");
      const client = await find(adapter, args[0]!);
      await wifi.kickClient(client);
      return { mac: client.mac, message: "Wi-Fi reconnect requested" };
    }
    case "dns":
    case "internet": {
      count(args, 3);
      const [action, identity, value] = args as [string, string, string];
      if (action !== "status" && action !== "on" && action !== "off") throw new Error("Use status, on, or off");
      if (command === "dns") {
        if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$/i.test(identity)) throw new Error("Provide a valid DNS hostname");
        const dns = required(adapter.dns, "DNS overrides"), target = { domain: identity, overrideIp: ip(value) };
        return action === "status" ? { state: await dns.describe(target) } : { message: await dns.set(target, action) };
      }
      const internet = required(adapter.internet, "internet blocking"), target = { mac: mac(identity), label: value };
      return action === "status" ? { state: await internet.describe(target) } : { message: await internet.set(target, action) };
    }
    case "capture": {
      count(args, 3);
      const seconds = Number(args[1]);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) throw new Error("Capture duration must be 1..600 seconds");
      const capture = required(adapter.capture, "packet capture"), client = await find(adapter, args[0]!);
      dependencies.signal?.throwIfAborted();
      const file = await open(args[2]!, "wx", 0o600);
      let writing = Promise.resolve();
      let failure: Error | undefined;
      let finish!: () => void;
      const done = new Promise<void>(resolve => { finish = resolve; });
      const aborted = () => finish();
      dependencies.signal?.addEventListener("abort", aborted, { once: true });
      const timer = setTimeout(finish, seconds * 1000);
      let session: Awaited<ReturnType<typeof capture.start>> | undefined;
      try {
        session = await capture.start(client, chunk => {
          const bytes = Buffer.from(chunk);
          writing = writing.then(async () => { await file.writeFile(bytes); }).catch(error => { failure = error; finish(); });
        }, error => { failure = error; finish(); });
        if (dependencies.signal?.aborted) finish();
        await done;
      } finally {
        clearTimeout(timer);
        dependencies.signal?.removeEventListener("abort", aborted);
        try { await session?.stop(); } finally { await writing; await file.close(); }
      }
      if (failure) throw failure;
      return { mac: client.mac, path: args[2], where: session?.where };
    }
  }
}
