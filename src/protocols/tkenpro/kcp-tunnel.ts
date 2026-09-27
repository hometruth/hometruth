import { randomBytes } from "node:crypto";

/** Meari factory-10 cameras use one fixed KCP conversation over UDP. */
export const MEARI_KCP_CONVERSATION = 0x0000_000c;
export const KCP_COMMAND_PUSH = 0x51;
export const KCP_COMMAND_ACK = 0x52;
export const KCP_COMMAND_WINDOW_ASK = 0x53;
export const KCP_COMMAND_WINDOW_SIZE = 0x54;
export const KCP_HEADER_SIZE = 24;
export const MEARI_KCP_MSS = 1176;
export const MEARI_KCP_RECEIVE_WINDOW = 1024;

export const IVA_HEADER_SIZE = 20;
export const IVA_TYPE_DATA = 0x7010;
export const IVA_TYPE_HANDSHAKE = 0x7012;

const KCP_COMMANDS = new Set([
  KCP_COMMAND_PUSH,
  KCP_COMMAND_ACK,
  KCP_COMMAND_WINDOW_ASK,
  KCP_COMMAND_WINDOW_SIZE,
]);
const VVP_COMMAND_MAGIC = Buffer.from([0x99, 0x50, 0x56, 0x56]);
const XTS_MEDIA_TYPES = new Set([0xf9, 0xfa, 0xfc, 0xfd, 0xfe]);

export interface KcpSegmentInput {
  readonly command: number;
  readonly fragment?: number;
  readonly window?: number;
  readonly timestamp?: number;
  readonly sequence?: number;
  readonly unacknowledged?: number;
  readonly payload?: Uint8Array;
}

export interface ParsedKcpSegment {
  readonly conversation: number;
  readonly command: number;
  readonly fragment: number;
  readonly window: number;
  readonly timestamp: number;
  readonly sequence: number;
  readonly unacknowledged: number;
  readonly payloadLength: number;
  readonly payload: Buffer;
  readonly byteLength: number;
}

export interface IvaFrameInput {
  readonly type: number;
  readonly sessionId1: number;
  readonly sessionId2: number;
  readonly payload?: Uint8Array;
}

export interface ParsedIvaFrame {
  readonly type: number;
  readonly sessionId1: number;
  readonly sessionId2: number;
  readonly payloadLength: number;
  readonly payload: Buffer;
  readonly byteLength: number;
}

export type MeariTunnelEvent =
  | { readonly type: "handshake"; readonly sessionId1: number; readonly sessionId2: number }
  | { readonly type: "data"; readonly payload: Buffer }
  | { readonly type: "raw"; readonly payload: Buffer }
  | { readonly type: "ack"; readonly sequence: number }
  | { readonly type: "duplicate"; readonly sequence: number }
  | { readonly type: "fragment"; readonly sequence: number }
  | { readonly type: "window-ask" }
  | { readonly type: "window-size"; readonly window: number };

export interface MeariKcpTunnelOptions {
  readonly send?: (datagram: Buffer) => void;
  readonly receiveWindow?: number;
  readonly maximumSegmentSize?: number;
  readonly now?: () => number;
  readonly sessionId1?: number;
  readonly sessionId2?: number;
}

interface BufferedPush {
  readonly fragment: number;
  readonly payload: Buffer;
  readonly timestamp: number;
}

interface SentPush {
  readonly fragment: number;
  readonly payload: Buffer;
}

