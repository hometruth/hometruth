import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { EventLog, type EventFilter, type ServiceEventListener } from "../../models/event-log";
import { Service, type ServiceStatus } from "../../models/service";
import { environmentSecret, type HueEvent, type ProxyConfig } from "./config";
import { Discovery, description } from "./discovery";
import { Destinations, Fanout, sleep, type Deliver } from "./fanout";
import { DtlsEndpoint } from "./dtls";
import { OpensslHueReceiver } from "./openssl-server";
import { LightStateTracker, parseHueStream, type Resource } from "./state";
import { readSse } from "./sse";
import { ensureCertificate, loadStorage, privateJson, type ProxyStorage } from "./storage";

declare module "../../models/device" { interface SiteServices { hueProxy?: Service } }
/**
 * A real bridge gives about 30s, because you are standing at it when you press
 * it. This button is pressed wherever HomeTruth is, and the client is wherever
 * it is — a TV two rooms away, driven by a remote — so the window has to cover
 * walking there and working through a setup flow, not just the pairing call.
 */
export const LINK_BUTTON_WINDOW_MS = 300_000;
export interface LinkButtonState { open: boolean; msRemaining: number; until?: string }
/**
 * What a Hue client asks for. Clients reach a bridge on port 80/443 whatever
 * a discovery response says its port is, so this bridge has to answer there —
 * and something else on this host may already hold those ports. Matching only
 * these paths lets it share them, and deliberately leaves out /healthz and
 * /hometruth, which belong to this service rather than to the Hue API.
 */
export const HUE_CLIENT_PATH = /^\/(?:description\.xml$|api(?:\/|$)|clip\/v2(?:\/|$)|eventstream\/clip\/v2(?:\/|$)|auth\/v1(?:\/|$))/u;
const hopHeaders = ["host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length", "content-encoding"];
function cleanHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  for (const name of (input.get("connection") ?? "").split(",")) if (name.trim()) headers.delete(name.trim());
  for (const name of hopHeaders) headers.delete(name);
  return headers;
}
export function redactPath(path: string): string { return path.replace(/^\/api\/[^/]+/u, "/api/:key"); }
function accepted(payload: any, response: Response): boolean {
  return response.ok && !(Array.isArray(payload) ? payload.some(r => r?.error) : Array.isArray(payload?.errors) && payload.errors.length);
}
/** The TV-facing end of a relay: openssl s_server in production, a DtlsEndpoint in tests, sharing this surface. */
interface ReceiverEndpoint {
  readonly ready: Promise<void>;
  readonly connected: Promise<void>;
  cipher: string | undefined;
  send(frame: Uint8Array): void;
  stop(): Promise<void>;
}
interface Streaming {
  identity: string;
  path: string;
  stopBody: unknown;
  area: string;
  receiver: ReceiverEndpoint;
  sender?: DtlsEndpoint;
  lastFrameAt: number;
  startedAt: number;
  /** Frames relayed from the TV to the real bridge; zero at teardown means the TV never actually streamed. */
  frames: number;
  closing?: Promise<void>;
  /** Why it is being torn down, for the log — which leg went, and the helper's last handshake stage. */
  cause?: string;
  watchdog?: ReturnType<typeof setInterval>;
}

export interface HueProxyOptions {
  config: ProxyConfig;
  applicationKey: string;
  clientKey?: string;
  fetch?: typeof fetch;
  deliver?: Deliver;
}

export class HueProxyService extends Service {
  private readonly log = new EventLog(500);
  private readonly destinations: Destinations;
  readonly fanout: Fanout;
  readonly tracker: LightStateTracker;
  private readonly controller = new AbortController();
  private readonly fetchImpl: typeof fetch;
  private readonly listeners = new Set<(event: HueEvent) => void>();
  private readonly history: HueEvent[] = [];
  private storage!: ProxyStorage;
  private http: ReturnType<typeof Bun.serve> | undefined;
  private https: ReturnType<typeof Bun.serve> | undefined;
  private discovery: Discovery | undefined;
  private monitorTask: Promise<void> | undefined;
  private pollTask: Promise<void> | undefined;
  private streamConnected = false;
  private lastSync = 0;
  private revision = 0;
  private streaming: Streaming | undefined;
  private entertainmentTask: Promise<unknown> = Promise.resolve();
  /** The in-flight background connect of the upstream leg to the real bridge, so shutdown can await it. */
  private senderTask: Promise<void> = Promise.resolve();
  private saveTask: Promise<void> = Promise.resolve();
  private refreshTask: Promise<void> | undefined;
  private readonly replayIds = new Set<string>();
  private started = false;
  private stopping: Promise<void> | undefined;
  /** Epoch ms until which this bridge answers pairing, as a real bridge does for ~30s after its button. */
  private pairingUntil = 0;

