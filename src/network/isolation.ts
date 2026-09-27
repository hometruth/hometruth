/**
 * Network isolation: switch any device onto a rule that cuts it off from the
 * public internet, and — for a device whose vendor cloud HomeTruth emulates —
 * stand in for that cloud while it is cut off.
 *
 * Isolating a device means three things happen together:
 *
 * 1. The gateway gets a per-device firewall rule (`NetworkAdapter.internet`,
 *    keyed by MAC) that drops everything the device sends toward the
 *    internet. The LAN still works, so HomeTruth still reaches it.
 * 2. Every vendor hostname the device's model declares (`DeviceModel.
 *    cloudHostnames`) gets a DNS override to this server, where a local
 *    emulator or an `HttpInterceptor` answers in the vendor's place. DNS
 *    records are network-wide, so a record is on while any isolated device
 *    needs it and off once none does.
 * 3. Its traffic reaches this server: what the catch-all listeners receive
 *    (plain HTTP on :80, TLS on :443 with a stand-in certificate) and, when
 *    the network adapter can, a packet capture at the device's access point.
 *
 * **This is not a `Service`.** Nothing here runs a life of its own worth
 * watching: it is a persisted switch (`.hometruth/network-isolation.json`),
 * some gateway config, and listeners that hand what they hear to whoever
 * owns the device's cloud. A device that is merely jailed — blocked, with no
 * cloud of ours standing in for it — produces nothing to log, and that is
 * the whole story of isolating it. A device whose cloud we emulate already
 * has a service (the TKENPRO local cloud emulator), and its events belong
 * there, tagged with the device, alongside everything else that camera does.
 * `observer` is how they get there.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Resolver } from "node:dns/promises";
import { NetworkAdapterError, type DnsRecordState, type DnsTarget, type NetworkAdapter, type PacketCaptureSession, type WifiClient } from "./adapter";
import type { TCPSocketListener } from "bun";
import { PcapStreamDecoder, type PacketFact } from "./pcap-stream";
import { selfSignedCertificate, type TlsCertificate } from "./tls-cert";

/**
 * Where isolation's observations go. A vendor service that emulates a
 * device's cloud implements this; anything it is not told about is simply
 * not recorded, which is the right outcome for a device that is only jailed.
 */
export interface IsolationObserver {
  /**
   * Something a device did on the network: a request to a hostname we stand
   * in for, or an attempt its packet capture saw. `type` is an event type
   * from the catalog (`src/models/event-types.ts`); the observer decides
   * which device it belongs to, from the address.
   */
  observe(address: string, event: { type: string; message: string; level?: "info" | "warn" | "error"; data?: Record<string, unknown> }): void;
}

/** One site device as isolation sees it: where it is and which vendor hosts it needs stood in for. */
export interface IsolatableDevice {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly cloudHostnames: readonly string[];
}

/** Who a captured request came from: the address, and the site device at that address when there is one. */
export interface CaptureSource {
  readonly address: string;
  readonly device?: IsolatableDevice;
}

/**
 * A vendor's stand-in for one of its hostnames while a device is isolated.
 * `handle` returns the response the device should get, or undefined to say
 * "not mine" (the request is then logged and answered 404).
 */
export interface HttpInterceptor {
  readonly id: string;
  readonly hostnames: readonly string[];
  handle(request: Request, source: CaptureSource): Promise<Response | undefined>;
}

export type RuleState = DnsRecordState | "unavailable";

export interface DeviceIsolationStatus {
  readonly deviceId: string;
  readonly name: string;
  readonly host: string;
  /** What is wanted (persisted); the rule states below say what the network is actually doing. */
  readonly isolated: boolean;
  readonly mac?: string;
  readonly internetBlock: RuleState;
  readonly capture: "running" | "stopped" | "unavailable";
  readonly captureWhere?: string;
  /** Packets the running capture has decoded so far (all of them, not only the ones that became events). */
  readonly capturedPackets?: number;
  readonly hostnames: readonly string[];
  readonly detail?: string;
}

export interface DnsRecordStatus {
  readonly domain: string;
  readonly overrideIp: string;
  readonly record: RuleState;
  readonly resolvedTo?: string;
  /** Which isolated devices need this record right now. */
  readonly neededBy: readonly string[];
}

export interface IsolationStatus {
  readonly adapter: string;
  readonly overrideIp?: string;
  readonly canIsolate: boolean;
  readonly dns: readonly DnsRecordStatus[];
  readonly devices: readonly DeviceIsolationStatus[];
  readonly listeners: { readonly http?: number; readonly tls?: number };
  readonly detail?: string;
  readonly checkedAt: string;
}

interface StoredDevice {
  isolated: boolean;
  mac?: string;
  since?: string;
}

interface IsolationStateFile {
  version: 1;
  devices: Record<string, StoredDevice>;
}

/** Owner-only JSON file of the desired isolation state per device (no secrets, but it names the home's devices and MACs). */
export class IsolationStateStore {
  readonly path: string;

  constructor(path = ".hometruth/network-isolation.json") {
    this.path = resolve(path);
  }

  /** Undefined when the file does not exist yet (first run: nothing decided). */
  async load(): Promise<Record<string, StoredDevice> | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return undefined;
      throw error;
    }
    const parsed = JSON.parse(text) as Partial<IsolationStateFile>;
    if (parsed.version !== 1 || !parsed.devices || typeof parsed.devices !== "object") throw new Error(`${this.path} is not a version-1 isolation state file`);
    const devices: Record<string, StoredDevice> = {};
    for (const [id, value] of Object.entries(parsed.devices)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Partial<StoredDevice>;
      devices[id] = {
        isolated: entry.isolated === true,
        ...(typeof entry.mac === "string" ? { mac: entry.mac.toLowerCase() } : {}),
        ...(typeof entry.since === "string" ? { since: entry.since } : {}),
      };
    }
    return devices;
  }

  async save(devices: Record<string, StoredDevice>): Promise<void> {
    const file: IsolationStateFile = { version: 1, devices };
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
}