function assertUint(name: string, value: number, maximum: number): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be between 0 and ${maximum}`);
  }
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Encode one KCP segment using the little-endian layout in libppsdk. */
export function encodeKcpSegment(input: KcpSegmentInput): Buffer {
  assertUint("command", input.command, 0xff);
  if (!KCP_COMMANDS.has(input.command)) {
    throw new TypeError(`Unsupported KCP command 0x${input.command.toString(16)}`);
  }
  const fragment = input.fragment ?? 0;
  const window = input.window ?? MEARI_KCP_RECEIVE_WINDOW;
  const timestamp = input.timestamp ?? 0;
  const sequence = input.sequence ?? 0;
  const unacknowledged = input.unacknowledged ?? 0;
  assertUint("fragment", fragment, 0xff);
  assertUint("window", window, 0xffff);
  assertUint("timestamp", timestamp, 0xffff_ffff);
  assertUint("sequence", sequence, 0xffff_ffff);
  assertUint("unacknowledged", unacknowledged, 0xffff_ffff);
  const payload = input.payload ? asBuffer(input.payload) : Buffer.alloc(0);
  assertUint("payloadLength", payload.byteLength, 0xffff_ffff);

  const segment = Buffer.allocUnsafe(KCP_HEADER_SIZE + payload.byteLength);
  segment.writeUInt32LE(MEARI_KCP_CONVERSATION, 0);
  segment.writeUInt8(input.command, 4);
  segment.writeUInt8(fragment, 5);
  segment.writeUInt16LE(window, 6);
  segment.writeUInt32LE(timestamp, 8);
  segment.writeUInt32LE(sequence, 12);
  segment.writeUInt32LE(unacknowledged, 16);
  segment.writeUInt32LE(payload.byteLength, 20);
  payload.copy(segment, KCP_HEADER_SIZE);
  return segment;
}

/** Decode every concatenated KCP segment in one UDP datagram. */
export function decodeKcpSegments(bytes: Uint8Array): ParsedKcpSegment[] {
  const datagram = asBuffer(bytes);
  const segments: ParsedKcpSegment[] = [];
  let offset = 0;
  while (offset < datagram.byteLength) {
    // TURN ChannelData paths can retain up to one KCP-header's worth of zero
    // alignment after the final segment. It is not part of the KCP stream.
    const remaining = datagram.byteLength - offset;
    if (
      remaining === 1 ||
      (remaining < KCP_HEADER_SIZE && datagram.subarray(offset).every((value) => value === 0))
    ) break;
    if (datagram.byteLength - offset < KCP_HEADER_SIZE) {
      throw new Error("Truncated KCP segment header");
    }
    const conversation = datagram.readUInt32LE(offset);
    if (conversation !== MEARI_KCP_CONVERSATION) {
      throw new Error(`Unexpected KCP conversation ${conversation}`);
    }
    const command = datagram.readUInt8(offset + 4);
    if (!KCP_COMMANDS.has(command)) {
      throw new Error(`Unsupported KCP command 0x${command.toString(16)}`);
    }
    const payloadLength = datagram.readUInt32LE(offset + 20);
    const byteLength = KCP_HEADER_SIZE + payloadLength;
    if (byteLength > datagram.byteLength - offset) {
      throw new Error("Truncated KCP segment payload");
    }
    segments.push({
      conversation,
      command,
      fragment: datagram.readUInt8(offset + 5),
      window: datagram.readUInt16LE(offset + 6),
      timestamp: datagram.readUInt32LE(offset + 8),
      sequence: datagram.readUInt32LE(offset + 12),
      unacknowledged: datagram.readUInt32LE(offset + 16),
      payloadLength,
      payload: Buffer.from(datagram.subarray(offset + KCP_HEADER_SIZE, offset + byteLength)),
      byteLength,
    });
    offset += byteLength;
  }
  if (segments.length === 0) throw new Error("Datagram did not contain a KCP segment");
  return segments;
}

/** Encode the 20-byte InterVideo/IVA envelope used inside Meari KCP. */
export function encodeIvaFrame(input: IvaFrameInput): Buffer {
  assertUint("type", input.type, 0xffff);
  assertUint("sessionId1", input.sessionId1, 0xffff_ffff);
  assertUint("sessionId2", input.sessionId2, 0xffff_ffff);
  const payload = input.payload ? asBuffer(input.payload) : Buffer.alloc(0);
  assertUint("payloadLength", payload.byteLength, 0xffff_ffff);
  const frame = Buffer.allocUnsafe(IVA_HEADER_SIZE + payload.byteLength);
  frame.writeUInt8(0xff, 0);
  frame.writeUInt8(0x01, 1);
  frame.writeUInt16LE(0, 2);
  frame.writeUInt32LE(input.sessionId1, 4);
  frame.writeUInt32LE(input.sessionId2, 8);
  frame.writeUInt16LE(0, 12);
  frame.writeUInt16LE(input.type, 14);
  frame.writeUInt32LE(payload.byteLength, 16);
  payload.copy(frame, IVA_HEADER_SIZE);
  return frame;
}

export function encodeIvaHandshake(sessionId1: number, sessionId2: number): Buffer {
  return encodeIvaFrame({ type: IVA_TYPE_HANDSHAKE, sessionId1, sessionId2 });
}

export function encodeIvaData(
  payload: Uint8Array,
  sessionId1: number,
  sessionId2: number,
): Buffer {
  return encodeIvaFrame({ type: IVA_TYPE_DATA, sessionId1, sessionId2, payload });
}

export function decodeIvaFrame(bytes: Uint8Array): ParsedIvaFrame {
  const frame = asBuffer(bytes);
  if (frame.byteLength < IVA_HEADER_SIZE) throw new Error("Truncated IVA frame header");
  if (frame[0] !== 0xff || frame[1] !== 0x01) throw new Error("Invalid IVA frame magic");
  if (
    frame.readUInt16LE(2) !== 0 ||
    ![0, 0x0100].includes(frame.readUInt16LE(12))
  ) {
    throw new Error("Unsupported IVA frame flags");
  }
  const payloadLength = frame.readUInt32LE(16);
  const byteLength = IVA_HEADER_SIZE + payloadLength;
  if (frame.byteLength !== byteLength) {
    throw new Error(`IVA frame length mismatch: expected ${byteLength}, received ${frame.byteLength}`);
  }
  return {
    type: frame.readUInt16LE(14),
    sessionId1: frame.readUInt32LE(4),
    sessionId2: frame.readUInt32LE(8),
    payloadLength,
    payload: Buffer.from(frame.subarray(IVA_HEADER_SIZE)),
    byteLength,
  };
}

function randomSessionId(): number {
  return randomBytes(4).readUInt32LE(0) & 0x0fff_ffff;
}

function startsAtMessageBoundary(payload: Buffer): boolean {
  return (
    (payload[0] === 0xff && payload[1] === 0x01) ||
    (payload.byteLength >= 4 && payload.subarray(0, 4).equals(VVP_COMMAND_MAGIC)) ||
    (
      payload.byteLength >= 4 &&
      payload[0] === 0 &&
      payload[1] === 0 &&
      payload[2] === 1 &&
      XTS_MEDIA_TYPES.has(payload[3] as number)
    )
  );
}

/**
 * Small KCP state machine for Meari's reliable command channel.
 *
 * It deliberately exposes datagrams through a callback instead of owning a
 * socket, so LAN discovery can choose the correct address and UDP socket.
 */
export class MeariKcpTunnel {
  readonly sessionId1: number;
  readonly sessionId2: number;

  private readonly sendDatagram: (datagram: Buffer) => void;
  private readonly receiveWindow: number;
  private readonly maximumSegmentSize: number;
  private readonly now: () => number;
  private readonly startedAt: number;
  private sendSequence = 0;
  private nextReceiveSequence: number | undefined;
  private readonly sent = new Map<number, SentPush>();
  private readonly received = new Map<number, BufferedPush>();
  private readonly pendingAcks = new Map<number, number>();
  private fragmentParts: Buffer[] = [];
  private readonly queuedMessages: Buffer[] = [];

  constructor(options: MeariKcpTunnelOptions = {}) {
    this.sendDatagram = options.send ?? (() => undefined);
    this.receiveWindow = options.receiveWindow ?? MEARI_KCP_RECEIVE_WINDOW;
    this.maximumSegmentSize = options.maximumSegmentSize ?? MEARI_KCP_MSS;
    this.now = options.now ?? Date.now;
    assertUint("receiveWindow", this.receiveWindow, 0xffff);
    if (this.receiveWindow < 1) throw new RangeError("receiveWindow must be positive");
    assertUint("maximumSegmentSize", this.maximumSegmentSize, 0xffff_ffff);
    if (this.maximumSegmentSize < 1) throw new RangeError("maximumSegmentSize must be positive");
    this.sessionId1 = options.sessionId1 ?? randomSessionId();
    this.sessionId2 = options.sessionId2 ?? randomSessionId();
    assertUint("sessionId1", this.sessionId1, 0xffff_ffff);
    assertUint("sessionId2", this.sessionId2, 0xffff_ffff);
    this.startedAt = this.now();
  }

  get nextSendSequence(): number {
    return this.sendSequence;
  }

  get nextExpectedReceiveSequence(): number | undefined {
    return this.nextReceiveSequence;
  }

  get unacknowledgedSendCount(): number {
    return this.sent.size;
  }

  private timestamp(): number {
    return (this.now() - this.startedAt) >>> 0;
  }

  private advertisedWindow(): number {
    return Math.max(0, this.receiveWindow - this.received.size - this.queuedMessages.length);
  }

  private cumulativeAck(): number {
    return this.nextReceiveSequence ?? 0;
  }

  /** Send one complete KCP message, fragmenting it at the official 1176-byte MSS. */
  sendMessage(message: Uint8Array): Buffer[] {
    const bytes = asBuffer(message);
    const fragmentCount = Math.max(1, Math.ceil(bytes.byteLength / this.maximumSegmentSize));
    if (fragmentCount > 0x100) throw new RangeError("KCP message requires more than 256 fragments");
    const datagrams: Buffer[] = [];
    for (let index = 0; index < fragmentCount; index += 1) {
      const start = index * this.maximumSegmentSize;
      const payload = Buffer.from(bytes.subarray(start, start + this.maximumSegmentSize));
      const fragment = fragmentCount - index - 1;
      const sequence = this.sendSequence;
      const datagram = encodeKcpSegment({
        command: KCP_COMMAND_PUSH,
        fragment,
        window: this.advertisedWindow(),
        timestamp: this.timestamp(),
        sequence,
        unacknowledged: this.cumulativeAck(),
        payload,
      });
      this.sent.set(sequence, { fragment, payload });
      this.sendSequence = (this.sendSequence + 1) >>> 0;
      datagrams.push(datagram);
      this.sendDatagram(datagram);
    }
    return datagrams;
  }

  /** Official startup order: handshake is SN 0, first command is SN 1. */
  sendHandshake(): Buffer[] {
    return this.sendMessage(encodeIvaHandshake(this.sessionId1, this.sessionId2));
  }

  sendIvaData(payload: Uint8Array): Buffer[] {
    return this.sendMessage(encodeIvaData(payload, this.sessionId1, this.sessionId2));
  }

  /** Re-send every PUSH for which the peer has not supplied ACK or UNA. */
  retransmitUnacknowledged(): Buffer[] {
    const datagrams: Buffer[] = [];
    for (const [sequence, sent] of [...this.sent].sort(([left], [right]) => left - right)) {
      const datagram = encodeKcpSegment({
        command: KCP_COMMAND_PUSH,
        fragment: sent.fragment,
        window: this.advertisedWindow(),
        timestamp: this.timestamp(),
        sequence,
        unacknowledged: this.cumulativeAck(),
        payload: sent.payload,
      });
      datagrams.push(datagram);
      this.sendDatagram(datagram);
    }
    return datagrams;
  }

  /** Emit pending ACKs as compact compound KCP datagrams. */
  flushAcks(maximumSegments = 16): Buffer[] {
    if (!Number.isInteger(maximumSegments) || maximumSegments < 1) {
      throw new RangeError("maximumSegments must be positive");
    }
    const parts = [...this.pendingAcks]
      .sort(([left], [right]) => left - right)
      .map(([sequence, timestamp]) => encodeKcpSegment({
        command: KCP_COMMAND_ACK,
        window: this.advertisedWindow(),
        timestamp,
        sequence,
        unacknowledged: this.cumulativeAck(),
      }));
    this.pendingAcks.clear();
    const datagrams: Buffer[] = [];
    for (let offset = 0; offset < parts.length; offset += maximumSegments) {
      const datagram = Buffer.concat(parts.slice(offset, offset + maximumSegments));
      datagrams.push(datagram);
      this.sendDatagram(datagram);
    }
    return datagrams;
  }

  pollMessage(): Buffer | undefined {
    return this.queuedMessages.shift();
  }

  private applyRemoteCumulativeAck(unacknowledged: number): void {
    for (const sequence of this.sent.keys()) {
      if (sequence < unacknowledged) this.sent.delete(sequence);
    }
  }

  private decodeCompleteMessage(message: Buffer): MeariTunnelEvent {
    if (message[0] !== 0xff || message[1] !== 0x01) return { type: "raw", payload: message };
    const iva = decodeIvaFrame(message);
    if (iva.type === IVA_TYPE_HANDSHAKE) {
      return { type: "handshake", sessionId1: iva.sessionId1, sessionId2: iva.sessionId2 };
    }
    if (iva.type === IVA_TYPE_DATA) return { type: "data", payload: iva.payload };
    return { type: "raw", payload: iva.payload };
  }

  private processPush(segment: ParsedKcpSegment): MeariTunnelEvent[] {
    this.pendingAcks.set(segment.sequence, segment.timestamp);
    if (
      this.nextReceiveSequence !== undefined &&
      segment.sequence < this.nextReceiveSequence
    ) {
      return [{ type: "duplicate", sequence: segment.sequence }];
    }
    if (!this.received.has(segment.sequence)) {
      this.received.set(segment.sequence, {
        fragment: segment.fragment,
        payload: segment.payload,
        timestamp: segment.timestamp,
      });
    }
    if (this.nextReceiveSequence === undefined) {
      const start = [...this.received]
        .filter(([, candidate]) => startsAtMessageBoundary(candidate.payload))
        .map(([sequence]) => sequence)
        .sort((left, right) => left - right)[0];
      if (start === undefined) return [{ type: "fragment", sequence: segment.sequence }];
      this.nextReceiveSequence = start;
      for (const sequence of this.received.keys()) {
        if (sequence < start) this.received.delete(sequence);
      }
      this.fragmentParts = [];
    }

    const events: MeariTunnelEvent[] = [];
    while (this.received.has(this.nextReceiveSequence)) {
      const sequence: number = this.nextReceiveSequence;
      const current = this.received.get(sequence) as BufferedPush;
      this.received.delete(sequence);
      this.fragmentParts.push(current.payload);
      this.nextReceiveSequence = (sequence + 1) >>> 0;
      if (current.fragment === 0) {
        const complete = Buffer.concat(this.fragmentParts);
        this.fragmentParts = [];
        const event = this.decodeCompleteMessage(complete);
        events.push(event);
        if (event.type === "data" || event.type === "raw") {
          this.queuedMessages.push(event.payload);
        }
      }
    }
    return events.length > 0 ? events : [{ type: "fragment", sequence: segment.sequence }];
  }

  /** Process raw UDP input and return every transport event it contained. */
  processDatagram(datagram: Uint8Array): MeariTunnelEvent[] {
    const bytes = asBuffer(datagram);
    if (bytes[0] === 0xff && bytes[1] === 0x01) {
      return [this.decodeCompleteMessage(Buffer.from(bytes))];
    }
    const events: MeariTunnelEvent[] = [];
    for (const segment of decodeKcpSegments(bytes)) {
      this.applyRemoteCumulativeAck(segment.unacknowledged);
      switch (segment.command) {
        case KCP_COMMAND_PUSH:
          events.push(...this.processPush(segment));
          break;
        case KCP_COMMAND_ACK:
          this.sent.delete(segment.sequence);
          events.push({ type: "ack", sequence: segment.sequence });
          break;
        case KCP_COMMAND_WINDOW_ASK: {
          const response = encodeKcpSegment({
            command: KCP_COMMAND_WINDOW_SIZE,
            window: this.advertisedWindow(),
            timestamp: this.timestamp(),
            sequence: this.sendSequence,
            unacknowledged: this.cumulativeAck(),
          });
          this.sendDatagram(response);
          events.push({ type: "window-ask" });
          break;
        }
        case KCP_COMMAND_WINDOW_SIZE:
          events.push({ type: "window-size", window: segment.window });
          break;
      }
    }
    return events;
  }
}
