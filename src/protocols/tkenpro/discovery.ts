/**
 * Local-only discovery helpers for ONVIF cameras.
 *
 * Network access is deliberately bounded: multicast discovery has a short
 * deadline and active probing accepts only private/link-local IPv4 hosts (or
 * explicit `.local` names), a small allow-list of ports, and a hard host cap.
 */

export const CAMERA_PROBE_PORTS = [8000, 8554, 80, 443, 8090, 554] as const;

export type CameraProbePort = (typeof CAMERA_PROBE_PORTS)[number];
export type DiscoverySource = "ws-discovery" | "meari-lan" | "ssdp" | "probe";

export interface DatagramReply {
  readonly data: Uint8Array;
  readonly address: string;
  readonly port: number;
}

export interface DatagramExchange {
  readonly address: string;
  readonly port: number;
  /** Fixed local UDP port when the protocol replies somewhere other than the sender's ephemeral port. */
  readonly bindPort?: number;
  readonly payload: Uint8Array;
  readonly timeoutMs: number;
}

export interface DatagramTransport {
  exchange(request: DatagramExchange): Promise<readonly DatagramReply[]>;
}

export type PortProbe = (host: string, port: CameraProbePort, timeoutMs: number) => Promise<boolean>;
export type OnvifEndpointProbe = (url: string, timeoutMs: number) => Promise<boolean>;

export interface DiscoveryObservation {
  readonly source: DiscoverySource;
  readonly sourceAddress: string;
  readonly endpointReference?: string;
  readonly usn?: string;
  readonly server?: string;
  readonly model?: string;
  readonly firmware?: string;
  readonly serialNumber?: string;
  readonly deviceName?: string;
  /** Vendor capability evidence; it does not mean an ONVIF session is reachable. */
  readonly onvifAdvertised?: boolean;
  readonly types: readonly string[];
  readonly scopes: readonly string[];
  readonly locations: readonly string[];
  readonly openPorts: readonly number[];
}

export interface DiscoveredCamera {
  /** Stable when WS-Discovery supplies an EPR/UUID; otherwise derived from host. */
  readonly id: string;
  readonly host: string;
  readonly sources: readonly DiscoverySource[];
  readonly endpointReference?: string;
  readonly usn?: string;
  readonly server?: string;
  readonly model?: string;
  readonly firmware?: string;
  readonly serialNumber?: string;
  readonly deviceName?: string;
  readonly onvifAdvertised?: boolean;
  readonly types: readonly string[];
  readonly scopes: readonly string[];
  readonly locations: readonly string[];
  readonly onvifEndpoints: readonly string[];
  readonly openPorts: readonly number[];
}

export interface DiscoveryDependencies {
  readonly datagrams?: DatagramTransport;
  readonly probePort?: PortProbe;
  readonly probeOnvifEndpoint?: OnvifEndpointProbe;
  readonly now?: () => number;
}

export interface DiscoverCameraOptions {
  readonly wsDiscovery?: boolean;
  /** TKENPRO/Meari's account-free JSON discovery broadcast. */
  readonly meariLan?: boolean;
  readonly ssdp?: boolean;
  /** Explicit private IPv4 addresses or `.local` names. */
  readonly hosts?: readonly string[];
  /** Private IPv4 CIDRs only. Large ranges are rejected rather than truncated. */
  readonly cidrs?: readonly string[];
  readonly ports?: readonly CameraProbePort[];
  readonly multicastTimeoutMs?: number;
  readonly probeTimeoutMs?: number;
  readonly probeConcurrency?: number;
  /** Maximum number of distinct active-probe hosts, hard limited to 256. */
  readonly maxProbeHosts?: number;
}

