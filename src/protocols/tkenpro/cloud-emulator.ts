import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { isDeepStrictEqual } from "node:util";
import {
  MeariRoutedPayloadAssembler,
  buildMeariIotSettingsRequest,
  decodeMsgSvrFrame,
  encodeMeariRoutedPayloads,
  encodeMsgSvrFrame,
  MSGSVR_COMMANDS,
  MSGSVR_METHODS,
  MSGSVR_NODES,
  splitMsgSvrFrames,
  type MeariRouteContact,
  type MsgSvrFrame,
} from "./msgsvr.ts";

type UnknownRecord = Record<string, unknown>;

export interface MeariCameraRegistration {
  readonly uuid: string;
  readonly password: string;
  readonly clientId: string;
  readonly version: number;
  readonly runtime: number;
  readonly remoteAddress: string;
}

type MeariCameraSessionRole = "platform" | "data";

export type MeariRegistrationAuthorizer = (
  registration: MeariCameraRegistration,
) => boolean | Promise<boolean>;

export type MeariLocalCloudEvent =
  | { readonly type: "connected" }
  | { readonly type: "registered"; readonly uuid: string }
  | { readonly type: "disconnected"; readonly uuid?: string }
  | {
    readonly type: "settings";
    readonly uuid: string;
    readonly source: "sync" | "response";
    readonly values: Readonly<Record<string, unknown>>;
  }
  | { readonly type: "message"; readonly uuid: string; readonly content: Readonly<UnknownRecord>; readonly via?: "heartbeat" | "unhandled-command" }
  | { readonly type: "persistence-error"; readonly message: string }
  | { readonly type: "protocol-error"; readonly uuid?: string; readonly message: string };

export type MeariLocalCloudFrameDirection = "camera-to-cloud" | "cloud-to-camera";

export interface MeariLocalCloudEmulatorOptions {
  /** Address on this machine to listen on. */
  readonly host?: string;
  /** Camera MsgSvr port. Use zero to choose a free port in tests. */
  readonly port?: number;
  /** Optional distinct routed-settings listener. */
  readonly dataPort?: number;
  /** LAN address advertised back to the camera. */
  readonly advertisedHost: string;
  /** Override the advertised command port. Defaults to the bound port. */
  readonly advertisedPort?: number;
  /** Logical router port used when addressing the registered camera. */
  readonly routedDevicePort?: number;
  readonly dnsPort?: number;
  /** Logical regional platform domain. */
  readonly domain?: string;
  /** Logical routed-settings domain. Defaults to `domain`. */
  readonly dataDomain?: string;
  /** Address reported as the camera's observed WAN endpoint for NAT-mode parity. */
  readonly wanAddress?: string;
  readonly heartbeatIntervalSeconds?: number;
  readonly heartbeatFailures?: number;
  readonly serverVersion?: number;
  readonly commandTimeoutMs?: number;
  readonly authorizeRegistration: MeariRegistrationAuthorizer;
  readonly now?: () => number;
  readonly issueToken?: () => string;
  /** IoT values returned to the camera's bootstrap `get` request. */
  readonly bootstrapIotKeys?: readonly string[];
  readonly onEvent?: (event: MeariLocalCloudEvent) => void;
  /** Optional diagnostics hook. Raw frames may contain credentials; callers must store them privately. */
  readonly onFrame?: (
    direction: MeariLocalCloudFrameDirection,
    frame: Readonly<Buffer>,
  ) => void;
  readonly initialStates?: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
}

