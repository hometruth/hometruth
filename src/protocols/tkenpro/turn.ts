import { createHash, createHmac, randomBytes } from "node:crypto";
import { createSocket, type RemoteInfo, type Socket } from "node:dgram";
import {
  decodeStunMessage,
  encodeStunAttribute,
  encodeStunMessage,
  STUN_ATTRIBUTES,
  STUN_MAGIC_COOKIE,
  type ParsedStunMessage,
  type StunAttributeInput,
} from "./ice.ts";

export const TURN_MESSAGES = Object.freeze({
  BINDING_REQUEST: 0x0001,
  BINDING_SUCCESS: 0x0101,
  BINDING_ERROR: 0x0111,
  ALLOCATE_REQUEST: 0x0003,
  ALLOCATE_SUCCESS: 0x0103,
  ALLOCATE_ERROR: 0x0113,
  REFRESH_REQUEST: 0x0004,
  REFRESH_SUCCESS: 0x0104,
  CREATE_PERMISSION_REQUEST: 0x0008,
  CREATE_PERMISSION_SUCCESS: 0x0108,
  CHANNEL_BIND_REQUEST: 0x0009,
  CHANNEL_BIND_SUCCESS: 0x0109,
  SEND_INDICATION: 0x0016,
  DATA_INDICATION: 0x0017,
});

export const TURN_ATTRIBUTES = Object.freeze({
  MAPPED_ADDRESS: 0x0001,
  USERNAME: STUN_ATTRIBUTES.USERNAME,
  MESSAGE_INTEGRITY: STUN_ATTRIBUTES.MESSAGE_INTEGRITY,
  ERROR_CODE: 0x0009,
  CHANNEL_NUMBER: 0x000c,
  LIFETIME: 0x000d,
  XOR_PEER_ADDRESS: 0x0012,
  DATA: 0x0013,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_TRANSPORT: 0x0019,
  XOR_MAPPED_ADDRESS: STUN_ATTRIBUTES.XOR_MAPPED_ADDRESS,
});

export interface MeariTurnClientOptions {
  readonly serverIp: string;
  readonly serverPort: number;
  readonly username: string;
  readonly password: string;
  readonly realm?: string;
  readonly bindAddress?: string;
  readonly requestTimeoutMs?: number;
}

export interface MeariTurnAddress {
  readonly ip: string;
  readonly port: number;
}

export interface MeariTurnAllocation {
  readonly relay: MeariTurnAddress;
  readonly mapped?: MeariTurnAddress;
  readonly local: MeariTurnAddress;
}

export interface MeariTurnPacket {
  readonly data: Buffer;
  readonly source: MeariTurnAddress;
  readonly peer?: MeariTurnAddress;
  readonly viaTurn: boolean;
  readonly stun?: ParsedStunMessage;
}

interface PendingRequest {
  readonly successType: number;
  readonly errorType: number;
  readonly resolve: (message: ParsedStunMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface PacketWaiter {
  readonly resolve: (packet: MeariTurnPacket) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function assertPort(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new RangeError(`${name} must be between 1 and 65535`);
  }
}

function ipv4Bytes(ip: string): Buffer {
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new TypeError("TURN address must be IPv4");
  }
  return Buffer.from(octets);
}

function ipv4Text(bytes: Uint8Array): string {
  if (bytes.byteLength !== 4) throw new TypeError("IPv4 address requires four bytes");
  return [...bytes].join(".");
}

export function encodeTurnXorAddress(ip: string, port: number): Buffer {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("TURN peer port must be between 0 and 65535");
  }
  const magic = Buffer.allocUnsafe(4);
  magic.writeUInt32BE(STUN_MAGIC_COOKIE);
  const input = ipv4Bytes(ip);
  const value = Buffer.allocUnsafe(8);
  value.writeUInt8(0, 0);
  value.writeUInt8(1, 1);
  value.writeUInt16BE(port ^ (STUN_MAGIC_COOKIE >>> 16), 2);
  for (let index = 0; index < 4; index += 1) {
    value[4 + index] = (input[index] as number) ^ (magic[index] as number);
  }
  return value;
}