  constructor(private readonly options: HueProxyOptions) {
    super("hue-proxy", "Hue bridge proxy");
    this.fetchImpl = options.fetch ?? fetch;
    this.destinations = new Destinations(this.fetchImpl);
    this.fanout = new Fanout(options.config, options.deliver ?? this.destinations.deliver, target => this.record("Delivery failed", "warn", { target }));
    this.tracker = new LightStateTracker(event => this.emit(event));
  }
  private get config() { return this.options.config; }
  private record(message: string, level: "info" | "warn" | "error" = "info", data: Record<string, unknown> = {}) { this.log.record("hue_proxy", message, { level, data }); }
  override events(limit?: number, filter?: EventFilter) { return this.log.recent(limit, filter); }
  override subscribe(listener: ServiceEventListener, filter?: EventFilter) { return this.log.subscribe(listener, filter); }
  override status(): ServiceStatus {
    const healthy = this.started && (!this.config.monitor.enabled || this.streamConnected || Date.now() - this.lastSync < this.config.monitor.pollIntervalMs * 3);
    return { availability: healthy ? "online" : "offline", detail: `${this.started ? "Listening" : "Stopped"}; bridge events ${this.streamConnected ? "connected" : this.lastSync ? "polling" : "unavailable"}; Entertainment ${this.streaming ? "active" : "idle"}` };
  }
  snapshot() { return { ...this.status(), httpPort: this.http?.port, httpsPort: this.https?.port, bridgeId: this.storage?.identity.bridgeId, streamConnected: this.streamConnected, lastSync: this.lastSync || null, entertainment: !!this.streaming, destinations: this.fanout.status() }; }
  private emit(event: HueEvent): void {
    this.history.push(event);
    if (this.history.length > 500) this.history.shift();
    this.fanout.publish(event, this.tracker.aliases(event.source));
    for (const listener of this.listeners) { try { listener(event); } catch {} }
    // A light's every colour change belongs to the /hometruth stream and the routing above, not the service log:
    // the log is for connections and lifecycle, which a flood of colour would bury. The full history stays at /hometruth/events.
  }
  async start(): Promise<void> {
    if (this.started || this.controller.signal.aborted) throw new Error("Create a new Hue proxy service for each run");
    this.storage = await loadStorage(this.config.stateDirectory);
    for (const target of this.config.targets) for (const name of [target.tokenEnv, target.usernameEnv, target.passwordEnv]) environmentSecret(name);
    if (this.options.clientKey) this.storage.keys[this.options.applicationKey] = this.options.clientKey;
    if (this.config.entertainment.enabled && !await Bun.file(this.config.entertainment.helperPath).exists()) throw new Error("Build the DTLS helper first: bun run hue:proxy:build");
    const certificate = await ensureCertificate(this.config.stateDirectory, this.storage.identity.bridgeId, this.config.listen.advertiseAddress);
    const settings = { hostname: this.config.listen.host, maxRequestBodySize: 2_000_000, idleTimeout: 0 as const, fetch: (request: Request) => this.handle(request) };
    try {
      this.http = Bun.serve({ ...settings, port: this.config.listen.httpPort });
      this.https = Bun.serve({ ...settings, port: this.config.listen.httpsPort, tls: { cert: Bun.file(certificate.cert), key: Bun.file(certificate.key) } });
      if (this.config.listen.discovery) {
        this.discovery = new Discovery(this.config, this.storage.identity, () => this.record("Discovery socket error", "warn"));
        await this.discovery.start();
      }
      this.started = true;
      this.record("Hue proxy started");
      if (this.config.monitor.enabled) {
        await this.refresh(false).catch(() => this.record("Bridge inventory unavailable; retrying", "warn"));
        this.monitorTask = this.monitor();
        this.pollTask = this.poll();
      }
    } catch (error) { await this.stop(); throw error; }
  }