interface PendingCommand {
  readonly values: Readonly<Record<string, unknown>>;
  readonly resolve: (response: Readonly<UnknownRecord>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingRoutedRequest {
  readonly resolve: (response: Readonly<UnknownRecord>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PendingBootstrapDelivery {
  readonly expected: Readonly<Record<string, unknown>>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly fallbackTimer?: ReturnType<typeof setTimeout>;
}

export interface MeariLocalRoutedRequestOptions {
  /** Logical source presented to the camera. Defaults to the local data server. */
  readonly from?: MeariRouteContact;
  /** Diagnostic destination override used for exact captured-route replay. */
  readonly to?: MeariRouteContact;
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, name: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`${name} is not an object`);
  return value;
}

function textAt(record: UnknownRecord, name: string): string {
  const value = record[name];
  return typeof value === "string" ? value : "";
}

function integerAt(record: UnknownRecord, name: string): number {
  const value = Number(record[name]);
  return Number.isInteger(value) ? value : 0;
}

function normalizedAddress(value: string | undefined): string {
  return (value ?? "").replace(/^::ffff:/u, "");
}

function assertPort(name: string, value: number, allowZero = false): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum || value > 65_535) {
    throw new RangeError(`${name} must be between ${minimum} and 65535`);
  }
}

function unixTime(now: () => number): string {
  return String(Math.floor(now() / 1_000));
}

function writeSocket(socket: Socket, bytes: Uint8Array): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.write(bytes, (error?: Error | null) => error ? reject(error) : resolve());
  });
}

class MeariCameraCloudSession {
  readonly emulator: MeariLocalCloudEmulator;
  readonly socket: Socket;
  readonly assembler = new MeariRoutedPayloadAssembler();
  readonly pending = new Map<string, PendingCommand>();
  readonly pendingRouted = new Map<string, PendingRoutedRequest>();
  buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  work: Promise<void> = Promise.resolve();
  uuid = "";
  token = "";
  cameraContact: MeariRouteContact | undefined;
  closed = false;

