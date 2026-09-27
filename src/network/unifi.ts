import { isIPv4 } from "node:net";
import { UniFiAdmissionClient } from "./unifi-admission";
import { validAdmissionMac } from "./wifi-admission";
import type { NetworkAddressClient } from "./adapter";
/**
 * UniFi Network adapter.
 *
 * DNS overrides use the integration API (`/proxy/network/integration/v1`,
 * DNS policies of type A_RECORD). Wi-Fi kicks use the classic Network API
 * (`cmd/stamgr kick-sta`), which accepts the same API key and is keyed by site
 * name rather than site UUID.
 *
 * The per-device internet block (the isolation rule) is a zone-based firewall
 * policy on the integration API: source = the Internal zone filtered to one
 * MAC, destination = the External zone, action BLOCK, logging on. The adapter
 * implements the UniFi OS 4.x policy shape; other gateway versions need
 * compatibility validation. Packet capture runs `tcpdump` on the
 * access point the client is associated with, over SSH, with the AP's
 * hardware flow offload disabled for the duration (else offloaded flows
 * never reach tcpdump) and restored when the capture ends.
 *
 * Environment:
 *   UNIFI_API_KEY          required; a UniFi Network API key
 *   UNIFI_BASE_URL         controller URL (default https://192.168.1.1, the UniFi factory default)
 *   UNIFI_SITE_ID          integration API site UUID (auto-discovered when omitted)
 *   UNIFI_SITE_NAME        site name used for auto-discovery and the classic API (default "default")
 *   UNIFI_SKIP_TLS_VERIFY  set to 1 for a controller with a self-signed certificate
 *   UNIFI_SSH_USER         SSH user on the access points (packet capture); the device SSH login from UniFi's settings
 *   UNIFI_SSH_KEY          path to the private key that user accepts
 */
import {
  NetworkAdapterError,
  type DnsAction,
  type DnsOverrideAdapter,
  type DnsRecordState,
  type DnsTarget,
  type InternetBlockAdapter,
  type InternetBlockTarget,
  type NetworkAdapter,
  type PacketCaptureAdapter,
  type PacketCaptureSession,
  type WifiClient,
  type WifiKickAdapter,
} from "./adapter";

const DEFAULT_BASE_URL = "https://192.168.1.1";
const DEFAULT_SITE_NAME = "default";
const API_ROOT = "/proxy/network/integration/v1";

export type DnsPolicy = {
  id?: string;
  type?: string;
  enabled?: boolean;
  domain?: string;
  ipv4Address?: string;
  ttlSeconds?: number;
  [key: string]: unknown;
};

/** The raw UniFi calls, separated so the record logic is unit-testable. */
export interface UniFiDnsApi {
  listDnsPolicies(): Promise<DnsPolicy[]>;
  setPolicy(policy: DnsPolicy, enabled: boolean): Promise<void>;
  createPolicy(domain: string, ip: string): Promise<void>;
}

export interface UniFiWifiApi {
  listClients(): Promise<WifiClient[]>;
  kickClient(mac: string): Promise<void>;
}

export type FirewallZone = { id?: string; name?: string; [key: string]: unknown };
export type FirewallPolicy = {
  id?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  action?: { type?: string; [key: string]: unknown };
  source?: { zoneId?: string; trafficFilter?: { type?: string; macAddressFilter?: { macAddresses?: string[] }; [key: string]: unknown }; [key: string]: unknown };
  destination?: { zoneId?: string; [key: string]: unknown };
  [key: string]: unknown;
};

export interface UniFiFirewallApi {
  listFirewallZones(): Promise<FirewallZone[]>;
  listFirewallPolicies(): Promise<FirewallPolicy[]>;
  createFirewallPolicy(policy: FirewallPolicy): Promise<void>;
  setFirewallPolicy(policy: FirewallPolicy, enabled: boolean): Promise<void>;
}

/** One access point as the classic API lists it, with the per-SSID radio interfaces a capture attaches to. */
export interface AccessPoint {
  readonly mac: string;
  readonly address: string;
  readonly name: string;
  readonly interfaces: readonly { readonly name: string; readonly ssid: string; readonly radio: string }[];
}

