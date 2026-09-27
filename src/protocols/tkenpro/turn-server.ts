import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import {
  decodeStunMessage,
  encodeStunAttribute,
  encodeStunMessage,
  STUN_ATTRIBUTES,
  STUN_BINDING_REQUEST,
  STUN_BINDING_SUCCESS,
  STUN_HEADER_SIZE,
  STUN_MAGIC_COOKIE,
  type ParsedStunMessage,
  type StunAttributeInput,
} from "./ice.ts";
import {
  decodeTurnXorAddress,
  encodeTurnXorAddress,
  TURN_ATTRIBUTES,
  TURN_MESSAGES,
  type MeariTurnAddress,
} from "./turn.ts";

interface AuthorizedCredential {
  readonly password: string;
  readonly expiresAt: number;
}

interface LocalTurnAllocation {
  readonly source: { readonly ip: string; readonly port: number };
  readonly username: string;
  readonly permissions: Map<string, number>;
  readonly channels: Map<number, MeariTurnAddress>;
  readonly reverseChannels: Map<string, number>;
  expiresAt: number;
}

interface AuthenticatedRequest {
  readonly key: Buffer;
  readonly username: string;
}

export interface MeariLocalTurnServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly advertisedHost: string;
  readonly realm?: string;
  readonly allocationLifetimeSeconds?: number;
  readonly allowSourceAddress: (address: string) => boolean;
  readonly onAllocation?: (source: { readonly ip: string; readonly port: number }) => void;
  readonly onError?: (error: Error) => void;
}

export interface MeariLocalTurnCredential {
  readonly username: string;
  readonly password: string;
  readonly release: () => void;
}

function assertPort(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new RangeError("Local TURN port must be between 0 and 65535");
  }
}

function normalizedAddress(value: string): string {
  return value.replace(/^::ffff:/u, "");
}

function endpointKey(ip: string, port: number): string {
  return `${normalizedAddress(ip)}:${port}`;
}

/** Encode the camera SDK's UDP ChannelData variant with its one-byte NUL suffix. */
export function encodeMeariTurnChannelData(channel: number, payload: Uint8Array): Buffer {
  if (!Number.isInteger(channel) || channel < 0x4000 || channel > 0x7fff) {
    throw new RangeError("TURN channel must be between 0x4000 and 0x7fff");
  }
  const bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const bodyLength = bytes.byteLength + 1;
  const frame = Buffer.allocUnsafe(4 + bodyLength);
  frame.writeUInt16BE(channel, 0);
  frame.writeUInt16BE(bodyLength, 2);
  bytes.copy(frame, 4);
  frame[frame.byteLength - 1] = 0;
  return frame;
}

function attribute(message: ParsedStunMessage, type: number): Buffer | undefined {
  return message.attributes.find((candidate) => candidate.type === type)?.value;
}

function uint32(value: number): Buffer {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value >>> 0);
  return bytes;
}

function errorCode(code: number, reason: string): Buffer {
  const text = Buffer.from(reason, "utf8");
  const value = Buffer.alloc(4 + text.byteLength);
  value[2] = Math.floor(code / 100);
  value[3] = code % 100;
  text.copy(value, 4);
  return value;
}

function longTermKey(username: string, realm: string, password: string): Buffer {
  return createHash("md5").update(`${username}:${realm}:${password}`, "utf8").digest();
}

function authenticatedMessage(
  type: number,
  attributes: readonly StunAttributeInput[],
  transactionId: Uint8Array,
  key: Buffer,
): Buffer {
  const beforeIntegrity = Buffer.concat(attributes.map(encodeStunAttribute));
  const header = Buffer.allocUnsafe(STUN_HEADER_SIZE);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(beforeIntegrity.byteLength + 24, 2);
  header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  Buffer.from(transactionId).copy(header, 8);
  const integrity = createHmac("sha1", key)
    .update(header)
    .update(beforeIntegrity)
    .digest();
  return encodeStunMessage(
    type,
    [...attributes, { type: TURN_ATTRIBUTES.MESSAGE_INTEGRITY, value: integrity }],
    transactionId,
  );
}