  constructor(
    emulator: MeariLocalCloudEmulator,
    socket: Socket,
    readonly role: MeariCameraSessionRole,
  ) {
    this.emulator = emulator;
    this.socket = socket;
    socket.setKeepAlive(true);
    socket.on("data", (chunk: Buffer) => {
      this.work = this.work.then(() => this.consume(chunk)).catch((error: unknown) => {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      });
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.close());
  }

  private async consume(chunk: Buffer): Promise<void> {
    const split = splitMsgSvrFrames(Buffer.concat([this.buffer, chunk]));
    this.buffer = split.remainder;
    for (const bytes of split.frames) {
      this.emulator.observeFrame("camera-to-cloud", bytes);
      await this.handleFrame(decodeMsgSvrFrame(bytes));
    }
  }

  private async handleFrame(frame: MsgSvrFrame): Promise<void> {
    if (frame.command === MSGSVR_COMMANDS.REGISTER) {
      await this.handleRegistration(frame);
      return;
    }
    if (!this.uuid) throw new Error("Camera sent data before registration");
    if (frame.command === MSGSVR_COMMANDS.HEARTBEAT) {
      await this.handleHeartbeat(frame);
      return;
    }
    if (frame.command === MSGSVR_COMMANDS.WEBRTC) {
      await this.handleRouted(frame);
      return;
    }
    // STATUS (0xc7), LAN_CONNECT (0xc3), and CONNECT (0xd1) have never been
    // observed from a camera on this path — this emulator has no reply for
    // them and does not know their payload shape. Rather than silently
    // reject them as a protocol error (which previously made them
    // indistinguishable from a real malformed frame, and gave no visibility
    // into what such a frame contains), surface them the same
    // structurally-logged way as any other unrecognized push, tagged so a
    // future session can tell this apart from the WEBRTC-routed catch-all.
    // If one of these turns out to carry a motion alarm, this is where it
    // would first become visible.
    const payload = frame.payload;
    this.emulator.emit({
      type: "message",
      uuid: this.uuid,
      via: "unhandled-command",
      content: isRecord(payload) ? { ...payload, __unhandledCommand: frame.command } : { __unhandledCommand: frame.command, __nonObjectPayload: typeof payload },
    });
  }

  private async handleRegistration(frame: MsgSvrFrame): Promise<void> {
    if (this.uuid) throw new Error("Camera registered twice on one connection");
    const body = requireRecord(frame.payload, "camera registration");
    if (body.action !== "register") throw new Error("Unexpected camera registration action");
    const extra = isRecord(body.extra_params) ? body.extra_params : {};
    const registration: MeariCameraRegistration = {
      uuid: textAt(body, "uuid"),
      password: textAt(body, "password"),
      clientId: textAt(extra, "clientid"),
      version: integerAt(body, "ver"),
      runtime: integerAt(body, "runtime"),
      remoteAddress: normalizedAddress(this.socket.remoteAddress),
    };
    if (!registration.uuid || !registration.password) {
      throw new Error("Camera registration omitted its identity proof");
    }
    const allowed = await this.emulator.options.authorizeRegistration(registration);
    if (!allowed) {
      // Visible as a warning: a camera that is not (or no longer) allowed here is told FAIL and dropped.
      this.emulator.emit({ type: "protocol-error", uuid: registration.uuid, message: `Registration refused for ${registration.remoteAddress} (not authorized, or not isolated)` });
      await this.sendFrame(MSGSVR_NODES.SERVER, MSGSVR_COMMANDS.REGISTER, {
        action: "register",
        uuid: registration.uuid,
        result: "FAIL",
      });
      this.socket.end();
      return;
    }

    this.uuid = registration.uuid;
    this.token = this.emulator.issueToken();
    this.emulator.register(this);
    await this.sendFrame(MSGSVR_NODES.SERVER, MSGSVR_COMMANDS.REGISTER, {
      action: "register",
      uuid: this.uuid,
      result: "OK",
      token: this.token,
      wan: this.emulator.options.wanAddress ?? registration.remoteAddress,
      ver: this.emulator.serverVersion,
      domain: this.emulator.domain,
      hb: this.emulator.heartbeatIntervalSeconds,
      ht: this.emulator.heartbeatFailures,
      dns: {
        ip: this.emulator.options.advertisedHost,
        port: this.emulator.dnsPort,
      },
      t: unixTime(this.emulator.now),
      datasvr: {
        domain: this.emulator.dataDomain,
        ip: this.emulator.options.advertisedHost,
        port: this.emulator.advertisedPort,
      },
    });
    this.emulator.emit({ type: "registered", uuid: this.uuid });
  }

  private async handleHeartbeat(frame: MsgSvrFrame): Promise<void> {
    const body = requireRecord(frame.payload, "camera heartbeat");
    const heartbeatUuid = textAt(body, "uuid");
    const heartbeatToken = textAt(body, "token");
    if (heartbeatUuid !== this.uuid || heartbeatToken !== this.token) {
      const mismatch = heartbeatUuid !== this.uuid ? "camera identity" : "session token";
      throw new Error(
        `Camera heartbeat ${mismatch} did not match registration (token lengths ${heartbeatToken.length}/${this.token.length})`,
      );
    }
    // Only `uuid`/`token` were ever inspected here; every other field the
    // camera includes in its heartbeat — the one message it is guaranteed to
    // send on a regular cadence regardless of anything else — was silently
    // discarded. A vendor commonly piggybacks state flags (battery, an
    // alarm-pending bit) on exactly this message for that reason. Surface
    // whatever else is present so it is visible instead of invisible; still
    // never emitted for a heartbeat that carried only identity fields.
    const extra = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "uuid" && key !== "token"));
    if (Object.keys(extra).length > 0) {
      this.emulator.emit({ type: "message", uuid: this.uuid, via: "heartbeat", content: extra });
    }
    await this.sendFrame(MSGSVR_NODES.SERVER, MSGSVR_COMMANDS.HEARTBEAT, {
      wan: this.emulator.options.wanAddress ?? normalizedAddress(this.socket.remoteAddress),
      ver: this.emulator.serverVersion,
      t: unixTime(this.emulator.now),
      domain: this.emulator.domain,
      dns: {
        ip: this.emulator.options.advertisedHost,
        port: this.emulator.dnsPort,
      },
      datasvr: {
        domain: this.emulator.dataDomain,
        ip: this.emulator.options.advertisedHost,
        port: this.emulator.advertisedPort,
      },
    });
  }

  private async handleRouted(frame: MsgSvrFrame): Promise<void> {
    const routed = this.assembler.accept<UnknownRecord>(frame.payload);
    if (!routed) return;
    // Meari firmware commonly keeps separate platform and data-server sockets
    // registered with the same UUID. Whichever authenticated socket is
    // carrying routed traffic is the best command path for subsequent local
    // requests.
    this.emulator.touch(this);
    this.cameraContact = routed.from;
    const content = requireRecord(routed.content, "camera routed content");
    const sid = textAt(content, "sid");
    const routedRequest = this.pendingRouted.get(sid);
    if (routedRequest) {
      this.pendingRouted.delete(sid);
      clearTimeout(routedRequest.timer);
      routedRequest.resolve(content);
      return;
    }
    const params = isRecord(content.params) ? content.params : {};
    const isSettings = content.cmd === "conf" && content.method === "settings"
      && Number(params.code) === 100001 && params.name === "iot";
    if (!isSettings) {
      this.emulator.emit({ type: "message", uuid: this.uuid, content });
      return;
    }

    const values = isRecord(params.iot) ? params.iot : {};
    if (content.action === "sync" || params.action === "sync") {
      this.emulator.mergeState(this.uuid, values, "sync");
      await this.sendRouted({
        sid,
        action: "ack",
        cmd: "conf",
        method: "settings",
        uuid: this.uuid,
        params: { code: 100001, name: "iot", action: "sync" },
      });
      return;
    }

    if (content.action === "req" && params.action === "get") {
      const state = this.emulator.getDeviceState(this.uuid);
      const bootstrapValues = this.emulator.options.bootstrapIotKeys
        ? Object.fromEntries(this.emulator.options.bootstrapIotKeys
          .filter((key) => Object.hasOwn(state, key))
          .map((key) => [key, state[key]]))
        : state;
      await this.sendRouted({
        sid,
        action: "rsp",
        cmd: "conf",
        method: "settings",
        uuid: this.uuid,
        params: {
          code: 100001,
          name: "iot",
          action: "get",
          iot: bootstrapValues,
        },
      });
      this.emulator.noteBootstrapDelivered(this.uuid, bootstrapValues);
      return;
    }

    if (content.action === "rsp") {
      const pending = this.pending.get(sid);
      if (pending) {
        this.pending.delete(sid);
        clearTimeout(pending.timer);
        if (Number(content.errid) > 0) {
          pending.reject(new Error(`Camera rejected local command (${Number(content.errid)})`));
        } else {
          this.emulator.mergeState(this.uuid, Object.keys(values).length > 0 ? values : pending.values, "response");
          pending.resolve(content);
        }
      } else if (Object.keys(values).length > 0) {
        this.emulator.mergeState(this.uuid, values, "response");
      }
      return;
    }

    this.emulator.emit({ type: "message", uuid: this.uuid, content });
  }

  async setIot(values: Readonly<Record<string, unknown>>, timeoutMs: number): Promise<Readonly<UnknownRecord>> {
    if (Object.keys(values).length === 0) throw new TypeError("At least one IoT value is required");
    const sid = this.emulator.nextSid();
    const response = new Promise<Readonly<UnknownRecord>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(sid);
        reject(new Error("Local camera command timed out"));
      }, timeoutMs);
      this.pending.set(sid, { values, resolve, reject, timer });
    });
    try {
      await this.sendRouted(buildMeariIotSettingsRequest(this.uuid, values, sid));
    } catch (error) {
      const pending = this.pending.get(sid);
      if (pending) {
        this.pending.delete(sid);
        clearTimeout(pending.timer);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return await response;
  }

  async requestRouted(
    content: Readonly<UnknownRecord>,
    options: MeariLocalRoutedRequestOptions,
  ): Promise<Readonly<UnknownRecord>> {
    const sid = textAt(content, "sid");
    if (!sid) throw new TypeError("A routed camera request requires a string sid");
    if (this.pendingRouted.has(sid) || this.pending.has(sid)) {
      throw new Error("A routed camera request with this sid is already pending");
    }
    const timeoutMs = options.timeoutMs ?? this.emulator.commandTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new RangeError("Routed request timeout must be between 1 and 120000 milliseconds");
    }
    const response = new Promise<Readonly<UnknownRecord>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRouted.delete(sid);
        reject(new Error("Local camera routed request timed out"));
      }, timeoutMs);
      this.pendingRouted.set(sid, { resolve, reject, timer });
    });
    try {
      await this.sendRouted(content, options.from, options.to);
    } catch (error) {
      const pending = this.pendingRouted.get(sid);
      if (pending) {
        this.pendingRouted.delete(sid);
        clearTimeout(pending.timer);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return await response;
  }

  cancelRouted(sid: string): void {
    const pending = this.pendingRouted.get(sid);
    if (!pending) return;
    this.pendingRouted.delete(sid);
    clearTimeout(pending.timer);
    pending.reject(new Error("Routed request completed on another authenticated camera socket"));
  }

  private async sendRouted(
    content: unknown,
    source?: MeariRouteContact,
    destination?: MeariRouteContact,
  ): Promise<void> {
    const from: MeariRouteContact = source ?? {
      node: "datasvr",
      domain: this.emulator.dataDomain,
      transport: "tcp",
      type: "binary",
      ip: this.emulator.options.advertisedHost,
      port: this.emulator.advertisedPort,
    };
    const cameraContact: MeariRouteContact = destination ?? this.cameraContact ?? {
      node: "dev",
      domain: this.uuid,
      transport: "tcp",
      type: "binary",
    };
    // The production router fills these with the MsgSvr endpoint carrying the
    // camera session, even when the camera's own routed `from` omits them.
    // Firmware drops WebRTC offers whose destination contact is incomplete.
    const to: MeariRouteContact = {
      ...cameraContact,
      ip: cameraContact.ip ?? this.emulator.options.advertisedHost,
      port: cameraContact.port ?? this.emulator.routedDevicePort,
    };
    for (const payload of encodeMeariRoutedPayloads({ from, to, content })) {
      const frame = encodeMsgSvrFrame({
        node: from.node === "webrtcsvr"
          ? MSGSVR_NODES.CAMERA_WEBRTC_SERVER
          : MSGSVR_NODES.DATA_SERVER,
        method: MSGSVR_METHODS.ROUTED,
        command: MSGSVR_COMMANDS.WEBRTC,
        payload,
      });
      this.emulator.observeFrame("cloud-to-camera", frame);
      await writeSocket(this.socket, frame);
    }
  }

  private async sendFrame(node: number, command: number, payload: unknown): Promise<void> {
    const frame = encodeMsgSvrFrame({
      node,
      method: MSGSVR_METHODS.ROUTED,
      command,
      payload,
    });
    this.emulator.observeFrame("cloud-to-camera", frame);
    await writeSocket(this.socket, frame);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.emulator.emit({
      type: "protocol-error",
      ...(this.uuid ? { uuid: this.uuid } : {}),
      message: error.message,
    });
    this.socket.destroy();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.assembler.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Local camera connection closed"));
    }
    this.pending.clear();
    for (const pending of this.pendingRouted.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Local camera connection closed"));
    }
    this.pendingRouted.clear();
    this.emulator.unregister(this);
  }
}