export interface UniFiAccessPointApi {
  listAccessPoints(): Promise<AccessPoint[]>;
}

export interface UniFiOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly siteId?: string;
  readonly siteName?: string;
  readonly skipTlsVerify?: boolean;
  readonly fetch?: typeof fetch;
  /** SSH login for the access points, for packet capture; capture is unavailable without both. */
  readonly sshUser?: string;
  readonly sshKeyPath?: string;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

function asPolicies(value: unknown): DnsPolicy[] {
  const object = asObject(value);
  const data = Array.isArray(object.data) ? object.data : Array.isArray(value) ? value : [];
  return data.filter((item): item is DnsPolicy => Boolean(item && typeof item === "object" && !Array.isArray(item)));
}

function asClients(value: unknown): WifiClient[] {
  const data = asObject(value).data;
  const rows: unknown[] = Array.isArray(data) ? data : [];
  return rows.flatMap((row) => {
    const object = asObject(row);
    const mac = typeof object.mac === "string" ? object.mac.toLowerCase() : "";
    // A client whose DHCP exchange failed can have a current 169.254/16 address
    // while its reservation still names the configured HomeTruth address. Keep
    // all three so a reconnect can find it by the address in devices.yml.
    const currentAddress = typeof object.ip === "string" && object.ip ? object.ip : undefined;
    const fixedAddress = object.use_fixedip !== false && typeof object.fixed_ip === "string" && object.fixed_ip ? object.fixed_ip : undefined;
    const lastAddress = typeof object.last_ip === "string" && object.last_ip ? object.last_ip : undefined;
    const address = currentAddress ?? fixedAddress ?? lastAddress ?? "";
    if (!mac || !address) return [];
    return [{
      mac,
      address,
      ...(fixedAddress ? { fixedAddress } : {}),
      ...(lastAddress ? { lastAddress } : {}),
      ...(typeof object.hostname === "string" && object.hostname ? { hostname: object.hostname } : {}),
      ...(typeof object.name === "string" && object.name ? { name: object.name } : {}),
      ...(typeof object.ap_mac === "string" && object.ap_mac ? { apMac: object.ap_mac.toLowerCase() } : {}),
      ...(typeof object.radio === "string" && object.radio ? { radio: object.radio } : {}),
      ...(typeof object.essid === "string" && object.essid ? { ssid: object.essid } : {}),
      ...(typeof object.vlan === "number" ? { vlan: object.vlan } : {}),
    }];
  });
}

function asAccessPoints(value: unknown): AccessPoint[] {
  const data = asObject(value).data;
  const rows: unknown[] = Array.isArray(data) ? data : [];
  return rows.flatMap((row) => {
    const object = asObject(row);
    if (object.type !== "uap") return [];
    const mac = typeof object.mac === "string" ? object.mac.toLowerCase() : "";
    const address = typeof object.ip === "string" ? object.ip : "";
    if (!mac || !address) return [];
    const vaps: unknown[] = Array.isArray(object.vap_table) ? object.vap_table : [];
    const interfaces = vaps.flatMap((vap) => {
      const entry = asObject(vap);
      return typeof entry.name === "string" && typeof entry.essid === "string" && typeof entry.radio === "string"
        ? [{ name: entry.name, ssid: entry.essid, radio: entry.radio }]
        : [];
    });
    return [{ mac, address, name: typeof object.name === "string" && object.name ? object.name : mac, interfaces }];
  });
}

function asZones(value: unknown): FirewallZone[] {
  return asPolicies(value) as FirewallZone[];
}

const ISOLATION_POLICY_PREFIX = "hometruth-isolate";

function isolationPolicyMatches(policy: FirewallPolicy, target: InternetBlockTarget): boolean {
  if (!policy.name?.startsWith(ISOLATION_POLICY_PREFIX)) return false;
  const macs = policy.source?.trafficFilter?.macAddressFilter?.macAddresses ?? [];
  return macs.length === 1 && macs[0]?.toLowerCase() === target.mac.toLowerCase();
}

