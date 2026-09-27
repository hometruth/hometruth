import { StateEvents } from "./events";
import type { Service, ServiceSnapshot } from "../models/service";
import type { DeviceEventLogs } from "../models/device-event-log";
import type { NetworkAddressClient } from "../network/adapter";
/** Domain configuration and inventory held beside observed values. No UI dependencies. */
import { buildGraph, collectSnapshot } from "../graph/build";
import type { Graph as Topology } from "../graph/graph";
import type { DiscoveredSensor } from "../graph/instance-graph";
import type { MatterBridgeSettings, MatterSettingsSource } from "../integrations/matter/settings";
import { MemoryKindleConfigStore, type KindleConfigStore, type KindleSettings } from "../kindle/store";
import type { SavedSignalCode } from "../schemas";
import type { HomeTruthObject } from "../schemas";
import { SelectedDeviceGroup, type GroupSnapshot } from "../models/device-group";
import type { SensorCollection } from "../models/sensors";
import type { SignalCodeStore } from "../signal-code-store";
import type { Site } from "../site";
import type { TagStore } from "../tags/store";
import type { Graph } from "./graph";
import { isCold } from "./persistence";
import type { Availability } from "../models/capability";
import { deviceNode, parseNode, type NodeRecord } from "./protocol";

export interface StateDataSources {
  readonly site: Site;
  readonly signals: SignalCodeStore;
  readonly kindle: KindleConfigStore;
  readonly tags: TagStore;
  readonly matter?: MatterSettingsSource;
  readonly eventSources?: readonly Service[];
  readonly deviceLogs?: DeviceEventLogs;
  readonly networkClients?: () => Promise<readonly NetworkAddressClient[]>;
}

export class StateData {
  readonly events: StateEvents;
  readonly #services = new Map<string, ServiceSnapshot>();
  readonly #serviceReleases: (() => void)[] = [];
  readonly #dirtyServices = new Set<Service>();
  #networkClients: readonly NetworkAddressClient[] = [];
  #networkEpoch = 0;
  #networkPending: Promise<void> | undefined;
  readonly #signals = new Map<string, readonly SavedSignalCode[]>();
  readonly #sensors = new Map<string, readonly DiscoveredSensor[]>();
  #kindle: KindleSettings = new MemoryKindleConfigStore().snapshot();
  #matter: MatterBridgeSettings | undefined;
  #matterError: string | undefined;
  #topology: Topology | undefined;
  readonly #groups = new Map<string, GroupSnapshot>();
  readonly #releaseObservation: () => void;
  readonly #releaseTags: () => void;
  #devices: Site["devices"] | undefined;
  #tagRevision = -1;
  #pending: Promise<void> | undefined;
  #kindleEpoch = 0;
  readonly #signalEpoch = new Map<string, number>();
  #closed = false;

  /** These adapters publish successful writes before their callers receive the result. */
  readonly signals: SignalCodeStore;
  readonly kindle: KindleConfigStore;