/**
 * Camera-facing replacement for the Meari platform/data server. It accepts
 * the firmware's persistent MsgSvr socket, authenticates registration locally,
 * mirrors IoT state, acknowledges syncs, answers heartbeats, and can issue the
 * same settings commands as CloudEdge without an account session.
 */
export class MeariLocalCloudEmulator {
  readonly options: MeariLocalCloudEmulatorOptions;
  readonly now: () => number;
  readonly server: Server;
  readonly dataServer: Server | undefined;
  readonly sessions = new Map<string, MeariCameraCloudSession>();
  readonly states = new Map<string, UnknownRecord>();
  readonly connections = new Set<MeariCameraCloudSession>();
  readonly domain: string;
  readonly dataDomain: string;
  readonly heartbeatIntervalSeconds: number;
  readonly heartbeatFailures: number;
  readonly serverVersion: number;
  readonly dnsPort: number;
  readonly commandTimeoutMs: number;
  private readonly pendingBootstrapDeliveries = new Map<string, Set<PendingBootstrapDelivery>>();
  private readonly bootstrapUpdateTasks = new Map<string, Promise<void>>();
  private boundPort = 0;
  private boundDataPort = 0;
  private lastSid = 0;

  constructor(options: MeariLocalCloudEmulatorOptions) {
    if (!options.advertisedHost.trim()) throw new TypeError("advertisedHost is required");
    if (typeof options.authorizeRegistration !== "function") {
      throw new TypeError("authorizeRegistration is required");
    }
    assertPort("port", options.port ?? 18_665, true);
    if (options.dataPort !== undefined) assertPort("dataPort", options.dataPort, true);
    if (options.advertisedPort !== undefined) assertPort("advertisedPort", options.advertisedPort);
    if (options.routedDevicePort !== undefined) assertPort("routedDevicePort", options.routedDevicePort);
    assertPort("dnsPort", options.dnsPort ?? 18_661);
    this.options = options;
    this.now = options.now ?? Date.now;
    this.domain = options.domain ?? "hometruth.local";
    this.dataDomain = options.dataDomain ?? this.domain;
    this.heartbeatIntervalSeconds = options.heartbeatIntervalSeconds ?? 35;
    this.heartbeatFailures = options.heartbeatFailures ?? 5;
    this.serverVersion = options.serverVersion ?? 17_516;
    this.dnsPort = options.dnsPort ?? 18_661;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 8_000;
    for (const [uuid, values] of options.initialStates ?? []) {
      this.states.set(uuid, { ...values });
    }
    const accept = (role: MeariCameraSessionRole) => (socket: Socket): void => {
      const session = new MeariCameraCloudSession(this, socket, role);
      this.connections.add(session);
      this.emit({ type: "connected" });
    };
    this.server = createServer(accept("platform"));
    this.dataServer = options.dataPort !== undefined && (
      options.dataPort === 0 || options.dataPort !== (options.port ?? 18_665)
    )
      ? createServer(accept("data"))
      : undefined;
  }

