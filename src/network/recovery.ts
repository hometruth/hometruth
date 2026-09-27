/**
 * Explicit network inspection and reconnection for a LAN device.
 *
 * HomeTruth cannot send DHCP from another host on a device's behalf. What a
 * managed Wi-Fi network can do is drop the station association; reconnecting
 * makes the device run DHCP again. Only an explicit reconnect action may do
 * this; status reads must never kick a device or its shared bridge off Wi-Fi.
 */
import { NetworkAdapterError, type DnsRecordState, type NetworkAdapter, type WifiClient } from "./adapter";

export interface DeviceNetworkTarget {
  readonly id: string;
  readonly name: string;
  /** Configured LAN address, including a gateway-side fixed DHCP reservation. */
  readonly address: string;
  /** Stable client identity. UniFi lookups prefer this over an address. */
  readonly mac?: string;
}

export interface DeviceNetworkStatus {
  readonly deviceId: string;
  readonly adapter: string;
  readonly configuredAddress: string;
  readonly configuredMac?: string;
  readonly associated: boolean;
  readonly mac?: string;
  readonly currentAddress?: string;
  readonly addressMatches?: boolean;
  /** Observed HomeTruth internet block; null means it could not be inspected. */
  readonly isolated: boolean | null;
  readonly isolation: DeviceNetworkIsolationStatus;
  readonly message: string;
}

type IsolationRuleState = DnsRecordState | "unavailable";

export interface DeviceNetworkInspectionOptions {
  /** The isolation service's desired state, separate from gateway observations. */
  readonly isolationRequested?: boolean;
  /** Model-declared vendor names, including shared overrides needed by other devices. */
  readonly dnsOverrides?: readonly { readonly domain: string; readonly overrideIp?: string }[];
}

export interface DeviceNetworkIsolationStatus {
  /** These checks cover HomeTruth-managed rules, not every router policy. */
  readonly scope: "hometruth";
  readonly requested?: boolean;
  readonly internetBlock: IsolationRuleState;
  /** Active mechanisms. DNS redirection alone does not block internet access. */
  readonly methods: readonly ("internet-block" | "dns-override")[];
  readonly dns: readonly {
    readonly domain: string;
    readonly overrideIp?: string;
    readonly state: IsolationRuleState;
    readonly detail?: string;
  }[];
  readonly detail?: string;
}

export interface DeviceReconnectResult {
  readonly deviceId: string;
  readonly address: string;
  readonly mac: string;
  readonly currentAddress: string;
  readonly message: string;
}

export interface DeviceNetworkRecoveryOptions {
  /** Lazily supplies the configured network adapter. */
  readonly adapter: () => NetworkAdapter;
  readonly logger?: (event: Record<string, unknown>) => void;
}

export type DeviceNetworkRecoveryEvent = Record<string, unknown>;

function adapterLabel(name: string): string {
  return name === "unifi" ? "UniFi" : name;
}

export class DeviceNetworkRecovery {
  private readonly adapterFactory: () => NetworkAdapter;
  private readonly logger: (event: Record<string, unknown>) => void;
  private readonly listeners = new Set<(event: DeviceNetworkRecoveryEvent) => void>();
  private readonly inFlight = new Map<string, Promise<DeviceReconnectResult>>();
  private adapter: NetworkAdapter | undefined;

  constructor(options: DeviceNetworkRecoveryOptions) {
    this.adapterFactory = options.adapter;
    this.logger = options.logger ?? ((event) => console.log(JSON.stringify(event)));
  }

  private key(target: DeviceNetworkTarget): string {
    return `${target.id}\0${target.address}`;
  }

  private client(): NetworkAdapter {
    if (!this.adapter) this.adapter = this.adapterFactory();
    return this.adapter;
  }

  addressSettings() {
    const addresses = this.client().addresses;
    if (!addresses) throw new NetworkAdapterError("This network adapter cannot edit IP reservations", "not_supported");
    return addresses;
  }