function policyMatches(policy: DnsPolicy, target: DnsTarget): boolean {
  return ["A", "A_RECORD"].includes(policy.type?.toUpperCase() ?? "")
    && policy.domain === target.domain
    && policy.ipv4Address === target.overrideIp;
}

function policyId(policy: DnsPolicy): string {
  const id = typeof policy.id === "string" ? policy.id : typeof policy._id === "string" ? policy._id : "";
  if (!id) throw new NetworkAdapterError("UniFi returned a DNS policy without an id", "gateway_error");
  return id;
}

/** HTTP client for both UniFi APIs. */
export class UniFiClient implements UniFiDnsApi, UniFiWifiApi, UniFiFirewallApi, UniFiAccessPointApi {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly siteName: string;
  private readonly skipTlsVerify: boolean;
  private readonly fetchImpl: typeof fetch;
  private siteId: string | undefined;

  constructor(options: UniFiOptions) {
    if (!options.apiKey.trim()) throw new NetworkAdapterError("UNIFI_API_KEY is not set", "not_configured");
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/u, "");
    this.apiKey = options.apiKey.trim();
    this.siteName = options.siteName?.trim() || DEFAULT_SITE_NAME;
    this.siteId = options.siteId?.trim() || undefined;
    this.skipTlsVerify = options.skipTlsVerify ?? false;
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-API-Key": this.apiKey,
        ...(init.headers ?? {}),
      },
      ...(this.skipTlsVerify ? { tls: { rejectUnauthorized: false } } : {}),
      signal: init.signal ?? AbortSignal.timeout(15_000),
    } as RequestInit);
    const text = await response.text();
    let body: unknown = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    if (!response.ok) {
      const detail = typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 500);
      throw new NetworkAdapterError(`UniFi API ${response.status} ${response.statusText}: ${detail}`, "gateway_error");
    }
    return body;
  }

  /** Restricted classic-API surface for the Wi-Fi admission adapter. */
  admissionRequest(path: string, init: RequestInit = {}): Promise<unknown> {
    return this.request(`${this.classicSite}/${path}`, { ...init, signal: AbortSignal.timeout(5000) });
  }

  private async resolveSiteId(): Promise<string> {
    if (this.siteId) return this.siteId;
    const body = await this.request(`${API_ROOT}/sites`);
    const data = asObject(body).data;
    const sites: unknown[] = Array.isArray(data) ? data : [];
    const match = sites.find((site) => {
      const object = asObject(site);
      return object.name === this.siteName || object.siteName === this.siteName;
    }) ?? (sites.length === 1 ? sites[0] : undefined);
    const rawId = asObject(match).id;
    const id = typeof rawId === "string" ? rawId : "";
    if (!id) throw new NetworkAdapterError(`Could not find UniFi site ${this.siteName}; set UNIFI_SITE_ID`, "not_configured");
    this.siteId = id;
    return id;
  }

  async listDnsPolicies(): Promise<DnsPolicy[]> {
    const siteId = await this.resolveSiteId();
    return asPolicies(await this.request(`${API_ROOT}/sites/${encodeURIComponent(siteId)}/dns/policies`));
  }

  async setPolicy(policy: DnsPolicy, enabled: boolean): Promise<void> {
    const siteId = await this.resolveSiteId();
    await this.request(`${API_ROOT}/sites/${encodeURIComponent(siteId)}/dns/policies/${encodeURIComponent(policyId(policy))}`, {
      method: "PUT",
      body: JSON.stringify({
        type: policy.type ?? "A_RECORD",
        enabled,
        domain: policy.domain,
        ipv4Address: policy.ipv4Address,
        ttlSeconds: typeof policy.ttlSeconds === "number" ? policy.ttlSeconds : 0,
      }),
    });
  }

  async createPolicy(domain: string, ip: string): Promise<void> {
    const siteId = await this.resolveSiteId();
    await this.request(`${API_ROOT}/sites/${encodeURIComponent(siteId)}/dns/policies`, {
      method: "POST",
      body: JSON.stringify({ type: "A_RECORD", enabled: true, domain, ipv4Address: ip, ttlSeconds: 0 }),
    });
  }

  private get classicSite(): string {
    return `/proxy/network/api/s/${encodeURIComponent(this.siteName)}`;
  }

  async listClients(): Promise<WifiClient[]> {
    return asClients(await this.request(`${this.classicSite}/stat/sta`));
  }

  async listAddressClients(): Promise<NetworkAddressClient[]> {
    const [activeBody, usersBody, networkBody] = await Promise.all([
      this.request(`${this.classicSite}/stat/sta`),
      this.request(`${this.classicSite}/rest/user`),
      this.request(`${this.classicSite}/rest/networkconf`),
    ]);
    const networks = asPolicies(networkBody);
    const active = new Set(asPolicies(activeBody).flatMap(row => typeof row.mac === "string" ? [row.mac.toLowerCase()] : []));
    const rows = new Map<string, DnsPolicy>();
    for (const row of [...asPolicies(usersBody), ...asPolicies(activeBody)]) {
      if (typeof row.mac !== "string") continue;
      const mac = row.mac.toLowerCase();
      rows.set(mac, { ...rows.get(mac), ...row, mac });
    }
    // Persistent client records include wired and offline devices. Active
    // records supply the current address/network; the user table owns DHCP.
    for (const user of asPolicies(usersBody)) {
      if (typeof user.mac !== "string") continue;
      const row = rows.get(user.mac.toLowerCase());
      if (row) { row.use_fixedip = user.use_fixedip === true; row.fixed_ip = user.fixed_ip; }
    }
    return asClients({ data: [...rows.values()] }).map((client) => {
      const raw = rows.get(client.mac);
      const networkId = raw?.network_id ?? raw?.last_connection_network_id;
      const candidates = networks.filter(row => networkId ? row._id === networkId : row.name === raw?.last_connection_network_name);
      const network = candidates.length === 1 ? candidates[0] : undefined;
      return { ...client, connected: active.has(client.mac), address: active.has(client.mac) ? client.address : "",
        ...(typeof network?.name === "string" ? { network: network.name } : {}),
        ...(typeof network?.ip_subnet === "string" && network.dhcpd_enabled === true ? { subnet: network.ip_subnet } : {}),
      };
    });
  }

  async reserveAddress(mac: string, address: string): Promise<() => Promise<void>> {
    if (!validAdmissionMac(mac)) throw new NetworkAdapterError("Enter a valid unicast MAC address", "not_supported");
    mac = mac.toLowerCase();
    if (!isIPv4(address)) throw new NetworkAdapterError("Enter a valid IPv4 address", "not_supported");
    const [clients, usersBody] = await Promise.all([
      this.listAddressClients(), this.request(`${this.classicSite}/rest/user`),
    ]);
    const client = clients.find((row) => typeof row.mac === "string" && row.mac.toLowerCase() === mac);
    const users = asPolicies(usersBody);
    const user = users.find((row) => typeof row.mac === "string" && row.mac.toLowerCase() === mac);
    if (!client?.subnet || typeof user?._id !== "string") {
      throw new NetworkAdapterError("Select a known device on a network managed by this DHCP server", "not_supported");
    }
    const [gateway, prefixText] = client.subnet.split("/");
    const prefix = Number(prefixText);
    if (!gateway || !isIPv4(gateway) || !/^\d+$/.test(prefixText ?? "") || prefix < 1 || prefix > 30) {
      throw new NetworkAdapterError("The gateway returned an unsupported subnet", "not_supported");
    }
    const numeric = (ip: string) => ip.split(".").reduce((n, part) => ((n * 256) + Number(part)) >>> 0, 0);
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    const network = (numeric(gateway) & mask) >>> 0;
    const value = numeric(address);
    const broadcast = (network | ~mask) >>> 0;
    if (((value & mask) >>> 0) !== network || value === network || value === broadcast || address === gateway) {
      throw new NetworkAdapterError(`Choose a host address in ${client.network ?? "the device network"} (${client.subnet}), excluding the gateway`, "not_supported");
    }
    if (clients.some((row) => row.mac !== mac && row.address === address)
      || users.some((row) => typeof row.mac === "string" && row.mac.toLowerCase() !== mac && row.use_fixedip === true && row.fixed_ip === address)) {
      throw new NetworkAdapterError(`${address} is already used or reserved by another device`, "not_supported");
    }
    const path = `${this.classicSite}/rest/user/${encodeURIComponent(user._id)}`;
    const update = async (fields: Record<string, unknown>) => {
      const body = asObject(await this.request(path, { method: "PUT", body: JSON.stringify(fields) }));
      if (asObject(body.meta).rc === "error") throw new NetworkAdapterError("UniFi rejected the reservation update", "gateway_error");
    };
    const undo = () => update({ use_fixedip: user.use_fixedip === true, fixed_ip: user.fixed_ip ?? "" });
    try {
      await update({ use_fixedip: true, fixed_ip: address });
      const saved = asPolicies(await this.request(`${this.classicSite}/rest/user`)).find((row) => typeof row.mac === "string" && row.mac.toLowerCase() === mac);
      if (saved?.use_fixedip !== true || saved.fixed_ip !== address) throw new Error("UniFi did not retain the requested reservation");
    } catch (error) {
      try { await undo(); }
      catch { throw new NetworkAdapterError("The reservation update failed and its previous value could not be restored. Check this device in UniFi before retrying.", "gateway_error"); }
      throw error;
    }
    return undo;
  }

  async kickClient(mac: string): Promise<void> {
    await this.request(`${this.classicSite}/cmd/stamgr`, {
      method: "POST",
      body: JSON.stringify({ cmd: "kick-sta", mac }),
    });
  }

  async listAccessPoints(): Promise<AccessPoint[]> {
    return asAccessPoints(await this.request(`${this.classicSite}/stat/device`));
  }

  async listFirewallZones(): Promise<FirewallZone[]> {
    const siteId = await this.resolveSiteId();
    return asZones(await this.request(`${API_ROOT}/sites/${encodeURIComponent(siteId)}/firewall/zones`));
  }

  async listFirewallPolicies(): Promise<FirewallPolicy[]> {
    const siteId = await this.resolveSiteId();
    return asPolicies(await this.request(`${API_ROOT}/sites/${encodeURIComponent(siteId)}/firewall/policies`)) as FirewallPolicy[];
  }

  async createFirewallPolicy(policy: FirewallPolicy): Promise<void> {
    const siteId = await this.resolveSiteId();
    await this.request(`${API_ROOT}/sites/${encodeURIComponent(siteId)}/firewall/policies`, { method: "POST", body: JSON.stringify(policy) });
  }

  async setFirewallPolicy(policy: FirewallPolicy, enabled: boolean): Promise<void> {
    const siteId = await this.resolveSiteId();
    // The PUT body is the policy without its read-only fields (id, index, metadata); the API rejects unknown properties.
    const { id: _id, index: _index, metadata: _metadata, ...rest } = policy;
    void _id; void _index; void _metadata;
    await this.request(`${API_ROOT}/sites/${encodeURIComponent(siteId)}/firewall/policies/${encodeURIComponent(policyId(policy))}`, {
      method: "PUT",
      body: JSON.stringify({ ...rest, enabled }),
    });
  }
}