  get port(): number {
    return this.boundPort;
  }

  get advertisedPort(): number {
    return this.options.advertisedPort ?? (this.boundDataPort || this.boundPort);
  }

  get dataPort(): number {
    return this.boundDataPort || this.boundPort;
  }

  get routedDevicePort(): number {
    return this.options.routedDevicePort ?? 18_857;
  }

  get connectedDeviceUuids(): readonly string[] {
    return [...this.sessions.keys()];
  }

  /** Drop a registered camera's session so it reconnects and is judged by the registration gate again. */
  disconnectDevice(uuid: string): boolean {
    const session = this.sessions.get(uuid);
    if (!session) return false;
    session.socket.destroy();
    return true;
  }

  /** Whether routed camera traffic has identified the command-capable session. */
  hasRoutedContact(uuid: string): boolean {
    return Boolean(this.sessions.get(uuid)?.cameraContact);
  }

  async start(): Promise<number> {
    if (this.server.listening) return this.boundPort;
    const listen = async (server: Server, port: number): Promise<number> => {
      await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
        server.once("error", onError);
        server.listen({
        host: this.options.host ?? "127.0.0.1",
          port,
      }, () => {
          server.off("error", onError);
        resolve();
      });
    });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Local cloud server did not expose a TCP port");
      return address.port;
    };
    this.boundPort = await listen(this.server, this.options.port ?? 18_665);
    if (this.dataServer) {
      try {
        this.boundDataPort = await listen(this.dataServer, this.options.dataPort ?? 18_834);
      } catch (error) {
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
        this.boundPort = 0;
        throw error;
      }
    }
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Local cloud server did not expose a TCP port");
    return this.boundPort;
  }

  async stop(): Promise<void> {
    this.rejectBootstrapDeliveries(new Error("Local cloud stopped before camera bootstrap completed"));
    for (const session of this.connections) session.socket.destroy();
    const servers = [this.server, this.dataServer].filter((server): server is Server => Boolean(server));
    await Promise.all(servers.map(async (server) => {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }));
  }

  getDeviceState(uuid: string): Readonly<Record<string, unknown>> {
    return { ...(this.states.get(uuid) ?? {}) };
  }

  async setIot(
    uuid: string,
    values: Readonly<Record<string, unknown>>,
    timeoutMs = this.commandTimeoutMs,
  ): Promise<Readonly<UnknownRecord>> {
    if (Object.keys(values).length === 0) throw new TypeError("At least one IoT value is required");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new RangeError("Camera command timeout must be between 1 and 120000 milliseconds");
    }
    const session = this.sessions.get(uuid);
    if (!session) throw new Error("Camera is not connected to the local cloud");
    const bootstrapKeys = new Set(this.options.bootstrapIotKeys ?? []);
    const bootstrapValues = Object.fromEntries(
      Object.entries(values).filter(([key]) => bootstrapKeys.has(key)),
    );
    const routedValues = Object.fromEntries(
      Object.entries(values).filter(([key]) => !bootstrapKeys.has(key)),
    );

    let routedResponse: Readonly<UnknownRecord> | undefined;
    if (Object.keys(routedValues).length > 0) {
      routedResponse = await session.setIot(routedValues, timeoutMs);
    }
    if (Object.keys(bootstrapValues).length > 0) {
      await this.queueBootstrapUpdate(uuid, bootstrapValues, timeoutMs);
    }
    return routedResponse ?? this.localIotResponse(uuid, bootstrapValues);
  }

  private localIotResponse(
    uuid: string,
    values: Readonly<Record<string, unknown>>,
  ): Readonly<UnknownRecord> {
    return {
      sid: this.nextSid(),
      uuid,
      cmd: "conf",
      action: "rsp",
      method: "settings",
      params: {
        code: 100001,
        action: "set",
        name: "iot",
        iot: { ...values },
      },
    };
  }

  private async queueBootstrapUpdate(
    uuid: string,
    values: Readonly<Record<string, unknown>>,
    timeoutMs: number,
  ): Promise<void> {
    const previous = this.bootstrapUpdateTasks.get(uuid) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => { await this.applyBootstrapUpdate(uuid, values, timeoutMs); });
    this.bootstrapUpdateTasks.set(uuid, task);
    try {
      await task;
    } finally {
      if (this.bootstrapUpdateTasks.get(uuid) === task) this.bootstrapUpdateTasks.delete(uuid);
    }
  }

  private async applyBootstrapUpdate(
    uuid: string,
    values: Readonly<Record<string, unknown>>,
    timeoutMs: number,
  ): Promise<void> {
    const state = this.getDeviceState(uuid);
    const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => (
      !Object.hasOwn(state, key) || !isDeepStrictEqual(state[key], value)
    )));
    if (Object.keys(changed).length === 0) return;
    if (![...this.connections].some((session) => !session.closed && session.uuid === uuid)) {
      throw new Error("Camera disconnected before its server-backed setting could be updated");
    }

    // These properties are owned by the vendor config service rather than by
    // the camera's ordinary settings endpoint. Persist the desired value,
    // recycle the data-server channel, and only resolve after firmware fetches
    // that value through its authenticated bootstrap `get` request.
    this.mergeState(uuid, changed, "response");
    await this.waitForBootstrapDelivery(uuid, changed, timeoutMs);
  }

  private waitForBootstrapDelivery(
    uuid: string,
    expected: Readonly<Record<string, unknown>>,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const matching = [...this.connections].filter((session) => (
        !session.closed && session.uuid === uuid
      ));
      const dataSessions = matching.filter((session) => session.role === "data");
      const primaryTargets = dataSessions.length > 0 ? dataSessions : matching;
      if (primaryTargets.length === 0) {
        reject(new Error("Camera disconnected before its bootstrap channel could refresh"));
        return;
      }

      let pending: PendingBootstrapDelivery;
      const cleanup = (): void => {
        const entries = this.pendingBootstrapDeliveries.get(uuid);
        entries?.delete(pending);
        if (entries?.size === 0) this.pendingBootstrapDeliveries.delete(uuid);
        clearTimeout(pending.timer);
        if (pending.fallbackTimer) clearTimeout(pending.fallbackTimer);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Camera did not fetch its updated server-backed setting"));
      }, timeoutMs);
      const fallbackDelay = Math.min(2_000, Math.max(100, Math.floor(timeoutMs / 2)));
      const fallbackTimer = dataSessions.length > 0 && dataSessions.length < matching.length
        ? setTimeout(() => {
          for (const session of matching) {
            if (!session.closed && !dataSessions.includes(session)) session.socket.destroy();
          }
        }, fallbackDelay)
        : undefined;
      pending = {
        expected: { ...expected },
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        timer,
        ...(fallbackTimer ? { fallbackTimer } : {}),
      };
      const entries = this.pendingBootstrapDeliveries.get(uuid) ?? new Set<PendingBootstrapDelivery>();
      entries.add(pending);
      this.pendingBootstrapDeliveries.set(uuid, entries);
      for (const session of primaryTargets) session.socket.destroy();
    });
  }

  noteBootstrapDelivered(uuid: string, values: Readonly<Record<string, unknown>>): void {
    for (const pending of [...(this.pendingBootstrapDeliveries.get(uuid) ?? [])]) {
      const delivered = Object.entries(pending.expected).every(([key, value]) => (
        Object.hasOwn(values, key) && isDeepStrictEqual(values[key], value)
      ));
      if (delivered) pending.resolve();
    }
  }

  private rejectBootstrapDeliveries(error: Error): void {
    for (const entries of this.pendingBootstrapDeliveries.values()) {
      for (const pending of [...entries]) pending.reject(error);
    }
  }

  async requestRouted(
    uuid: string,
    content: Readonly<UnknownRecord>,
    options: MeariLocalRoutedRequestOptions = {},
  ): Promise<Readonly<UnknownRecord>> {
    const allCandidates = [...this.connections].filter((session) => (
      !session.closed && session.uuid === uuid
    ));
    if (allCandidates.length === 0) throw new Error("Camera is not connected to the local cloud");
    const candidates = allCandidates.filter((session) => session.role === "platform");
    const sid = textAt(content, "sid");
    if (!sid) throw new TypeError("A routed camera request requires a string sid");
    // The first authenticated socket is the regional natsvr/platform session.
    // Later sockets are datasvr channels used for settings sync. Firmware
    // silently drops WebRTC offers delivered over a datasvr channel.
    const platform = (candidates[0] ?? allCandidates[0]) as MeariCameraCloudSession;
    try {
      return await platform.requestRouted(content, options);
    } finally {
      platform.cancelRouted(sid);
    }
  }

  register(session: MeariCameraCloudSession): void {
    // A camera can legitimately register more than one persistent MsgSvr
    // socket (notably one for the platform and one for the advertised data
    // server). Closing the previous socket makes the firmware reconnect both
    // forever. Retain every authenticated connection and prefer the newest
    // active one until routed traffic identifies a better path.
    this.sessions.set(session.uuid, session);
    if (!this.states.has(session.uuid)) this.states.set(session.uuid, {});
  }

  touch(session: MeariCameraCloudSession): void {
    if (!session.closed && session.uuid) this.sessions.set(session.uuid, session);
  }

  unregister(session: MeariCameraCloudSession): void {
    this.connections.delete(session);
    if (!session.uuid) return;
    if (this.sessions.get(session.uuid) === session) {
      const replacement = [...this.connections].reverse().find((candidate) => (
        !candidate.closed && candidate.uuid === session.uuid
      ));
      if (replacement) this.sessions.set(session.uuid, replacement);
      else this.sessions.delete(session.uuid);
    }
    if (!this.sessions.has(session.uuid)) {
      this.emit({ type: "disconnected", uuid: session.uuid });
    }
  }

  mergeState(
    uuid: string,
    values: Readonly<Record<string, unknown>>,
    source: "sync" | "response",
  ): void {
    if (Object.keys(values).length === 0) return;
    this.states.set(uuid, { ...(this.states.get(uuid) ?? {}), ...values });
    this.emit({ type: "settings", uuid, source, values: { ...values } });
  }

  issueToken(): string {
    // Production MsgSvr returns a six-character token. Some firmware copies
    // only six bytes into its heartbeat structure, so longer replacements are
    // silently truncated and then fail validation on the next heartbeat.
    return this.options.issueToken?.() ?? randomBytes(3).toString("hex");
  }

  nextSid(): string {
    const current = Math.floor(this.now() / 1_000);
    this.lastSid = Math.max(current, this.lastSid + 1);
    return String(this.lastSid);
  }

  emit(event: MeariLocalCloudEvent): void {
    this.options.onEvent?.(event);
  }

  observeFrame(direction: MeariLocalCloudFrameDirection, frame: Readonly<Buffer>): void {
    try {
      this.options.onFrame?.(direction, Buffer.from(frame));
    } catch {
      // Diagnostics must never disrupt camera control.
    }
  }
}