  /** All client credentials stay intact; registration uses the real link button. */
  private async upstream(path: string, init: RequestInit = {}, stream = false): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const signal = AbortSignal.any([this.controller.signal, controller.signal, ...(init.signal ? [init.signal] : [])]);
    try {
      const response = await this.fetchImpl(`${this.config.bridge.url}${path}`, { ...init, signal, redirect: "manual", tls: { rejectUnauthorized: this.config.bridge.verifyTls } } as RequestInit);
      // Ordinary responses keep the deadline through body consumption. Streams
      // only time out the connection, then follow caller/service cancellation.
      if (stream) clearTimeout(timer);
      timer.unref();
      return response;
    } catch (error) { clearTimeout(timer); throw error; }
  }
  refresh(publish = true): Promise<void> {
    return this.refreshTask ??= this.readInventory(publish).finally(() => { this.refreshTask = undefined; });
  }
  private async readInventory(publish: boolean): Promise<void> {
    const revision = this.revision;
    const response = await this.upstream("/clip/v2/resource", { headers: { "hue-application-key": this.options.applicationKey } });
    const payload = await response.json() as any;
    if (!accepted(payload, response) || !Array.isArray(payload.data)) throw new Error("Bridge inventory unavailable");
    // Never replace a newer SSE update with an in-flight snapshot.
    if (revision === this.revision) this.tracker.snapshot(payload.data, publish);
    this.lastSync = Date.now();
  }
  private async poll(): Promise<void> {
    while (!this.controller.signal.aborted) {
      await sleep(this.config.monitor.pollIntervalMs, this.controller.signal);
      if (this.controller.signal.aborted) break;
      await this.refresh().catch(() => this.record("Bridge inventory refresh failed", "warn"));
    }
  }
  private async monitor(): Promise<void> {
    let failures = 0, lastEventId: string | undefined;
    while (!this.controller.signal.aborted) {
      try {
        const response = await this.upstream("/eventstream/clip/v2", { headers: { "hue-application-key": this.options.applicationKey, accept: "text/event-stream", ...(lastEventId ? { "last-event-id": lastEventId } : {}) } }, true);
        if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) { await response.body?.cancel(); throw new Error("Event stream unavailable"); }
        this.streamConnected = true;
        failures = 0;
        this.record("Bridge event stream connected");
        await readSse(response.body, (data, id) => {
          if (id) lastEventId = id;
          try { this.ingestEvents(JSON.parse(data)); } catch { this.record("Invalid bridge event ignored", "warn"); }
        }, this.controller.signal);
      } catch { if (!this.controller.signal.aborted) this.record("Bridge event stream disconnected; reconnecting", "warn"); }
      this.streamConnected = false;
      if (this.controller.signal.aborted) break;
      await sleep(Math.min(30_000, this.config.monitor.reconnectMs * 2 ** Math.min(failures++, 4)), this.controller.signal);
    }
  }
  ingestEvents(envelopes: unknown): void {
    if (!Array.isArray(envelopes)) return;
    for (const envelope of envelopes) {
      if (!envelope || !Array.isArray(envelope.data)) continue;
      if (typeof envelope.id === "string") {
        if (this.replayIds.has(envelope.id)) continue;
        this.replayIds.add(envelope.id);
        if (this.replayIds.size > 2000) this.replayIds.delete(this.replayIds.values().next().value!);
      }
      this.revision++;
      for (const resource of envelope.data as Resource[]) {
        if (typeof resource?.id !== "string" || typeof resource.type !== "string") continue;
        if (envelope.type === "delete") { this.tracker.resources.delete(resource.id); this.tracker.states.delete(`light/${resource.id}`); }
        else this.tracker.ingest(resource);
        this.emit(this.tracker.event("resource", "bridge", `resource/${resource.type}/${resource.id}`, { data: { type: envelope.type, creationtime: envelope.creationtime, resource } }));
      }
      this.lastSync = Date.now();
    }
  }

  /** Opens the pairing window: the virtual equivalent of pressing a real bridge's link button. */
  pressLinkButton(windowMs = LINK_BUTTON_WINDOW_MS): LinkButtonState {
    this.pairingUntil = Date.now() + windowMs;
    this.record("Link button pressed; this bridge is accepting pairing", "info", { windowMs });
    return this.linkButton();
  }
  /** Whether a client may pair right now, and for how much longer. */
  linkButton(): LinkButtonState {
    const msRemaining = Math.max(0, this.pairingUntil - Date.now());
    return { open: msRemaining > 0, msRemaining, ...(msRemaining > 0 ? { until: new Date(this.pairingUntil).toISOString() } : {}) };
  }
  /**
   * The two ends of the bridge, for the service page: the clients paired to it
   * (its own upstream credential is not one of them) and the real bridge it
   * fronts. `streaming` marks the client that owns the Entertainment relay now.
   */
  connectionSummary(): { clients: { label: string; streaming: boolean }[]; bridge: { host: string; connected: boolean; lights: number } } {
    const streamingId = this.streaming?.identity;
    const clients = Object.keys(this.storage?.keys ?? {})
      .filter(id => id !== this.options.applicationKey)
      .map(id => ({ label: this.storage.labels?.[id] ?? `client ${id.slice(0, 8)}`, streaming: id === streamingId }));
    const lights = [...(this.storage ? this.tracker.resources.values() : [])].filter(resource => resource.type === "light").length;
    return { clients, bridge: { host: new URL(this.config.bridge.url).hostname, connected: this.streamConnected, lights } };
  }
  /**
   * Answers pairing here instead of relaying it upstream. A relayed
   * registration needs the real bridge's physical button, and whoever pressed
   * it would hold a credential issued by the real bridge — so the real bridge
   * wins the client, not this one. Minting locally lets this bridge accept on
   * its own; upstream is reached with the key already in the secrets file.
   */
  private async pair(body: any): Promise<Response> {
    if (!body || typeof body.devicetype !== "string" || !body.devicetype) {
      return Response.json([{ error: { type: 1, address: "/", description: "body contains invalid json" } }]);
    }
    if (!this.linkButton().open) {
      // Worth a line: it is the difference between a client that never found this bridge and one that found it while the window was shut.
      this.record("Pairing refused: link button not pressed", "info", { devicetype: body.devicetype.slice(0, 80) });
      return Response.json([{ error: { type: 101, address: "/", description: "link button not pressed" } }]);
    }
    const username = randomBytes(20).toString("hex");
    const clientkey = randomBytes(16).toString("hex").toUpperCase();
    this.storage.keys[username] = clientkey;
    // The client's own name for itself ("Hue Sync#Samsung TV"), so the page can say who is paired rather than show a random id.
    (this.storage.labels ??= {})[username] = body.devicetype.slice(0, 80);
    // Persist before answering: a credential this bridge has forgotten would leave the client unable to stream, with no way back but pairing again.
    this.saveTask = this.saveTask.catch(() => undefined).then(() => privateJson(join(this.config.stateDirectory, "bridge.json"), this.storage));
    await this.saveTask;
    this.record("Hue client paired with this bridge", "info", { devicetype: body.devicetype.slice(0, 80) });
    return Response.json([{ success: { username, ...(body.generateclientkey === true ? { clientkey } : {}) } }]);
  }
  /**
   * A credential minted here means nothing upstream: the real bridge only
   * knows the configured application key. Swap it in on the way out, for both
   * the v2 header and the v1 path segment, leaving anything else untouched.
   */
  private translate(fullPath: string, init: RequestInit): string {
    const headers = init.headers as Headers;
    const presented = headers.get("hue-application-key");
    if (presented && Object.hasOwn(this.storage.keys, presented)) headers.set("hue-application-key", this.options.applicationKey);
    return fullPath.replace(/^\/api\/([^/]+)/u, (match, user: string) => Object.hasOwn(this.storage.keys, user) ? `/api/${this.options.applicationKey}` : match);
  }

  private authorized(request: Request): boolean { return request.headers.get("hue-application-key") === this.options.applicationKey; }
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/healthz") return Response.json(this.snapshot());
    if (path.startsWith("/hometruth/")) {
      if (!this.authorized(request)) return new Response("Unauthorized", { status: 401 });
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      if (path === "/hometruth/events") return Response.json(this.history);
      if (path === "/hometruth/sources") return Response.json([...this.tracker.resources.values()].map(r => ({ source: r.type === "light" ? `light/${r.id}` : `resource/${r.type}/${r.id}`, name: r.metadata?.name, aliases: r.type === "light" ? this.tracker.aliases(`light/${r.id}`) : [], ...(r.type === "entertainment_configuration" ? { channels: r.channels?.map((c: any) => ({ source: `entertainment/${r.id}/${c.channel_id}`, members: c.members })) } : {}) })));
      if (path === "/hometruth/stream") return this.eventStream(request);
      return new Response("Not found", { status: 404 });
    }
    if (path === "/description.xml" && request.method === "GET") {
      // The first thing a discovering client fetches, so this is the earliest proof one has found this bridge at all.
      // The origin says which listener it came through: the advertised port, or 80/443 shared with the stand-in.
      this.record("A client read this bridge's description", "info", { path: `${url.origin}${path}` });
      return new Response(description(this.config, this.storage.identity), { headers: { "content-type": "application/xml" } });
    }
    if (!/^\/(?:api(?:\/|$)|clip\/v2(?:\/|$)|eventstream\/clip\/v2(?:\/|$)|auth\/v1(?:\/|$))/u.test(path)) return new Response("Not found", { status: 404 });
    // The unauthenticated config read is how a client decides whether this bridge is one it will pair with, so it
    // is the last thing seen from a client that then walks away — worth knowing it happened, and on which port.
    if (request.method === "GET" && /^\/api\/(?:0\/|nouser\/)?config\/?$/u.test(path)) this.record("A client read this bridge's config", "info", { path: `${url.origin}${path}` });
    const isStream = path.startsWith("/eventstream/");
    // Connections worth a line: opening the event stream, and starting/stopping Entertainment — not the client's frequent auth/config heartbeats.
    if (isStream) this.record("Client opened the event stream", "info", { path: redactPath(path) });
    try {
      if (request.method === "TRACE" || request.method === "CONNECT") return new Response("Method not allowed", { status: 405 });
      const body = ["GET", "HEAD"].includes(request.method) ? undefined : new Uint8Array(await request.arrayBuffer());
      if (body && body.length > 2_000_000) return new Response("Body too large", { status: 413 });
      const parsed = body?.length ? (() => { try { return JSON.parse(new TextDecoder().decode(body)); } catch { return undefined; } })() : undefined;
      // Pairing is answered here, never relayed: see pair().
      if (request.method === "POST" && /^\/api\/?$/u.test(path)) return this.pair(parsed);
      const headers = cleanHeaders(request.headers);
      headers.set("accept-encoding", "identity");
      const init: RequestInit = { method: request.method, headers, signal: request.signal, ...(body?.length ? { body } : {}) };
      const execute = () => this.proxy(request, path + url.search, parsed, init, isStream);
      if ((/^\/clip\/v2\/resource\/entertainment_configuration\/[^/]+$/u.test(path) && ["start", "stop"].includes(parsed?.action)) || (/^\/api\/[^/]+\/groups\/[^/]+$/u.test(path) && typeof parsed?.stream?.active === "boolean")) {
        const task = this.entertainmentTask.catch(() => undefined).then(execute);
        this.entertainmentTask = task;
        return await task;
      }
      return await execute();
    } catch {
      this.record("Upstream Hue request failed", "warn", { path: redactPath(path), method: request.method });
      return Response.json({ errors: [{ description: "Hue bridge unavailable or proxy transport failed" }], data: [] }, { status: 502 });
    }
  }

  private async proxy(request: Request, fullPath: string, body: any, init: RequestInit, isStream: boolean): Promise<Response> {
    const path = fullPath.split("?")[0]!;
    const v2 = /^\/clip\/v2\/resource\/entertainment_configuration\/([^/]+)$/u.exec(path);
    const v1 = /^\/api\/([^/]+)\/groups\/([^/]+)$/u.exec(path);
    const start = request.method === "PUT" && ((v2 && body?.action === "start") || (v1 && body?.stream?.active === true));
    const stop = request.method === "PUT" && ((v2 && body?.action === "stop") || (v1 && body?.stream?.active === false));
    const identity = v1?.[1] ?? request.headers.get("hue-application-key") ?? "";
    let prepared: Streaming | undefined;
    if (start) {
      if (!this.config.entertainment.enabled) return Response.json({ errors: [{ description: "Entertainment relay is disabled" }], data: [] }, { status: 503 });
      if (this.streaming) return Response.json({ errors: [{ description: "An Entertainment stream is already active; stop it first" }], data: [] }, { status: 409 });
      const key = Object.hasOwn(this.storage.keys, identity) ? this.storage.keys[identity] : undefined;
      if (!key) return Response.json({ errors: [{ description: "Pair this client with this bridge first: press its link button, registering with generateclientkey=true" }], data: [] }, { status: 403 });
      // The upstream leg is ours, not the client's, so it needs our own Entertainment key.
      if (!this.options.clientKey) return Response.json({ errors: [{ description: "Set vendors.hue.clientKey in the HomeTruth secrets file to relay Entertainment to the real bridge" }], data: [] }, { status: 503 });
      // The TV-facing receiver is real OpenSSL (s_server), exactly as diyHue runs it: the clients that stream Entertainment
      // are known to talk to stock OpenSSL, so nothing custom in our DTLS can make one complete the handshake and then refuse.
      const receiver = new OpensslHueReceiver({ host: this.config.listen.host, port: this.config.entertainment.port, identity, key,
        frame: frame => { if (this.streaming === prepared) this.receiveFrame(prepared!, frame); },
        closed: reason => { if (prepared && this.streaming === prepared) void this.endStream(prepared, true, `the TV closed the connection${reason ? ` (${reason})` : ""}`); },
      });
      prepared = { identity, path, stopBody: v2 ? { action: "stop" } : { stream: { active: false } }, area: v2?.[1] ?? `v1-${v1![2]}`, receiver, lastFrameAt: Date.now(), startedAt: Date.now(), frames: 0 };
      this.streaming = prepared;
      // Whether the TV's own DTLS handshake completed, as distinct from our socket being bound: it tells "the TV never connected" apart from "the TV connected but sent no frames".
      const streaming = prepared;
      void receiver.connected.then(() => { if (this.streaming === streaming) this.record("TV Entertainment handshake complete; awaiting frames", "info", { cipher: receiver.cipher ?? "unknown" }); }, () => undefined);
      try { await receiver.ready; } catch (error) { await this.endStream(prepared, false); throw error; }
    }
    let response: Response;
    try { response = await this.upstream(this.translate(fullPath, init), init, isStream); }
    catch (error) { if (prepared) await this.endStream(prepared, true); throw error; }
    if (isStream) return this.proxyEventStream(response, request.signal);
    const bytes = await response.arrayBuffer().catch(async error => { if (prepared) await this.endStream(prepared, true); throw error; });
    let payload: any;
    try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch {}
    const ok = accepted(payload, response);
    if (prepared) {
      if (!ok || this.streaming !== prepared || this.controller.signal.aborted) await this.endStream(prepared, ok);
      else {
        const stream = prepared;
        stream.watchdog = setInterval(() => { if (Date.now() - stream.lastFrameAt > this.config.entertainment.idleTimeoutMs) void this.endStream(stream, true, `no frames for ${this.config.entertainment.idleTimeoutMs} ms`); }, 1000);
        // Connect the upstream leg to the real bridge in the BACKGROUND, not before replying. A Hue client opens its own DTLS
        // and abandons streaming within a few seconds of the start response, so making it wait on our connection to the real
        // bridge (which the reply used to) delayed its handshake past that window and it never sent a frame. diyHue likewise
        // returns start at once and reaches the real bridge asynchronously. Frames that arrive before this leg is up are dropped
        // by receiveFrame (no sender yet); the real bridge's own no-frame timeout is far longer than this connect takes.
        this.senderTask = this.senderTask.catch(() => undefined).then(async () => {
          if (this.streaming !== stream || this.controller.signal.aborted) return;
          try {
            stream.sender = new DtlsEndpoint({ helperPath: this.config.entertainment.helperPath, mode: "client", host: new URL(this.config.bridge.url).hostname, port: this.config.entertainment.upstreamPort, identity: this.options.applicationKey, key: this.options.clientKey!, frame: frame => { if (this.streaming === stream) stream.receiver.send(frame); }, closed: reason => { if (this.streaming === stream) void this.endStream(stream, true, `the real bridge closed the connection${reason ? ` (${reason})` : ""}`); } });
            await stream.sender.connected;
            if (this.streaming === stream) this.record("Entertainment relay started");
          } catch { if (this.streaming === stream) await this.endStream(stream, true, "could not open the upstream stream to the real bridge"); }
        });
      }
    }
    if (stop && ok && this.streaming && (path === this.streaming.path || v2?.[1] === this.streaming.area || (v1 && this.tracker.resources.get(this.streaming.area)?.id_v1 === `/groups/${v1[2]}`))) await this.endStream(this.streaming, false);
    // Rewrite discovery identity only. Resource IDs, pairing credentials,
    // ordinary payloads and Hue's application-level error bodies stay intact.
    if (request.method === "GET" && payload) {
      if (/^\/api\/(?:config|[^/]+\/config)\/?$/u.test(path)) payload = this.rewriteConfig(payload);
      else if (/^\/api\/[^/]+\/?$/u.test(path) && payload.config) payload = { ...payload, config: this.rewriteConfig(payload.config) };
      else if (path.startsWith("/clip/v2/resource") && Array.isArray(payload.data)) payload.data = payload.data.map((r: any) => r.type === "bridge" ? { ...r, bridge_id: this.storage.identity.bridgeId.toLowerCase() } : r);
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      this.emit(this.tracker.event("request", "proxy", `request/${redactPath(path).slice(1)}`, { data: { method: request.method, path: redactPath(path), status: response.status, accepted: ok } }));
      // Scenes, grouped_light and v1 increments require resolved light state.
      if (ok && this.config.monitor.enabled && !this.streamConnected) void this.refresh().catch(() => undefined);
    }
    const responseHeaders = cleanHeaders(response.headers);
    responseHeaders.set("cache-control", "no-store");
    return new Response([204, 205, 304].includes(response.status) || request.method === "HEAD" ? null : payload === undefined ? bytes : JSON.stringify(payload), { status: response.status, headers: responseHeaders });
  }
  private rewriteConfig(value: any): any {
    if (!value || Array.isArray(value) || typeof value !== "object") return value;
    return { ...value, name: this.config.name, ipaddress: this.config.listen.advertiseAddress, bridgeid: this.storage.identity.bridgeId, mac: this.storage.identity.mac, ...(value.proxyaddress !== undefined ? { proxyaddress: "none", proxyport: 0 } : {}) };
  }
  private proxyEventStream(response: Response, clientSignal: AbortSignal): Response {
    if (!response.body) { this.record("Eventstream relay: upstream had no body", "warn", { status: response.status }); return new Response(null, { status: response.status, headers: cleanHeaders(response.headers) }); }
    const reader = response.body.getReader();
    const signal = AbortSignal.any([clientSignal, this.controller.signal]);
    const openedAt = Date.now();
    let closed = false;
    let close = () => {};
    // Piped byte-for-byte. The real bridge's own `active_streamer` (an auth_v1 uuid for our application key) is exactly what
    // the client, which reaches the bridge as that key through this proxy, recognises as itself — so nothing here is rewritten.
    const body = new ReadableStream<Uint8Array>({
      start: controller => {
        close = () => { if (!closed) { closed = true; this.record("Eventstream relay closed", "info", { lifetimeMs: Date.now() - openedAt }); } signal.removeEventListener("abort", close); void reader.cancel().catch(() => undefined); try { controller.close(); } catch {} };
        signal.addEventListener("abort", close, { once: true });
        if (signal.aborted) close();
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) close();
          else if (!signal.aborted) controller.enqueue(value);
        } catch { close(); }
      },
      cancel: () => close(),
    });
    return new Response(body, { status: response.status, headers: cleanHeaders(response.headers) });
  }
  private receiveFrame(stream: Streaming, frame: Buffer): void {
    if (stream.closing || !stream.sender) return;
    stream.lastFrameAt = Date.now();
    stream.frames += 1;
    // Relay the original authenticated record before doing any interpretation.
    stream.sender?.send(frame);
    try {
      const parsed = parseHueStream(frame);
      if (parsed.version === 2 && parsed.area !== stream.area) return;
      for (const { channel, state } of parsed.channels) this.tracker.change(`entertainment/${parsed.version === 2 ? parsed.area : stream.area}/${channel}`, state, "entertainment");
    } catch { this.record("Unsupported or malformed Entertainment record relayed", "warn"); }
  }
  private endStream(stream: Streaming, releaseBridge: boolean, cause?: string): Promise<void> {
    if (cause && stream.cause === undefined) stream.cause = cause;
    return stream.closing ??= this.closeStream(stream, releaseBridge);
  }
  private async closeStream(stream: Streaming, releaseBridge: boolean): Promise<void> {
    if (this.streaming !== stream) return;
    clearInterval(stream.watchdog);
    await Promise.all([stream.receiver.stop(), stream.sender?.stop()]);
    if (releaseBridge && !this.controller.signal.aborted) {
      // Released with our own credential: the client's was minted here and means nothing upstream.
      const path = stream.path.replace(/^\/api\/[^/]+/u, `/api/${this.options.applicationKey}`);
      try { const response = await this.upstream(path, { method: "PUT", headers: { "content-type": "application/json", "hue-application-key": this.options.applicationKey }, body: JSON.stringify(stream.stopBody) }); await response.body?.cancel(); } catch {}
    }
    if (this.streaming === stream) this.streaming = undefined;
    // The whole diagnosis of a stream that will not stay up: what ended it, how long it lasted, and whether the TV ever sent a frame.
    this.record(`Entertainment relay stopped: ${stream.cause ?? "the stream was stopped"}`, stream.cause && stream.frames === 0 ? "warn" : "info", { area: stream.area, frames: stream.frames, lifetimeMs: Date.now() - stream.startedAt });
  }
  private eventStream(request: Request): Response {
    let cleanup = () => {};
    const body = new ReadableStream<Uint8Array>({
      start: controller => {
        const encoder = new TextEncoder();
        let closed = false;
        const write = (text: string) => {
          if (closed) return;
          if ((controller.desiredSize ?? 0) <= 0) { cleanup(); return; }
          controller.enqueue(encoder.encode(text));
        };
        const listener = (event: HueEvent) => write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
        const timer = setInterval(() => write(": keepalive\n\n"), 15_000);
        cleanup = () => { if (closed) return; closed = true; clearInterval(timer); this.listeners.delete(listener); request.signal.removeEventListener("abort", cleanup); this.controller.signal.removeEventListener("abort", cleanup); try { controller.close(); } catch {} };
        this.listeners.add(listener);
        request.signal.addEventListener("abort", cleanup, { once: true });
        this.controller.signal.addEventListener("abort", cleanup, { once: true });
        write(": connected\n\n");
      }, cancel: () => cleanup(),
    }, { highWaterMark: 256 });
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" } });
  }
  override stop(): Promise<void> { return this.stopping ??= this.shutdown(); }
  private async shutdown(): Promise<void> {
    this.discovery?.stop();
    // Stop accepting requests, release only the stream we own, then abort SSE.
    const listeners = Promise.all([this.http?.stop(true), this.https?.stop(true)]);
    if (this.streaming) await this.endStream(this.streaming, true);
    this.controller.abort();
    await Promise.allSettled([listeners, this.monitorTask, this.pollTask, this.entertainmentTask, this.senderTask, this.saveTask]);
    await this.fanout.stop();
    await this.destinations.stop();
    this.started = false;
  }
}