/**
 * The isolation rule on a zone-based UniFi firewall: one BLOCK policy per
 * device from the Internal zone (filtered to its MAC) to the External zone,
 * with logging on so the gateway's own flow log keeps what it dropped. The
 * policy is created disabled-or-enabled as asked and toggled afterwards,
 * never deleted, so the gateway keeps its history.
 */
export class UniFiInternetBlock implements InternetBlockAdapter {
  private zones: { internal: string; external: string } | undefined;

  constructor(private readonly api: UniFiFirewallApi) {}

  private async zoneIds(): Promise<{ internal: string; external: string }> {
    if (this.zones) return this.zones;
    const zones = await this.api.listFirewallZones();
    const find = (name: string) => zones.find((zone) => zone.name?.toLowerCase() === name)?.id;
    const internal = find("internal");
    const external = find("external");
    if (!internal || !external) {
      throw new NetworkAdapterError("The UniFi site has no Internal/External firewall zones; the isolation rule needs the zone-based firewall (UniFi Network 9+)", "not_supported");
    }
    this.zones = { internal, external };
    return this.zones;
  }

  private async matching(target: InternetBlockTarget): Promise<FirewallPolicy | undefined> {
    const matching = (await this.api.listFirewallPolicies()).filter((policy) => isolationPolicyMatches(policy, target));
    if (matching.length > 1) {
      throw new NetworkAdapterError(`Found ${matching.length} duplicate isolation rules for ${target.mac}; remove the extras in the UniFi firewall settings`, "gateway_error");
    }
    return matching[0];
  }

