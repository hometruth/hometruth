/** Router-independent Network Tools contract. Capabilities are optional;
 * unsupported operations must be reported, never silently emulated.
 * Provider scripts and setup: docs/NETWORK_TOOLS.md.
 */
import type { WifiAdmissionApi } from "./wifi-admission";

export type DnsAction = "on" | "off";
export type DnsRecordState = "on" | "off" | "missing";

export interface DnsTarget {
  /** Hostname the cameras resolve; `usce.mearicloud.com` for the Pet 3T. */
  readonly domain: string;
  /** LAN address of the HomeTruth server the record should point at. */
  readonly overrideIp: string;
}

/** One Wi-Fi client as the gateway lists it. The access-point fields are what a packet capture needs to find the right radio interface. */
export interface WifiClient {
  /** Address the client is using now. May be a self-assigned 169.254/16 address when DHCP failed. */
  readonly mac: string;
  readonly address: string;
  /** Address reserved for this client by the gateway's DHCP server, when one is configured. */
  readonly fixedAddress?: string;
  /** Last address the gateway saw this client use, when different from the current address. */
  readonly lastAddress?: string;
  readonly hostname?: string;
  readonly name?: string;
  /** MAC of the access point the client is associated with. */
  readonly apMac?: string;
  /** Radio band as the gateway names it (UniFi: "ng", "na", "6e"). */
  readonly radio?: string;
  readonly ssid?: string;
  readonly vlan?: number;
}

/** Per-camera outcome of a Wi-Fi kick. */
export interface CameraKickResult {
  readonly address: string;
  readonly mac?: string;
  readonly kicked: boolean;
  readonly detail: string;
}

/** Reads and switches the DNS override record. */
export interface DnsOverrideAdapter {
  describe(target: DnsTarget): Promise<DnsRecordState>;
  /** Returns a short human-readable summary of what changed. */
  set(target: DnsTarget, action: DnsAction): Promise<string>;
}

/** Finds a Wi-Fi client by address and drops its association. */
export interface WifiKickAdapter {
  /** Finds a client by its stable hardware identity, when the adapter can enumerate clients. */
  findClientByMac?(mac: string): Promise<WifiClient | undefined>;
  /** Finds a client by its current, fixed/reserved, or last address. */
  findClientByAddress(address: string): Promise<WifiClient | undefined>;
  kickClient(client: WifiClient): Promise<void>;
}

/** One device the isolation rule applies to, by the address the gateway keys firewall rules on. */
export interface InternetBlockTarget {
  readonly mac: string;
  /** Shown in the rule's name on the gateway, e.g. the device id. */
  readonly label: string;
}

/** Reads and switches one device's internet block (the isolation rule). Same on/off/missing vocabulary as the DNS record. */
export interface InternetBlockAdapter {
  describe(target: InternetBlockTarget): Promise<DnsRecordState>;
  /** Returns a short human-readable summary of what changed. */
  set(target: InternetBlockTarget, action: DnsAction): Promise<string>;
}

export interface PacketCaptureSession {
  /** Where the capture runs, e.g. "U7 Pro XG (10.77.0.131) wifi0ap0.3". */
  readonly where: string;
  stop(): Promise<void>;
}

/**
 * Streams the raw libpcap bytes of one client's traffic. `sink` receives the
 * stream as it arrives (file header first); `onEnd` fires once when the
 * capture stops for any reason other than `stop()`.
 */
export interface PacketCaptureAdapter {
  start(client: WifiClient, sink: (chunk: Uint8Array) => void, onEnd: (error?: Error) => void): Promise<PacketCaptureSession>;
}

export interface NetworkAddressClient extends WifiClient {
  /** False for remembered/offline clients; address is empty when disconnected. */
  readonly connected?: boolean;
  readonly network?: string;
  readonly subnet?: string;
}

export interface NetworkAddressAdapter {
  list(): Promise<NetworkAddressClient[]>;
  /** Validate and reserve an address; return an undo operation for a failed local save. */
  reserve(mac: string, address: string): Promise<() => Promise<void>>;
}

export interface NetworkAdapter {
  readonly admission?: { readonly target: string; readonly api: WifiAdmissionApi };
  readonly addresses?: NetworkAddressAdapter;
  /** Short identifier shown in status messages, e.g. "unifi". */
  readonly name: string;
  /** Absent when this network cannot switch the record from HomeTruth. */
  readonly dns?: DnsOverrideAdapter;
  /** Absent when this network cannot kick Wi-Fi clients. */
  readonly wifi?: WifiKickAdapter;
  /** Absent when this network cannot block a single device from the internet. */
  readonly internet?: InternetBlockAdapter;
  /** Absent when this network cannot capture a device's packets for HomeTruth. */
  readonly capture?: PacketCaptureAdapter;
}

export class NetworkAdapterError extends Error {
  constructor(message: string, readonly code: "not_configured" | "not_supported" | "gateway_error") {
    super(message);
    this.name = "NetworkAdapterError";
  }
}

export const DEFAULT_CAMERA_DNS_DOMAIN = "usce.mearicloud.com";

/**
 * Drop each camera's Wi-Fi association so it re-resolves the cloud hostname
 * and reconnects to whatever the DNS record points at right now. A camera the
 * gateway does not currently list (unplugged, wired, or asleep) is reported
 * rather than treated as an error, so one missing camera never blocks the rest.
 */
export async function kickCameraWifi(addresses: readonly string[], wifi: WifiKickAdapter): Promise<CameraKickResult[]> {
  const results: CameraKickResult[] = [];
  for (const address of [...new Set(addresses)]) {
    const client = await wifi.findClientByAddress(address);
    if (!client) {
      results.push({ address, kicked: false, detail: `${address} is not associated with the Wi-Fi right now` });
      continue;
    }
    const label = client.name ?? client.hostname ?? client.mac;
    try {
      await wifi.kickClient(client);
      results.push({ address, mac: client.mac, kicked: true, detail: `kicked ${label} (${address}) off Wi-Fi so it reconnects and re-resolves DNS` });
    } catch (error) {
      results.push({
        address,
        mac: client.mac,
        kicked: false,
        detail: `the gateway refused to kick ${label} (${address}): ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return results;
}
