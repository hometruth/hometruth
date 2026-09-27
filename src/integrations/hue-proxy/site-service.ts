import type { SecretsFile } from "../../schemas";
import { secretsFor } from "../../config/secrets";
import { localAddressFor } from "../../network/local-address";
import { EventLog, type EventFilter, type ServiceEventListener } from "../../models/event-log";
import { Service, type ServiceAction, type ServiceEndpoint, type ServiceStatus } from "../../models/service";
import { bridgeCredentials, loadProxyConfig, parseProxyConfig, type ProxyConfig } from "./config";
import { buildDtls } from "./build-dtls";
import { HUE_CLIENT_PATH, HueProxyService, type HueProxyOptions, type LinkButtonState } from "./service";
import { ensureCertificate, loadStorage } from "./storage";

export const DEFAULT_HUE_PROXY_CONFIG_PATH = "hue-proxy.yml";
export interface HueProxySiteOptions {
  secrets: SecretsFile;
  configPath?: string;
  enabled?: boolean;
  /** Bind dedicated ports alongside the camera isolation listeners on 80/443. */
  address?: string;
  httpPort?: number;
  httpsPort?: number;
  exists?: (path: string) => Promise<boolean>;
  loadConfig?: typeof loadProxyConfig;
  buildHelper?: typeof buildDtls;
  createRuntime?: (options: HueProxyOptions) => HueProxyService;
}

/** A first-class site service, visible even when disabled or startup fails. */
export class HueProxySiteService extends Service {
  private readonly log = new EventLog(500);
  private runtime: HueProxyService | undefined;
  private unsubscribe: (() => void) | undefined;
  private state: ServiceStatus = { availability: "unknown", detail: "Starting Hue bridge proxy" };
  private task: Promise<void> | undefined;
  private stopping = false;
  private endpoint = "";

  private readonly exists: (path: string) => Promise<boolean>;

  constructor(private readonly options: HueProxySiteOptions) {
    super("hue-proxy", "Hue bridge proxy");
    this.exists = options.exists ?? (path => Bun.file(path).exists());
  }
  override status(): ServiceStatus {
    if (!this.runtime) return this.state;
    const status = this.runtime.status();
    const lights = [...this.runtime.tracker.resources.values()].filter(resource => resource.type === "light").length;
    const pairing = this.runtime.linkButton();
    return { availability: status.availability, detail: `${this.endpoint}; ${lights} lights observed; ${status.detail}; pairing ${pairing.open ? `open for ${Math.ceil(pairing.msRemaining / 1000)}s` : "closed"}` };
  }

  /** How much longer this bridge accepts pairing, so a page can paint the real state before any press. */
  linkButton(): LinkButtonState { return this.runtime?.linkButton() ?? { open: false, msRemaining: 0 }; }

  /**
   * Serves a request belonging to the Hue API, so this bridge can answer on a
   * port another listener already holds. A Hue client ignores the port a
   * discovery response advertises and goes to 80/443 regardless, so being
   * reachable there is the difference between being found and being skipped.
   * Undefined means the path is not ours and the caller should carry on.
   */
  async serve(request: Request): Promise<Response | undefined> {
    const runtime = this.runtime;
    if (!runtime || !HUE_CLIENT_PATH.test(new URL(request.url).pathname)) return undefined;
    return await runtime.handle(request);
  }

  /**
   * The virtual link button. A Hue client pairs by asking every bridge it
   * found until one accepts, so without this the real bridge is always the one
   * that answers and this one can never win a client.
   */
  override get actions(): readonly ServiceAction[] {
    const runtime = this.runtime;
    if (!runtime) return [];
    return [{
      id: "link-button",
      state: () => {
        const { open, until } = runtime.linkButton();
        return open && until ? { until } : {};
      },
      invoke: async () => {
        const state = runtime.pressLinkButton();
        return { detail: `Pairing open for ${Math.ceil(state.msRemaining / 1000)}s` };
      },
    }];
  }

  /** What the bridge is joined to: the paired clients on one side, the real Hue bridge on the other. */
  override get endpoints(): readonly ServiceEndpoint[] {
    if (!this.runtime) return [];
    const { clients, bridge } = this.runtime.connectionSummary();
    return [
      ...clients.map((client): ServiceEndpoint => ({ direction: "in", label: client.label, ...(client.streaming ? { active: true } : {}) })),
      // The real bridge serves its own page at its address — the honest "click to see what it reaches".
      { direction: "out", label: "Hue bridge", detail: `${bridge.host} · ${bridge.lights} lights`, href: `http://${bridge.host}/`, active: bridge.connected },
    ];
  }
  override events(limit?: number, filter?: EventFilter) { return this.log.recent(limit, filter); }
  override subscribe(listener: ServiceEventListener, filter?: EventFilter) { return this.log.subscribe(listener, filter); }
  start(): Promise<void> { return this.task ??= this.initialize(); }