  async describe(target: InternetBlockTarget): Promise<DnsRecordState> {
    const policy = await this.matching(target);
    return !policy ? "missing" : policy.enabled === false ? "off" : "on";
  }

  async set(target: InternetBlockTarget, action: DnsAction): Promise<string> {
    const label = `${target.label} (${target.mac})`;
    const policy = await this.matching(target);
    if (!policy) {
      if (action === "off") return `already not isolating ${label} (no rule found)`;
      const { internal, external } = await this.zoneIds();
      await this.api.createFirewallPolicy({
        name: `${ISOLATION_POLICY_PREFIX} ${target.label}`.slice(0, 64),
        description: `HomeTruth isolation rule: ${target.label} may not reach the public internet`,
        enabled: true,
        action: { type: "BLOCK" },
        source: { zoneId: internal, trafficFilter: { type: "MAC_ADDRESS", macAddressFilter: { macAddresses: [target.mac.toLowerCase()] } } },
        destination: { zoneId: external },
        ipProtocolScope: { ipVersion: "IPV4_AND_IPV6" },
        loggingEnabled: true,
      });
      return `isolated ${label} from the internet (rule created)`;
    }
    await this.api.setFirewallPolicy(policy, action === "on");
    return `${action === "on" ? "isolated" : "released"} ${label} ${action === "on" ? "from" : "to"} the internet`;
  }
}