function verifyIntegrity(message: ParsedStunMessage, key: Buffer): boolean {
  const integrity = message.attributes.find(
    (candidate) => candidate.type === STUN_ATTRIBUTES.MESSAGE_INTEGRITY,
  );
  if (!integrity || integrity.value.byteLength !== 20) return false;
  const header = Buffer.from(message.bytes.subarray(0, STUN_HEADER_SIZE));
  header.writeUInt16BE(integrity.offset - STUN_HEADER_SIZE + 24, 2);
  const expected = createHmac("sha1", key)
    .update(header)
    .update(message.bytes.subarray(STUN_HEADER_SIZE, integrity.offset))
    .digest();
  return timingSafeEqual(expected, integrity.value);
}

/**
 * Camera-facing TURN subset used during local peer bootstrap.
 *
 * Firmware performs a binding check, authenticated allocation, and sometimes
 * refresh/permission/channel-bind requests even when ICE ultimately selects
 * the direct LAN candidate. This server implements those exchanges while
 * accepting only an authorized camera source and short-lived credentials.
 */
export class MeariLocalTurnServer {
  readonly socket: Socket;
  readonly realm: string;
  readonly allocationLifetimeSeconds: number;
  private readonly credentials = new Map<string, AuthorizedCredential>();
  private readonly nonces = new Map<string, string>();
  private readonly allocations = new Map<string, LocalTurnAllocation>();
  private boundPort = 0;
  private started = false;
  private successfulAllocations = 0;
  private successfulPermissions = 0;
  private successfulChannelBindings = 0;
  private relayedPackets = 0;
  private peerChannelDataPackets = 0;
  private peerDataIndicationPackets = 0;
  private cameraChannelDataPackets = 0;
  private unmatchedPeerPackets = 0;

  constructor(readonly options: MeariLocalTurnServerOptions) {
    if (!options.advertisedHost.trim()) throw new TypeError("advertisedHost is required");
    if (typeof options.allowSourceAddress !== "function") {
      throw new TypeError("allowSourceAddress is required");
    }
    assertPort(options.port ?? 9_100);
    this.realm = options.realm ?? "hometruth";
    this.allocationLifetimeSeconds = options.allocationLifetimeSeconds ?? 600;
    if (
      !Number.isInteger(this.allocationLifetimeSeconds)
      || this.allocationLifetimeSeconds < 1
      || this.allocationLifetimeSeconds > 86_400
    ) {
      throw new RangeError("allocationLifetimeSeconds must be between 1 and 86400");
    }
    this.socket = createSocket("udp4");
    this.socket.on("message", (bytes, source) => this.handle(Buffer.from(bytes), source));
    this.socket.on("error", (error) => this.options.onError?.(error));
  }

  get port(): number {
    return this.boundPort;
  }

  get allocationCount(): number {
    return this.successfulAllocations;
  }

  get permissionCount(): number {
    return this.successfulPermissions;
  }

  get channelBindingCount(): number {
    return this.successfulChannelBindings;
  }

  get relayedPacketCount(): number {
    return this.relayedPackets;
  }

  get peerChannelDataPacketCount(): number {
    return this.peerChannelDataPackets;
  }

  get peerDataIndicationPacketCount(): number {
    return this.peerDataIndicationPackets;
  }

  get cameraChannelDataPacketCount(): number {
    return this.cameraChannelDataPackets;
  }

  get unmatchedPeerPacketCount(): number {
    return this.unmatchedPeerPackets;
  }

  authorizeCredential(username: string, password: string, lifetimeMs = 120_000): () => void {
    if (!username.trim() || !password) throw new TypeError("TURN username and password are required");
    if (!Number.isInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 86_400_000) {
      throw new RangeError("TURN credential lifetime must be between 1 and 86400000 milliseconds");
    }
    const credential = { password, expiresAt: Date.now() + lifetimeMs };
    this.credentials.set(username, credential);
    return () => {
      if (this.credentials.get(username) === credential) {
        this.credentials.delete(username);
        for (const [key, allocation] of this.allocations) {
          if (allocation.username === username) this.allocations.delete(key);
        }
      }
    };
  }

  issueCredential(lifetimeMs = 120_000): MeariLocalTurnCredential {
    const username = `${Math.floor((Date.now() + lifetimeMs) / 1_000)}:mearicloud`;
    const password = randomBytes(20).toString("base64");
    return {
      username,
      password,
      release: this.authorizeCredential(username, password, lifetimeMs),
    };
  }