export function decodeTurnXorAddress(value: Uint8Array): MeariTurnAddress | undefined {
  const bytes = asBuffer(value);
  if (bytes.byteLength < 8 || bytes[1] !== 1) return undefined;
  const magic = Buffer.allocUnsafe(4);
  magic.writeUInt32BE(STUN_MAGIC_COOKIE);
  const address = Buffer.allocUnsafe(4);
  for (let index = 0; index < 4; index += 1) {
    address[index] = (bytes[4 + index] as number) ^ (magic[index] as number);
  }
  return {
    ip: ipv4Text(address),
    port: bytes.readUInt16BE(2) ^ (STUN_MAGIC_COOKIE >>> 16),
  };
}

function attribute(message: ParsedStunMessage, type: number): Buffer | undefined {
  return message.attributes.find((candidate) => candidate.type === type)?.value;
}

function encodeAttributes(attributes: readonly StunAttributeInput[]): Buffer {
  return Buffer.concat(attributes.map(encodeStunAttribute));
}

function longTermKey(username: string, realm: string, password: string): Buffer {
  return createHash("md5").update(`${username}:${realm}:${password}`, "utf8").digest();
}

function authenticatedTurnMessage(
  messageType: number,
  attributes: readonly StunAttributeInput[],
  transactionId: Buffer,
  key: Buffer,
): Buffer {
  const beforeIntegrity = encodeAttributes(attributes);
  const header = Buffer.allocUnsafe(20);
  header.writeUInt16BE(messageType, 0);
  header.writeUInt16BE(beforeIntegrity.byteLength + 24, 2);
  header.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
  transactionId.copy(header, 8);
  const integrity = createHmac("sha1", key)
    .update(header)
    .update(beforeIntegrity)
    .digest();
  return encodeStunMessage(
    messageType,
    [...attributes, { type: TURN_ATTRIBUTES.MESSAGE_INTEGRITY, value: integrity }],
    transactionId,
  );
}

function turnError(message: ParsedStunMessage): string {
  const value = attribute(message, TURN_ATTRIBUTES.ERROR_CODE);
  if (!value || value.byteLength < 4) return "TURN request failed";
  const code = (value[2] as number) * 100 + (value[3] as number);
  const reason = value.subarray(4).toString("utf8").replaceAll("\0", "").trim();
  return `TURN error ${code}${reason ? `: ${reason}` : ""}`;
}

function maybeStun(data: Buffer): ParsedStunMessage | undefined {
  try {
    return decodeStunMessage(data);
  } catch {
    return undefined;
  }
}

/** RFC 5766 subset used by Meari's authenticated UDP relay. */
export class MeariTurnClient {
  readonly serverIp: string;
  readonly serverPort: number;
  readonly username: string;
  readonly password: string;

  private readonly bindAddress: string;
  private readonly requestTimeoutMs: number;
  private readonly socket: Socket;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly packetQueue: MeariTurnPacket[] = [];
  private packetWaiter: PacketWaiter | undefined;
  private realm: string;
  private nonce: Buffer | undefined;
  private bound = false;
  private closed = false;
  private channelCounter = 0x4000;
  private readonly channels = new Map<string, number>();
  private readonly reverseChannels = new Map<number, MeariTurnAddress>();
  private allocation: MeariTurnAllocation | undefined;

