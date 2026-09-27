/**
 * The application frame carried by the native PPCS transport.
 *
 * This is deliberately separate from kcp-tunnel.ts. KCP/IVA is one transport
 * used by the current local command path; native PPCS uses this eight-byte
 * channel header and a 16-bit sequence counter per channel.
 */
export const PPCS_FRAME_PREFIX_SIZE = 8;
export const PPCS_FRAME_MARKER = 0xd1;
export const PPCS_FRAME_MAGIC = 0xd0f1;
/** Native acknowledgment-list frame magic (wire bytes f1 d1). */
export const PPCS_ACK_MAGIC = 0xd1f1;
export const PPCS_CHANNEL_COUNT = 8;
export const PPCS_MAX_PAYLOAD = 0x4f8;
export const PPCS_MAX_ACK_ENTRIES = PPCS_MAX_PAYLOAD / 2;

export interface PpcsChannelFrameInput {
  readonly channel: number;
  readonly sequence: number;
  readonly payload?: Uint8Array;
}

export interface ParsedPpcsChannelFrame {
  readonly magic: number;
  readonly marker: number;
  readonly channel: number;
  readonly sequence: number;
  /** Length stored by the native header, including its four-byte prefix. */
  readonly declaredLength: number;
  readonly payloadLength: number;
  readonly payload: Buffer;
  readonly byteLength: number;
}

export interface PpcsChannelAckFrameInput {
  readonly channel: number;
  readonly sequences: readonly number[];
}

export interface ParsedPpcsChannelAckFrame {
  readonly magic: number;
  readonly marker: number;
  readonly channel: number;
  readonly count: number;
  /** Native length field: four bytes plus two bytes per acknowledged sequence. */
  readonly declaredLength: number;
  readonly sequences: readonly number[];
  readonly byteLength: number;
}