  private challenge(message: ParsedStunMessage, source: RemoteInfo): Buffer {
    const sourceAddress = normalizedAddress(source.address);
    let nonce = this.nonces.get(sourceAddress);
    if (!nonce) {
      nonce = randomBytes(8).toString("hex");
      this.nonces.set(sourceAddress, nonce);
    }
    return encodeStunMessage(message.type | 0x0110, [
      { type: TURN_ATTRIBUTES.ERROR_CODE, value: errorCode(401, "Unauthorized") },
      { type: TURN_ATTRIBUTES.NONCE, value: Buffer.from(nonce, "utf8") },
      { type: TURN_ATTRIBUTES.REALM, value: Buffer.from(this.realm, "utf8") },
    ], message.transactionId);
  }

  private authenticatedRequest(
    message: ParsedStunMessage,
    source: RemoteInfo,
  ): AuthenticatedRequest | undefined {
    const username = attribute(message, TURN_ATTRIBUTES.USERNAME)?.toString("utf8").replaceAll("\0", "");
    const realm = attribute(message, TURN_ATTRIBUTES.REALM)?.toString("utf8").replaceAll("\0", "");
    const nonce = attribute(message, TURN_ATTRIBUTES.NONCE)?.toString("utf8").replaceAll("\0", "");
    const expectedNonce = this.nonces.get(normalizedAddress(source.address));
    if (!username || realm !== this.realm || !nonce || nonce !== expectedNonce) return undefined;
    const credential = this.credentials.get(username);
    if (!credential || credential.expiresAt <= Date.now()) {
      this.credentials.delete(username);
      return undefined;
    }
    const key = longTermKey(username, this.realm, credential.password);
    return verifyIntegrity(message, key) ? { key, username } : undefined;
  }

  private successAttributes(message: ParsedStunMessage, source: RemoteInfo): StunAttributeInput[] {
    if (message.type === TURN_MESSAGES.ALLOCATE_REQUEST) {
      return [
        {
          type: TURN_ATTRIBUTES.XOR_RELAYED_ADDRESS,
          value: encodeTurnXorAddress(this.options.advertisedHost, this.boundPort),
        },
        {
          type: TURN_ATTRIBUTES.XOR_MAPPED_ADDRESS,
          value: encodeTurnXorAddress(normalizedAddress(source.address), source.port),
        },
        { type: TURN_ATTRIBUTES.LIFETIME, value: uint32(this.allocationLifetimeSeconds) },
      ];
    }
    if (message.type === TURN_MESSAGES.REFRESH_REQUEST) {
      return [{ type: TURN_ATTRIBUTES.LIFETIME, value: uint32(this.allocationLifetimeSeconds) }];
    }
    return [];
  }

  private send(bytes: Uint8Array, source: RemoteInfo): void {
    this.socket.send(bytes, source.port, source.address, (error) => {
      if (error) this.options.onError?.(error);
    });
  }

  private activeAllocation(source: RemoteInfo): LocalTurnAllocation | undefined {
    const key = endpointKey(source.address, source.port);
    const allocation = this.allocations.get(key);
    if (!allocation) return undefined;
    if (allocation.expiresAt <= Date.now()) {
      this.allocations.delete(key);
      return undefined;
    }
    return allocation;
  }

  private peerAllocation(source: RemoteInfo): {
    readonly allocation: LocalTurnAllocation;
    readonly channel?: number;
  } | undefined {
    const sourceAddress = normalizedAddress(source.address);
    const now = Date.now();
    for (const [key, allocation] of this.allocations) {
      if (allocation.expiresAt <= now) {
        this.allocations.delete(key);
        continue;
      }
      const channel = allocation.reverseChannels.get(endpointKey(sourceAddress, source.port));
      if (channel !== undefined) return { allocation, channel };
      const permission = allocation.permissions.get(sourceAddress);
      if (permission !== undefined && permission > now) return { allocation };
    }
    return undefined;
  }

