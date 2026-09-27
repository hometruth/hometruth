import {
  decodePpcsChannelAckFrame,
  decodePpcsChannelFrame,
  encodePpcsChannelAckFrame,
  encodePpcsChannelFrame,
  type ParsedPpcsChannelAckFrame,
  type ParsedPpcsChannelFrame,
} from "./ppcs-channel.ts";
import {
  decodePpcsOuterPacket,
  encodePpcsOuterPacket,
} from "./ppcs-protection.ts";

export type PpcsProtectedPacket =
  | { readonly type: "data"; readonly frame: ParsedPpcsChannelFrame }
  | { readonly type: "ack"; readonly frame: ParsedPpcsChannelAckFrame };

export interface PpcsProtectedChannelCodecOptions {
  readonly hostKey: string;
  /** When false, expose the inner channel frame for a confirmed raw socket. */
  readonly protect?: boolean;
}

/**
 * Joins the recovered logical-channel framing to the recovered outer wrapper.
 * The default is protected mode, matching the native `PPCS_Write` path.
 */
export class PpcsProtectedChannelCodec {
  private readonly hostKey: string;
  private readonly protect: boolean;

  constructor(options: PpcsProtectedChannelCodecOptions) {
    if (!options.hostKey.trim()) throw new TypeError("hostKey is required");
    this.hostKey = options.hostKey;
    this.protect = options.protect ?? true;
  }

  encodeData(channel: number, sequence: number, payload?: Uint8Array): Buffer {
    const frame = payload === undefined
      ? encodePpcsChannelFrame({ channel, sequence })
      : encodePpcsChannelFrame({ channel, sequence, payload });
    return this.protect ? encodePpcsOuterPacket({ hostKey: this.hostKey, payload: frame }) : frame;
  }

  encodeAck(channel: number, sequences: readonly number[]): Buffer {
    const frame = encodePpcsChannelAckFrame({ channel, sequences });
    return this.protect ? encodePpcsOuterPacket({ hostKey: this.hostKey, payload: frame }) : frame;
  }

  decode(packet: Uint8Array): PpcsProtectedPacket {
    const frame = this.protect
      ? decodePpcsOuterPacket(packet, this.hostKey).payload
      : Buffer.from(packet);
    if (frame.byteLength < 2) throw new Error("Truncated PPCS protected channel packet");
    const magic = frame.readUInt16LE(0);
    if (magic === 0xd0f1) return { type: "data", frame: decodePpcsChannelFrame(frame) };
    if (magic === 0xd1f1) return { type: "ack", frame: decodePpcsChannelAckFrame(frame) };
    throw new Error(`Unknown PPCS channel frame magic: 0x${magic.toString(16)}`);
  }
}
