import { createHash, randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { resolve4 } from "node:dns/promises";
import { createConnection, type Socket } from "node:net";
import {
  decodeMsgSvrFrame,
  encodeMsgSvrFrame,
  MSGSVR_COMMANDS,
  MSGSVR_METHODS,
  MSGSVR_NODES,
  splitMsgSvrFrames,
  type MsgSvrFrame,
} from "./msgsvr.ts";

export const MEARI_ROOT_DISCOVERY_PORT = 9253;
export const MEARI_ROOT_DISCOVERY_VERSION = 15_259;
export const MEARI_DEFAULT_PLATFORM_DOMAINS = Object.freeze([
  "usce.mearicloud.com",
  "euce.mearicloud.com",
  "asce.mearicloud.com",
  "cnce.mearicloud.com",
]);

// CloudEdge labels each WebRTC negotiation with the current Unix timestamp
// (the captured sid is a ten-digit value). Keep IDs monotonic so back-to-back
// local commands cannot reuse a camera's recently closed negotiation.
let lastMeariSignalingSessionId = 0;

export function createMeariSignalingSessionId(now = Date.now()): string {
  const timestamp = Math.floor(now / 1_000);
  lastMeariSignalingSessionId = Math.max(timestamp, lastMeariSignalingSessionId + 1);
  return String(lastMeariSignalingSessionId);
}

export interface MeariSignalContact {
  readonly node: string;
  readonly domain: string;
  readonly transport: string;
  readonly type: string;
  readonly ip: string;
  readonly port: number;
}

export interface MeariRootDiscoveryResponse {
  readonly contact?: MeariSignalContact;
  readonly host?: string;
  readonly dnsServer?: MeariSignalContact;
  readonly dnsServerHost?: string;
  readonly frame: MsgSvrFrame;
}

export interface MeariRootDiscoveryOptions {
  readonly clientId?: string;
  readonly domain?: string;
  readonly parent?: boolean;
  readonly now?: () => number;
}

export interface DiscoverMeariSignalingOptions extends MeariRootDiscoveryOptions {
  readonly domains?: readonly string[];
  readonly timeoutMs?: number;
  readonly platformDomainHint?: string;
  readonly openapiServerHint?: string;
  readonly apiServerHint?: string;
}

export interface MeariWebRtcServer extends MeariSignalContact {
  readonly tag: string;
}

export interface MeariIceCandidate {
  readonly ip: string;
  readonly port: number;
  readonly type: string;
}

export interface ParsedMeariSdp {
  readonly usernameFragment: string;
  readonly password: string;
  readonly candidates: readonly MeariIceCandidate[];
}

export interface MeariLanOffer {
  readonly sdp: string;
  readonly usernameFragment: string;
  readonly password: string;
}

export interface MeariOfferOptions {
  readonly localIp: string;
  readonly localPort: number;
  readonly relayIp: string;
  readonly relayPort: number;
  readonly mappedIp?: string;
  readonly mappedPort?: number;
}

export interface MeariSignalingRegisterOptions {
  readonly clientId: string;
  readonly clientUuid?: string;
  readonly brand?: string;
  readonly appVersion?: string;
  readonly country?: string;
  readonly sdkVersion?: number;
}

export interface MeariSignalingTransport {
  readonly localPort: number;
  send(frame: Uint8Array): void | Promise<void>;
  receive(timeoutMs?: number): Promise<MsgSvrFrame>;
  close(): void;
}

export interface MeariSignalingClientOptions {
  readonly sessionIndex?: number;
}

interface UnknownRecord {
  readonly [key: string]: unknown;
}

interface PendingFrame {
  readonly resolve: (frame: MsgSvrFrame) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textAt(record: UnknownRecord, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function integerAt(record: UnknownRecord, key: string): number {
  const value = Number(record[key]);
  return Number.isInteger(value) ? value : 0;
}

function requireRecord(value: unknown, name: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`${name} is not an object`);
  return value;
}

function parseContact(value: unknown, name: string): MeariSignalContact {
  const record = requireRecord(value, name);
  const contact = {
    node: textAt(record, "node"),
    domain: textAt(record, "domain"),
    transport: textAt(record, "transport"),
    type: textAt(record, "type"),
    ip: textAt(record, "ip"),
    port: integerAt(record, "port"),
  };
  if (!contact.ip || contact.port < 1 || contact.port > 65_535) {
    throw new Error(`${name} omitted a valid IPv4 endpoint`);
  }
  return contact;
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function sessionIndex(value: number | undefined): number {
  const index = value ?? 1;
  if (!Number.isInteger(index) || index < 1 || index > 99) {
    throw new RangeError("sessionIndex must be between 1 and 99");
  }
  return index;
}

/** Build the native encrypted UDP root-server lookup. */
export function encodeMeariRootDiscoveryQuery(options: MeariRootDiscoveryOptions = {}): Buffer {
  const body: Record<string, unknown> = {
    action: "conf",
    ver: MEARI_ROOT_DISCOVERY_VERSION,
    t: ((options.now ?? Date.now)() / 1_000).toFixed(3),
  };
  if (options.clientId) body.uuid = options.clientId;
  if (options.domain) body.domain = options.domain;
  if (options.parent) body.tag = "parent";
  return encodeMsgSvrFrame({
    node: MSGSVR_NODES.APP,
    method: MSGSVR_METHODS.DIRECT,
    command: MSGSVR_COMMANDS.STATUS,
    payload: body,
  });
}

export function decodeMeariRootDiscoveryResponse(bytes: Uint8Array): MeariRootDiscoveryResponse {
  const frame = decodeMsgSvrFrame(bytes);
  const body = requireRecord(frame.payload, "root discovery response");
  if (body.action !== "conf") throw new Error("Unexpected root discovery action");
  const contact = body.contact === undefined
    ? undefined
    : parseContact(body.contact, "root discovery contact");
  const dnsServer = body.dnssvr === undefined
    ? undefined
    : parseContact(body.dnssvr, "root discovery DNS server");
  if (!contact && !dnsServer) {
    throw new Error("Root discovery response omitted both contact and DNS server");
  }
  return {
    ...(contact ? { contact } : {}),
    ...(textAt(body, "host") ? { host: textAt(body, "host") } : {}),
    ...(dnsServer ? { dnsServer } : {}),
    ...(textAt(body, "dnssvr_host") ? { dnsServerHost: textAt(body, "dnssvr_host") } : {}),
    frame,
  };
}

async function queryMeariRoot(
  address: string,
  port: number,
  query: Buffer,
  timeoutMs: number,
): Promise<MeariRootDiscoveryResponse> {
  const socket = createSocket("udp4");
  try {
    const response = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`Meari root discovery timed out at ${address}`));
      }, timeoutMs);
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once("message", (message) => {
        clearTimeout(timer);
        resolve(Buffer.from(message));
      });
      socket.send(query, port, address);
    });
    return decodeMeariRootDiscoveryResponse(response);
  } finally {
    try {
      socket.close();
    } catch {
      // The timeout path already closed it.
    }
  }
}

