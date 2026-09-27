import { Resolver } from "node:dns/promises";
import type { IsolationStatus, NetworkIsolation } from "../../network/isolation";
import {
  cameraDnsTarget,
  createNetworkAdapter,
  kickCameraWifi,
  type CameraKickResult,
  type DnsAction,
  type DnsRecordState,
  type DnsTarget,
  type NetworkAdapter,
} from "../../network";

/**
 * Which control plane the Pet 3T cameras are using right now.
 *
 * The DNS override (`usce.mearicloud.com -> HomeTruth`) is one network-wide A
 * record, so this is a single shared state rather than a per-camera one.
 * `record` is what the network adapter says the record is; `resolvedTo` is
 * what the LAN resolver actually answers, which is what the cameras
 * experience. `mode` prefers the live resolver answer and falls back to the
 * record when DNS could not be checked.
 */
export interface CameraNetworkStatus {
  mode: "local" | "cloud" | "unknown";
  dnsOverride: DnsRecordState | "unavailable";
  domain: string;
  overrideIp: string;
  resolvedTo?: string;
  /** Why the record or resolver check is incomplete, when it is. */
  detail?: string;
  checkedAt: string;
  /** False when the network adapter cannot read or switch the record. */
  canToggle: boolean;
  /** The per-camera fields, present only from `IsolationNetworkMode.snapshotFor()`. */
  deviceId?: string;
  isolated?: boolean;
  internetBlock?: DnsRecordState | "unavailable";
  capture?: "running" | "stopped" | "unavailable";
  hostnames?: string[];
}

const DEFAULT_CAMERA_DNS_DOMAIN_FOR_STATUS = "usce.mearicloud.com";

export interface CameraNetworkModeOptions {
  /** Lazily builds the network adapter; may throw when the environment is incomplete. */
  readonly adapter?: () => NetworkAdapter;
  /** Resolves the record; may throw when the server address is unknown. */
  readonly target?: () => DnsTarget;
  /** Resolves the override hostname the way a LAN client would. */
  readonly resolve?: (domain: string) => Promise<readonly string[]>;
  /** Milliseconds a status stays fresh before the next read re-checks. */
  readonly cacheMs?: number;
  readonly now?: () => number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The LAN gateway is the resolver the cameras use; the workstation may use a
 * public resolver instead, so ask the gateway directly. */
async function defaultGateway(): Promise<string | undefined> {
  const configured = process.env.HOMETRUTH_CAMERA_DNS_SERVER?.trim();
  if (configured) return configured;
  try {
    const command = process.platform === "darwin" ? ["route", "-n", "get", "default"] : ["ip", "route", "show", "default"];
    const proc = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    const match = process.platform === "darwin"
      ? text.match(/gateway:\s*([0-9.]+)/u)
      : text.match(/via\s+([0-9.]+)/u);
    return match?.[1];
  } catch {
    return undefined;
  }
}

async function gatewayResolve(domain: string): Promise<readonly string[]> {
  const gateway = await defaultGateway();
  const resolver = new Resolver({ timeout: 2_500, tries: 1 });
  if (gateway) resolver.setServers([gateway]);
  return await resolver.resolve4(domain);
}

export class CameraNetworkMode {
  readonly #adapter: () => NetworkAdapter;
  readonly #target: () => DnsTarget;
  readonly #resolve: (domain: string) => Promise<readonly string[]>;
  readonly #cacheMs: number;
  readonly #now: () => number;
  #status: CameraNetworkStatus | undefined;
  #checkedAtMs = 0;
  #inFlight: Promise<CameraNetworkStatus> | undefined;
  #instance: NetworkAdapter | undefined;

  constructor(options: CameraNetworkModeOptions = {}) {
    this.#adapter = options.adapter ?? (() => createNetworkAdapter());
    this.#target = options.target ?? (() => cameraDnsTarget());
    this.#resolve = options.resolve ?? gatewayResolve;
    this.#cacheMs = options.cacheMs ?? 15_000;
    this.#now = options.now ?? Date.now;
  }