export interface DiscoveryReport {
  readonly cameras: readonly DiscoveredCamera[];
  readonly errors: readonly string[];
  readonly elapsedMs: number;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const MAX_MULTICAST_TIMEOUT_MS = 10_000;
const MAX_PROBE_TIMEOUT_MS = 5_000;
const HARD_MAX_PROBE_HOSTS = 256;
const WS_DISCOVERY_ADDRESS = "239.255.255.250";
const WS_DISCOVERY_PORT = 3702;
const MEARI_LAN_BROADCAST_ADDRESS = "255.255.255.255";
const MEARI_LAN_BROADCAST_PORT = 3703;
const MEARI_LAN_REPLY_PORT = 6969;
const SSDP_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;

function clampTimeout(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(50, Math.min(maximum, Math.floor(value)));
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function contentValues(xml: string, localName: string): string[] {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${escaped}\\s*>`,
    "gi",
  );
  return [...xml.matchAll(pattern)].map((match) => decodeXml((match[1] ?? "").replace(/<[^>]+>/g, "").trim()));
}

function splitSpaceSeparated(values: readonly string[]): string[] {
  return values.flatMap((value) => value.split(/\s+/u)).map((value) => value.trim()).filter(Boolean);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function normalizeUuid(value: string): string {
  return value.trim().replace(/^urn:uuid:/iu, "").toLowerCase();
}

function urlHost(value: string): string | undefined {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function observationHost(observation: DiscoveryObservation): string {
  for (const location of observation.locations) {
    const host = urlHost(location);
    if (host !== undefined) return host;
  }
  return observation.sourceAddress.toLowerCase();
}

/** Parse one WS-Discovery datagram. A datagram can contain multiple ProbeMatch elements. */
export function parseWsDiscoveryResponse(payload: string | Uint8Array, sourceAddress: string): DiscoveryObservation[] {
  const xml = typeof payload === "string" ? payload : textDecoder.decode(payload);
  const matches = [...xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?ProbeMatch\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?ProbeMatch\s*>/gi)];
  const blocks = matches.length > 0 ? matches.map((match) => match[1] ?? "") : [xml];

  return blocks.flatMap((block): DiscoveryObservation[] => {
    const locations = unique(splitSpaceSeparated(contentValues(block, "XAddrs")));
    const endpointReference = contentValues(block, "Address")[0];
    const types = unique(splitSpaceSeparated(contentValues(block, "Types")));
    const scopes = unique(splitSpaceSeparated(contentValues(block, "Scopes")));
    if (locations.length === 0 && endpointReference === undefined && types.length === 0) return [];

    return [{
      source: "ws-discovery",
      sourceAddress,
      ...(endpointReference === undefined ? {} : { endpointReference }),
      types,
      scopes,
      locations,
      openPorts: [],
    }];
  });
}

/** Parse a single SSDP HTTPU response, retaining only useful identity/location fields. */
export function parseSsdpResponse(payload: string | Uint8Array, sourceAddress: string): DiscoveryObservation | undefined {
  const message = (typeof payload === "string" ? payload : textDecoder.decode(payload)).replaceAll("\r\n", "\n");
  const lines = message.split("\n");
  if (!/^HTTP\/1\.[01]\s+200\b/iu.test(lines[0]?.trim() ?? "")) return undefined;

  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name && value && !headers.has(name)) headers.set(name, value);
  }

  const location = headers.get("location");
  const usn = headers.get("usn");
  const server = headers.get("server");
  const type = headers.get("st") ?? headers.get("nt");
  if (location === undefined && usn === undefined) return undefined;

  return {
    source: "ssdp",
    sourceAddress,
    ...(usn === undefined ? {} : { usn }),
    ...(server === undefined ? {} : { server }),
    types: type === undefined ? [] : [type],
    scopes: [],
    locations: location === undefined ? [] : [location],
    openPorts: [],
  };
}

/** Parse the flat JSON reply used by TKENPRO/Meari's local device search. */
export function parseMeariLanResponse(
  payload: string | Uint8Array,
  sourceAddress: string,
): DiscoveryObservation | undefined {
  try {
    const parsed: unknown = JSON.parse(typeof payload === "string" ? payload : textDecoder.decode(payload));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const advertisedIp = typeof record.ip === "string" ? record.ip.trim() : "";
    const host = isLocalProbeHost(advertisedIp) && parseIpv4(advertisedIp) !== undefined
      ? advertisedIp
      : sourceAddress.trim();
    if (!isLocalProbeHost(host) || parseIpv4(host) === undefined) return undefined;

    const protocolSerial = typeof record.sn === "string" ? record.sn.trim() : "";
    const serialNumber = typeof record.serialno === "string" ? record.serialno.trim() : protocolSerial;
    const p2pUuid = typeof record.p2p_uuid === "string" ? record.p2p_uuid.trim() : "";
    const model = typeof record.model === "string" ? record.model.trim() : "";
    const firmware = typeof record.version === "string" ? record.version.trim() : "";
    const deviceName = typeof record.deviceName === "string" ? record.deviceName.trim() : "";
    let onvifAdvertised = false;
    if (typeof record.capability === "string") {
      try {
        const capability = JSON.parse(record.capability) as { caps?: { ovf?: unknown } };
        onvifAdvertised = capability.caps?.ovf === true
          || capability.caps?.ovf === 1
          || capability.caps?.ovf === "1";
      } catch {
        // Older firmware can return a non-JSON capability string.
      }
    }
    if (!serialNumber && !p2pUuid && !model) return undefined;

    const identity = p2pUuid || serialNumber;
    return {
      source: "meari-lan",
      sourceAddress: host,
      ...(identity ? { endpointReference: `urn:uuid:${identity}` } : {}),
      ...(model ? { server: model } : {}),
      ...(model ? { model } : {}),
      ...(firmware ? { firmware } : {}),
      ...(serialNumber ? { serialNumber } : {}),
      ...(deviceName ? { deviceName } : {}),
      ...(onvifAdvertised ? { onvifAdvertised: true } : {}),
      types: ["meari:camera"],
      scopes: [
        ...(serialNumber ? [`meari://device/serial/${encodeURIComponent(serialNumber)}`] : []),
        ...(model ? [`meari://device/model/${encodeURIComponent(model)}`] : []),
      ],
      locations: [],
      openPorts: [],
    };
  } catch {
    return undefined;
  }
}

