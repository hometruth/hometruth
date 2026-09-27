import { networkInterfaces } from "node:os";
import {
  MeariLocalCloudEmulator,
  type MeariLocalCloudEvent,
  type MeariLocalCloudFrameDirection,
} from "./cloud-emulator.ts";
import {
  MeariLocalCloudAuthStore,
  createMeariRegistrationAuthorizer,
  type MeariLocalCloudAuthorizationFile,
} from "./local-cloud-auth.ts";
import { MeariLocalCloudStateStore } from "./local-cloud-state.ts";
import { MeariLocalRootDiscoveryServer } from "./root-emulator.ts";
import { MeariLocalTurnServer } from "./turn-server.ts";
import { MeariLocalWebRtcRelayServer } from "./webrtc-relay.ts";

export interface MeariLocalCloudRuntimeOptions {
  readonly authPath?: string;
  readonly statePath?: string;
  readonly host?: string;
  readonly advertisedHost?: string;
  readonly platformPort?: number;
  readonly dataPort?: number;
  readonly wanAddress?: string;
  readonly dnsPort?: number;
  readonly rootPort?: number;
  readonly nestedRootPort?: number;
  readonly turnPort?: number;
  readonly relayPort?: number;
  readonly onEvent?: (event: MeariLocalCloudEvent) => void;
  readonly onFrame?: (direction: MeariLocalCloudFrameDirection, frame: Readonly<Buffer>) => void;
  readonly onRootQuery?: (port: number) => void;
  /**
   * A second, changeable gate on top of the authorization allow-list: a
   * camera whose address it refuses is turned away at registration and by
   * every helper listener, which makes the firmware fall back to the vendor's
   * own domain. Network isolation uses it so a camera that is *not* isolated
   * keeps using the real cloud even while the shared DNS records point here.
   */
  readonly allowSource?: (address: string) => boolean;
}

function ipv4Integer(value: string): number | undefined {
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return undefined;
  }
  return parts.reduce((result, part) => (result * 256 + part) >>> 0, 0);
}

function assertPort(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new RangeError(`${name} must be between 1 and 65535`);
  }
}

/** Select the first non-loopback IPv4 interface sharing a camera subnet. */
export function localAddressForMeariCameras(
  cameraAddresses: readonly string[],
  interfaces = networkInterfaces(),
): string {
  const cameraNumbers = cameraAddresses.flatMap((address) => {
    const parsed = ipv4Integer(address);
    return parsed === undefined ? [] : [parsed];
  });
  if (cameraNumbers.length !== cameraAddresses.length || cameraNumbers.length === 0) {
    throw new Error("Every local camera authorization must contain a valid IPv4 source address");
  }
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const address = ipv4Integer(entry.address);
      const mask = ipv4Integer(entry.netmask);
      if (address === undefined || mask === undefined) continue;
      if (cameraNumbers.some((camera) => (camera & mask) === (address & mask))) return entry.address;
    }
  }
  throw new Error("No local network interface shares the authorized camera subnet");
}

/**
 * Owns the camera-facing discovery and MsgSvr listeners used by the local
 * replacement cloud. The source allow-list and registration proof both come
 * from the permission-restricted bootstrap artifact.
 */
export class MeariLocalCloudRuntime {
  readonly authorization: MeariLocalCloudAuthorizationFile;
  readonly advertisedHost: string;
  readonly cameraAddresses: readonly string[];
  readonly emulator: MeariLocalCloudEmulator;
  readonly roots: readonly MeariLocalRootDiscoveryServer[];
  readonly turn: MeariLocalTurnServer;
  readonly relay: MeariLocalWebRtcRelayServer;
  private readonly stateStore: MeariLocalCloudStateStore;
  private readonly onEvent: ((event: MeariLocalCloudEvent) => void) | undefined;
  private readonly listeners = new Set<(event: MeariLocalCloudEvent) => void>();
  private stateDirty = false;
  private stateSaveTask: Promise<void> | undefined;
  private started = false;
  private sourceGate: (address: string) => boolean = () => true;

