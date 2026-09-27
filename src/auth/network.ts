/**
 * Is this request from the local network?
 *
 * The whole "open on the LAN" policy rests on this one answer, so it is a
 * separate, exhaustively tested file rather than a regex inline in the guard.
 *
 * Two rules it must never break:
 *
 *  - The address comes from the **socket**, never from a header a client can
 *    write. `X-Forwarded-For` is a claim, not a fact. The supervisor reads the
 *    real peer address and passes it on after deleting any inbound copy; if
 *    that trusted value is missing, this answers no rather than guessing.
 *  - An IPv4-mapped IPv6 address (`::ffff:10.77.0.5`) is the same host as
 *    `10.77.0.5`. Dual-stack listeners report the mapped form, and matching
 *    only the plain form would quietly disable LAN trust on some setups —
 *    while matching it carelessly (`includes("192.168.")`) would accept
 *    `2001:db8::10.77.0.5` from anywhere.
 *
 * Deliberately *not* local: 100.64.0.0/10. That is carrier-grade NAT, which is
 * also the range Tailscale hands out, and a tailnet is remote access wearing a
 * private-looking address. Reaching the house from outside should need a token.
 */

/** The header the supervisor sets from the real peer address, after stripping any client copy. */
export const CLIENT_ADDRESS_HEADER = "x-hometruth-client-address";

function ipv4IsPrivate(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map(part => (/^\d{1,3}$/u.test(part) ? Number(part) : Number.NaN));
  if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  // Reject "01.2.3.4": a leading zero is octal to some parsers and decimal to
  // others, which is exactly the disagreement an address filter is bypassed with.
  if (parts.some(part => part.length > 1 && part.startsWith("0"))) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true;                        // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;          // 192.168.0.0/16
  if (a === 127) return true;                       // loopback
  if (a === 169 && b === 254) return true;          // 169.254.0.0/16 link-local
  return false;
}

/**
 * Whether an address is on a private network: RFC 1918, loopback, link-local,
 * IPv6 unique-local (fc00::/7) and IPv6 link-local (fe80::/10).
 */
export function isPrivateAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  let value = address.trim().toLowerCase();
  if (!value) return false;
  // A bracketed literal, with or without a port: [::1]:3000.
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) return false;
    value = value.slice(1, end);
  }
  // A zone index on a link-local address: fe80::1%en0.
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  if (!value) return false;

  if (!value.includes(":")) return ipv4IsPrivate(value);

  if (value === "::1") return true;
  // An IPv4-mapped or IPv4-compatible address, but only when the prefix really
  // is the mapping prefix — not merely because it ends in dotted quad.
  const lastColon = value.lastIndexOf(":");
  const tail = value.slice(lastColon + 1);
  if (tail.includes(".")) {
    const prefix = value.slice(0, lastColon + 1);
    if (prefix !== "::ffff:" && prefix !== "::") return false;
    return ipv4IsPrivate(tail);
  }
  const head = value.split(":")[0] ?? "";
  if (!/^[0-9a-f]{1,4}$/u.test(head)) return false;
  const leading = Number.parseInt(head, 16);
  if (Number.isNaN(leading)) return false;
  if ((leading & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((leading & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  return false;
}

/** Whether this site treats the local network as trusted. On unless switched off. */
export function trustsLocalNetwork(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.HOMETRUTH_TRUST_LAN?.trim().toLowerCase();
  return value !== "off" && value !== "false" && value !== "0" && value !== "no";
}