  /**
   * The proxy's configuration: the file when there is one, otherwise the
   * secrets file plus this machine's address. `offline` is the reason there is
   * nothing to run, worded for the services page.
   */
  private async resolveConfig(): Promise<ProxyConfig | { offline: string }> {
    if (this.options.enabled === false) return { offline: "Disabled by HUE_PROXY_ENABLED=0" };
    const path = this.options.configPath ?? DEFAULT_HUE_PROXY_CONFIG_PATH;
    const configured = this.options.configPath !== undefined || await this.exists(path);
    const hue = secretsFor(this.options.secrets, "vendors", "hue");
    if (!configured && (typeof hue.host !== "string" || typeof hue.applicationKey !== "string" || !hue.applicationKey)) {
      return { offline: "Set vendors.hue.host and vendors.hue.applicationKey in .hometruth/secrets.yml to connect a Hue bridge" };
    }
    const address = this.options.address ?? localAddressFor(typeof hue.host === "string" ? [hue.host] : []);
    if (!configured && !address) throw new Error("No LAN address found; set HUE_PROXY_ADDRESS");
    return configured ? await (this.options.loadConfig ?? loadProxyConfig)(path) : parseProxyConfig({
      bridge: { url: `https://${hue.host}` },
      listen: { host: address, advertiseAddress: address, httpPort: this.options.httpPort ?? 9080, httpsPort: this.options.httpsPort ?? 9443 },
      targets: [], routes: [],
    });
  }

  /**
   * What a Hue client must see on port 443: a certificate whose CN and serial
   * are this bridge's id, which is what a client checks before it will pair.
   * That port is held by the stand-in listener for the cameras, so it asks
   * here for what to present to a client that names no vendor hostname.
   * Undefined when there is no bridge to present, so the listener carries on
   * exactly as it did without one.
   */
  async tlsIdentity(): Promise<{ key: string; cert: string } | undefined> {
    try {
      const config = await this.resolveConfig();
      if ("offline" in config) return undefined;
      const storage = await loadStorage(config.stateDirectory);
      const paths = await ensureCertificate(config.stateDirectory, storage.identity.bridgeId, config.listen.advertiseAddress);
      return { key: await Bun.file(paths.key).text(), cert: await Bun.file(paths.cert).text() };
    } catch (error) {
      this.log.record("hue_proxy", `No certificate to present on port 443: ${error instanceof Error ? error.message : "unknown error"}`, { level: "warn" });
      return undefined;
    }
  }

  private async initialize(): Promise<void> {
    try {
      const config = await this.resolveConfig();
      if ("offline" in config) {
        this.state = { availability: "offline", detail: config.offline };
        return;
      }
      const credentials = await bridgeCredentials(config, this.options.secrets);
      if (config.entertainment.enabled && !await this.exists(config.entertainment.helperPath)) await (this.options.buildHelper ?? buildDtls)(config.entertainment.helperPath);
      if (this.stopping) return;
      this.endpoint = `HTTP ${config.listen.advertiseAddress}:${config.listen.httpPort}, HTTPS :${config.listen.httpsPort}`;
      const runtime = (this.options.createRuntime ?? (options => new HueProxyService(options)))({ config, ...credentials });
      this.runtime = runtime;
      this.unsubscribe = runtime.subscribe(event => this.log.record(event.type, event.message, {
        level: event.level, ...(event.subject ? { subject: event.subject } : {}), ...(event.data ? { data: event.data } : {}),
      }));
      await runtime.start();
    } catch (error) {
      await this.runtime?.stop();
      this.unsubscribe?.(); this.unsubscribe = undefined; this.runtime = undefined;
      const detail = error instanceof Error ? error.message : "Unknown startup error";
      this.state = { availability: "offline", detail: `Hue proxy could not start: ${detail}` };
      this.log.record("hue_proxy", this.state.detail, { level: "error" });
    }
  }
  override async stop(): Promise<void> {
    this.stopping = true;
    await this.task;
    await this.runtime?.stop();
    this.unsubscribe?.(); this.unsubscribe = undefined; this.runtime = undefined;
    this.state = { availability: "offline", detail: "Hue bridge proxy stopped" };
  }
}