function hostname(value: string | undefined): string {
  const raw = value?.trim().toLowerCase() ?? "";
  if (!raw) return "";
  if (!raw.includes("://")) return raw.replace(/\.$/u, "");
  try {
    return new URL(raw).hostname.toLowerCase().replace(/\.$/u, "");
  } catch {
    return "";
  }
}

function regionCode(...values: readonly (string | undefined)[]): string {
  for (const value of values) {
    const host = hostname(value).replaceAll("-", ".");
    for (const part of host.split(".")) {
      if (["us", "eu", "as", "cn"].includes(part)) return part;
      if (["usce", "euce", "asce", "cnce"].includes(part)) return part.slice(0, 2);
    }
  }
  return "";
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function discoveryDomains(options: DiscoverMeariSignalingOptions): string[] {
  const openapiHost = hostname(options.openapiServerHint);
  const hinted = unique([
    hostname(options.platformDomainHint),
    openapiHost.startsWith("openapi-") ? openapiHost.slice(8) : openapiHost,
  ].filter(Boolean));
  const code = regionCode(
    options.apiServerHint,
    options.platformDomainHint,
    options.openapiServerHint,
  );
  const configured = options.domains ?? MEARI_DEFAULT_PLATFORM_DOMAINS;
  return unique([
    ...(code ? [`${code}ce.mearicloud.com`] : []),
    ...hinted,
    ...configured,
  ]);
}

function rootQueryOptions(options: DiscoverMeariSignalingOptions): MeariRootDiscoveryOptions[] {
  const code = options.domain ?? regionCode(
    options.apiServerHint,
    options.platformDomainHint,
    options.openapiServerHint,
  );
  return unique([
    JSON.stringify({ clientId: options.clientId }),
    JSON.stringify({}),
    JSON.stringify({ clientId: options.clientId, domain: code || undefined }),
    JSON.stringify({ domain: code || undefined }),
  ]).map((serialized) => {
    const parsed = JSON.parse(serialized) as { clientId?: string; domain?: string };
    return {
      ...(parsed.clientId ? { clientId: parsed.clientId } : {}),
      ...(parsed.domain ? { domain: parsed.domain } : {}),
      ...(options.now ? { now: options.now } : {}),
    };
  });
}

function parentQueryOptions(options: DiscoverMeariSignalingOptions): MeariRootDiscoveryOptions[] {
  const code = options.domain ?? regionCode(
    options.apiServerHint,
    options.platformDomainHint,
    options.openapiServerHint,
  );
  return unique([
    JSON.stringify({ clientId: options.clientId, parent: true }),
    JSON.stringify({ clientId: options.clientId, domain: code || undefined, parent: true }),
    JSON.stringify({ parent: true }),
  ]).map((serialized) => {
    const parsed = JSON.parse(serialized) as {
      clientId?: string;
      domain?: string;
      parent: boolean;
    };
    return {
      parent: true,
      ...(parsed.clientId ? { clientId: parsed.clientId } : {}),
      ...(parsed.domain ? { domain: parsed.domain } : {}),
      ...(options.now ? { now: options.now } : {}),
    };
  });
}

async function queryFirstUsefulRoot(
  address: string,
  port: number,
  queries: readonly MeariRootDiscoveryOptions[],
  timeoutMs: number,
): Promise<MeariRootDiscoveryResponse | undefined> {
  for (const options of queries) {
    try {
      const response = await queryMeariRoot(
        address,
        port,
        encodeMeariRootDiscoveryQuery(options),
        timeoutMs,
      );
      if (response.contact || response.dnsServer) return response;
    } catch {
      // A root may silently reject a UUID/domain variant. Try the native
      // generic shape before abandoning this address.
    }
  }
  return undefined;
}

/**
 * Discover every distinct regional MsgSvr contact, including the parent
 * lookup returned through the root response's dnssvr endpoint.
 */
export async function discoverMeariSignalingCandidates(
  options: DiscoverMeariSignalingOptions = {},
): Promise<readonly MeariRootDiscoveryResponse[]> {
  const timeoutMs = options.timeoutMs ?? 700;
  const responses: MeariRootDiscoveryResponse[] = [];
  const seen = new Set<string>();
  const add = (response: MeariRootDiscoveryResponse | undefined): void => {
    const contact = response?.contact;
    if (!response || !contact) return;
    const key = `${contact.ip}:${contact.port}`;
    if (seen.has(key)) return;
    seen.add(key);
    responses.push(response);
  };

  for (const domain of discoveryDomains(options)) {
    let addresses: readonly string[];
    try {
      addresses = await resolve4(domain);
    } catch {
      continue;
    }
    for (const address of addresses) {
      const root = await queryFirstUsefulRoot(
        address,
        MEARI_ROOT_DISCOVERY_PORT,
        rootQueryOptions(options),
        timeoutMs,
      );
      add(root);
      const dns = root?.dnsServer;
      if (dns) {
        add(await queryFirstUsefulRoot(
          dns.ip,
          dns.port,
          parentQueryOptions(options),
          timeoutMs,
        ));
      }
      if (root?.contact || root?.dnsServer) break;
    }
  }
  return responses;
}

/** Resolve the current regional TCP MsgSvr endpoint without an account login. */
export async function discoverMeariSignaling(
  options: DiscoverMeariSignalingOptions = {},
): Promise<MeariRootDiscoveryResponse> {
  const responses = await discoverMeariSignalingCandidates(options);
  const response = responses[0];
  if (response) return response;
  throw new Error("No Meari signaling endpoint answered root discovery");
}

/** Incremental MsgSvr framing for a TCP signaling socket. */
export class MeariMsgSvrTcpTransport implements MeariSignalingTransport {
  private readonly socket: Socket;
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly queue: MsgSvrFrame[] = [];
  private pending: PendingFrame | undefined;
  private terminalError: Error | undefined;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("Meari signaling socket closed")));
  }

  static async connect(host: string, port: number, timeoutMs = 5_000): Promise<MeariMsgSvrTcpTransport> {
    const socket = createConnection({ host, port });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Meari signaling connection to ${host}:${port} timed out`));
      }, timeoutMs);
      const onError = (error: Error): void => {
        clearTimeout(timer);
        reject(error);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.off("error", onError);
        socket.setKeepAlive(true);
        resolve();
      });
    });
    return new MeariMsgSvrTcpTransport(socket);
  }

  get localPort(): number {
    const address = this.socket.address();
    return typeof address === "object" && "port" in address ? Number(address.port) : 0;
  }

  private onData(chunk: Buffer): void {
    try {
      const split = splitMsgSvrFrames(Buffer.concat([this.buffer, chunk]));
      this.buffer = split.remainder;
      for (const bytes of split.frames) this.deliver(decodeMsgSvrFrame(bytes));
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private deliver(frame: MsgSvrFrame): void {
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.resolve(frame);
      return;
    }
    this.queue.push(frame);
  }

  private fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  async send(frame: Uint8Array): Promise<void> {
    if (this.terminalError) throw this.terminalError;
    const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
    await new Promise<void>((resolve, reject) => {
      this.socket.write(bytes, (error?: Error | null) => error ? reject(error) : resolve());
    });
  }

  async receive(timeoutMs = 5_000): Promise<MsgSvrFrame> {
    if (this.queue.length > 0) return this.queue.shift() as MsgSvrFrame;
    if (this.terminalError) throw this.terminalError;
    if (this.pending) throw new Error("Only one MsgSvr receive may be pending");
    return new Promise<MsgSvrFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new Error("Meari signaling response timed out"));
      }, timeoutMs);
      this.pending = { resolve, reject, timer };
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

export function meariClientUuid(clientId: string, profile = "cloudedge"): string {
  return createHash("md5")
    .update(`cloudplus-p2p|${profile}|${clientId}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

export function formatMeariDeviceUuid(serialNumber: string): string {
  const serial = serialNumber.trim();
  if (!serial) throw new TypeError("serialNumber is required");
  return serial.length === 9 ? `0000000${serial}` : serial.length > 16 ? serial.slice(4) : serial;
}

/** High-level app-side signaling used to obtain a camera's LAN ICE candidate. */
export class MeariSignalingClient {
  readonly transport: MeariSignalingTransport;
  readonly sessionIndex: number;
  uuid = "";
  token = "";
  heartbeatIntervalSeconds = 30;
  webRtcServer: MeariWebRtcServer | undefined;

  constructor(transport: MeariSignalingTransport, options: MeariSignalingClientOptions = {}) {
    this.transport = transport;
    this.sessionIndex = sessionIndex(options.sessionIndex);
  }

  static async connect(
    host: string,
    port: number,
    options: MeariSignalingClientOptions = {},
  ): Promise<MeariSignalingClient> {
    const transport = await MeariMsgSvrTcpTransport.connect(host, port);
    return new MeariSignalingClient(transport, options);
  }

  private async send(method: number, command: number, payload: unknown): Promise<void> {
    await this.transport.send(encodeMsgSvrFrame({
      node: MSGSVR_NODES.APP,
      method,
      command,
      payload,
    }));
  }

  private async response(timeoutMs?: number): Promise<UnknownRecord> {
    const frame = await this.transport.receive(timeoutMs);
    return requireRecord(frame.payload, "Meari signaling response");
  }

  async register(options: MeariSignalingRegisterOptions): Promise<UnknownRecord> {
    if (!options.clientId) throw new TypeError("clientId is required");
    const sdkVersion = options.sdkVersion ?? MEARI_ROOT_DISCOVERY_VERSION;
    const body: Record<string, unknown> = {
      action: "register",
      transport: "tcp",
      type: "binary",
      nat: {
        local_port: this.transport.localPort,
        medium: [{ mode: "xts", transport: "udp", type: "binary" }],
      },
      ver: sdkVersion,
      runtime: 0,
      extra_params: {
        brand: options.brand ?? "8",
        clientid: options.clientId,
        v: options.appVersion ?? "6.3.2a16",
        c: options.country ?? "US",
      },
    };
    if (options.clientUuid) body.uuid = options.clientUuid;
    await this.send(MSGSVR_METHODS.DIRECT, MSGSVR_COMMANDS.REGISTER, body);
    const response = await this.response();
    if (response.result !== "OK") throw new Error("Meari signaling registration failed");
    this.uuid = textAt(response, "uuid");
    this.token = textAt(response, "token");
    this.heartbeatIntervalSeconds = Number(response.hb) || 30;
    if (!this.uuid || !this.token) throw new Error("Meari registration omitted session identity");
    return response;
  }

  private sessionSuffix(): string {
    return String(this.sessionIndex).padStart(2, "0");
  }

  private sessionId(): string {
    if (!this.uuid) throw new Error("Meari signaling client is not registered");
    return `${this.uuid}:${this.sessionSuffix()}`;
  }

  private async sendWebRtc(inner: UnknownRecord, routed: boolean): Promise<void> {
    if (!this.uuid) throw new Error("Meari signaling client is not registered");
    const message: Record<string, unknown> = {
      from: {
        node: "client",
        domain: this.uuid,
        transport: "tcp",
        type: "binary",
      },
      content: Buffer.from(JSON.stringify(inner), "utf8").toString("base64"),
    };
    if (routed) {
      if (!this.webRtcServer) throw new Error("Meari WebRTC server is not selected");
      message.to = this.webRtcServer;
    } else {
      message.node = "webrtcsvr";
    }
    await this.send(
      routed ? MSGSVR_METHODS.ROUTED : MSGSVR_METHODS.DIRECT,
      MSGSVR_COMMANDS.WEBRTC,
      message,
    );
  }

  private async webRtcResponse(timeoutMs?: number): Promise<{
    readonly inner: UnknownRecord;
    readonly outer: UnknownRecord;
  }> {
    const outer = await this.response(timeoutMs);
    const content = textAt(outer, "content");
    if (!content) throw new Error("Meari WebRTC response omitted content");
    const inner = requireRecord(
      JSON.parse(Buffer.from(content, "base64").toString("utf8")) as unknown,
      "Meari WebRTC response content",
    );
    return { inner, outer };
  }

  async hello(): Promise<UnknownRecord> {
    await this.sendWebRtc({ cmd: "hello" }, false);
    const { inner, outer } = await this.webRtcResponse();
    const from = requireRecord(outer.from, "Meari WebRTC hello source");
    this.webRtcServer = {
      ...parseContact(from, "Meari WebRTC hello source"),
      tag: textAt(inner, "tag"),
    };
    return inner;
  }

  async queryDeviceStatus(deviceUuid: string): Promise<UnknownRecord> {
    await this.send(MSGSVR_METHODS.DIRECT, MSGSVR_COMMANDS.STATUS, {
      action: "status",
      uuid: deviceUuid,
      sid: randomHex(8),
    });
    return this.response();
  }

  async requestCoturn(deviceUuid: string): Promise<UnknownRecord> {
    await this.sendWebRtc({
      cmd: "option",
      sid: this.sessionId(),
      caller: this.uuid,
      callee: deviceUuid,
      method: "coturn",
    }, true);
    return (await this.webRtcResponse()).inner;
  }

  async sendOffer(deviceUuid: string, sdp: string): Promise<UnknownRecord> {
    if (!this.webRtcServer) throw new Error("Meari WebRTC server is not selected");
    await this.sendWebRtc({
      cmd: "offer",
      sid: this.sessionId(),
      caller: this.uuid,
      callee: deviceUuid,
      channel: 0,
      stream_type: 1,
      sdp,
      tag: `${this.webRtcServer.tag}${this.sessionSuffix()}`,
    }, true);
    return (await this.webRtcResponse(15_000)).inner;
  }

  async sendCandidateComplete(deviceUuid: string): Promise<UnknownRecord> {
    await this.sendWebRtc({
      cmd: "candidate",
      sid: this.sessionId(),
      caller: this.uuid,
      callee: deviceUuid,
      candidate: { cmd: "nego", state: "completed", mode: 1 },
    }, true);
    return (await this.webRtcResponse()).inner;
  }

  close(): void {
    this.transport.close();
  }
}

function offerIpv4(name: string, value: string): number[] {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    throw new TypeError(`${name} must be an IPv4 address`);
  }
  return octets;
}

