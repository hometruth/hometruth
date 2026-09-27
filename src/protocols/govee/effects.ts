/** Raw light packets carried by ptReal on UDP 4003.
 * Protocol evidence: https://github.com/wez/govee2mqtt/issues/105 and
 * https://github.com/egold555/Govee-Reverse-Engineering/issues/11
 */
export function lightPacket(bytes: readonly number[]): string {
  if (bytes.length > 19 || bytes.some(value => !Number.isInteger(value) || value < 0 || value > 255)) throw new Error("Invalid Govee light packet");
  const packet = Buffer.alloc(20);
  packet.set(bytes);
  packet[19] = packet.subarray(0, 19).reduce((checksum, value) => checksum ^ value, 0);
  return packet.toString("base64");
}

/** Upload the scene parameters, then select its little-endian scene code. */
export function scenePackets(code: number, parameters: string): string[] {
  if (!Number.isInteger(code) || code < 0 || code > 65535 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(parameters)) throw new Error("Invalid Govee scene");
  const decoded = Buffer.from(parameters, "base64");
  if (decoded.length === 0) return [lightPacket([0x33, 0x05, 0x04, code & 255, code >> 8])];
  if (decoded.length > 4000) throw new Error("Invalid Govee scene parameters");
  const data = [0xa3, 0, 1, 0, 2];
  let page = 0;
  let lastMarker = 1;
  for (const byte of decoded) {
    if (data.length % 19 === 0) { data.push(0xa3); lastMarker = data.length; data.push(++page); }
    data.push(byte);
  }
  data[lastMarker] = 0xff;
  data[3] = page + 1;
  const packets: string[] = [];
  for (let offset = 0; offset < data.length; offset += 19) packets.push(lightPacket(data.slice(offset, offset + 19)));
  packets.push(lightPacket([0x33, 0x05, 0x04, code & 255, code >> 8]));
  return packets;
}

/** H7021 manual RGB: bits select physical positions, starting at the controller.
 * Seven bytes remain for the mask; the H7021 inventory is bounded to 30 bulbs.
 */
export function bulbColorPacket(index: number, hex: string): string {
  if (!Number.isInteger(index) || index < 0 || index >= 30 || !/^#[0-9a-f]{6}$/i.test(hex)) throw new Error("Invalid Govee bulb color");
  const mask = Array<number>(4).fill(0);
  mask[Math.floor(index / 8)] = 1 << (index % 8);
  return lightPacket([0x33, 0x05, 0x15, 0x01, ...[1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)), 0, 0, 0, 0, 0, ...mask]);
}

export function bulbBrightnessPacket(index: number, percent: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= 30 || !Number.isInteger(percent) || percent < 0 || percent > 100) throw new Error("Invalid Govee bulb brightness");
  const mask = Array<number>(4).fill(0);
  mask[Math.floor(index / 8)] = 1 << (index % 8);
  return lightPacket([0x33, 0x05, 0x15, 0x02, percent, ...mask]);
}

/** Send one static arrangement, grouped by color to fit a single LAN datagram. */
export function arrangementPackets(colors: readonly string[]): string[] {
  if (colors.length < 1 || colors.length > 30 || colors.some(color => !/^#[0-9a-f]{6}$/i.test(color))) throw new Error("Invalid Govee arrangement");
  const all = [0, 0, 0, 0];
  const groups = new Map<string, number[]>();
  colors.forEach((color, index) => {
    const key = color.toLowerCase();
    const mask = groups.get(key) ?? [0, 0, 0, 0];
    mask[Math.floor(index / 8)]! |= 1 << (index % 8);
    all[Math.floor(index / 8)]! |= 1 << (index % 8);
    groups.set(key, mask);
  });
  return [lightPacket([0x33, 5, 0x15, 2, 100, ...all]), ...[...groups].map(([hex, mask]) => lightPacket([0x33, 5, 0x15, 1, ...[1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)), 0, 0, 0, 0, 0, ...mask]))];
}