export interface UniFiSshOptions {
  readonly user: string;
  readonly keyPath: string;
  /** Replaced in tests; runs `ssh` by default. */
  readonly spawn?: (command: string[]) => { readonly stdout: ReadableStream<Uint8Array>; readonly stderr: ReadableStream<Uint8Array>; readonly exited: Promise<number>; kill(): void };
}

/** Longest one remote tcpdump runs before the AP restores its offload on its own; the caller restarts a capture it still wants. */
export const UNIFI_CAPTURE_MAX_SECONDS = 3_600;

/**
 * The remote side: disable the AP's ECM/SFE flow acceleration and the Wi-Fi
 * fast-transmit offload (otherwise accelerated flows bypass the kernel path
 * tcpdump taps), stream the capture to stdout, and restore everything when
 * tcpdump ends — because the SSH session dropped, the cap elapsed, or a kill.
 */
export function captureScript(iface: string, mac: string, maxSeconds = UNIFI_CAPTURE_MAX_SECONDS): string {
  if (!/^[a-z0-9.]+$/iu.test(iface)) throw new NetworkAdapterError(`Refusing to capture on an oddly named interface "${iface}"`, "gateway_error");
  if (!/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/iu.test(mac)) throw new NetworkAdapterError(`Refusing to capture an oddly formed MAC "${mac}"`, "gateway_error");
  return [
    "E=/sys/kernel/debug/ecm",
    "restore() { for k in ppe_fse_enable sfe_fse_enable sfe_fast_xmit_enable; do echo 1 > /proc/sys/net/ecm/$k 2>/dev/null; done; echo 0 > $E/front_end_ipv4_stop 2>/dev/null; }",
    "trap restore EXIT HUP INT TERM",
    "echo 1 > $E/front_end_ipv4_stop 2>/dev/null; echo 1 > $E/ecm_db/defunct_all 2>/dev/null",
    "for k in ppe_fse_enable sfe_fse_enable sfe_fast_xmit_enable; do echo 0 > /proc/sys/net/ecm/$k 2>/dev/null; done",
    `tcpdump -i ${iface} -s0 -U -w - ether host ${mac} 2>/dev/null & TP=$!`,
    `( sleep ${Math.floor(maxSeconds)}; kill $TP 2>/dev/null ) & WD=$!`,
    // Re-assert the offload switches every 30 s: a sibling capture on the same AP restores them when it ends.
    "while kill -0 $TP 2>/dev/null; do for k in ppe_fse_enable sfe_fse_enable sfe_fast_xmit_enable; do echo 0 > /proc/sys/net/ecm/$k 2>/dev/null; done; sleep 30 & SL=$!; wait $SL; done",
    "kill $WD 2>/dev/null; exit 0",
  ].join("\n");
}

