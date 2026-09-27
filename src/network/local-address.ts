import { networkInterfaces } from "node:os";

function toNumber(address: string): number | undefined {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

function maskBits(netmask: string): number | undefined {
  const value = toNumber(netmask);
  if (value === undefined) return undefined;
  let bits = 0;
  for (let index = 31; index >= 0; index -= 1) {
    if ((value >>> index) & 1) bits += 1;
    else break;
  }
  return bits;
}

/**
 * The address of this machine that the given LAN clients would use to reach
 * it: the first non-internal IPv4 interface whose subnet contains one of the
 * addresses, else the first non-internal IPv4 interface, else undefined.
 */
export function localAddressFor(clientAddresses: readonly string[]): string | undefined {
  const candidates: { address: string; netmask: string }[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      candidates.push({ address: entry.address, netmask: entry.netmask });
    }
  }
  for (const client of clientAddresses) {
    const clientNumber = toNumber(client);
    if (clientNumber === undefined) continue;
    for (const candidate of candidates) {
      const own = toNumber(candidate.address);
      const bits = maskBits(candidate.netmask);
      if (own === undefined || bits === undefined) continue;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((own & mask) >>> 0 === (clientNumber & mask) >>> 0) return candidate.address;
    }
  }
  return candidates[0]?.address;
}