  private sendChannelData(
    allocation: LocalTurnAllocation,
    channel: number,
    payload: Buffer,
  ): void {
    // Meari's native TURN path includes one compatibility NUL in ChannelData.
    // Its UDP transport ends the datagram at that declared byte length; unlike
    // stream transports, it does not append four-byte alignment padding.
    const frame = encodeMeariTurnChannelData(channel, payload);
    this.send(frame, {
      address: allocation.source.ip,
      family: "IPv4",
      port: allocation.source.port,
      size: frame.byteLength,
    });
  }

  private sendDataIndication(allocation: LocalTurnAllocation, peer: MeariTurnAddress, payload: Buffer): void {
    this.send(encodeStunMessage(TURN_MESSAGES.DATA_INDICATION, [
      { type: TURN_ATTRIBUTES.XOR_PEER_ADDRESS, value: encodeTurnXorAddress(peer.ip, peer.port) },
      { type: TURN_ATTRIBUTES.DATA, value: payload },
    ]), {
      address: allocation.source.ip,
      family: "IPv4",
      port: allocation.source.port,
      size: payload.byteLength,
    });
  }

  private relayFromPeer(bytes: Buffer, source: RemoteInfo): boolean {
    const match = this.peerAllocation(source);
    if (!match) return false;
    if (match.channel !== undefined) {
      this.sendChannelData(match.allocation, match.channel, bytes);
      this.peerChannelDataPackets += 1;
    } else {
      this.sendDataIndication(match.allocation, {
        ip: normalizedAddress(source.address),
        port: source.port,
      }, bytes);
      this.peerDataIndicationPackets += 1;
    }
    this.relayedPackets += 1;
    return true;
  }

  private relayCameraChannelData(bytes: Buffer, source: RemoteInfo): boolean {
    if (bytes.byteLength < 4 || ((bytes[0] as number) & 0xc0) !== 0x40) return false;
    const allocation = this.activeAllocation(source);
    if (!allocation) return false;
    const channel = bytes.readUInt16BE(0);
    const length = bytes.readUInt16BE(2);
    if (length > bytes.byteLength - 4) return false;
    const peer = allocation.channels.get(channel);
    if (!peer) return false;
    let payload = Buffer.from(bytes.subarray(4, 4 + length));
    if (payload.at(-1) === 0) payload = payload.subarray(0, -1);
    this.socket.send(payload, peer.port, peer.ip, (error) => {
      if (error) this.options.onError?.(error);
    });
    this.cameraChannelDataPackets += 1;
    this.relayedPackets += 1;
    return true;
  }

  private relayCameraSendIndication(message: ParsedStunMessage, source: RemoteInfo): boolean {
    if (message.type !== TURN_MESSAGES.SEND_INDICATION) return false;
    const allocation = this.activeAllocation(source);
    if (!allocation) return true;
    const peerValue = attribute(message, TURN_ATTRIBUTES.XOR_PEER_ADDRESS);
    const data = attribute(message, TURN_ATTRIBUTES.DATA);
    const peer = peerValue ? decodeTurnXorAddress(peerValue) : undefined;
    if (!peer || !data) return true;
    const permission = allocation.permissions.get(peer.ip);
    if (permission === undefined || permission <= Date.now()) return true;
    this.socket.send(data, peer.port, peer.ip, (error) => {
      if (error) this.options.onError?.(error);
    });
    this.relayedPackets += 1;
    return true;
  }