  /** Observe successful reconnect actions without replacing server logging. */
  subscribe(listener: (event: DeviceNetworkRecoveryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(event: DeviceNetworkRecoveryEvent): void {
    this.logger(event);
    for (const listener of this.listeners) listener(event);
  }

  private async find(target: DeviceNetworkTarget): Promise<WifiClient | undefined> {
    const wifi = this.client().wifi;
    if (!wifi) throw new NetworkAdapterError("The configured network adapter cannot inspect Wi-Fi clients", "not_supported");
    // When the adapter supports MAC lookup, a configured MAC is authoritative:
    // falling back to an address after a typo could select and kick another client.
    return target.mac && wifi.findClientByMac
      ? await wifi.findClientByMac(target.mac)
      : await wifi.findClientByAddress(target.address);
  }

  private async inspectIsolation(target: DeviceNetworkTarget, mac: string | undefined, options: DeviceNetworkInspectionOptions): Promise<DeviceNetworkIsolationStatus> {
    const adapter = this.client();
    let internetBlock: IsolationRuleState = "unavailable";
    let detail: string | undefined;
    if (!adapter.internet) {
      detail = "This network adapter cannot inspect HomeTruth internet blocks";
    } else if (!mac) {
      detail = "The device's MAC is unknown, so its internet block cannot be inspected";
    } else {
      try {
        internetBlock = await adapter.internet.describe({ mac, label: target.id });
      } catch (error) {
        detail = `Could not inspect the internet block: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const dns = await Promise.all((options.dnsOverrides ?? []).map(async ({ domain, overrideIp }) => {
      let state: IsolationRuleState = "unavailable";
      let detail: string | undefined;
      if (!adapter.dns) {
        detail = "This network adapter cannot inspect DNS overrides";
      } else if (!overrideIp) {
        detail = "The HomeTruth DNS override address is unknown";
      } else {
        try {
          state = await adapter.dns.describe({ domain, overrideIp });
        } catch (error) {
          detail = `Could not inspect the DNS override: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      return { domain, ...(overrideIp ? { overrideIp } : {}), state, ...(detail ? { detail } : {}) };
    }));
    const methods: ("internet-block" | "dns-override")[] = [];
    if (internetBlock === "on") methods.push("internet-block");
    if (dns.some(record => record.state === "on")) methods.push("dns-override");
    return {
      scope: "hometruth",
      ...(options.isolationRequested === undefined ? {} : { requested: options.isolationRequested }),
      internetBlock,
      methods,
      dns,
      ...(detail ? { detail } : {}),
    };
  }

  /** Inspect association and HomeTruth isolation rules without changing the network. */
  async inspect(target: DeviceNetworkTarget, options: DeviceNetworkInspectionOptions = {}): Promise<DeviceNetworkStatus> {
    const client = await this.find(target);
    const adapter = this.client().name;
    const label = adapterLabel(adapter);
    // A configured MAC still identifies an offline device's persistent rule.
    const isolation = await this.inspectIsolation(target, target.mac ?? client?.mac, options);
    const isolated = isolation.internetBlock === "unavailable" ? null : isolation.internetBlock === "on";
    if (!client) {
      const identity = target.mac ? `MAC ${target.mac}` : `address ${target.address}`;
      return {
        deviceId: target.id,
        adapter,
        configuredAddress: target.address,
        ...(target.mac ? { configuredMac: target.mac } : {}),
        associated: false,
        isolated,
        isolation,
        message: `${label} does not currently list ${target.name} (${identity}) as an associated Wi-Fi client`,
      };
    }
    const addressMatches = client.address === target.address;
    return {
      deviceId: target.id,
      adapter,
      configuredAddress: target.address,
      ...(target.mac ? { configuredMac: target.mac } : {}),
      associated: true,
      mac: client.mac,
      currentAddress: client.address,
      addressMatches,
      isolated,
      isolation,
      message: addressMatches
        ? `${label} found ${client.mac} at its configured address ${target.address}`
        : `${label} found ${client.mac} at ${client.address}; HomeTruth expects ${target.address}`,
    };
  }

  private async kick(target: DeviceNetworkTarget): Promise<DeviceReconnectResult> {
    const wifi = this.client().wifi;
    if (!wifi) throw new NetworkAdapterError("The configured network adapter cannot reconnect Wi-Fi clients", "not_supported");
    const client: WifiClient | undefined = await this.find(target);
    if (!client) {
      throw new NetworkAdapterError(
        `${target.name} (${target.address}) is not associated with managed Wi-Fi right now`,
        "not_supported",
      );
    }
    await wifi.kickClient(client);
    const message = `Asked the gateway to reconnect ${target.name}; it should renew DHCP for ${target.address}`;
    this.emit({
      event: "device_network_reconnect",
      deviceId: target.id,
      address: target.address,
      currentAddress: client.address,
      mac: client.mac,
    });
    return { deviceId: target.id, address: target.address, mac: client.mac, currentAddress: client.address, message };
  }

  /** Manual recovery. Every explicit call makes one attempt. */
  async reconnect(target: DeviceNetworkTarget): Promise<DeviceReconnectResult> {
    const key = this.key(target);
    const existing = this.inFlight.get(key);
    if (existing) return await existing;
    const operation = this.kick(target).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, operation);
    return await operation;
  }
}