  constructor(options: MeariTurnClientOptions) {
    assertPort("TURN server port", options.serverPort);
    if (!options.serverIp || !options.username || !options.password) {
      throw new TypeError("TURN serverIp, username, and password are required");
    }
    this.serverIp = options.serverIp;
    this.serverPort = options.serverPort;
    this.username = options.username;
    this.password = options.password;
    this.realm = options.realm ?? "hangzhou";
    this.bindAddress = options.bindAddress ?? "0.0.0.0";
    this.requestTimeoutMs = options.requestTimeoutMs ?? 3_000;
    this.socket = createSocket("udp4");
    this.socket.on("message", (data, remote) => this.onMessage(Buffer.from(data), remote));
    this.socket.on("error", (error) => this.fail(error));
  }

  get localPort(): number {
    if (!this.bound) return 0;
    const address = this.socket.address();
    return typeof address === "string" ? 0 : address.port;
  }

  get relayAddress(): MeariTurnAddress | undefined {
    return this.allocation?.relay;
  }

  get mappedAddress(): MeariTurnAddress | undefined {
    return this.allocation?.mapped;
  }

  async bind(): Promise<number> {
    if (this.bound) return this.localPort;
    if (this.closed) throw new Error("TURN client is closed");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.socket.once("error", onError);
      this.socket.bind(0, this.bindAddress, () => {
        this.socket.off("error", onError);
        this.bound = true;
        try {
          this.socket.setRecvBufferSize(16 * 1024 * 1024);
        } catch {
          // The OS may cap the receive buffer. The default is enough for control.
        }
        resolve();
      });
    });
    return this.localPort;
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (this.packetWaiter) {
      clearTimeout(this.packetWaiter.timer);
      this.packetWaiter.reject(error);
      this.packetWaiter = undefined;
    }
  }

  private deliver(packet: MeariTurnPacket): void {
    if (this.packetWaiter) {
      const waiter = this.packetWaiter;
      this.packetWaiter = undefined;
      clearTimeout(waiter.timer);
      waiter.resolve(packet);
      return;
    }
    this.packetQueue.push(packet);
  }

  private unwrap(data: Buffer, remote: RemoteInfo, stun?: ParsedStunMessage): MeariTurnPacket {
    const source = { ip: remote.address, port: remote.port };
    if (data.byteLength >= 4 && ((data[0] as number) & 0xc0) === 0x40) {
      const channel = data.readUInt16BE(0);
      const length = data.readUInt16BE(2);
      let payload = Buffer.from(data.subarray(4, 4 + length));
      if (
        payload.at(-1) === 0 && payload.byteLength > 20 &&
        payload.readUInt32BE(4) === STUN_MAGIC_COOKIE &&
        payload.readUInt16BE(2) + 20 === payload.byteLength - 1
      ) payload = payload.subarray(0, -1);
      const peer = this.reverseChannels.get(channel);
      const payloadStun = maybeStun(payload);
      return {
        data: payload,
        source,
        ...(peer ? { peer } : {}),
        viaTurn: true,
        ...(payloadStun ? { stun: payloadStun } : {}),
      };
    }
    if (stun?.type === TURN_MESSAGES.DATA_INDICATION) {
      const payload = attribute(stun, TURN_ATTRIBUTES.DATA) ?? Buffer.alloc(0);
      const peerValue = attribute(stun, TURN_ATTRIBUTES.XOR_PEER_ADDRESS);
      const peer = peerValue ? decodeTurnXorAddress(peerValue) : undefined;
      const payloadStun = maybeStun(payload);
      return {
        data: Buffer.from(payload),
        source,
        ...(peer ? { peer } : {}),
        viaTurn: true,
        ...(payloadStun ? { stun: payloadStun } : {}),
      };
    }
    return {
      data,
      source,
      ...(remote.address === this.serverIp ? {} : { peer: source }),
      viaTurn: false,
      ...(stun ? { stun } : {}),
    };
  }

  private onMessage(data: Buffer, remote: RemoteInfo): void {
    const stun = maybeStun(data);
    if (stun) {
      const key = stun.transactionId.toString("hex");
      const pending = this.pending.get(key);
      if (pending && (stun.type === pending.successType || stun.type === pending.errorType)) {
        this.pending.delete(key);
        clearTimeout(pending.timer);
        pending.resolve(stun);
        return;
      }
    }
    this.deliver(this.unwrap(data, remote, stun));
  }

  private async send(data: Uint8Array, ip: string, port: number): Promise<void> {
    if (this.closed) throw new Error("TURN client is closed");
    if (!this.bound) await this.bind();
    const bytes = asBuffer(data);
    await new Promise<void>((resolve, reject) => {
      this.socket.send(bytes, port, ip, (error) => error ? reject(error) : resolve());
    });
  }

  private async request(
    messageType: number,
    attributes: readonly StunAttributeInput[] = [],
    authenticated = true,
  ): Promise<ParsedStunMessage> {
    const transactionId = randomBytes(12);
    const authAttributes: StunAttributeInput[] = [...attributes];
    let message: Buffer;
    if (authenticated && this.nonce) {
      authAttributes.push(
        { type: TURN_ATTRIBUTES.USERNAME, value: Buffer.from(this.username, "utf8") },
        { type: TURN_ATTRIBUTES.REALM, value: Buffer.from(this.realm, "utf8") },
        { type: TURN_ATTRIBUTES.NONCE, value: this.nonce },
      );
      message = authenticatedTurnMessage(
        messageType,
        authAttributes,
        transactionId,
        longTermKey(this.username, this.realm, this.password),
      );
    } else {
      message = encodeStunMessage(messageType, authAttributes, transactionId);
    }
    const key = transactionId.toString("hex");
    const response = new Promise<ParsedStunMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error("TURN response timed out"));
      }, this.requestTimeoutMs);
      this.pending.set(key, {
        successType: messageType | 0x0100,
        errorType: messageType | 0x0110,
        resolve,
        reject,
        timer,
      });
    });
    try {
      await this.send(message, this.serverIp, this.serverPort);
      return await response;
    } catch (error) {
      const pending = this.pending.get(key);
      if (pending) clearTimeout(pending.timer);
      this.pending.delete(key);
      throw error;
    }
  }

  async allocate(): Promise<MeariTurnAllocation> {
    await this.bind();
    const transport = Buffer.alloc(4);
    transport.writeUInt8(17, 0);
    const requestedTransport = [{ type: TURN_ATTRIBUTES.REQUESTED_TRANSPORT, value: transport }];
    let challenge: ParsedStunMessage | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        challenge = await this.request(TURN_MESSAGES.ALLOCATE_REQUEST, requestedTransport, false);
      } catch {
        continue;
      }
      if (challenge.type === TURN_MESSAGES.ALLOCATE_SUCCESS) {
        return this.applyAllocation(challenge);
      }
      const nonce = attribute(challenge, TURN_ATTRIBUTES.NONCE);
      const realm = attribute(challenge, TURN_ATTRIBUTES.REALM);
      if (nonce) this.nonce = Buffer.from(nonce);
      if (realm) this.realm = realm.toString("utf8").replaceAll("\0", "");
      if (this.nonce) break;
    }
    if (!this.nonce) throw new Error(challenge ? turnError(challenge) : "TURN server did not provide a nonce");
    const response = await this.request(TURN_MESSAGES.ALLOCATE_REQUEST, requestedTransport, true);
    if (response.type !== TURN_MESSAGES.ALLOCATE_SUCCESS) throw new Error(turnError(response));
    return this.applyAllocation(response);
  }

  private applyAllocation(message: ParsedStunMessage): MeariTurnAllocation {
    const relayValue = attribute(message, TURN_ATTRIBUTES.XOR_RELAYED_ADDRESS);
    const relay = relayValue ? decodeTurnXorAddress(relayValue) : undefined;
    if (!relay) throw new Error("TURN allocation omitted its relay address");
    const mappedValue = attribute(message, TURN_ATTRIBUTES.XOR_MAPPED_ADDRESS);
    const mapped = mappedValue ? decodeTurnXorAddress(mappedValue) : undefined;
    this.allocation = {
      relay,
      ...(mapped ? { mapped } : {}),
      local: { ip: this.bindAddress, port: this.localPort },
    };
    return this.allocation;
  }

  async createPermission(peerIp: string): Promise<void> {
    const response = await this.request(TURN_MESSAGES.CREATE_PERMISSION_REQUEST, [{
      type: TURN_ATTRIBUTES.XOR_PEER_ADDRESS,
      value: encodeTurnXorAddress(peerIp, 0),
    }]);
    if (response.type !== TURN_MESSAGES.CREATE_PERMISSION_SUCCESS) throw new Error(turnError(response));
  }

  async channelBind(peer: MeariTurnAddress): Promise<number> {
    const channel = this.channelCounter;
    this.channelCounter += 1;
    const channelValue = Buffer.alloc(4);
    channelValue.writeUInt16BE(channel, 0);
    const response = await this.request(TURN_MESSAGES.CHANNEL_BIND_REQUEST, [
      { type: TURN_ATTRIBUTES.CHANNEL_NUMBER, value: channelValue },
      { type: TURN_ATTRIBUTES.XOR_PEER_ADDRESS, value: encodeTurnXorAddress(peer.ip, peer.port) },
    ]);
    if (response.type !== TURN_MESSAGES.CHANNEL_BIND_SUCCESS) throw new Error(turnError(response));
    this.channels.set(`${peer.ip}:${peer.port}`, channel);
    this.reverseChannels.set(channel, peer);
    return channel;
  }

  async refresh(lifetimeSeconds = 600): Promise<void> {
    const lifetime = Buffer.alloc(4);
    lifetime.writeUInt32BE(lifetimeSeconds);
    const response = await this.request(TURN_MESSAGES.REFRESH_REQUEST, [
      { type: TURN_ATTRIBUTES.LIFETIME, value: lifetime },
    ]);
    if (response.type !== TURN_MESSAGES.REFRESH_SUCCESS) throw new Error(turnError(response));
  }

  async sendDirect(peer: MeariTurnAddress, data: Uint8Array): Promise<void> {
    await this.send(data, peer.ip, peer.port);
  }

  async sendToPeer(peer: MeariTurnAddress, data: Uint8Array): Promise<void> {
    const payload = asBuffer(data);
    const channel = this.channels.get(`${peer.ip}:${peer.port}`);
    if (channel !== undefined) {
      const body = Buffer.concat([payload, Buffer.from([0])]);
      const padded = (body.byteLength + 3) & ~3;
      const frame = Buffer.alloc(4 + padded);
      frame.writeUInt16BE(channel, 0);
      frame.writeUInt16BE(body.byteLength, 2);
      body.copy(frame, 4);
      await this.send(frame, this.serverIp, this.serverPort);
      return;
    }
    await this.send(encodeStunMessage(TURN_MESSAGES.SEND_INDICATION, [
      { type: TURN_ATTRIBUTES.XOR_PEER_ADDRESS, value: encodeTurnXorAddress(peer.ip, peer.port) },
      { type: TURN_ATTRIBUTES.DATA, value: payload },
    ]), this.serverIp, this.serverPort);
  }

  async receive(timeoutMs = 5_000): Promise<MeariTurnPacket> {
    if (this.packetQueue.length > 0) return this.packetQueue.shift() as MeariTurnPacket;
    if (this.packetWaiter) throw new Error("Only one TURN receive may be pending");
    if (this.closed) throw new Error("TURN client is closed");
    return new Promise<MeariTurnPacket>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.packetWaiter = undefined;
        reject(new Error("TURN packet receive timed out"));
      }, timeoutMs);
      this.packetWaiter = { resolve, reject, timer };
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error("TURN client closed"));
    this.socket.close();
  }
}