function asBuffer(value: Uint8Array): Buffer {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function assertInteger(name: string, value: number, maximum: number): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be between 0 and ${maximum}`);
  }
}

function assertChannel(channel: number): void {
  assertInteger("channel", channel, PPCS_CHANNEL_COUNT - 1);
}

/** Encode the exact native d0f1/d1 channel frame. */
export function encodePpcsChannelFrame(input: PpcsChannelFrameInput): Buffer {
  assertChannel(input.channel);
  assertInteger("sequence", input.sequence, 0xffff);
  const payload = input.payload ? asBuffer(input.payload) : Buffer.alloc(0);
  if (payload.byteLength > PPCS_MAX_PAYLOAD) {
    throw new RangeError(`PPCS payload must not exceed ${PPCS_MAX_PAYLOAD} bytes`);
  }
  const declaredLength = payload.byteLength + 4;
  const frame = Buffer.allocUnsafe(PPCS_FRAME_PREFIX_SIZE + payload.byteLength);
  frame.writeUInt16LE(PPCS_FRAME_MAGIC, 0);
  frame.writeUInt8(PPCS_FRAME_MARKER, 2);
  frame.writeUInt8(input.channel, 3);
  frame.writeUInt16BE(input.sequence, 4);
  frame.writeUInt16BE(declaredLength, 6);
  payload.copy(frame, PPCS_FRAME_PREFIX_SIZE);
  return frame;
}

/** Decode one complete native PPCS channel frame. */
export function decodePpcsChannelFrame(bytes: Uint8Array): ParsedPpcsChannelFrame {
  const frame = asBuffer(bytes);
  if (frame.byteLength < PPCS_FRAME_PREFIX_SIZE) {
    throw new Error("Truncated PPCS channel frame header");
  }
  if (frame.readUInt16LE(0) !== PPCS_FRAME_MAGIC) {
    throw new Error("Invalid PPCS channel frame magic");
  }
  if (frame[2] !== PPCS_FRAME_MARKER) {
    throw new Error("Invalid PPCS channel frame marker");
  }
  const channel = frame[3] as number;
  assertChannel(channel);
  const declaredLength = frame.readUInt16BE(6);
  if (declaredLength < 4) {
    throw new Error("Invalid PPCS channel frame length");
  }
  const payloadLength = declaredLength - 4;
  const byteLength = PPCS_FRAME_PREFIX_SIZE + payloadLength;
  if (byteLength !== frame.byteLength) {
    throw new Error(
      `PPCS channel frame length mismatch: expected ${byteLength}, received ${frame.byteLength}`,
    );
  }
  return {
    magic: PPCS_FRAME_MAGIC,
    marker: PPCS_FRAME_MARKER,
    channel,
    sequence: frame.readUInt16BE(4),
    declaredLength,
    payloadLength,
    payload: Buffer.from(frame.subarray(PPCS_FRAME_PREFIX_SIZE)),
    byteLength,
  };
}

/** Encode the native d1f1 acknowledgment list for one logical channel. */
export function encodePpcsChannelAckFrame(input: PpcsChannelAckFrameInput): Buffer {
  assertChannel(input.channel);
  if (input.sequences.length > PPCS_MAX_ACK_ENTRIES) {
    throw new RangeError(`PPCS acknowledgment list must not exceed ${PPCS_MAX_ACK_ENTRIES} entries`);
  }
  for (const sequence of input.sequences) assertInteger("sequence", sequence, 0xffff);
  const declaredLength = input.sequences.length * 2 + 4;
  const frame = Buffer.allocUnsafe(PPCS_FRAME_PREFIX_SIZE + input.sequences.length * 2);
  frame.writeUInt16LE(PPCS_ACK_MAGIC, 0);
  frame.writeUInt8(PPCS_FRAME_MARKER, 2);
  frame.writeUInt8(input.channel, 3);
  frame.writeUInt16BE(input.sequences.length, 4);
  frame.writeUInt16BE(declaredLength, 6);
  input.sequences.forEach((sequence, index) => frame.writeUInt16BE(sequence, 8 + index * 2));
  return frame;
}

/** Decode one complete native d1f1 acknowledgment list. */
export function decodePpcsChannelAckFrame(bytes: Uint8Array): ParsedPpcsChannelAckFrame {
  const frame = asBuffer(bytes);
  if (frame.byteLength < PPCS_FRAME_PREFIX_SIZE) {
    throw new Error("Truncated PPCS acknowledgment frame header");
  }
  if (frame.readUInt16LE(0) !== PPCS_ACK_MAGIC) {
    throw new Error("Invalid PPCS acknowledgment frame magic");
  }
  if (frame[2] !== PPCS_FRAME_MARKER) {
    throw new Error("Invalid PPCS acknowledgment frame marker");
  }
  const channel = frame[3] as number;
  assertChannel(channel);
  const count = frame.readUInt16BE(4);
  if (count > PPCS_MAX_ACK_ENTRIES) throw new Error("PPCS acknowledgment list is too large");
  const declaredLength = frame.readUInt16BE(6);
  const expectedDeclaredLength = count * 2 + 4;
  if (declaredLength !== expectedDeclaredLength) {
    throw new Error("PPCS acknowledgment frame length mismatch");
  }
  const byteLength = PPCS_FRAME_PREFIX_SIZE + count * 2;
  if (frame.byteLength !== byteLength) {
    throw new Error(
      `PPCS acknowledgment frame length mismatch: expected ${byteLength}, received ${frame.byteLength}`,
    );
  }
  const sequences: number[] = [];
  for (let index = 0; index < count; index += 1) {
    sequences.push(frame.readUInt16BE(8 + index * 2));
  }
  return {
    magic: PPCS_ACK_MAGIC,
    marker: PPCS_FRAME_MARKER,
    channel,
    count,
    declaredLength,
    sequences,
    byteLength,
  };
}

/**
 * Parse concatenated decrypted PPCS frames from a byte stream.
 *
 * The native socket reader can return more than one outer packet in one read;
 * keeping this small framer independent makes that behavior testable without
 * involving a socket or the native protected wrapper.
 */
export class PpcsChannelStreamFramer {
  private buffer = Buffer.alloc(0);

  push(bytes: Uint8Array): ParsedPpcsChannelFrame[] {
    if (bytes.byteLength > 0) this.buffer = Buffer.concat([this.buffer, asBuffer(bytes)]);
    const frames: ParsedPpcsChannelFrame[] = [];
    while (this.buffer.byteLength >= PPCS_FRAME_PREFIX_SIZE) {
      if (this.buffer.readUInt16LE(0) !== PPCS_FRAME_MAGIC) {
        throw new Error("PPCS channel stream is not aligned to a d0f1 frame");
      }
      if (this.buffer[2] !== PPCS_FRAME_MARKER) {
        throw new Error("PPCS channel stream has an invalid d1 marker");
      }
      const declaredLength = this.buffer.readUInt16BE(6);
      if (declaredLength < 4) throw new Error("Invalid PPCS channel stream length");
      const byteLength = PPCS_FRAME_PREFIX_SIZE + declaredLength - 4;
      if (this.buffer.byteLength < byteLength) break;
      frames.push(decodePpcsChannelFrame(this.buffer.subarray(0, byteLength)));
      this.buffer = this.buffer.subarray(byteLength);
    }
    return frames;
  }

  get pendingByteLength(): number {
    return this.buffer.byteLength;
  }
}

/** Allocates the native 16-bit sequence independently for each channel. */
export class PpcsChannelMux {
  private readonly nextSequences = new Uint16Array(PPCS_CHANNEL_COUNT);

  nextSequence(channel: number): number {
    assertChannel(channel);
    return this.nextSequences[channel] as number;
  }

  encode(channel: number, payload?: Uint8Array): Buffer {
    assertChannel(channel);
    const sequence = this.nextSequences[channel] as number;
    this.nextSequences[channel] = (sequence + 1) & 0xffff;
    return payload === undefined
      ? encodePpcsChannelFrame({ channel, sequence })
      : encodePpcsChannelFrame({ channel, sequence, payload });
  }
}