export interface NetworkIsolationOptions {
  /** Development can observe the router without claiming its shared rules at startup. Explicit actions still reconcile. */
  readonly reconcileOnStart?: boolean;
  readonly devices: readonly IsolatableDevice[];
  /** Lazily builds the network adapter; may throw when the environment is incomplete. */
  readonly adapter?: () => NetworkAdapter;
  /** The address DNS overrides point at; may throw when unknown. */
  readonly overrideIp?: () => string;
  readonly store?: IsolationStateStore;
  /** Catch-all plain-HTTP listener port; 0 disables it. Default 80, which is what vendors' unencrypted uploads use. */
  readonly httpPort?: number;
  /**
   * Catch-all TLS listener port; 0 disables it. Default 443. With a stand-in
   * certificate (the default: self-signed for every hostname any device's
   * model declares) it terminates TLS and serves interceptors exactly like
   * the plain listener; a device that verifies certificates only shows up as
   * a failed handshake in its access-point capture.
   */
  readonly tlsPort?: number;
  /** The certificate to present; `false` keeps the old server-name-only listener (nothing decrypted). */
  readonly tlsCertificate?: TlsCertificate | (() => Promise<TlsCertificate>) | false;
  /**
   * What to present on the TLS port to a client that names no vendor hostname
   * — one that connects by address, as a Hue client does. The stand-in
   * certificate is then presented only to a client that asks for one of its
   * hostnames, which is what a camera does. Undefined keeps the stand-in
   * certificate for everyone, exactly as before.
   */
  readonly defaultCertificate?: () => Promise<{ readonly key: string; readonly cert: string } | undefined>;
  readonly listenHost?: string;
  /**
   * Offered every request on these ports before anything else looks at it; a
   * Response means it was not a device's traffic at all and nothing is
   * recorded against one. This is how another listener that must own a
   * well-known port (the Hue bridge emulation, which clients only ever reach
   * on 80/443) shares these without a second address.
   */
  readonly handOff?: (request: Request, scheme: "http" | "https") => Promise<Response | undefined>;
  /** Capture at the access point when the adapter can (default true). Costs the AP its hardware flow offload while a capture runs. */
  readonly accessPointCapture?: boolean;
  /** Resolves a hostname the way a LAN client would. */
  readonly resolve?: (domain: string) => Promise<readonly string[]>;
  readonly now?: () => number;
  /** Structured console line for the server log. */
  readonly logger?: (event: Record<string, unknown>) => void;
  /**
   * Where a device's own network events go: the service that emulates that
   * device's cloud. Without one, an isolated device is simply jailed and
   * nothing about it is recorded, which is the intended outcome.
   */
  readonly observer?: IsolationObserver;
}

const LOG_CAPACITY = 300;
const STATUS_CACHE_MS = 15_000;
const CAPTURE_RESTART_DELAY_MS = 5_000;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultGateway(): Promise<string | undefined> {
  const configured = process.env.HOMETRUTH_CAMERA_DNS_SERVER?.trim();
  if (configured) return configured;
  try {
    const command = process.platform === "darwin" ? ["route", "-n", "get", "default"] : ["ip", "route", "show", "default"];
    const proc = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return (process.platform === "darwin" ? text.match(/gateway:\s*([0-9.]+)/u) : text.match(/via\s+([0-9.]+)/u))?.[1];
  } catch {
    return undefined;
  }
}

/** The LAN gateway is the resolver the devices use; the workstation may use a public resolver instead, so ask the gateway directly. */
export async function gatewayResolve(domain: string): Promise<readonly string[]> {
  const gateway = await defaultGateway();
  const resolver = new Resolver({ timeout: 2_500, tries: 1 });
  if (gateway) resolver.setServers([gateway]);
  return await resolver.resolve4(domain);
}

/** Parse enough of a TLS ClientHello to name the server it was for. Returns undefined when it is not one. */
export function tlsServerName(bytes: Uint8Array): string | undefined {
  let name: string | undefined;
  const decoder = new PcapStreamDecoder({ clientAddress: "0.0.0.0", onFact: (fact) => { if (fact.kind === "tls_client_hello") name = fact.serverName; } });
  // Wrap the bytes as one raw-IP pcap record from the sentinel address so the same parser serves both paths.
  const ip = new Uint8Array(20 + 20 + bytes.length);
  ip[0] = 0x45; ip[2] = (ip.length >> 8) & 0xff; ip[3] = ip.length & 0xff; ip[9] = 6;
  ip[16] = 0; ip[17] = 0; ip[18] = 0; ip[19] = 0;
  ip[20 + 2] = 0x01; ip[20 + 3] = 0xbb; // dst port 443
  ip[20 + 12] = 0x50; ip[20 + 13] = 0x18; // data offset 20, PSH|ACK (not a SYN, so no tcp_connect fact)
  ip.set(bytes, 40);
  const header = new Uint8Array(24 + 16);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0xa1b2c3d4, true); view.setUint16(4, 2, true); view.setUint16(6, 4, true); view.setUint32(16, 65_535, true); view.setUint32(20, 101, true);
  view.setUint32(24 + 8, ip.length, true); view.setUint32(24 + 12, ip.length, true);
  decoder.push(header);
  decoder.push(ip);
  return name;
}

interface RunningCapture {
  session: PacketCaptureSession | undefined;
  decoder: PcapStreamDecoder;
  stopping: boolean;
  /** When "not on Wi-Fi" was last logged, so the wait is mentioned once, then every ten minutes. */
  waitingLoggedAt?: number | undefined;
  restartTimer?: ReturnType<typeof setTimeout> | undefined;
  /** Where the client was when the capture started; a roam to another AP or radio means the capture must move too. */
  client?: WifiClient | undefined;
}