  private constructor(
    authorization: MeariLocalCloudAuthorizationFile,
    stateStore: MeariLocalCloudStateStore,
    initialStates: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
    options: MeariLocalCloudRuntimeOptions,
  ) {
    this.authorization = authorization;
    this.stateStore = stateStore;
    this.onEvent = options.onEvent;
    this.cameraAddresses = authorization.devices.map((device) => {
      if (!device.sourceAddress) {
        throw new Error("Every authorized camera must have a source address before exposing the emulator on the LAN");
      }
      return device.sourceAddress;
    });
    this.advertisedHost = options.advertisedHost
      ?? localAddressForMeariCameras(this.cameraAddresses);

    const platformPort = options.platformPort ?? 18_665;
    const dataPort = options.dataPort ?? 18_834;
    const dnsPort = options.dnsPort ?? 18_661;
    const rootPort = options.rootPort ?? 9_253;
    const nestedRootPort = options.nestedRootPort ?? 9_255;
    const turnPort = options.turnPort ?? 9_100;
    const relayPort = options.relayPort ?? 18_837;
    for (const [name, value] of Object.entries({
      platformPort,
      dataPort,
      dnsPort,
      rootPort,
      nestedRootPort,
      turnPort,
      relayPort,
    })) {
      assertPort(name, value);
    }
    if (options.allowSource) this.sourceGate = options.allowSource;
    const allowedSources = new Set(this.cameraAddresses);
    const allowed = (address: string): boolean => allowedSources.has(address) && this.sourceGate(address);
    const authorizeRegistration = createMeariRegistrationAuthorizer(authorization.devices);
    this.emulator = new MeariLocalCloudEmulator({
      host: options.host ?? "0.0.0.0",
      port: platformPort,
      dataPort,
      advertisedHost: this.advertisedHost,
      routedDevicePort: 18_857,
      dnsPort,
      domain: "natsvr.us",
      dataDomain: "datasvr.us",
      ...(options.wanAddress ? { wanAddress: options.wanAddress } : {}),
      authorizeRegistration: (registration) => this.sourceGate(registration.remoteAddress) && authorizeRegistration(registration),
      initialStates,
      bootstrapIotKeys: ["124", "238"],
      ...(options.onFrame ? { onFrame: options.onFrame } : {}),
      onEvent: (event) => {
        if (event.type === "settings") this.queueStateSave();
        this.onEvent?.(event);
        for (const listener of this.listeners) {
          try {
            listener(event);
          } catch {
            // A misbehaving subscriber must not break camera handling.
          }
        }
      },
    });
    this.relay = new MeariLocalWebRtcRelayServer({
      host: options.host ?? "0.0.0.0",
      port: relayPort,
      allowSourceAddress: allowed,
    });
    this.turn = new MeariLocalTurnServer({
      host: options.host ?? "0.0.0.0",
      port: turnPort,
      advertisedHost: this.advertisedHost,
      allowSourceAddress: allowed,
    });
    const rootPorts = [...new Set([rootPort, nestedRootPort, dnsPort])];
    this.roots = rootPorts.map((port) => new MeariLocalRootDiscoveryServer({
      host: options.host ?? "0.0.0.0",
      port,
      advertisedHost: this.advertisedHost,
      signalingPort: platformPort,
      dnsPort,
      nestedDnsPort: nestedRootPort,
      domain: "natsvr.us",
      dnsDomain: "dnssvr.us",
      responseKind: port === rootPort ? "root" : "parent",
      allowSourceAddress: allowed,
      ...(options.onRootQuery ? { onQuery: () => options.onRootQuery?.(port) } : {}),
    }));
  }

  /** Replace the changeable source gate (see `allowSource`). Cameras already connected are not dropped; the next registration is judged. */
  setSourceGate(gate: (address: string) => boolean): void {
    this.sourceGate = gate;
  }

  /** Close the session of a camera at this address, if it has one, so it re-registers and is judged by the gate again. */
  dropSource(address: string): boolean {
    const uuid = this.authorization.devices.find((device) => device.sourceAddress === address)?.uuid;
    return uuid !== undefined && this.emulator.disconnectDevice(uuid);
  }

  /** Observe emulator events (registration, disconnects, settings) without replacing the owner's handler. */
  subscribe(listener: (event: MeariLocalCloudEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  static async create(options: MeariLocalCloudRuntimeOptions = {}): Promise<MeariLocalCloudRuntime> {
    const store = new MeariLocalCloudAuthStore(options.authPath ?? ".hometruth/local-camera-auth.json");
    const authorization = await store.load();
    const stateStore = new MeariLocalCloudStateStore(
      options.statePath ?? ".hometruth/local-camera-state.json",
    );
    const authorizedUuids = new Set(authorization.devices.map((device) => device.uuid));
    const savedStates = await stateStore.load();
    const initialStates = new Map(
      [...savedStates].filter(([uuid]) => authorizedUuids.has(uuid)),
    );
    return new MeariLocalCloudRuntime(authorization, stateStore, initialStates, options);
  }

  private queueStateSave(): void {
    this.stateDirty = true;
    if (this.stateSaveTask) return;
    const task = this.drainStateSaves()
      .catch((error: unknown) => {
        this.onEvent?.({
          type: "persistence-error",
          message: error instanceof Error ? error.message : "Could not persist local camera state",
        });
      })
      .finally(() => {
        if (this.stateSaveTask === task) this.stateSaveTask = undefined;
        if (this.stateDirty) this.queueStateSave();
      });
    this.stateSaveTask = task;
  }

  private async drainStateSaves(): Promise<void> {
    do {
      this.stateDirty = false;
      await this.stateStore.save(this.emulator.states);
    } while (this.stateDirty);
  }

  private async flushState(): Promise<void> {
    if (this.stateDirty) this.queueStateSave();
    while (this.stateSaveTask) await this.stateSaveTask;
  }

  async start(): Promise<void> {
    if (this.started) return;
    try {
      await this.emulator.start();
      await this.turn.start();
      await this.relay.start();
      for (const root of this.roots) await root.start();
      this.started = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    await Promise.allSettled(this.roots.map((root) => root.stop()));
    await this.turn.stop();
    await this.relay.stop();
    await this.emulator.stop();
    await this.flushState();
    this.started = false;
  }
}