  /** Last known status (undefined until the first refresh); kicks off a refresh when stale. */
  snapshot(): CameraNetworkStatus | undefined {
    if (this.#now() - this.#checkedAtMs > this.#cacheMs) void this.refresh().catch(() => undefined);
    return this.#status;
  }

  async refresh(): Promise<CameraNetworkStatus> {
    if (this.#inFlight) return await this.#inFlight;
    this.#inFlight = this.#check().finally(() => { this.#inFlight = undefined; });
    return await this.#inFlight;
  }

  async set(action: DnsAction): Promise<{ message: string; status: CameraNetworkStatus }> {
    const adapter = this.#client();
    if (!adapter.dns) {
      throw new Error(`The ${adapter.name} network adapter cannot change DNS records; update the record on your DNS server by hand`);
    }
    const message = await adapter.dns.set(this.#target(), action);
    this.#checkedAtMs = 0;
    const status = await this.refresh();
    return { message, status };
  }

  /** True when the configured adapter can drop Wi-Fi clients. */
  canKick(): boolean {
    try {
      return this.#client().wifi !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Make the cameras follow the DNS record right now. A Pet 3T keeps its cloud
   * TCP session until its own heartbeat timeout (minutes), but a Wi-Fi drop
   * makes the firmware re-resolve and reconnect within about 15 s.
   */
  async kick(addresses: readonly string[]): Promise<CameraKickResult[]> {
    const adapter = this.#client();
    if (!adapter.wifi) {
      throw new Error(`The ${adapter.name} network adapter cannot kick Wi-Fi clients`);
    }
    return await kickCameraWifi(addresses, adapter.wifi);
  }

  #client(): NetworkAdapter {
    if (!this.#instance) this.#instance = this.#adapter();
    return this.#instance;
  }

  async #check(): Promise<CameraNetworkStatus> {
    const problems: string[] = [];
    let target: DnsTarget;
    try {
      target = this.#target();
    } catch (error) {
      const status: CameraNetworkStatus = {
        mode: "unknown",
        dnsOverride: "unavailable",
        domain: "",
        overrideIp: "",
        detail: describeError(error),
        checkedAt: new Date(this.#now()).toISOString(),
        canToggle: false,
      };
      this.#status = status;
      this.#checkedAtMs = this.#now() - this.#cacheMs + 2_000;
      return status;
    }
    let record: CameraNetworkStatus["dnsOverride"] = "unavailable";
    let canToggle = false;
    try {
      const adapter = this.#client();
      if (adapter.dns) {
        record = await adapter.dns.describe(target);
        canToggle = true;
      } else {
        problems.push(`The ${adapter.name} network adapter cannot read or switch the DNS record from here; manage ${target.domain} -> ${target.overrideIp} on your DNS server`);
      }
    } catch (error) {
      problems.push(`The network adapter could not read the DNS record: ${describeError(error)}`);
    }
    let resolvedTo: string | undefined;
    try {
      const answers = await this.#resolve(target.domain);
      resolvedTo = answers[0];
      if (!resolvedTo) problems.push(`${target.domain} did not resolve to any address`);
    } catch (error) {
      problems.push(`${target.domain} could not be resolved: ${describeError(error)}`);
    }
    const mode: CameraNetworkStatus["mode"] = resolvedTo
      ? (resolvedTo === target.overrideIp ? "local" : "cloud")
      : record === "on"
        ? "local"
        : record === "off" || record === "missing"
          ? "cloud"
          : "unknown";
    if (resolvedTo && record === "on" && resolvedTo !== target.overrideIp) {
      problems.push(`The override record is on, but ${target.domain} still resolves to ${resolvedTo}; the resolver cache may not have expired yet`);
    }
    if (resolvedTo && (record === "off" || record === "missing") && resolvedTo === target.overrideIp) {
      problems.push(`The override record is off, but ${target.domain} still resolves to HomeTruth; the resolver cache may not have expired yet`);
    }
    const status: CameraNetworkStatus = {
      mode,
      dnsOverride: record,
      domain: target.domain,
      overrideIp: target.overrideIp,
      ...(resolvedTo ? { resolvedTo } : {}),
      ...(problems.length > 0 ? { detail: problems.join(". ") } : {}),
      checkedAt: new Date(this.#now()).toISOString(),
      canToggle,
    };
    this.#status = status;
    // A failed adapter read (typically credentials not loaded yet at boot)
    // should not be cached for the full window; re-check on the next read soon.
    this.#checkedAtMs = canToggle ? this.#now() : this.#now() - this.#cacheMs + 2_000;
    return status;
  }
}

/**
 * The camera service's network view over the site's generic isolation
 * service (`src/network/isolation.ts`): "local mode" for a camera means it
 * is isolated (its own gateway rule, the shared DNS records, a capture), and
 * the shared view reports local only when every camera is. `set()` without
 * an address switches every camera; with one, that camera alone.
 */
export class IsolationNetworkMode {
  constructor(
    private readonly isolation: NetworkIsolation,
    private readonly cameraHosts: readonly string[],
    private readonly primaryDomain: string = DEFAULT_CAMERA_DNS_DOMAIN_FOR_STATUS,
  ) {}

  snapshot(): CameraNetworkStatus | undefined {
    const status = this.isolation.snapshot();
    return status ? this.shared(status) : undefined;
  }

  snapshotFor(host: string): CameraNetworkStatus | undefined {
    const status = this.isolation.snapshot();
    return status ? this.forHost(status, host) : undefined;
  }

  async refresh(): Promise<CameraNetworkStatus> {
    return this.shared(await this.isolation.refresh());
  }

  async set(action: DnsAction, host?: string): Promise<{ message: string; status: CameraNetworkStatus }> {
    const targets = host ? [host] : this.cameraHosts;
    const messages: string[] = [];
    let status: IsolationStatus | undefined;
    for (const address of targets) {
      const device = this.isolation.deviceAt(address);
      if (!device) {
        messages.push(`${address} is not a device in devices.yml, so it cannot be isolated`);
        continue;
      }
      const result = await this.isolation.setIsolated(device.id, action === "on");
      messages.push(result.message);
      status = result.status;
    }
    const resolved = status ?? await this.isolation.refresh();
    return { message: messages.join(". "), status: host ? this.forHost(resolved, host) : this.shared(resolved) };
  }

  canKick(): boolean {
    return true;
  }

  async kick(addresses: readonly string[]): Promise<CameraKickResult[]> {
    const adapter = createNetworkAdapter();
    if (!adapter.wifi) throw new Error(`The ${adapter.name} network adapter cannot kick Wi-Fi clients`);
    return await kickCameraWifi(addresses, adapter.wifi);
  }

  private record(status: IsolationStatus, domain: string) {
    return status.dns.find((entry) => entry.domain === domain) ?? status.dns[0];
  }

  private shared(status: IsolationStatus): CameraNetworkStatus {
    const cameras = status.devices.filter((device) => this.cameraHosts.includes(device.host));
    const record = this.record(status, this.primaryDomain);
    const isolatedCount = cameras.filter((device) => device.isolated).length;
    const mode: CameraNetworkStatus["mode"] = cameras.length === 0 ? "unknown" : isolatedCount === cameras.length ? "local" : isolatedCount === 0 ? "cloud" : "local";
    const notes = [status.detail, isolatedCount > 0 && isolatedCount < cameras.length ? `${isolatedCount} of ${cameras.length} cameras isolated` : undefined].filter((note): note is string => Boolean(note));
    return {
      mode,
      dnsOverride: record?.record ?? "unavailable",
      domain: record?.domain ?? this.primaryDomain,
      overrideIp: status.overrideIp ?? "",
      ...(record?.resolvedTo ? { resolvedTo: record.resolvedTo } : {}),
      ...(notes.length > 0 ? { detail: notes.join(". ") } : {}),
      checkedAt: status.checkedAt,
      canToggle: status.canIsolate,
    };
  }

  private forHost(status: IsolationStatus, host: string): CameraNetworkStatus {
    const device = status.devices.find((entry) => entry.host === host);
    const shared = this.shared(status);
    if (!device) return shared;
    const record = this.record(status, this.primaryDomain);
    const notes = [status.detail, device.detail].filter((note): note is string => Boolean(note));
    return {
      mode: device.isolated ? "local" : "cloud",
      dnsOverride: record?.record ?? "unavailable",
      domain: record?.domain ?? this.primaryDomain,
      overrideIp: status.overrideIp ?? "",
      ...(record?.resolvedTo ? { resolvedTo: record.resolvedTo } : {}),
      ...(notes.length > 0 ? { detail: notes.join(". ") } : {}),
      checkedAt: status.checkedAt,
      canToggle: status.canIsolate,
      deviceId: device.deviceId,
      isolated: device.isolated,
      internetBlock: device.internetBlock,
      capture: device.capture,
      hostnames: [...device.hostnames],
    };
  }
}