/** Per-client packet capture on the UniFi access point the client is associated with. */
export class UniFiPacketCapture implements PacketCaptureAdapter {
  constructor(private readonly api: UniFiAccessPointApi, private readonly ssh: UniFiSshOptions) {}

  /** The AP and the radio interface (`wifi0ap0.3`: SSID interface plus VLAN tag) this client's frames cross. */
  async locate(client: WifiClient): Promise<{ ap: AccessPoint; iface: string }> {
    if (!client.apMac) throw new NetworkAdapterError(`${client.address} is not associated with an access point right now (wired, or offline)`, "not_supported");
    const ap = (await this.api.listAccessPoints()).find((candidate) => candidate.mac === client.apMac);
    if (!ap) throw new NetworkAdapterError(`The gateway lists no access point ${client.apMac} for ${client.address}`, "gateway_error");
    const match = ap.interfaces.find((entry) => entry.ssid === client.ssid && entry.radio === client.radio) ?? ap.interfaces.find((entry) => entry.ssid === client.ssid);
    if (!match) throw new NetworkAdapterError(`${ap.name} has no radio interface for SSID "${client.ssid ?? "?"}" on band "${client.radio ?? "?"}"`, "gateway_error");
    return { ap, iface: client.vlan && client.vlan > 1 ? `${match.name}.${client.vlan}` : match.name };
  }

  async start(client: WifiClient, sink: (chunk: Uint8Array) => void, onEnd: (error?: Error) => void): Promise<PacketCaptureSession> {
    const { ap, iface } = await this.locate(client);
    const spawn = this.ssh.spawn ?? ((command: string[]) => Bun.spawn(command, { stdout: "pipe", stderr: "pipe", stdin: "ignore" }));
    const process = spawn([
      "ssh", "-i", this.ssh.keyPath,
      "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=12", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
      "-o", "BatchMode=yes",
      `${this.ssh.user}@${ap.address}`,
      captureScript(iface, client.mac),
    ]);
    let stopped = false;
    let stderr = "";
    void (async () => {
      const reader = process.stderr.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        stderr = (stderr + new TextDecoder().decode(value)).slice(-600);
      }
    })().catch(() => undefined);
    void (async () => {
      const reader = process.stdout.getReader();
      let error: Error | undefined;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value.length > 0) sink(value);
        }
      } catch (caught) {
        error = caught instanceof Error ? caught : new Error(String(caught));
      }
      const code = await process.exited;
      if (stopped) return;
      const detail = stderr.trim().split(/\r?\n/u).filter(Boolean).pop();
      onEnd(error ?? (code === 0 ? undefined : new Error(`ssh to ${ap.name} exited with ${code}${detail ? `: ${detail}` : ""}`)));
    })();
    return {
      where: `${ap.name} (${ap.address}) ${iface}`,
      async stop() {
        stopped = true;
        process.kill();
        await process.exited.catch(() => undefined);
      },
    };
  }
}