function offerPort(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new RangeError(`${name} must be between 1 and 65535`);
  }
}

/** Build the native host + mapped + implicit relay SDP sent by CloudEdge. */
export function buildMeariOffer(options: MeariOfferOptions): MeariLanOffer {
  const octets = offerIpv4("localIp", options.localIp);
  offerIpv4("relayIp", options.relayIp);
  offerPort("localPort", options.localPort);
  offerPort("relayPort", options.relayPort);
  if ((options.mappedIp === undefined) !== (options.mappedPort === undefined)) {
    throw new TypeError("mappedIp and mappedPort must be provided together");
  }
  if (options.mappedIp !== undefined && options.mappedPort !== undefined) {
    offerIpv4("mappedIp", options.mappedIp);
    offerPort("mappedPort", options.mappedPort);
  }
  const usernameFragment = randomHex(4);
  const password = randomHex(12);
  const foundation = `H${Buffer.from(octets).toString("hex")}`;
  const lines = [
    "n=0 0 0 0 0",
    "a=transport:auto",
    `a=ice-ufrag:${usernameFragment}`,
    `a=ice-pwd:${password}`,
    `m=audio ${options.relayPort} RTP / AVP 0`,
    `c=IN IP4 ${options.relayIp}`,
    `a=candidate:${foundation} 1 UDP 1694498815 ${options.localIp} ${options.localPort} typ host`,
  ];
  if (options.mappedIp !== undefined && options.mappedPort !== undefined) {
    lines.push(
      `a=candidate:S${Buffer.from(octets).toString("hex")} 1 UDP 1862270975 ${options.mappedIp} ${options.mappedPort} typ srflx`,
    );
  }
  const sdp = `${lines.join("\n")}\n`;
  return { sdp, usernameFragment, password };
}