const ROAM_CHECK_MS = 60_000;

/**
 * The isolation switch: the desired state, the gateway rules that carry it
 * out, and the listeners and captures that make an isolated device's traffic
 * reachable. Not a `Service` — see this module's own note on why.
 */
export class NetworkIsolation {
  private readonly devices: readonly IsolatableDevice[];
  private readonly byId: ReadonlyMap<string, IsolatableDevice>;
  private readonly byHost: ReadonlyMap<string, IsolatableDevice>;
  private readonly interceptors = new Map<string, HttpInterceptor>();
  private readonly store: IsolationStateStore;
  private readonly adapterFactory: () => NetworkAdapter;
  private readonly overrideIpFactory: () => string;
  private readonly resolve: (domain: string) => Promise<readonly string[]>;
  private readonly now: () => number;
  private readonly logger: (event: Record<string, unknown>) => void;
  private readonly httpPort: number;
  private readonly tlsPort: number;
  private readonly listenHost: string;
  private readonly optionsReconcileOnStart: boolean;
  private readonly handOff: NetworkIsolationOptions["handOff"];
  private readonly accessPointCapture: boolean;
  private readonly tlsCertificate: TlsCertificate | (() => Promise<TlsCertificate>) | false;
  private readonly defaultCertificate: NetworkIsolationOptions["defaultCertificate"];
  private tlsMode: "terminating" | "server-name-only" | "off" = "off";
  private readonly observer: IsolationObserver | undefined;
  private readonly changeListeners = new Set<() => void>();
  private state: Record<string, StoredDevice> = {};
  private adapter: NetworkAdapter | undefined;
  private httpServer: ReturnType<typeof Bun.serve> | undefined;
  private httpsServer: ReturnType<typeof Bun.serve> | undefined;
  private tlsServer: TCPSocketListener<{ address: string; chunks: Uint8Array[] }> | undefined;
  private readonly captures = new Map<string, RunningCapture>();
  private current: IsolationStatus | undefined;
  private checkedAtMs = 0;
  private inFlight: Promise<IsolationStatus> | undefined;
  private applying: Promise<void> = Promise.resolve();
  private stopped = false;
  /** Requests and packet facts reported since start, for the settings page. */
  captured = 0;
  private roamTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: NetworkIsolationOptions) {
    this.devices = options.devices;
    this.byId = new Map(options.devices.map((device) => [device.id, device]));
    this.byHost = new Map(options.devices.map((device) => [device.host, device]));
    this.store = options.store ?? new IsolationStateStore();
    this.adapterFactory = options.adapter ?? (() => { throw new NetworkAdapterError("No network adapter is configured", "not_configured"); });
    this.overrideIpFactory = options.overrideIp ?? (() => { throw new NetworkAdapterError("The HomeTruth LAN address is unknown", "not_configured"); });
    this.resolve = options.resolve ?? gatewayResolve;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? ((event) => console.log(JSON.stringify(event)));
    this.httpPort = options.httpPort ?? 80;
    this.tlsPort = options.tlsPort ?? 443;
    this.listenHost = options.listenHost ?? "0.0.0.0";
    this.optionsReconcileOnStart = options.reconcileOnStart ?? true;
    this.handOff = options.handOff;
    this.accessPointCapture = options.accessPointCapture ?? true;
    this.observer = options.observer;
    this.tlsCertificate = options.tlsCertificate ?? (() => selfSignedCertificate(this.allDomains().length > 0 ? this.allDomains() : ["hometruth.local"]));
    this.defaultCertificate = options.defaultCertificate;
  }

  registerInterceptor(interceptor: HttpInterceptor): void {
    for (const hostname of interceptor.hostnames) this.interceptors.set(hostname.toLowerCase(), interceptor);
    this.logger({ event: "isolation_interceptor_registered", interceptor: interceptor.id, hostnames: interceptor.hostnames.join(",") });
  }

  /**
   * Report one event about a device to whoever emulates its cloud. A device
   * with no such service (one that is only jailed) reports nothing: there is
   * no log of its own to write to, by design.
   */
  private report(address: string, type: string, message: string, options: { level?: "info" | "warn" | "error"; data?: Record<string, unknown> } = {}): void {
    this.observer?.observe(address, { type, message, ...options });
  }

  /** The same, addressed by device rather than by LAN address. */
  private reportDevice(device: IsolatableDevice, type: string, message: string, options: { level?: "info" | "warn" | "error"; data?: Record<string, unknown> } = {}): void {
    this.report(device.host, type, message, options);
  }

  /** Called after any change of which devices are isolated. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => { this.changeListeners.delete(listener); };
  }

  isIsolated(deviceId: string): boolean {
    return this.state[deviceId]?.isolated === true;
  }

  /** Whether the device at this LAN address is isolated; false for addresses that are not site devices. */
  isIsolatedAddress(address: string): boolean {
    const device = this.byHost.get(address);
    return device !== undefined && this.isIsolated(device.id);
  }

  isolatedDevices(): readonly IsolatableDevice[] {
    return this.devices.filter((device) => this.isIsolated(device.id));
  }

  deviceAt(address: string): IsolatableDevice | undefined {
    return this.byHost.get(address);
  }

  /**
   * Load the desired state, start the catch-all listeners and reconcile the
   * network to it. On the very first run (no state file) a device whose
   * vendor hostnames already resolve to this server is adopted as isolated,
   * so an existing DNS override keeps working instead of being switched off.
   */
  async start(): Promise<void> {
    const loaded = await this.store.load();
    if (loaded) {
      this.state = loaded;
    } else {
      this.state = {};
      await this.adoptExistingOverrides();
      await this.store.save(this.state);
    }
    await this.startListeners();
    if (this.optionsReconcileOnStart) await this.reconcile("start");
    this.roamTimer = setInterval(() => void this.followRoams().catch(() => undefined), ROAM_CHECK_MS);
    this.logger({ event: "isolation_ready", isolated: this.isolatedDevices().length, devices: this.devices.length });
  }

  /** A capture is bound to one radio interface; when the client has moved (a kick, a roam), restart it where the client is now. */
  private async followRoams(): Promise<void> {
    let adapter: NetworkAdapter;
    try {
      adapter = this.client();
    } catch {
      return;
    }
    if (!adapter.wifi) return;
    for (const [deviceId, running] of [...this.captures]) {
      if (!running.session || !running.client || running.stopping) continue;
      const device = this.byId.get(deviceId);
      if (!device) continue;
      let now: WifiClient | undefined;
      try {
        now = await adapter.wifi.findClientByAddress(device.host);
      } catch {
        continue;
      }
      if (!now?.apMac) continue;
      const moved = now.apMac !== running.client.apMac || now.radio !== running.client.radio || now.ssid !== running.client.ssid || now.vlan !== running.client.vlan;
      if (!moved) continue;
      this.reportDevice(device, "capture_changed", `${device.host} moved to another access point or radio; restarting the capture there`, { data: { state: "moved", where: `${now.apMac} ${now.ssid ?? ""}/${now.radio ?? ""}`.trim() } });
      await this.stopCapture(deviceId);
      await this.startCapture(device);
    }
  }

  private async adoptExistingOverrides(): Promise<void> {
    let overrideIp: string;
    try {
      overrideIp = this.overrideIpFactory();
    } catch {
      return;
    }
    for (const device of this.devices) {
      if (device.cloudHostnames.length === 0) continue;
      const answers = await Promise.all(device.cloudHostnames.map((domain) => this.resolve(domain).catch(() => [] as readonly string[])));
      if (answers.some((list) => list.includes(overrideIp))) {
        this.state[device.id] = { isolated: true, since: new Date(this.now()).toISOString() };
        this.logger({ event: "isolation_adopted", deviceId: device.id, reason: "its vendor hostnames already resolve to HomeTruth" });
      }
    }
  }

  private client(): NetworkAdapter {
    if (!this.adapter) this.adapter = this.adapterFactory();
    return this.adapter;
  }

  private async startListeners(): Promise<void> {
    if (this.httpPort > 0 && !this.httpServer) {
      try {
        this.httpServer = Bun.serve({
          hostname: this.listenHost,
          port: this.httpPort,
          idleTimeout: 30,
          maxRequestBodySize: 32 * 1024 * 1024,
          fetch: (request, server) => this.handleHttp(request, server.requestIP(request)?.address ?? "", "http"),
        });
      } catch (error) {
        this.logger({ event: "isolation_listener_failed", scheme: "http", port: this.httpPort, detail: describeError(error) });
      }
    }
    if (this.tlsPort > 0 && !this.tlsServer && !this.httpsServer && this.tlsCertificate !== false) {
      try {
        const certificate = typeof this.tlsCertificate === "function" ? await this.tlsCertificate() : this.tlsCertificate;
        // Its failure is not the cameras' problem: without it the stand-in certificate is presented to everyone, as before.
        const fallback = await this.defaultCertificate?.().catch((error: unknown) => { this.logger({ event: "isolation_default_certificate_failed", detail: describeError(error) }); return undefined; });
        this.httpsServer = Bun.serve({
          hostname: this.listenHost,
          port: this.tlsPort,
          idleTimeout: 30,
          maxRequestBodySize: 32 * 1024 * 1024,
          // Bun picks by server name: a client naming one of the stand-in's hostnames gets the stand-in certificate,
          // and the first entry is what everyone else gets — a client that connects by address names nothing.
          tls: fallback
            ? [{ key: fallback.key, cert: fallback.cert }, ...certificate.hostnames.map((serverName) => ({ key: certificate.key, cert: certificate.cert, serverName }))]
            : { key: certificate.key, cert: certificate.cert },
          fetch: (request, server) => this.handleHttp(request, server.requestIP(request)?.address ?? "", "https"),
        });
        this.tlsMode = "terminating";
        this.logger({ event: "isolation_tls_standin", port: this.tlsPort, hostnames: certificate.hostnames.join(","), defaultCertificate: Boolean(fallback) });
      } catch (error) {
        this.logger({ event: "isolation_listener_failed", scheme: "https", port: this.tlsPort, detail: describeError(error), fallback: "server names only" });
      }
    }
    if (this.tlsPort > 0 && !this.tlsServer && !this.httpsServer) {
      try {
        this.tlsServer = Bun.listen<{ address: string; chunks: Uint8Array[] }>({
          hostname: this.listenHost,
          port: this.tlsPort,
          socket: {
            open: (socket) => { socket.data = { address: socket.remoteAddress, chunks: [] }; },
            data: (socket, data) => {
              socket.data.chunks.push(new Uint8Array(data));
              const total = socket.data.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
              if (total < 5) return;
              const joined = new Uint8Array(total);
              let offset = 0;
              for (const chunk of socket.data.chunks) { joined.set(chunk, offset); offset += chunk.length; }
              const recordLength = 5 + ((joined[3]! << 8) | joined[4]!);
              if (joined[0] === 0x16 && total < recordLength && total < 16_384) return;
              this.recordTls(socket.data.address, tlsServerName(joined));
              socket.end();
            },
            error: () => undefined,
          },
        });
      } catch (error) {
        this.logger({ event: "isolation_listener_failed", scheme: "tls-sni", port: this.tlsPort, detail: describeError(error) });
      }
      if (this.tlsServer) this.tlsMode = "server-name-only";
    }
  }

  private source(address: string): CaptureSource {
    const device = this.byHost.get(address);
    return device ? { address, device } : { address };
  }

  private recordFor(source: CaptureSource, type: string, message: string, data: Record<string, unknown>, level: "info" | "warn" = "info"): void {
    this.captured += 1;
    this.report(source.address, type, source.device ? message : `${message} (from ${source.address}, not a site device)`, { level, data });
  }

  private recordTls(address: string, serverName: string | undefined): void {
    this.recordFor(this.source(address), "tls_attempt", serverName
      ? `Tried to open TLS to ${serverName} (nothing here can answer; the vendor's certificate is not ours)`
      : "Tried to open TLS without a server name", { ...(serverName ? { serverName } : {}), port: this.tlsPort, accepted: false });
  }

  private async handleHttp(request: Request, address: string, scheme: "http" | "https"): Promise<Response> {
    const source = this.source(address);
    const url = new URL(request.url);
    const host = (request.headers.get("host") ?? url.host).split(":")[0]!.toLowerCase();
    const interceptor = this.interceptors.get(host);
    const data: Record<string, unknown> = { scheme, method: request.method, host, path: url.pathname.slice(0, 400), requestBytes: Number(request.headers.get("content-length") ?? 0), ...(interceptor ? { answeredBy: interceptor.id } : {}) };
    if (interceptor) {
      try {
        const response = await interceptor.handle(request, source);
        if (response) {
          this.recordFor(source, "cloud_request", `${request.method} ${host}${url.pathname.slice(0, 120)} answered by ${interceptor.id} (${response.status})`, { ...data, status: response.status });
          return response;
        }
      } catch (error) {
        this.recordFor(source, "network_error", `${interceptor.id} failed on ${request.method} ${host}${url.pathname.slice(0, 120)}: ${describeError(error)}`, { what: `${interceptor.id} stand-in` }, "warn");
        return new Response("", { status: 500 });
      }
    }
    // Nothing here stands in for this host, so before calling it an unanswered
    // device request, offer it to whoever else shares these ports. A vendor
    // hostname has already won above; this only ever sees what was left. Its
    // failure is its own, never a device's, so it falls through to the 404.
    if (this.handOff) {
      try {
        const response = await this.handOff(request, scheme);
        if (response) return response;
      } catch (error) {
        this.logger({ event: "isolation_handoff_failed", scheme, host, detail: describeError(error) });
      }
    }
    this.recordFor(source, "cloud_request", `${request.method} ${host}${url.pathname.slice(0, 120)} (no stand-in for this host; answered 404)`, { ...data, status: 404 });
    return new Response("", { status: 404 });
  }

  /** Cached status; refreshes in the background once stale. */
  snapshot(): IsolationStatus | undefined {
    if (this.now() - this.checkedAtMs > STATUS_CACHE_MS) void this.refresh().catch(() => undefined);
    return this.current;
  }

  async refresh(): Promise<IsolationStatus> {
    if (this.inFlight) return await this.inFlight;
    this.inFlight = this.check().finally(() => { this.inFlight = undefined; });
    return await this.inFlight;
  }

  /** The DNS records the isolated devices need: domain → device ids. */
  private neededRecords(): Map<string, string[]> {
    const needed = new Map<string, string[]>();
    for (const device of this.isolatedDevices()) {
      for (const domain of device.cloudHostnames) needed.set(domain, [...(needed.get(domain) ?? []), device.id]);
    }
    return needed;
  }

  /** Every domain any device could need, so a record left on for a released device is reported and switched off. */
  private allDomains(): readonly string[] {
    return [...new Set(this.devices.flatMap((device) => device.cloudHostnames))];
  }

  private async check(): Promise<IsolationStatus> {
    const problems: string[] = [];
    let adapter: NetworkAdapter | undefined;
    let adapterName = "none";
    try {
      adapter = this.client();
      adapterName = adapter.name;
    } catch (error) {
      problems.push(describeError(error));
    }
    let overrideIp: string | undefined;
    try {
      overrideIp = this.overrideIpFactory();
    } catch (error) {
      problems.push(describeError(error));
    }
    const needed = this.neededRecords();
    const dns: DnsRecordStatus[] = [];
    for (const domain of this.allDomains()) {
      let record: RuleState = "unavailable";
      if (adapter?.dns && overrideIp) {
        try {
          record = await adapter.dns.describe({ domain, overrideIp });
        } catch (error) {
          problems.push(`DNS record for ${domain}: ${describeError(error)}`);
        }
      }
      let resolvedTo: string | undefined;
      try {
        resolvedTo = (await this.resolve(domain))[0];
      } catch {
        // Unresolvable from here; the record state still says what the gateway is configured to answer.
      }
      dns.push({ domain, overrideIp: overrideIp ?? "", record, ...(resolvedTo ? { resolvedTo } : {}), neededBy: needed.get(domain) ?? [] });
    }
    const devices: DeviceIsolationStatus[] = [];
    for (const device of this.devices) {
      const stored = this.state[device.id];
      const isolated = stored?.isolated === true;
      const mac = stored?.mac;
      let internetBlock: RuleState = "unavailable";
      const notes: string[] = [];
      if (adapter?.internet && mac) {
        try {
          internetBlock = await adapter.internet.describe({ mac, label: device.id });
        } catch (error) {
          notes.push(`internet block: ${describeError(error)}`);
        }
      } else if (isolated && !mac) {
        notes.push(`${device.host} has not been seen on the network yet, so its MAC (and its rule) is unknown`);
      }
      if (isolated && internetBlock !== "on" && internetBlock !== "unavailable") notes.push("wanted isolated but the gateway rule is not on");
      if (!isolated && internetBlock === "on") notes.push("not wanted isolated but the gateway rule is still on");
      const capture = this.captures.get(device.id);
      devices.push({
        deviceId: device.id,
        name: device.name,
        host: device.host,
        isolated,
        ...(mac ? { mac } : {}),
        internetBlock,
        capture: capture?.session ? "running" : (adapter?.capture && this.accessPointCapture ? "stopped" : "unavailable"),
        ...(capture?.session ? { captureWhere: capture.session.where, capturedPackets: capture.decoder.packets } : {}),
        hostnames: device.cloudHostnames,
        ...(notes.length > 0 ? { detail: notes.join("; ") } : {}),
      });
    }
    const status: IsolationStatus = {
      adapter: adapterName,
      ...(overrideIp ? { overrideIp } : {}),
      canIsolate: Boolean(adapter?.internet && adapter.dns),
      dns,
      devices,
      listeners: { ...(this.httpServer ? { http: this.httpPort } : {}), ...(this.tlsServer || this.httpsServer ? { tls: this.tlsPort } : {}) },
      ...(problems.length > 0 ? { detail: problems.join(". ") } : {}),
      checkedAt: new Date(this.now()).toISOString(),
    };
    this.current = status;
    this.checkedAtMs = status.canIsolate ? this.now() : this.now() - STATUS_CACHE_MS + 2_000;
    return status;
  }

  private async lookupMac(device: IsolatableDevice): Promise<string | undefined> {
    const stored = this.state[device.id]?.mac;
    let adapter: NetworkAdapter;
    try {
      adapter = this.client();
    } catch {
      return stored;
    }
    if (!adapter.wifi) return stored;
    try {
      const client = await adapter.wifi.findClientByAddress(device.host);
      if (client?.mac) return client.mac.toLowerCase();
    } catch (error) {
      this.reportDevice(device, "network_error", `Could not look up ${device.host} on the gateway: ${describeError(error)}`, { level: "warn", data: { what: "gateway client lookup" } });
    }
    return stored;
  }

  /**
   * Switch one device's isolation on or off: persist the wish, then bring
   * the gateway rules, DNS records and captures in line with every device's
   * wish. Returns what changed, in words.
   */
  async setIsolated(deviceId: string, isolated: boolean): Promise<{ message: string; status: IsolationStatus }> {
    const device = this.byId.get(deviceId);
    if (!device) throw new NetworkAdapterError(`No device ${deviceId} can be isolated (it has no LAN address in devices.yml)`, "not_configured");
    const adapter = this.client();
    if (!adapter.internet || !adapter.dns) {
      throw new NetworkAdapterError(`The ${adapter.name} network adapter cannot isolate devices (it needs a per-device firewall rule and DNS records)`, "not_supported");
    }
    const mac = await this.lookupMac(device);
    if (isolated && !mac) {
      throw new NetworkAdapterError(`${device.name} (${device.host}) is not on the network right now, so its rule cannot be created; power it on and try again`, "gateway_error");
    }
    const previous = this.state[device.id];
    this.state[device.id] = { isolated, ...(mac ? { mac } : {}), ...(isolated ? { since: new Date(this.now()).toISOString() } : {}) };
    await this.store.save(this.state);
    this.reportDevice(device, "isolation_changed", isolated
      ? `Isolating ${device.name}: blocking ${device.host} from the internet and standing in for ${device.cloudHostnames.length} vendor host${device.cloudHostnames.length === 1 ? "" : "s"}`
      : `Releasing ${device.name} back to the internet`, { data: { isolated, ...(mac ? { mac } : {}), hostnames: [...device.cloudHostnames] } });
    const messages = await this.reconcile(isolated ? "isolate" : "release", device.id);
    if (previous?.isolated !== isolated) for (const listener of this.changeListeners) listener();
    this.checkedAtMs = 0;
    const status = await this.refresh();
    return { message: messages.join(". ") || (isolated ? `${device.name} is isolated` : `${device.name} is released`), status };
  }

  /** Make the network match the desired state. Serialized: one reconcile at a time. */
  async reconcile(reason: string, changedDeviceId?: string): Promise<string[]> {
    const run = this.applying.then(() => this.doReconcile(reason, changedDeviceId));
    this.applying = run.then(() => undefined, () => undefined);
    return await run;
  }

  private async doReconcile(reason: string, changedDeviceId?: string): Promise<string[]> {
    const messages: string[] = [];
    let adapter: NetworkAdapter;
    try {
      adapter = this.client();
    } catch (error) {
      this.logger({ event: "isolation_reconcile_skipped", reason, detail: describeError(error) });
      return messages;
    }
    // 1. Per-device internet blocks.
    for (const device of this.devices) {
      const stored = this.state[device.id];
      const wanted = stored?.isolated === true;
      const mac = stored?.mac ?? (wanted ? await this.lookupMac(device) : undefined);
      if (wanted && mac && stored && !stored.mac) {
        stored.mac = mac;
        await this.store.save(this.state);
      }
      if (!mac || !adapter.internet) continue;
      // A device never isolated has no rule to touch; only a device with a rule (or a wish) is reconciled.
      if (!wanted && stored === undefined) continue;
      try {
        const current = await adapter.internet.describe({ mac, label: device.id });
        const desired: DnsRecordState = wanted ? "on" : "off";
        if (current === desired || (!wanted && current === "missing")) continue;
        const message = await adapter.internet.set({ mac, label: device.id }, wanted ? "on" : "off");
        this.reportDevice(device, "isolation_changed", message, { data: { isolated: wanted, mac, hostnames: [...device.cloudHostnames] } });
        if (device.id === changedDeviceId) messages.push(message);
      } catch (error) {
        const message = `The gateway rule for ${device.name} could not be ${wanted ? "enabled" : "disabled"}: ${describeError(error)}`;
        this.reportDevice(device, "network_error", message, { level: "warn", data: { what: "gateway isolation rule" } });
        if (device.id === changedDeviceId) messages.push(message);
      }
    }
    // 2. DNS records: on for every hostname an isolated device needs, off for the rest.
    if (adapter.dns) {
      let overrideIp: string | undefined;
      try {
        overrideIp = this.overrideIpFactory();
      } catch (error) {
        this.logger({ event: "isolation_dns_skipped", detail: describeError(error) });
      }
      if (overrideIp) {
        const needed = this.neededRecords();
        for (const domain of this.allDomains()) {
          const target: DnsTarget = { domain, overrideIp };
          const wanted = needed.has(domain);
          try {
            const current = await adapter.dns.describe(target);
            if ((wanted && current === "on") || (!wanted && current !== "on")) continue;
            const message = await adapter.dns.set(target, wanted ? "on" : "off");
            this.logger({ event: wanted ? "isolation_dns_on" : "isolation_dns_off", domain, overrideIp, neededBy: (needed.get(domain) ?? []).join(","), reason });
            if (changedDeviceId && (needed.get(domain) ?? []).includes(changedDeviceId) === wanted) messages.push(message);
          } catch (error) {
            const message = `DNS record for ${domain} could not be switched ${wanted ? "on" : "off"}: ${describeError(error)}`;
            this.logger({ event: "isolation_dns_failed", domain, detail: message });
            if (changedDeviceId) messages.push(message);
          }
        }
      }
    }
    // 3. Access-point captures for the isolated devices; stop the others.
    for (const device of this.devices) {
      const wanted = this.isIsolated(device.id) && this.accessPointCapture && adapter.capture !== undefined;
      const running = this.captures.get(device.id);
      if (wanted && !running) await this.startCapture(device);
      if (!wanted && running) await this.stopCapture(device.id);
    }
    // 4. Kick the changed device so it re-resolves DNS and drops its open internet sessions right now.
    if (changedDeviceId && adapter.wifi) {
      const device = this.byId.get(changedDeviceId);
      if (device) {
        try {
          const client = await adapter.wifi.findClientByAddress(device.host);
          if (client) {
            await adapter.wifi.kickClient(client);
            this.reportDevice(device, "disconnected", `Kicked ${device.host} off Wi-Fi so it re-resolves DNS and reconnects under the new rule`);
            setTimeout(() => void this.followRoams().catch(() => undefined), 25_000);
          }
        } catch (error) {
          this.reportDevice(device, "network_error", `Could not kick ${device.host}: ${describeError(error)}`, { level: "warn", data: { what: "Wi-Fi kick" } });
        }
      }
    }
    return messages;
  }

  private async startCapture(device: IsolatableDevice, waitingLoggedAt?: number): Promise<void> {
    let adapter: NetworkAdapter;
    try {
      adapter = this.client();
    } catch {
      return;
    }
    if (!adapter.capture || !adapter.wifi) return;
    const running: RunningCapture = { session: undefined, decoder: this.decoderFor(device), stopping: false, waitingLoggedAt };
    this.captures.set(device.id, running);
    let client: WifiClient | undefined;
    try {
      client = await adapter.wifi.findClientByAddress(device.host);
    } catch (error) {
      this.reportDevice(device, "network_error", `Could not find ${device.host} on the gateway for a capture: ${describeError(error)}`, { level: "warn", data: { what: "packet capture" } });
    }
    if (!client) {
      const previous = this.captures.get(device.id) === running ? running.waitingLoggedAt : undefined;
      if (previous === undefined || this.now() - previous > 10 * 60_000) {
        this.reportDevice(device, "capture_changed", `${device.host} is not on Wi-Fi as far as the gateway can see; the capture starts when it is (checked every 30 s, mentioned every 10 min)`, { level: "warn", data: { state: "waiting" } });
        running.waitingLoggedAt = this.now();
      }
      this.scheduleCaptureRestart(device, running);
      return;
    }
    try {
      running.session = await adapter.capture.start(client, (chunk) => {
        try {
          running.decoder.push(chunk);
        } catch (error) {
          this.reportDevice(device, "network_error", `Capture stream could not be decoded: ${describeError(error)}`, { level: "warn", data: { what: "packet capture decoding" } });
        }
      }, (error) => {
        running.session = undefined;
        if (running.stopping || this.stopped) return;
        this.reportDevice(device, "capture_changed", error ? `Capture ended: ${error.message}` : "Capture ended (the access point's time cap elapsed); restarting", { level: error ? "warn" : "info", data: { state: "ended" } });
        running.decoder = this.decoderFor(device);
        this.scheduleCaptureRestart(device, running);
      });
      running.client = client;
      this.reportDevice(device, "capture_changed", `Capturing ${device.host}'s packets at ${running.session.where}`, { data: { state: "started", where: running.session.where } });
      this.logger({ event: "isolation_capture_started", deviceId: device.id, where: running.session.where });
    } catch (error) {
      this.reportDevice(device, "network_error", `Could not start a capture for ${device.host}: ${describeError(error)}`, { level: "warn", data: { what: "packet capture" } });
      this.scheduleCaptureRestart(device, running);
    }
  }

  private scheduleCaptureRestart(device: IsolatableDevice, running: RunningCapture): void {
    if (running.restartTimer) clearTimeout(running.restartTimer);
    running.restartTimer = setTimeout(() => {
      running.restartTimer = undefined;
      if (running.stopping || this.stopped || !this.isIsolated(device.id)) return;
      this.captures.delete(device.id);
      void this.startCapture(device, running.waitingLoggedAt);
    }, CAPTURE_RESTART_DELAY_MS * 6);
  }

  private async stopCapture(deviceId: string): Promise<void> {
    const running = this.captures.get(deviceId);
    if (!running) return;
    running.stopping = true;
    if (running.restartTimer) clearTimeout(running.restartTimer);
    this.captures.delete(deviceId);
    await running.session?.stop();
    const stopped = this.byId.get(deviceId);
    if (stopped) this.reportDevice(stopped, "capture_changed", "Packet capture stopped", { data: { state: "stopped" } });
  }

  private decoderFor(device: IsolatableDevice): PcapStreamDecoder {
    return new PcapStreamDecoder({
      clientAddress: device.host,
      onFact: (fact) => {
        this.captured += 1;
        const described = describeFact(fact, this.overrideIpSafe());
        this.reportDevice(device, described.type, described.message, { data: described.data });
      },
    });
  }

  private overrideIpSafe(): string | undefined {
    try {
      return this.overrideIpFactory();
    } catch {
      return undefined;
    }
  }

  /** One line about what isolation is doing, for the settings page. */
  summary(): string {
    const isolated = this.isolatedDevices().length;
    const status = this.current;
    const listeners = [this.httpServer ? `:${this.httpPort}` : undefined, this.httpsServer ? `:${this.tlsPort} (TLS stand-in)` : this.tlsServer ? `:${this.tlsPort} (server names only)` : undefined].filter(Boolean).join(" and ");
    const problems = status?.detail ? ` — ${status.detail}` : "";
    return `${isolated} of ${this.devices.length} devices isolated; ${status ? `${status.dns.filter((record) => record.record === "on").length} DNS override${status.dns.filter((record) => record.record === "on").length === 1 ? "" : "s"} on` : "not checked yet"}; stand-in listeners on ${listeners || "no ports"}${problems}`;
  }

  /**
   * Closes HomeTruth's side of isolation: the captures and the stand-in
   * listeners. The gateway rules and DNS overrides are deliberately left in
   * place — a device that was blocked stays blocked, now with nothing
   * answering it — so the closing line counts what is left that way rather
   * than claiming isolation ended.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.roamTimer) clearInterval(this.roamTimer);
    const capturesStopped = this.captures.size;
    for (const deviceId of [...this.captures.keys()]) await this.stopCapture(deviceId);
    const listenersClosed = [
      this.httpServer ? `http:${this.httpPort}` : undefined,
      this.httpsServer ? `https:${this.tlsPort}` : this.tlsServer ? `tls-sni:${this.tlsPort}` : undefined,
    ].filter(Boolean).join(",");
    this.httpServer?.stop(true);
    this.httpServer = undefined;
    this.httpsServer?.stop(true);
    this.httpsServer = undefined;
    this.tlsServer?.stop(true);
    this.tlsServer = undefined;
    const isolated = this.isolatedDevices().length;
    this.logger({
      event: "isolation_stopped",
      listenersClosed: listenersClosed || "none",
      capturesStopped,
      isolated,
      devices: this.devices.length,
      note: isolated === 0
        ? "no device is blocked"
        : isolated === 1
          ? "1 device stays blocked with nothing answering it"
          : `${isolated} devices stay blocked with nothing answering them`,
    });
  }
}

/** Addresses a device may always reach: this machine, the LAN it sits on, broadcast and multicast. The isolation rule only blocks the public internet. */
function isLocalDestination(destination: string, overrideIp: string | undefined): boolean {
  if (destination === overrideIp) return true;
  const parts = destination.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [first, second] = parts as [number, number, number, number];
  return first === 10
    || first === 127
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 169 && second === 254)
    || first >= 224;
}

