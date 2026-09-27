import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";

/** A Broadlink device found by LAN broadcast discovery, before authentication. */
export interface DiscoveredBroadlinkDevice {
  host: string;
  mac: string;
  devType: number;
}

function localIpv4Addresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

function macFromResponse(response: Buffer): string {
  const bytes = Array.from(response.subarray(0x3a, 0x40)).reverse();
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(":");
}

/**
 * Broadcast a Broadlink "hello" discovery packet on the LAN and collect
 * replies for `windowMs`. Devices identify themselves by their device-type
 * code and MAC address; the caller matches by host against devices.yml.
 */
export async function discoverBroadlinkDevices(windowMs = 2_000, localAddress?: string): Promise<DiscoveredBroadlinkDevice[]> {
  const address = localAddress ?? localIpv4Addresses()[0];
  if (!address) return [];
  const [a = 0, b = 0, c = 0] = address.split(".").map(Number);

  const packet = Buffer.alloc(0x30);
  const now = new Date();
  const offsetMinutes = -now.getTimezoneOffset();
  packet.writeInt32LE(Math.trunc(offsetMinutes / 60), 0x08);
  packet.writeUInt16LE(now.getFullYear(), 0x0c);
  packet[0x0e] = now.getSeconds();
  packet[0x0f] = now.getMinutes();
  packet[0x10] = now.getHours();
  packet[0x11] = now.getDay();
  packet[0x12] = now.getDate();
  packet[0x13] = now.getMonth() + 1;
  packet[0x18] = a;
  packet[0x19] = b;
  packet[0x1a] = c;
  packet[0x1b] = Number(address.split(".")[3]);
  packet.writeUInt16LE(80, 0x1c);
  packet[0x26] = 6;
  let sum = 0xbeaf;
  for (const byte of packet) sum = (sum + byte) & 0xffff;
  packet.writeUInt16LE(sum, 0x20);

  const socket = createSocket("udp4");
  const found = new Map<string, DiscoveredBroadlinkDevice>();
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.on("message", (message, remote) => {
        if (message.length < 0x40) return;
        const devType = message.readUInt16LE(0x34);
        found.set(remote.address, { host: remote.address, mac: macFromResponse(message), devType });
      });
      socket.bind(0, address, () => {
        socket.setBroadcast(true);
        socket.send(packet, 80, "255.255.255.255");
        setTimeout(() => {
          socket.close();
          resolve();
        }, windowMs);
      });
    });
  } finally {
    socket.removeAllListeners();
  }
  return [...found.values()];
}
