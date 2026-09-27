/**
 * SSDP discovery for Sonos players, reusing the generic multicast transport
 * and HTTPU response parser already built for camera discovery
 * (`../tkenpro/discovery`), scoped to Sonos's own device type rather than
 * the broad `ssdp:all` search cameras use.
 */
import { BunDatagramTransport, parseSsdpResponse, type DatagramTransport, type DiscoveryObservation } from "../tkenpro/discovery";

const SSDP_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;
const SONOS_DEVICE_TYPE = "urn:schemas-upnp-org:device:ZonePlayer:1";
const MAX_TIMEOUT_MS = 10_000;

export interface DiscoveredSpeaker {
  readonly host: string;
  readonly server?: string;
  readonly usn?: string;
  readonly location?: string;
}

export interface DiscoverSonosOptions {
  readonly timeoutMs?: number;
}

export interface DiscoverSonosDependencies {
  readonly datagrams?: DatagramTransport;
}

/** M-SEARCH request scoped to Sonos's ZonePlayer device type. */
export function createSonosSsdpSearch(): Uint8Array {
  return new TextEncoder().encode([
    "M-SEARCH * HTTP/1.1",
    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    "MX: 1",
    `ST: ${SONOS_DEVICE_TYPE}`,
    "",
    "",
  ].join("\r\n"));
}

function urlHost(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isZonePlayerObservation(observation: DiscoveryObservation): boolean {
  return observation.types.some((type) => type.includes("ZonePlayer"));
}

/** SSDP-scan the LAN for Sonos players. One entry per physical unit, deduped by host. */
export async function discoverSonosSpeakers(
  options: DiscoverSonosOptions = {},
  dependencies: DiscoverSonosDependencies = {},
): Promise<DiscoveredSpeaker[]> {
  const datagrams = dependencies.datagrams ?? new BunDatagramTransport();
  const timeoutMs = Math.max(50, Math.min(MAX_TIMEOUT_MS, Math.floor(options.timeoutMs ?? 1_500)));
  const replies = await datagrams.exchange({
    address: SSDP_ADDRESS,
    port: SSDP_PORT,
    payload: createSonosSsdpSearch(),
    timeoutMs,
  });

  const observations = replies
    .map((reply) => parseSsdpResponse(reply.data, reply.address))
    .filter((observation): observation is DiscoveryObservation => observation !== undefined && isZonePlayerObservation(observation));

  const byHost = new Map<string, DiscoveredSpeaker>();
  for (const observation of observations) {
    const location = observation.locations[0];
    const host = (location ? urlHost(location) : undefined) ?? observation.sourceAddress.toLowerCase();
    if (byHost.has(host)) continue;
    byHost.set(host, {
      host,
      ...(observation.server ? { server: observation.server } : {}),
      ...(observation.usn ? { usn: observation.usn } : {}),
      ...(location ? { location } : {}),
    });
  }
  return [...byHost.values()].sort((left, right) => left.host.localeCompare(right.host));
}