/** One captured packet fact as an event: its catalog type, a sentence, and the type's own fields. */
export function describeFact(fact: PacketFact, overrideIp: string | undefined): { type: string; message: string; data: Record<string, unknown> } {
  const here = (destination: string) => destination === overrideIp;
  const local = (destination: string) => isLocalDestination(destination, overrideIp);
  switch (fact.kind) {
    case "dns_query":
      return { type: "dns_lookup", message: `Looked up ${fact.name} (via ${fact.server})`, data: { name: fact.name, resolver: fact.server } };
    case "dns_answer":
      return { type: "dns_lookup", message: `${fact.name} answered ${fact.addresses.join(", ")}`, data: { name: fact.name, addresses: [...fact.addresses] } };
    case "tls_client_hello":
      return {
        type: "tls_attempt",
        message: `TLS to ${fact.serverName} at ${fact.destination}:${fact.port}${here(fact.destination) ? " (this server)" : local(fact.destination) ? " (on the local network)" : " (blocked by the isolation rule)"}`,
        data: { serverName: fact.serverName, destination: fact.destination, port: fact.port, accepted: local(fact.destination) },
      };
    case "http_request":
      return {
        type: "cloud_request",
        message: `${fact.method} ${fact.host || fact.destination}${fact.path.slice(0, 120)} at ${fact.destination}:${fact.port}`,
        data: { method: fact.method, host: fact.host || fact.destination, path: fact.path.slice(0, 400), scheme: "http" },
      };
    case "tcp_connect":
      return {
        type: "connection",
        message: `${fact.resumed ? "Kept sending on an existing TCP session to" : "Opened TCP to"} ${fact.destination}:${fact.port}${here(fact.destination) ? " (this server)" : local(fact.destination) ? " (on the local network)" : " (blocked by the isolation rule)"}`,
        data: { protocol: "tcp", destination: fact.destination, port: fact.port, ...(fact.resumed ? { resumed: true } : {}), blocked: !local(fact.destination) },
      };
    case "udp_send":
      return {
        type: "connection",
        message: `Sent UDP to ${fact.destination}:${fact.port}${here(fact.destination) ? " (this server)" : local(fact.destination) ? " (on the local network)" : fact.port === 123 ? " (NTP time sync, blocked by the isolation rule)" : " (blocked by the isolation rule)"}`,
        data: { protocol: "udp", destination: fact.destination, port: fact.port, blocked: !local(fact.destination), ...(fact.port === 123 ? { note: "NTP time sync" } : {}) },
      };
  }
}
