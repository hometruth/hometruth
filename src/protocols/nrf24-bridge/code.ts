import type { Nrf24PacketObservation, Nrf24TransmitRequest } from "./client";

const PREFIX = "nrf24:v1:";

function isInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function compactHex(value: unknown, bytesMinimum: number, bytesMaximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.replaceAll(":", "");
  return new RegExp(`^(?:[0-9a-f]{2}){${bytesMinimum},${bytesMaximum}}$`, "iu").test(compact)
    ? compact.toUpperCase()
    : undefined;
}

/** Encodes one validated Enhanced ShockBurst packet as an opaque saved-signal value. */
export function encodeNrf24Code(observation: Nrf24PacketObservation, dataRateKbps: number): string {
  return `${PREFIX}${Buffer.from(JSON.stringify({
    channel: observation.channel,
    dataRateKbps,
    address: observation.address.replaceAll(":", ""),
    addressWidth: observation.addressWidth,
    payloadHex: observation.payloadHex,
    crcBytes: observation.crcBytes,
  }), "utf8").toString("base64url")}`;
}

/** Decodes only HomeTruth's versioned, bounded nRF24 saved-code format. */
export function decodeNrf24Code(code: string): Nrf24TransmitRequest {
  if (!code.startsWith(PREFIX) || code.length > 1000) throw new Error("Saved code is not a supported nRF24 packet");
  let candidate: unknown;
  try { candidate = JSON.parse(Buffer.from(code.slice(PREFIX.length), "base64url").toString("utf8")); }
  catch { throw new Error("Saved nRF24 code is malformed"); }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Saved nRF24 code is malformed");
  const body = candidate as Record<string, unknown>;
  const address = compactHex(body.address, 3, 5);
  const payloadHex = compactHex(body.payloadHex, 1, 32);
  if (!isInteger(body.channel, 0, 125) || ![250, 1000, 2000].includes(body.dataRateKbps as number)
    || !isInteger(body.addressWidth, 3, 5) || !address || address.length !== body.addressWidth * 2
    || !payloadHex || !isInteger(body.crcBytes, 0, 2)) {
    throw new Error("Saved nRF24 code contains invalid packet settings");
  }
  return {
    channel: body.channel,
    dataRateKbps: body.dataRateKbps as 250 | 1000 | 2000,
    address,
    addressWidth: body.addressWidth,
    payloadHex,
    crcBytes: body.crcBytes,
  };
}