function observationKeys(observation: DiscoveryObservation): string[] {
  const keys: string[] = [];
  if (observation.endpointReference !== undefined) keys.push(`uuid:${normalizeUuid(observation.endpointReference)}`);
  if (observation.usn !== undefined) {
    const uuid = observation.usn.match(/uuid:([^:\s>]+)/iu)?.[1];
    keys.push(uuid === undefined ? `usn:${observation.usn.toLowerCase()}` : `uuid:${normalizeUuid(uuid)}`);
  }
  keys.push(`host:${observationHost(observation)}`);
  return unique(keys);
}

function isLikelyOnvifEndpoint(location: string): boolean {
  return /\/onvif(?:\/|$)|device_service/iu.test(location);
}

/** SSDP is broad; keep responses with camera/ONVIF or generic Basic-device evidence. */
export function isLikelyCameraObservation(observation: DiscoveryObservation): boolean {
  if (observation.source !== "ssdp") return true;
  const evidence = [observation.server ?? "", ...observation.types, ...observation.locations].join(" ");
  return /camera|onvif|networkvideo|digitalsecurity|(?:^|[\W_])ipc(?:[\W_]|$)|meari|tkenpro|cloudedge|device:Basic:1/iu.test(evidence);
}

/** Merge observations by UUID/USN or host without discarding alternate service URLs. */
export function dedupeDiscoveryObservations(observations: readonly DiscoveryObservation[]): DiscoveredCamera[] {
  type MutableCamera = {
    keys: Set<string>;
    observations: DiscoveryObservation[];
  };
  const groups: MutableCamera[] = [];

  for (const observation of observations) {
    const keys = new Set(observationKeys(observation));
    const matching = groups.filter((group) => [...keys].some((key) => group.keys.has(key)));
    if (matching.length === 0) {
      groups.push({ keys, observations: [observation] });
      continue;
    }

    const target = matching[0];
    if (target === undefined) continue;
    target.observations.push(observation);
    for (const key of keys) target.keys.add(key);
    for (const duplicate of matching.slice(1)) {
      target.observations.push(...duplicate.observations);
      for (const key of duplicate.keys) target.keys.add(key);
      groups.splice(groups.indexOf(duplicate), 1);
    }
  }

  return groups.map((group): DiscoveredCamera => {
    const observationsInGroup = group.observations;
    const endpointReference = observationsInGroup.find((item) => item.endpointReference !== undefined)?.endpointReference;
    const usn = observationsInGroup.find((item) => item.usn !== undefined)?.usn;
    const server = observationsInGroup.find((item) => item.server !== undefined)?.server;
    const model = observationsInGroup.find((item) => item.model !== undefined)?.model;
    const firmware = observationsInGroup.find((item) => item.firmware !== undefined)?.firmware;
    const serialNumber = observationsInGroup.find((item) => item.serialNumber !== undefined)?.serialNumber;
    const deviceName = observationsInGroup.find((item) => item.deviceName !== undefined)?.deviceName;
    const onvifAdvertised = observationsInGroup.some((item) => item.onvifAdvertised === true);
    const locations = unique(observationsInGroup.flatMap((item) => item.locations));
    const host = locations.map(urlHost).find((value) => value !== undefined) ?? observationHost(observationsInGroup[0]!);
    const uuid = endpointReference ?? usn?.match(/uuid:([^:\s>]+)/iu)?.[1];

    return {
      id: uuid === undefined ? `host:${host}` : `uuid:${normalizeUuid(uuid)}`,
      host,
      sources: unique(observationsInGroup.map((item) => item.source)),
      ...(endpointReference === undefined ? {} : { endpointReference }),
      ...(usn === undefined ? {} : { usn }),
      ...(server === undefined ? {} : { server }),
      ...(model === undefined ? {} : { model }),
      ...(firmware === undefined ? {} : { firmware }),
      ...(serialNumber === undefined ? {} : { serialNumber }),
      ...(deviceName === undefined ? {} : { deviceName }),
      ...(onvifAdvertised ? { onvifAdvertised: true } : {}),
      types: unique(observationsInGroup.flatMap((item) => item.types)),
      scopes: unique(observationsInGroup.flatMap((item) => item.scopes)),
      locations,
      onvifEndpoints: locations.filter(isLikelyOnvifEndpoint),
      openPorts: unique(observationsInGroup.flatMap((item) => item.openPorts)).sort((left, right) => left - right),
    };
  }).sort((left, right) => left.host.localeCompare(right.host));
}