export function buildMeariLanOffer(localIp: string, localPort: number): MeariLanOffer {
  return buildMeariOffer({
    localIp,
    localPort,
    relayIp: localIp,
    relayPort: localPort,
  });
}

export function parseMeariSdp(sdp: string): ParsedMeariSdp {
  let usernameFragment = "";
  let password = "";
  let mediaIp = "";
  let mediaPort = 0;
  const candidates: MeariIceCandidate[] = [];
  const add = (candidate: MeariIceCandidate): void => {
    if (!candidate.ip || !candidate.port) return;
    if (!candidates.some((item) => item.ip === candidate.ip && item.port === candidate.port)) {
      candidates.push(candidate);
    }
  };
  for (const raw of sdp.replaceAll("\\n", "\n").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("a=ice-ufrag:")) usernameFragment = line.slice(12).trim();
    else if (line.startsWith("a=ice-pwd:")) password = line.slice(10).trim();
    else if (line.startsWith("c=IN IP4 ")) mediaIp = line.slice(9).trim();
    else if (line.startsWith("m=")) mediaPort = Number(line.split(/\s+/u)[1]) || 0;
    else if (line.startsWith("a=candidate:")) {
      const parts = line.split(/\s+/u);
      add({ ip: parts[4] ?? "", port: Number(parts[5]) || 0, type: parts[7] ?? "relay" });
    }
  }
  if (mediaIp && mediaPort) {
    const media = { ip: mediaIp, port: mediaPort, type: "relay" };
    const duplicate = candidates.findIndex((item) => item.ip === mediaIp && item.port === mediaPort);
    if (duplicate >= 0) candidates.splice(duplicate, 1);
    candidates.unshift(media);
  }
  return { usernameFragment, password, candidates };
}