  private updateAllocation(
    message: ParsedStunMessage,
    source: RemoteInfo,
    authenticated: AuthenticatedRequest,
  ): void {
    const key = endpointKey(source.address, source.port);
    if (message.type === TURN_MESSAGES.ALLOCATE_REQUEST) {
      this.allocations.set(key, {
        source: { ip: normalizedAddress(source.address), port: source.port },
        username: authenticated.username,
        permissions: new Map(),
        channels: new Map(),
        reverseChannels: new Map(),
        expiresAt: Date.now() + this.allocationLifetimeSeconds * 1_000,
      });
      return;
    }
    const allocation = this.activeAllocation(source);
    if (!allocation || allocation.username !== authenticated.username) return;
    if (message.type === TURN_MESSAGES.REFRESH_REQUEST) {
      const lifetime = attribute(message, TURN_ATTRIBUTES.LIFETIME);
      const requested = lifetime && lifetime.byteLength >= 4
        ? lifetime.readUInt32BE(0)
        : this.allocationLifetimeSeconds;
      if (requested === 0) this.allocations.delete(key);
      else allocation.expiresAt = Date.now() + Math.min(requested, this.allocationLifetimeSeconds) * 1_000;
      return;
    }
    const peerValue = attribute(message, TURN_ATTRIBUTES.XOR_PEER_ADDRESS);
    const peer = peerValue ? decodeTurnXorAddress(peerValue) : undefined;
    if (!peer) return;
    if (message.type === TURN_MESSAGES.CREATE_PERMISSION_REQUEST) {
      allocation.permissions.set(peer.ip, Date.now() + 300_000);
      this.successfulPermissions += 1;
      return;
    }
    if (message.type === TURN_MESSAGES.CHANNEL_BIND_REQUEST) {
      const channelValue = attribute(message, TURN_ATTRIBUTES.CHANNEL_NUMBER);
      if (!channelValue || channelValue.byteLength < 2) return;
      const channel = channelValue.readUInt16BE(0);
      if (channel < 0x4000 || channel > 0x7fff) return;
      allocation.permissions.set(peer.ip, Date.now() + 300_000);
      allocation.channels.set(channel, peer);
      allocation.reverseChannels.set(endpointKey(peer.ip, peer.port), channel);
      this.successfulChannelBindings += 1;
    }
  }

  private handle(bytes: Buffer, source: RemoteInfo): void {
    const sourceAddress = normalizedAddress(source.address);
    const cameraSource = this.options.allowSourceAddress(sourceAddress);
    if (!cameraSource) {
      if (!this.relayFromPeer(bytes, source)) this.unmatchedPeerPackets += 1;
      return;
    }
    if (this.relayCameraChannelData(bytes, source)) return;
    let message: ParsedStunMessage;
    try {
      message = decodeStunMessage(bytes);
    } catch {
      // This also permits same-host loopback tests: an exact channel-bound peer
      // endpoint remains narrower than the camera address allow-list.
      this.relayFromPeer(bytes, source);
      return;
    }
    if (this.relayCameraSendIndication(message, source)) return;

    if (message.type === STUN_BINDING_REQUEST) {
      this.send(encodeStunMessage(STUN_BINDING_SUCCESS, [{
        type: STUN_ATTRIBUTES.XOR_MAPPED_ADDRESS,
        value: encodeTurnXorAddress(sourceAddress, source.port),
      }], message.transactionId), source);
      return;
    }

    const supported = new Set<number>([
      TURN_MESSAGES.ALLOCATE_REQUEST,
      TURN_MESSAGES.REFRESH_REQUEST,
      TURN_MESSAGES.CREATE_PERMISSION_REQUEST,
      TURN_MESSAGES.CHANNEL_BIND_REQUEST,
    ]);
    if (!supported.has(message.type)) return;
    const authenticated = this.authenticatedRequest(message, source);
    if (!authenticated) {
      this.send(this.challenge(message, source), source);
      return;
    }
    this.updateAllocation(message, source, authenticated);
    const response = authenticatedMessage(
      message.type | 0x0100,
      this.successAttributes(message, source),
      message.transactionId,
      authenticated.key,
    );
    this.send(response, source);
    if (message.type === TURN_MESSAGES.ALLOCATE_REQUEST) {
      this.successfulAllocations += 1;
      this.options.onAllocation?.({ ip: sourceAddress, port: source.port });
    }
  }

  async start(): Promise<number> {
    if (this.started) return this.boundPort;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.socket.once("error", onError);
      this.socket.bind(this.options.port ?? 9_100, this.options.host ?? "127.0.0.1", () => {
        this.socket.off("error", onError);
        resolve();
      });
    });
    const address = this.socket.address();
    if (typeof address === "string") throw new Error("Local TURN server did not expose a UDP port");
    this.boundPort = address.port;
    this.started = true;
    return this.boundPort;
  }

  async stop(): Promise<void> {
    this.credentials.clear();
    this.nonces.clear();
    this.allocations.clear();
    if (!this.started) return;
    this.started = false;
    await new Promise<void>((resolve) => this.socket.close(() => resolve()));
  }
}