export function createWsDiscoveryProbe(messageId = crypto.randomUUID()): Uint8Array {
  return textEncoder.encode(`<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
 xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing"
 xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
 xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
 <e:Header>
  <w:MessageID>urn:uuid:${escapeXml(messageId)}</w:MessageID>
  <w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
  <w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
 </e:Header>
 <e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body>
</e:Envelope>`);
}

export function createSsdpSearch(): Uint8Array {
  return textEncoder.encode([
    "M-SEARCH * HTTP/1.1",
    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    "MX: 1",
    "ST: ssdp:all",
    "",
    "",
  ].join("\r\n"));
}

/** Exact account-free discovery payload used by the TKENPRO Android client. */
export function createMeariLanSearch(): Uint8Array {
  return textEncoder.encode('{"discovery":{}}');
}

export class BunDatagramTransport implements DatagramTransport {
  async exchange(request: DatagramExchange): Promise<readonly DatagramReply[]> {
    const replies: DatagramReply[] = [];
    let failure: Error | undefined;
    const socket = await Bun.udpSocket({
      hostname: "0.0.0.0",
      port: request.bindPort ?? 0,
      socket: {
        data(_socket, data, port, address) {
          replies.push({ data: Uint8Array.from(data), address, port });
        },
        error(_socket, error) {
          failure = error;
        },
      },
    });

    try {
      if (request.address === MEARI_LAN_BROADCAST_ADDRESS) socket.setBroadcast(true);
      // Meari/ONVIF cameras answer discovery probes sporadically — a sleeping or
      // just-woken camera often ignores the first datagram. Re-send the probe a
      // few times across the wait window so every responder on the network is
      // caught in one scan, not just whichever one happened to be listening.
      const repeatEveryMs = 400;
      const deadline = Date.now() + request.timeoutMs;
      socket.send(request.payload, request.port, request.address);
      while (Date.now() < deadline) {
        await Bun.sleep(Math.min(repeatEveryMs, Math.max(0, deadline - Date.now())));
        if (Date.now() >= deadline) break;
        try {
          socket.send(request.payload, request.port, request.address);
        } catch {
          // A transient send failure must not abort collection of prior replies.
        }
      }
      if (failure !== undefined && replies.length === 0) throw failure;
      return replies;
    } finally {
      socket.close();
    }
  }
}

