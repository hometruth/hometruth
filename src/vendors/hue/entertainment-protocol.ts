/**
 * The HueStream v2 binary frame format used by the Hue Entertainment
 * streaming API, plus the CLIP v2 calls that start/stop a streaming session.
 * Pure functions here; the DTLS transport lives in `entertainment-session.ts`.
 *
 * HueStream v2 frame layout (all big-endian):
 *   "HueStream" (9 bytes) + version 0x02 0x00 (2) + sequence (1) +
 *   reserved 0x00 0x00 (2) + color space 0x00=RGB (1) + reserved 0x00 (1)
 *   = 16-byte header, then the entertainment area's UUID as 36 ASCII bytes
 *   (with dashes), then 7 bytes per channel: channel id (1) + R/G/B, each
 *   duplicated into 2 bytes (the bridge's 16-bit-with-duplicated-byte
 *   convention for an 8-bit source) = 6 bytes.
 */

export const HUE_ENTERTAINMENT_PORT = 2100;
export const HUE_ENTERTAINMENT_CIPHER = "PSK-AES128-GCM-SHA256";

const HUESTREAM_HEADER = new TextEncoder().encode("HueStream");
const HUESTREAM_VERSION = new Uint8Array([0x02, 0x00]);
const COLOR_SPACE_RGB = 0x00;

export interface ChannelColor {
  readonly channel: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)));
}

/**
 * Build one HueStream v2 UDP payload carrying every given channel's color.
 * `sequence` wraps to a byte; the bridge does not require it to be
 * meaningful, only present. `areaId` is the entertainment configuration's
 * UUID (with dashes), exactly 36 ASCII characters.
 */
export function buildHueStreamFrame(areaId: string, sequence: number, channels: readonly ChannelColor[]): Uint8Array {
  if (!/^[0-9a-fA-F-]{36}$/u.test(areaId)) {
    throw new Error(`Entertainment area id must be a 36-character UUID; got "${areaId}"`);
  }
  if (channels.length === 0) {
    throw new Error("A HueStream frame needs at least one channel");
  }
  const areaIdBytes = new TextEncoder().encode(areaId);
  const frame = new Uint8Array(16 + areaIdBytes.length + 7 * channels.length);
  let offset = 0;
  frame.set(HUESTREAM_HEADER, offset); offset += HUESTREAM_HEADER.length;
  frame.set(HUESTREAM_VERSION, offset); offset += HUESTREAM_VERSION.length;
  frame[offset++] = sequence & 0xFF;
  frame[offset++] = 0x00; // reserved
  frame[offset++] = 0x00; // reserved
  frame[offset++] = COLOR_SPACE_RGB;
  frame[offset++] = 0x00; // reserved
  frame.set(areaIdBytes, offset); offset += areaIdBytes.length;
  for (const { channel, r, g, b } of channels) {
    const red = clampByte(r);
    const green = clampByte(g);
    const blue = clampByte(b);
    frame[offset++] = channel & 0xFF;
    frame[offset++] = red; frame[offset++] = red;
    frame[offset++] = green; frame[offset++] = green;
    frame[offset++] = blue; frame[offset++] = blue;
  }
  return frame;
}