/** Record logic over any UniFi DNS API (real or fake). */
export class UniFiDnsOverride implements DnsOverrideAdapter {
  constructor(private readonly api: UniFiDnsApi) {}

  private async matching(target: DnsTarget): Promise<DnsPolicy[]> {
    const matching = (await this.api.listDnsPolicies()).filter((policy) => policyMatches(policy, target));
    if (matching.length > 1) {
      throw new NetworkAdapterError(`Found ${matching.length} duplicate DNS policies for ${target.domain} -> ${target.overrideIp}`, "gateway_error");
    }
    return matching;
  }

  async describe(target: DnsTarget): Promise<DnsRecordState> {
    const policy = (await this.matching(target))[0];
    return !policy ? "missing" : policy.enabled === false ? "off" : "on";
  }

  async set(target: DnsTarget, action: DnsAction): Promise<string> {
    const label = `${target.domain} -> ${target.overrideIp}`;
    const policy = (await this.matching(target))[0];
    if (!policy) {
      if (action === "off") return `already disabled DNS override ${label} (no record found)`;
      await this.api.createPolicy(target.domain, target.overrideIp);
      return `enabled DNS override ${label} (created)`;
    }
    await this.api.setPolicy(policy, action === "on");
    return `${action === "on" ? "enabled" : "disabled"} DNS override ${label}`;
  }
}

export class UniFiWifiKick implements WifiKickAdapter {
  constructor(private readonly api: UniFiWifiApi) {}

  async findClientByMac(mac: string): Promise<WifiClient | undefined> {
    const normalized = mac.toLowerCase();
    return (await this.api.listClients()).find((client) => client.mac.toLowerCase() === normalized);
  }

  async findClientByAddress(address: string): Promise<WifiClient | undefined> {
    return (await this.api.listClients()).find((client) =>
      client.address === address || client.fixedAddress === address || client.lastAddress === address,
    );
  }

  async kickClient(client: WifiClient): Promise<void> {
    await this.api.kickClient(client.mac);
  }
}

export function createUniFiAdapter(options: UniFiOptions): NetworkAdapter {
  const client = new UniFiClient(options);
  const ssh = options.sshUser?.trim() && options.sshKeyPath?.trim() ? { user: options.sshUser.trim(), keyPath: options.sshKeyPath.trim() } : undefined;
  return {
    name: "unifi",
    admission: { target: `${options.baseUrl ?? DEFAULT_BASE_URL}/${options.siteName ?? DEFAULT_SITE_NAME}`, api: new UniFiAdmissionClient(client) },
    addresses: { list: () => client.listAddressClients(), reserve: (mac, address) => client.reserveAddress(mac, address) },
    dns: new UniFiDnsOverride(client),
    wifi: new UniFiWifiKick(client),
    internet: new UniFiInternetBlock(client),
    ...(ssh ? { capture: new UniFiPacketCapture(client, ssh) } : {}),
  };
}

export function uniFiOptionsFromEnv(env: Record<string, string | undefined> = process.env): UniFiOptions {
  const apiKey = env.UNIFI_API_KEY?.trim();
  if (!apiKey) throw new NetworkAdapterError("Store a UniFi Network API key using ht secrets set network.unifi.apiKey", "not_configured");
  return {
    apiKey,
    ...(env.UNIFI_BASE_URL?.trim() ? { baseUrl: env.UNIFI_BASE_URL.trim() } : {}),
    ...(env.UNIFI_SSH_USER?.trim() ? { sshUser: env.UNIFI_SSH_USER.trim() } : {}),
    ...(env.UNIFI_SSH_KEY?.trim() ? { sshKeyPath: env.UNIFI_SSH_KEY.trim() } : {}),
    ...(env.UNIFI_SITE_ID?.trim() ? { siteId: env.UNIFI_SITE_ID.trim() } : {}),
    ...(env.UNIFI_SITE_NAME?.trim() ? { siteName: env.UNIFI_SITE_NAME.trim() } : {}),
    skipTlsVerify: env.UNIFI_SKIP_TLS_VERIFY === "1",
  };
}