  constructor(readonly sources: StateDataSources, private readonly observations: Graph) {
    this.#releaseTags = sources.tags.onChange(() => this.invalidate());
    this.events = new StateEvents(sources.site, sources.eventSources ?? sources.site.services, sources.deviceLogs);
    this.#releaseObservation = observations.onWrite(record => {
      this.#groups.clear();
      this.observeInventory(record);
    });
    this.syncInventory();
    for (const service of sources.site.services) this.#serviceReleases.push(service.subscribe(() => {
      if (this.#dirtyServices.has(service)) return;
      this.#dirtyServices.add(service);
      queueMicrotask(() => { this.#dirtyServices.delete(service); if (!this.#closed) this.refreshService(service); });
    }));
    this.signals = {
      snapshot: async () => new Map(this.#signals),
      list: async id => this.signalCodes(id),
      add: async (id, input) => { const result = await sources.signals.add(id, input); await this.refreshSignals(id); return result; },
      update: async (id, code, input) => { const result = await sources.signals.update(id, code, input); await this.refreshSignals(id); return result; },
      remove: async (id, code) => { const result = await sources.signals.remove(id, code); await this.refreshSignals(id); return result; },
    };
    this.kindle = {
      load: async () => this.kindleSettings(),
      save: async (config, revision) => {
        const result = await sources.kindle.save(config, revision);
        if (!this.#closed) { this.#kindleEpoch++; this.#kindle = result; this.invalidate(); }
        return result;
      },
    };
    this.topology();
  }

  signalCodes(id: string): readonly SavedSignalCode[] { return this.#signals.get(id) ?? []; }
  record(id: string) { return this.observations.read(deviceNode(id)); }
  device(id: string): HomeTruthObject | undefined {
    const record = this.observations.read(deviceNode(id));
    return record?.value as HomeTruthObject | undefined;
  }
  group(id: string): GroupSnapshot | undefined {
    const { site } = this.sources;
    this.checkConfiguration();
    const cached = this.#groups.get(id);
    if (cached) return cached;
    const group = site.deviceGroups.find(group => group.id === id);
    if (!group) return undefined;
    const members = group.members.flatMap(id => site.get(id) ?? []);
    const documents = new Map<string, HomeTruthObject>();
    const statuses = new Map<string, Availability>();
    for (const device of members) {
      const record = this.record(device.id);
      if (record?.value) documents.set(device.id, record.value as HomeTruthObject);
      if (record?.fault) statuses.set(device.id, "offline");
      else if (isCold(record?.observedAt)) statuses.set(device.id, "unknown");
    }
    const snapshot = new SelectedDeviceGroup(members, Boolean(group.criteria)).snapshot(documents, statuses);
    this.#groups.set(id, snapshot);
    return snapshot;
  }
  kindleSettings(): KindleSettings { return this.#kindle; }
  matterSettings(): { value?: MatterBridgeSettings; error?: string } {
    return { ...(this.#matter ? { value: this.#matter } : {}), ...(this.#matterError ? { error: this.#matterError } : {}) };
  }
  invalidate(): void {
    this.#topology = undefined;
    this.#groups.clear();
    // Coalesce configuration writes. The materialized index is ready before the next request.
    queueMicrotask(() => { if (!this.#closed && !this.#topology) this.topology(); });
  }
  configurationChanged(): void { this.sources.site.invalidateConfiguration(); this.invalidate(); }
  close(): void { this.#closed = true; this.#releaseObservation(); this.#releaseTags(); this.events.close(); for (const release of this.#serviceReleases) release(); }

  /** Explicit refresh/bootstrap only. Reads never invoke this, including on a cache miss. */
  refresh(): Promise<void> {
    return this.#pending ??= this.refreshSources().finally(() => { this.#pending = undefined; });
  }

  service(id: string): ServiceSnapshot | undefined { return this.#services.get(id); }
  services(): readonly ServiceSnapshot[] { return [...this.#services.values()]; }
  refreshService(service: Service): void {
    try {
      this.#services.set(service.id, { id: service.id, title: service.title, health: service.health, status: service.status(), endpoints: [...service.endpoints], actions: service.actions.map(action => ({ id: action.id, ...action.state?.() })) });
    } catch { /* Keep the last successful service observation. */ }
  }

  networkClients(): readonly NetworkAddressClient[] { return this.#networkClients; }
  reserveNetworkAddress(mac: string, address: string): void {
    this.#networkEpoch++;
    this.#networkClients = this.#networkClients.map(client => client.mac === mac ? { ...client, fixedAddress: address } : client);
  }
  refreshNetworkClients(): Promise<void> {
    if (!this.sources.networkClients) return Promise.resolve();
    const epoch = this.#networkEpoch;
    return this.#networkPending ??= Promise.resolve().then(() => this.sources.networkClients!()).then(clients => {
      if (!this.#closed && epoch === this.#networkEpoch) this.#networkClients = clients;
    }, () => { /* Preserve last-known clients; external refresh never holds up startup or rendering. */ }).finally(() => { this.#networkPending = undefined; });
  }

  private async refreshSignals(id: string): Promise<void> {
    const epoch = (this.#signalEpoch.get(id) ?? 0) + 1;
    this.#signalEpoch.set(id, epoch);
    const codes = await this.sources.signals.list(id);
    if (this.#closed || this.#signalEpoch.get(id) !== epoch) return;
    if (JSON.stringify(codes) !== JSON.stringify(this.#signals.get(id))) {
      this.#signals.set(id, codes);
      this.invalidate();
    }
  }

  private async refreshSources(): Promise<void> {
    const { site, kindle, matter } = this.sources;
    this.sources.tags.refresh();
    this.events.refresh();
    for (const service of site.services) this.refreshService(service);
    void this.refreshNetworkClients();
    if (site.refreshServiceMetadata()) this.invalidate();
    const signalEpoch = new Map(this.#signalEpoch);
    const reads = [this.sources.signals.snapshot().then(signals => {
      if (this.#closed) return;
      for (const id of new Set([...this.#signals.keys(), ...signals.keys()])) {
        if (signalEpoch.get(id) !== this.#signalEpoch.get(id)) continue;
        const codes = signals.get(id) ?? [];
        if (JSON.stringify(codes) !== JSON.stringify(this.#signals.get(id))) {
          this.#signals.set(id, codes); this.invalidate();
        }
      }
    })];
    const kindleEpoch = this.#kindleEpoch;
    reads.push(kindle.load().then(settings => {
      if (this.#closed || kindleEpoch !== this.#kindleEpoch) return;
      if (settings.revision !== this.#kindle.revision) { this.#kindle = settings; this.invalidate(); }
    }));
    if (matter) reads.push(matter.read().then(value => {
      if (!this.#closed) { this.#matter = value; this.#matterError = undefined; }
    }, error => {
      if (!this.#closed) this.#matterError = error instanceof Error ? error.message : String(error);
    }));
    const results = await Promise.allSettled(reads);
    for (const result of results) if (result.status === "rejected") {
      console.warn(JSON.stringify({ event: "state_data_refresh_failed", detail: String(result.reason) }));
    }
  }

  private observeInventory(record: NodeRecord): void {
    const parsed = parseNode(record.node);
    if (parsed?.kind !== "device") return;
    const device = this.sources.site.get(parsed.id);
    if (!device || device.sensors.length) return;
    const value = record.value as { capabilities?: { sensor?: { state?: { sensors?: DiscoveredSensor[] } } } } | undefined;
    const known = value?.capabilities?.sensor?.state?.sensors;
    if (!known?.length) return; // Identity survives an offline reading.
    const sensors = known.map(({ id, name }) => ({ id, name }));
    if (JSON.stringify(sensors) !== JSON.stringify(this.#sensors.get(device.id))) {
      this.#sensors.set(device.id, sensors);
      this.invalidate();
    }
  }

  private syncInventory(): void {
    const ids = new Set(this.sources.site.devices.map(device => device.id));
    for (const id of this.#sensors.keys()) if (!ids.has(id)) this.#sensors.delete(id);
    for (const device of this.sources.site.devices) {
      const known = (device.capabilities.sensor as SensorCollection | undefined)?.inventory;
      if (!device.sensors.length && known?.length) this.#sensors.set(device.id, known.map(({ id, name }) => ({ id, name })));
      const record = this.record(device.id);
      if (record) this.observeInventory(record);
    }
  }

  private checkConfiguration(): void {
    const { site, tags } = this.sources;
    if (this.#devices === site.devices && this.#tagRevision === tags.revision) return;
    const changedDevices = this.#devices !== site.devices;
    this.#devices = site.devices;
    this.#tagRevision = tags.revision;
    if (changedDevices) this.syncInventory();
    this.invalidate();
  }

  /** Constant-time read of the domain index. Sensor discovery updates it at publication. */
  topology(): Topology {
    this.checkConfiguration();
    const { site, tags } = this.sources;
    return this.#topology ??= buildGraph(collectSnapshot({
      site, signals: this.#signals, kindle: this.#kindle.config, tags, discoveredSensors: this.#sensors,
    }));
  }
}
