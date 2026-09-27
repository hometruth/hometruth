/** Native PPStrong channel-1 talkback packet framing. */
export const VVP_VOICE_FRAME_TYPE = 0x82;
export const VVP_VOICE_MEDIA_TYPE = 0xfa;
export const VVP_VOICE_MODE = 3;
export const VVP_VOICE_MAX_SAMPLES = 1_280;
export const VVP_VOICE_LEGACY_HEADER_SIZE = 32;
export const VVP_VOICE_HEADER_SIZE = 44;
/** Factory-10 talkback is an XTS audio message around a 44-byte voice header. */
export const VVP_FACTORY10_VOICE_HEADER_SIZE = 52;
/** Native libmrplayer converts one 640-byte (320-sample) PCMU block per write. */
export const VVP_FACTORY10_VOICE_MAX_SAMPLES = 320;
/** 8 kHz mono G.711 µ-law — the audio format HomeTruth encodes and the
 * parameters CloudEdge announces in its POST /devices/voicetalk speaker open. */
export const VVP_FACTORY10_VOICE_SAMPLE_RATE = 8_000;
export const VVP_FACTORY10_VOICE_BITRATE = 64_000;

export interface VvpVoicePacketOptions {
  readonly sequence: number;
  readonly pcm: Int16Array;
  /** Native protocol generation. Version 2 and newer use the 44-byte header. */
  readonly protocolVersion?: number;
  /** Negotiated voice mode returned by the camera; CloudEdge uses mode 3. */
  readonly mode?: number;
}