function parseIpv4(value: string): number | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
  return octets.reduce((result, octet) => ((result << 8) | octet) >>> 0, 0);
}

function formatIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

export function isLocalProbeHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/u, "");
  if (normalized === "localhost" || normalized.endsWith(".local")) return true;
  const address = parseIpv4(normalized);
  if (address === undefined) return false;
  const first = address >>> 24;
  const second = (address >>> 16) & 255;
  return first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

/** Enumerate a private CIDR, rejecting ranges above maxHosts before any network traffic. */
export function enumeratePrivateCidr(cidr: string, maxHosts = 64): string[] {
  const match = cidr.trim().match(/^([^/]+)\/(\d{1,2})$/u);
  if (match === null) throw new Error(`Invalid IPv4 CIDR: ${cidr}`);
  const addressText = match[1];
  const prefixText = match[2];
  if (addressText === undefined || prefixText === undefined) throw new Error(`Invalid IPv4 CIDR: ${cidr}`);
  const address = parseIpv4(addressText);
  const prefix = Number(prefixText);
  const boundedMax = Math.max(1, Math.min(HARD_MAX_PROBE_HOSTS, Math.floor(maxHosts)));
  if (address === undefined || prefix < 0 || prefix > 32) throw new Error(`Invalid IPv4 CIDR: ${cidr}`);
  if (!isLocalProbeHost(addressText)) throw new Error(`Refusing non-local CIDR: ${cidr}`);

  const size = 2 ** (32 - prefix);
  const hostCount = prefix <= 30 ? size - 2 : size;
  if (hostCount > boundedMax) throw new Error(`CIDR ${cidr} contains ${hostCount} hosts; limit is ${boundedMax}`);
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  const network = (address & mask) >>> 0;
  const start = prefix <= 30 ? 1 : 0;
  const end = prefix <= 30 ? size - 1 : size;
  const result: string[] = [];
  for (let offset = start; offset < end; offset += 1) result.push(formatIpv4((network + offset) >>> 0));
  return result;
}

export const bunPortProbe: PortProbe = async (host, port, timeoutMs) => {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let activeSocket: { end(): void } | undefined;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        activeSocket?.end();
      } catch {
        // The peer may already have closed the socket.
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);

    void Bun.connect({
      hostname: host,
      port,
      socket: {
        open(socket) {
          activeSocket = socket;
          finish(true);
        },
        data() {},
        close() {
          finish(false);
        },
        error() {
          finish(false);
        },
        connectError() {
          finish(false);
        },
      },
    }).then((socket) => {
      activeSocket = socket;
      if (settled) socket.end();
    }).catch(() => finish(false));
  });
};

const unauthenticatedDateProbe = `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
<s:Body><tds:GetSystemDateAndTime/></s:Body></s:Envelope>`;

/** Confirm that a web port actually speaks ONVIF without sending credentials. */
export const fetchOnvifEndpointProbe: OnvifEndpointProbe = async (url, timeoutMs) => {
  try {
    const action = "http://www.onvif.org/ver10/device/wsdl/GetSystemDateAndTime";
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": `application/soap+xml; charset=utf-8; action="${action}"`,
        soapaction: `"${action}"`,
      },
      body: unauthenticatedDateProbe,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) return true;
    if (response.status >= 300 && response.status < 400) return false;
    const contentType = response.headers.get("content-type") ?? "";
    const server = response.headers.get("server") ?? "";
    if (/onvif/iu.test(server)) return true;
    if (!/xml|soap/iu.test(contentType) && response.status !== 400 && response.status !== 500) return false;
    const body = (await response.text()).slice(0, 262_144);
    return /onvif|soap-envelope|GetSystemDateAndTime|(?:<|:)Fault\b/iu.test(body);
  } catch {
    return false;
  }
};