function assertUint(name: string, value: number, maximum: number): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${name} must be between 0 and ${maximum}`);
  }
}

/** Exact signed-linear PCM to G.711 mu-law conversion used by libmrplayer. */
export function pcm16ToMuLaw(sample: number): number {
  if (!Number.isInteger(sample) || sample < -32_768 || sample > 32_767) {
    throw new RangeError("PCM sample must be a signed 16-bit integer");
  }
  const magnitude = Math.abs(sample) + 0x84;
  const mask = sample < 0 ? 0x7f : 0xff;
  if (magnitude >= 0x8000) return mask & 0x80;

  let exponent = 0;
  let boundary = 0x100;
  while (magnitude >= boundary && exponent < 7) {
    exponent += 1;
    boundary <<= 1;
  }
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return ((exponent << 4) | mantissa) ^ mask;
}

export function encodeMuLaw(pcm: Int16Array): Buffer {
  if (pcm.length > VVP_VOICE_MAX_SAMPLES) {
    throw new RangeError(`Voice packet cannot exceed ${VVP_VOICE_MAX_SAMPLES} samples`);
  }
  const encoded = Buffer.allocUnsafe(pcm.length);
  for (let index = 0; index < pcm.length; index += 1) {
    encoded[index] = pcm16ToMuLaw(pcm[index] as number);
  }
  return encoded;
}

/**
 * Encode one PPCS channel-1 voice packet.
 *
 * Protocol versions 2+ use CloudEdge's 44-byte header. Older cameras use the
 * 32-byte compatibility header retained in the same native implementation.
 */
export function encodeVvpVoicePacket(options: VvpVoicePacketOptions): Buffer {
  assertUint("sequence", options.sequence, 0xffff_ffff);
  const protocolVersion = options.protocolVersion ?? 2;
  assertUint("protocolVersion", protocolVersion, 0xffff_ffff);
  const mode = options.mode ?? VVP_VOICE_MODE;
  assertUint("mode", mode, protocolVersion >= 2 ? 0xffff_ffff : 0xff);
  const audio = encodeMuLaw(options.pcm);
  const headerSize = protocolVersion >= 2
    ? VVP_VOICE_HEADER_SIZE
    : VVP_VOICE_LEGACY_HEADER_SIZE;
  const packet = Buffer.alloc(headerSize + audio.length);
  packet.writeUInt32LE(options.sequence, 0);
  packet.writeUInt32LE(VVP_VOICE_FRAME_TYPE, 12);
  packet.writeUInt8(VVP_VOICE_MEDIA_TYPE, 16);

  if (protocolVersion >= 2) {
    packet.writeUInt32LE(mode, 20);
    packet.writeUInt32LE(16, 24);
    packet.writeUInt32LE(1, 28);
    packet.writeUInt32LE(audio.length, 40);
  } else {
    packet.writeUInt8(mode, 17);
    packet.writeUInt16LE(0x0110, 18);
    packet.writeUInt32LE(audio.length, 28);
  }
  audio.copy(packet, headerSize);
  return packet;
}

/**
 * Encode the factory-10/type-10 talkback message recovered from libmrplayer.
 *
 * Native `ppsdev_voicetalk_write` sends this as an XTS stream message:
 * an eight-byte XTS audio envelope followed by the 44-byte voice header. The
 * envelope is why sending the bare VVP voice header is accepted by KCP but is
 * silent at the speaker.
 */
export function encodeVvpFactory10VoicePacket(
  options: VvpVoicePacketOptions & { readonly channel?: number },
): Buffer {
  assertUint("sequence", options.sequence, 0xffff_ffff);
  // The native writer receives the logical channel separately from the media
  // buffer, then stores it in the final reserved byte before the media-flags
  // word (inner-header offset 19). The media-flags word itself is zero for
  // the factory-10 PCMU path. The official app sends channel 0 (verified on
  // the wire against a Pet 3T; see VVP_STREAM_VOICE_CHANNEL).
  const channel = options.channel ?? 0;
  assertUint("channel", channel, 0xffff_ffff);
  if (options.pcm.length > VVP_FACTORY10_VOICE_MAX_SAMPLES) {
    throw new RangeError(
      `Factory-10 voice packet cannot exceed ${VVP_FACTORY10_VOICE_MAX_SAMPLES} samples`,
    );
  }
  const audio = encodeMuLaw(options.pcm);
  const packet = Buffer.alloc(VVP_FACTORY10_VOICE_HEADER_SIZE + audio.length);
  // XTS audio envelope: 00 00 01 fa, reserved u16, then embedded length.
  packet.writeUInt32BE(0x000001fa, 0);
  packet.writeUInt16LE(audio.length + VVP_VOICE_HEADER_SIZE, 6);
  packet.writeUInt32LE(options.sequence, 8);
  packet.writeUInt32LE(VVP_VOICE_FRAME_TYPE, 20);
  packet.writeUInt8(VVP_VOICE_MEDIA_TYPE, 24);
  packet.writeUInt8(channel, 27);
  packet.writeUInt32LE(0x10, 32);
  packet.writeUInt32LE(1, 36);
  packet.writeUInt32LE(audio.length, 48);
  audio.copy(packet, VVP_FACTORY10_VOICE_HEADER_SIZE);
  return packet;
}

export interface ParsedVvpVoicePacket {
  readonly sequence: number;
  readonly protocolVersion: 1 | 2;
  readonly mode: number;
  readonly audio: Buffer;
}

/** Decode channel-1 talkback packets for capture diagnostics and tests. */
export function decodeVvpVoicePacket(bytes: Uint8Array): ParsedVvpVoicePacket {
  const packet = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (packet.byteLength < VVP_VOICE_LEGACY_HEADER_SIZE) {
    throw new Error("Truncated VVP voice packet");
  }
  if (packet.readUInt32LE(12) !== VVP_VOICE_FRAME_TYPE || packet[16] !== VVP_VOICE_MEDIA_TYPE) {
    throw new Error("Invalid VVP voice packet");
  }
  const modern = packet.byteLength >= VVP_VOICE_HEADER_SIZE
    && packet.readUInt32LE(24) === 16
    && packet.readUInt32LE(28) === 1;
  const headerSize = modern ? VVP_VOICE_HEADER_SIZE : VVP_VOICE_LEGACY_HEADER_SIZE;
  const audioLength = packet.readUInt32LE(modern ? 40 : 28);
  if (headerSize + audioLength !== packet.byteLength) {
    throw new Error("VVP voice packet length mismatch");
  }
  return {
    sequence: packet.readUInt32LE(0),
    protocolVersion: modern ? 2 : 1,
    mode: modern ? packet.readUInt32LE(20) : packet.readUInt8(17),
    audio: Buffer.from(packet.subarray(headerSize)),
  };
}