async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await mapper(item);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function discoverCameras(
  options: DiscoverCameraOptions = {},
  dependencies: DiscoveryDependencies = {},
): Promise<DiscoveryReport> {
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const datagrams = dependencies.datagrams ?? new BunDatagramTransport();
  const probePort = dependencies.probePort ?? bunPortProbe;
  const probeOnvifEndpoint = dependencies.probeOnvifEndpoint ?? fetchOnvifEndpointProbe;
  const multicastTimeoutMs = clampTimeout(options.multicastTimeoutMs, 1_200, MAX_MULTICAST_TIMEOUT_MS);
  const probeTimeoutMs = clampTimeout(options.probeTimeoutMs, 500, MAX_PROBE_TIMEOUT_MS);
  const maxProbeHosts = boundedInteger(options.maxProbeHosts, 64, 1, HARD_MAX_PROBE_HOSTS);
  const concurrency = boundedInteger(options.probeConcurrency, 12, 1, 32);
  const errors: string[] = [];
  const ports = unique(options.ports ?? CAMERA_PROBE_PORTS).filter((port): port is CameraProbePort => {
    if ((CAMERA_PROBE_PORTS as readonly number[]).includes(port)) return true;
    errors.push(`Probe: refusing port ${String(port)}; it is not in the camera probe allow-list`);
    return false;
  });
  const observations: DiscoveryObservation[] = [];
  const multicastTasks: Promise<void>[] = [];

  if (options.wsDiscovery !== false) {
    multicastTasks.push(datagrams.exchange({
      address: WS_DISCOVERY_ADDRESS,
      port: WS_DISCOVERY_PORT,
      payload: createWsDiscoveryProbe(),
      timeoutMs: multicastTimeoutMs,
    }).then((replies) => {
      for (const reply of replies) observations.push(...parseWsDiscoveryResponse(reply.data, reply.address));
    }).catch((error: unknown) => {
      errors.push(`WS-Discovery: ${error instanceof Error ? error.message : String(error)}`);
    }));
  }

  if (options.meariLan !== false) {
    const payload = createMeariLanSearch();
    for (const target of [
      { address: WS_DISCOVERY_ADDRESS, port: WS_DISCOVERY_PORT, label: "multicast" },
      { address: MEARI_LAN_BROADCAST_ADDRESS, port: MEARI_LAN_BROADCAST_PORT, label: "broadcast" },
    ] as const) {
      multicastTasks.push(datagrams.exchange({
        address: target.address,
        port: target.port,
        ...(target.port === MEARI_LAN_BROADCAST_PORT ? { bindPort: MEARI_LAN_REPLY_PORT } : {}),
        payload,
        timeoutMs: multicastTimeoutMs,
      }).then((replies) => {
        for (const reply of replies) {
          const parsed = parseMeariLanResponse(reply.data, reply.address);
          if (parsed !== undefined) observations.push(parsed);
        }
      }).catch((error: unknown) => {
        errors.push(`TKENPRO LAN ${target.label}: ${error instanceof Error ? error.message : String(error)}`);
      }));
    }
  }

  if (options.ssdp !== false) {
    multicastTasks.push(datagrams.exchange({
      address: SSDP_ADDRESS,
      port: SSDP_PORT,
      payload: createSsdpSearch(),
      timeoutMs: multicastTimeoutMs,
    }).then((replies) => {
      for (const reply of replies) {
        const parsed = parseSsdpResponse(reply.data, reply.address);
        if (parsed !== undefined) observations.push(parsed);
      }
    }).catch((error: unknown) => {
      errors.push(`SSDP: ${error instanceof Error ? error.message : String(error)}`);
    }));
  }

  await Promise.all(multicastTasks);

  const activeHosts = new Set<string>();
  let hostLimitReported = false;
  const reportHostLimit = (message: string): void => {
    if (hostLimitReported) return;
    hostLimitReported = true;
    errors.push(message);
  };
  for (const rawHost of options.hosts ?? []) {
    const host = rawHost.trim().toLowerCase().replace(/\.$/u, "");
    if (!isLocalProbeHost(host)) {
      errors.push(`Probe: refusing non-local host ${rawHost}`);
      continue;
    }
    if (!activeHosts.has(host) && activeHosts.size >= maxProbeHosts) {
      reportHostLimit(`Probe: additional hosts skipped after reaching the ${maxProbeHosts}-host limit.`);
      continue;
    }
    activeHosts.add(host);
  }
  for (const cidr of options.cidrs ?? []) {
    try {
      const cidrHosts = enumeratePrivateCidr(cidr, maxProbeHosts);
      const newHosts = cidrHosts.filter((host) => !activeHosts.has(host));
      if (activeHosts.size + newHosts.length > maxProbeHosts) {
        reportHostLimit(`Probe: later CIDRs skipped to keep active discovery within the ${maxProbeHosts}-host limit.`);
        continue;
      }
      for (const host of newHosts) activeHosts.add(host);
    } catch (error) {
      errors.push(`Probe: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const targets = [...activeHosts].flatMap((host) => ports.map((port) => ({ host, port })));
  const results = await mapConcurrent(targets, concurrency, async ({ host, port }) => ({
    host,
    port,
    open: await probePort(host, port, probeTimeoutMs).catch(() => false),
  }));
  for (const host of activeHosts) {
    const openPorts = results.filter((result) => result.host === host && result.open).map((result) => result.port);
    if (openPorts.length === 0) continue;
    const webCandidates = openPorts.flatMap((port): string[] => {
      if (port !== 80 && port !== 443 && port !== 8000 && port !== 8090) return [];
      const scheme = port === 443 ? "https" : "http";
      return [`${scheme}://${host}:${port}/onvif/device_service`];
    });
    const locations = (await mapConcurrent(webCandidates, Math.min(4, concurrency), async (url) => ({
      url,
      confirmed: await probeOnvifEndpoint(url, probeTimeoutMs).catch(() => false),
    }))).filter((result) => result.confirmed).map((result) => result.url);
    const cameraSpecificPortOpen = openPorts.some((port) => port === 554 || port === 8554 || port === 8000 || port === 8090);
    if (locations.length === 0 && !cameraSpecificPortOpen) continue;
    observations.push({
      source: "probe",
      sourceAddress: host,
      types: [],
      scopes: [],
      locations,
      openPorts,
    });
  }

  return {
    cameras: dedupeDiscoveryObservations(observations.filter(isLikelyCameraObservation)),
    errors,
    elapsedMs: Math.max(0, now() - startedAt),
  };
}

/**
 * True when a discovered camera belongs to the Meari / TKENPRO / CloudEdge
 * family that HomeTruth can actually control. This is the "compatible pet cam"
 * predicate used when persisting the discovered inventory.
 *
 * Evidence, strongest first:
 *  - it answered Meari's account-free LAN broadcast (`meari-lan` source);
 *  - a Meari discovery scope (`meari://…`) or `meari:camera` type;
 *  - vendor strings (meari / tkenpro / cloudedge / pet 3t / pet3t) in its
 *    server banner, model, device name, USN, or ONVIF/service URLs.
 */
export function isCompatiblePetCamera(camera: DiscoveredCamera): boolean {
  if (camera.sources.includes("meari-lan")) return true;
  if (camera.types.some((type) => /meari/iu.test(type))) return true;
  if (camera.scopes.some((scope) => /^meari:\/\//iu.test(scope))) return true;
  const evidence = [
    camera.server ?? "",
    camera.model ?? "",
    camera.deviceName ?? "",
    camera.usn ?? "",
    ...camera.locations,
    ...camera.scopes,
  ].join(" ");
  return /meari|tkenpro|cloudedge|pet\s*3t/iu.test(evidence);
}
