import type { HealthCheck } from "./health/model";
import { automaticGroupMembers, resolveDeviceGroups, type GroupTagSource } from "./models/automatic-group";
import { elementKey } from "./tags/identity";
import type { AutomaticGroupCriteria } from "./schemas";
import { StringLight } from "./models/string-light";
/**
 * The site: the models HomeTruth knows and the devices this installation has
 * provisioned from them. One per process; everything that serves a page or
 * an API route looks devices up here.
 */
import { provisionSite, type ResolvedReference } from "./config/provision";
import { secretsFor } from "./config/secrets";
import type { Device, DeviceModel, SiteServices } from "./models/device";
import type { DeviceConnectionType } from "./models/device-connection";
import type { CapabilityKind } from "./models/capability";
import type { SensorDefinition } from "./models/sensor";
import type { ServiceEvent } from "./models/event-log";
import { Service } from "./models/service";
import { MODELS } from "./registry";
import type { DeviceGroup, DeviceGroupConfig, DeviceListResponse, DevicesConfig, HomeTruthObject, ModelListResponse, SecretsFile } from "./schemas";
import { describeValidationErrors, validators } from "./validation";
import { PageDirectory, type ElementLink, type GroupView } from "./page-urls";

/** One running service as the services list and its own page see it. */
export interface RegisteredService {
  readonly health: HealthCheck;
  readonly id: string;
  readonly title: string;
  readonly availability: "online" | "offline" | "degraded" | "unknown";
  readonly detail: string;
  readonly page: string;
  /**
   * The momentary actions it declares, with whatever each has standing right
   * now. Declared once on the model and published here, so the API route, the
   * page and the CLI all read the same list rather than three hand-written
   * copies; a client that has never heard of this service can still offer it.
   */
  readonly actions: readonly { readonly id: string; readonly until?: string }[];
  /** What it is joined to now: `in` clients that reached it, `out` upstreams it reaches. */
  readonly endpoints: readonly { readonly direction: "in" | "out"; readonly label: string; readonly detail?: string; readonly href?: string; readonly active?: boolean }[];
}

export function servicePagePath(id: string): string {
  return `/services/${encodeURIComponent(id)}`;
}

export function registeredServiceView(service: Service): RegisteredService {
  const status = service.status();
  const actions = service.actions.map((action) => {
    const until = action.state?.().until;
    return { id: action.id, ...(until ? { until } : {}) };
  });
  const endpoints = service.endpoints.map((endpoint) => ({
    direction: endpoint.direction, label: endpoint.label,
    ...(endpoint.detail ? { detail: endpoint.detail } : {}),
    ...(endpoint.href ? { href: endpoint.href } : {}),
    ...(endpoint.active !== undefined ? { active: endpoint.active } : {}),
  }));
  return { id: service.id, title: service.title, health: service.health, availability: status.availability, detail: status.detail, page: servicePagePath(service.id), actions, endpoints };
}

/**
 * Every `Service` instance in a `SiteServices` bag: values that are
 * themselves a `Service` (the MQTT broker), and, one level deep, arrays of
 * them (TKENPRO's per-camera link services). A vendor-only helper that is
 * neither (TKENPRO's camera control link) is not a `Service` and is skipped.
 */
function servicesOf(services: SiteServices): readonly Service[] {
  return Object.values(services).flatMap((value) => {
    if (value instanceof Service) return [value];
    if (Array.isArray(value)) return value.filter((entry): entry is Service => entry instanceof Service);
    return [];
  });
}

/** The page templates still key on this while the per-capability renderers land (phase 4). */
export type DeviceKind = "device" | "binary-switch" | "pet-camera" | "camera" | "light" | "string-light" | "ir-rf-blaster" | "rf-receiver" | "speaker" | "speaker-group" | "television" | "button" | "sensor" | "hub";

/** One provisioned device as the pages and the device list see it, independent of any live connection. */
export interface RegisteredDevice {
  readonly parent?: { readonly id: string; readonly index: number };
  readonly relationships?: readonly ElementLink[];
  readonly groupPage?: string;
  readonly room?: string;
  readonly id: string;
  readonly name: string;
  readonly kind: DeviceKind;
  readonly model: string;
  readonly modelTitle: string;
  readonly capabilities: CapabilityKind[];
  /** Declared paths HomeTruth can use to reach this device. */
  readonly connectionTypes?: DeviceConnectionType[];
  readonly sensors?: SensorDefinition[];
  readonly host: string;
  /** The page that renders full controls for this device. */
  readonly page: string;
  /** The object schema the device describes itself with. */
  readonly schemaId: string;
  /** When set, this device is shown grouped with every other device sharing the same label (e.g. a Sonos stereo pair or home theater set) rather than as its own top-level card. */
  readonly groupLabel?: string;
  /** False when the device is kept in the inventory but switched off: no controls, no background polling. */
  readonly enabled: boolean;
}

export type DeviceSummary = DeviceListResponse["devices"][number];

const SUMMARY_TIMEOUT_MS = 3_000;

export function devicePagePath(id: string): string {
  return `/devices/${encodeURIComponent(id)}`;
}

/** Which page template a model's capabilities call for. */
export function deviceKindOf(model: DeviceModel): DeviceKind {
  if (model.capabilities.includes("cooktop")) return "device";
  if (model.capabilities.includes("camera")) return model.capabilities.includes("treatDispenser") ? "pet-camera" : "camera";
  if (model.capabilities.includes("stringLight")) return "string-light";
  if (model.capabilities.includes("light")) return "light";
  if (model.capabilities.includes("infraredBlaster") || model.capabilities.includes("radioFrequencyBlaster")) return "ir-rf-blaster";
  if (model.capabilities.includes("radioFrequencyReceiver")) return "rf-receiver";
  if (model.capabilities.includes("television")) return "television";
  if (model.capabilities.includes("speaker")) return model.id === "sonos-group" ? "speaker-group" : "speaker";
  if (model.capabilities.includes("button")) return "button";
  if (model.capabilities.includes("sensor") || model.capabilities.includes("occupancySensor") || model.capabilities.includes("contactSensor")) return "sensor";
  if (model.capabilities.includes("hub")) return "hub";
  if (model.sensors?.length) return "device";
  return "binary-switch";
}

function hostOf(device: Device): string {
  const displayHost = device.displayHost?.();
  if (displayHost) return displayHost;
  const host = (device.config as { host?: unknown } | undefined)?.host;
  return typeof host === "string" ? host : "";
}

function groupLabelOf(device: Device): string | undefined {
  const group = (device.config as { group?: unknown } | undefined)?.group;
  return typeof group === "string" && group.trim() ? group : undefined;
}

export function registeredView(device: Device): RegisteredDevice & { readonly connectionTypes: DeviceConnectionType[] } {
  const groupLabel = groupLabelOf(device);
  return {
    id: device.id,
    name: device.name,
    ...(device.parent ? { parent: device.parent } : {}),
    ...(device.room ? { room: device.room } : {}),
    kind: deviceKindOf(device.model),
    model: device.model.id,
    modelTitle: device.model.title,
    capabilities: [...device.model.capabilities],
    connectionTypes: [...device.model.connectionTypes],
    ...(device.sensors.length ? { sensors: device.sensors.map(({ id, name, schemaId }) => ({ id, name, schemaId })) } : {}),
    host: hostOf(device),
    page: devicePagePath(device.id),
    schemaId: device.model.objectSchemaId,
    ...(groupLabel ? { groupLabel } : {}),
    enabled: device.enabled,
  };
}

/** One line of status for the home page, from the device's own document. */
export function summaryDetail(object: HomeTruthObject): string | undefined {
  const { capabilities } = object;
  if (capabilities.binarySwitch) {
    const value = capabilities.binarySwitch.state?.value;
    return value ? (value === "on" ? "On" : "Off") : "Not reachable";
  }
  if (capabilities.stringLight) {
    const state = capabilities.stringLight.state;
    return `${state.lightCount} lights · ${state.on === undefined ? "Unknown" : state.on ? "On" : "Off"}`;
  }
  if (capabilities.light) {
    const state = capabilities.light.state;
    if (state?.on === undefined) return "Not reachable";
    return state.on ? `On · ${state.brightnessPercent ?? "?"}% · ${state.colorTemperatureKelvin ?? "?"}K` : "Off";
  }
  if (capabilities.camera) {
    if (object.status === "offline") return capabilities.treatDispenser ? "Not discovered yet" : "Not reachable";
    return [object.model, object.firmwareVersion ? `firmware ${object.firmwareVersion}` : undefined].filter(Boolean).join(", ") || "Discovered";
  }
  if (capabilities.infraredBlaster || capabilities.radioFrequencyBlaster) {
    return object.status === "online" ? "Ready" : "Not reachable";
  }
  if (capabilities.radioFrequencyReceiver) {
    const state = capabilities.radioFrequencyReceiver.state;
    return state.availability === "offline" ? "Not reachable" : "Ready to listen";
  }
  if (capabilities.speaker) {
    const state = capabilities.speaker.state;
    if (state?.playback === undefined) return "Not reachable";
    if (state.group && state.group.isCoordinator === false) return `Bonded to ${state.group.coordinatorHost}`;
    return `${state.playback[0]?.toUpperCase()}${state.playback.slice(1)} · ${state.volumePercent ?? "?"}%`;
  }
  if (capabilities.button) return "Ready to press";
  if (object.sensors?.length) {
    const readings = object.sensors.filter(sensor => sensor.state.availability === "online" && sensor.state.value !== undefined);
    const preview = readings.slice(0, 3).map(sensor => `${sensor.name} ${Math.round(sensor.state.value! * 10) / 10} ${sensor.unit}`).join(" · ");
    return preview ? `${preview}${object.status === "degraded" ? " · Some readings unavailable" : ""}`
      : object.sensors.find(sensor => sensor.state.detail)?.state.detail ?? "Reading unavailable";
  }
  const sensor = capabilities.sensor?.state;
  if (sensor) {
    if (sensor.availability === "offline") return sensor.detail ?? "Not reachable";
    const readings = sensor.sensors.filter((reading) => reading.availability === "online" && reading.value !== undefined);
    const preview = readings.slice(0, 3).map((reading) => `${reading.name} ${Math.round(reading.value! * 10) / 10} ${reading.unit}`).join(" · ");
    return preview ? `${preview}${sensor.availability === "degraded" ? " · Some readings unavailable" : ""}` : sensor.detail ?? "Reading unavailable";
  }
  const occupancy = capabilities.occupancySensor?.state;
  if (occupancy) return occupancy.detail ?? (occupancy.occupied === undefined ? "Reading unavailable" : occupancy.occupied ? "Occupied" : "Clear");
  const contact = capabilities.contactSensor?.state;
  if (contact) return contact.detail ?? (contact.open === undefined ? "Reading unavailable" : `${contact.open ? "Open" : "Closed"}${contact.batteryPercent === undefined ? "" : ` · Battery ${contact.batteryPercent}%`}`);
  const hub = capabilities.hub?.state;
  if (hub) return hub.detail ?? `${hub.accessories?.length ?? 0} bridged accessories`;
  return undefined;
}

export class Site {
  #tagSource: GroupTagSource | undefined;
  #groups: { revision: number; value: DeviceGroup[] } | undefined;
  #references: readonly ResolvedReference[] | undefined;
  readonly #directories = new WeakMap<readonly DeviceGroup[], PageDirectory>();
  readonly #serviceMetadata = new Map<string, { subjects: readonly string[]; detectionLabels: readonly string[] }>();

  /** Domain inventory refresh. Page projections only read the cached result. */
  refreshServiceMetadata(): boolean {
    let changed = false;
    for (const service of this.services) {
      try {
        const next = { subjects: service.subjects(), detectionLabels: service.detectionLabels() };
        if (JSON.stringify(next) !== JSON.stringify(this.#serviceMetadata.get(service.id))) {
          this.#serviceMetadata.set(service.id, next); changed = true;
        }
      }
      catch { /* Keep the last known inventory if a service cannot refresh. */ }
    }
    return changed;
  }
  serviceSubjects(id: string): readonly string[] { return this.#serviceMetadata.get(id)?.subjects ?? []; }
  serviceDetectionLabels(id: string): readonly string[] { return this.#serviceMetadata.get(id)?.detectionLabels ?? []; }

  get tagSource(): GroupTagSource | undefined { return this.#tagSource; }
  /** Shared metadata is read on demand so tag edits immediately affect every group consumer. */
  setTagSource(source: GroupTagSource | undefined): void { this.#tagSource = source; this.invalidateConfiguration(); }
  /** Configuration writers call this after changing an existing Site in place. */
  invalidateConfiguration(): void { this.#groups = undefined; this.#references = undefined; }

  /**
   * Every room. The ontology owns this once a tag store is attached; the
   * `room:` strings still in `devices.yml` are the fallback, which is
   * what makes an install with no database yet — and every test that builds a
   * bare `Site` — behave as it always did.
   */
  get rooms(): readonly string[] {
    const fromTags = this.#tagSource?.rooms?.();
    return fromTags && fromTags.length ? fromTags : this.configuredRooms;
  }

  /** The room a device or group is in, by its element key. */
  roomOf(elementKey: string, configured?: string): string | undefined {
    return this.#tagSource?.roomOf?.(elementKey) ?? configured;
  }

  /**
   * A device's view with its room taken from the ontology. Everything that
   * shows a room goes through this, so the tag is what the UI displays while
   * the `room:` still in the YAML stays a fallback rather than the truth.
   */
  deviceView(device: Device): RegisteredDevice & { readonly connectionTypes: DeviceConnectionType[] } {
    const base = registeredView(device);
    const room = this.roomOf(elementKey("device", device.id), base.room);
    return room ? { ...base, room } : (({ room: _room, ...rest }) => rest)(base) as typeof base;
  }
  automaticGroupMembers(criteria: AutomaticGroupCriteria): string[] {
    return automaticGroupMembers(this.devices, criteria, this.#tagSource?.assignments(), this.deviceReferences);
  }
  /** Rooms as configuration declared them, before the ontology is attached. */
  readonly configuredRooms: readonly string[];
  readonly models: readonly DeviceModel[];
  readonly devices: readonly Device[];
  readonly services: readonly Service[];
  readonly #secretKeys: ReadonlyMap<string, readonly string[]>;
  readonly #macAddresses: ReadonlyMap<string, string>;

  constructor(
    devices: readonly Device[],
    models: readonly DeviceModel[] = MODELS,
    secretKeys: ReadonlyMap<string, readonly string[]> = new Map(),
    services: readonly Service[] = [],
    macAddresses: ReadonlyMap<string, string> = new Map(),
    rooms: readonly string[] = [],
    readonly configuredGroups: readonly DeviceGroupConfig[] = [],
    /** Device-to-device references, as provisioning recorded them being resolved. */
    readonly references: readonly ResolvedReference[] = [],
  ) {
    const ids = new Set<string>();
    for (const device of devices) {
      if (ids.has(device.id)) throw new Error(`Device id "${device.id}" is defined more than once`);
      ids.add(device.id);
    }
    this.configuredRooms = Object.freeze([...new Set([...rooms, ...configuredGroups.flatMap(group => group.criteria?.room ? [group.criteria.room] : []), ...[...devices, ...configuredGroups].flatMap((device) => device.room ? [device.room] : [])])].sort((a, b) => a.localeCompare(b)));
    this.devices = Object.freeze([...devices]);
    this.models = models;
    this.#secretKeys = secretKeys;
    this.#macAddresses = macAddresses;
    this.services = Object.freeze([...services]);
    this.refreshServiceMetadata();
  }

  /** The top-level secret keys a device has in the secrets file; presence only, never values. */
  secretKeysOf(id: string): readonly string[] {
    return this.#secretKeys.get(id) ?? [];
  }

  /** Configured stable LAN identity, normalized for gateway lookups. */
  macAddressOf(id: string): string | undefined {
    return this.#macAddresses.get(id);
  }

  static empty(): Site {
    return new Site([]);
  }

  /** Provision every configured device from the registry's models. */
  static fromConfig(config: DevicesConfig, services: SiteServices = {}, secrets?: SecretsFile, models: readonly DeviceModel[] = MODELS): Site {
    const secretKeys = new Map<string, readonly string[]>();
    const macAddresses = new Map<string, string>();
    for (const entry of config.devices ?? []) {
      if (secrets) secretKeys.set(entry.id, Object.keys(secretsFor(secrets, "devices", entry.id)).sort());
      if (entry.mac) macAddresses.set(entry.id, entry.mac.toLowerCase());
    }
    const { devices, references } = provisionSite(config, models, services, secrets);
    return new Site(devices, models, secretKeys, servicesOf(services), macAddresses, config.rooms, config.deviceGroups, references);
  }

  getService(id: string): Service | undefined {
    return this.services.find((service) => service.id === id);
  }

  listServices(): readonly RegisteredService[] {
    const pages = this.pages();
    return this.services.map(service => ({ ...registeredServiceView(service), page: pages.page("service", service.id)! }));
  }

  serviceEvents(id: string, limit?: number): readonly ServiceEvent[] | undefined {
    return this.getService(id)?.events(limit);
  }

  get(id: string): Device | undefined {
    return this.devices.find((device) => device.id === id);
  }

  /** The device, narrowed to one class, or undefined when it is not one. */
  as<T extends Device>(id: string, type: abstract new (...args: never[]) => T): T | undefined {
    const device = this.get(id);
    return device instanceof type ? device : undefined;
  }

  list(): readonly RegisteredDevice[] {
    const groups = this.deviceGroups;
    const pages = this.pages(groups);
    return this.devices.map(device => this.registered(device, pages, groups));
  }

  view(id: string): RegisteredDevice | undefined {
    const device = this.get(id);
    const groups = this.deviceGroups;
    return device ? this.registered(device, this.pages(groups), groups) : undefined;
  }

  get deviceGroups(): DeviceGroup[] {
    const revision = this.#tagSource?.revision ?? 0;
    if (!this.#groups || this.#groups.revision !== revision) this.#groups = { revision, value: resolveDeviceGroups(this.devices, this.configuredGroups, this.#tagSource?.assignments(), this.deviceReferences) };
    return this.#groups.value;
  }

  /**
   * Every device-to-device reference in this site: the ones provisioning
   * recorded as composites resolved their siblings, plus the one relationship
   * it cannot record. A Sonos group names no ids at all — its members are
   * whichever devices share its `group` label — so that is derived here.
   *
   * This is the single source for "what changes when this device does", read
   * by the graph and by the observer's invalidation.
   */
  get deviceReferences(): readonly ResolvedReference[] {
    if (this.#references) return this.#references;
    const labelled: ResolvedReference[] = [];
    for (const device of this.devices) {
      if (device.model.id !== "sonos-group") continue;
      const label = registeredView(device).groupLabel;
      if (!label) continue;
      for (const member of this.devices) {
        if (member.id !== device.id && registeredView(member).groupLabel === label) {
          labelled.push({ from: device.id, to: member.id, relation: "members" });
        }
      }
    }
    return this.#references = labelled.length ? [...this.references, ...labelled] : this.references;
  }

  pages(groups: readonly DeviceGroup[] = this.deviceGroups): PageDirectory {
    let directory = this.#directories.get(groups);
    if (!directory) { directory = new PageDirectory(this.devices.map(device => this.deviceView(device)), groups, this.services); this.#directories.set(groups, directory); }
    return directory;
  }

  listGroups(): GroupView[] {
    const groups = this.deviceGroups;
    const pages = this.pages(groups);
    return groups.map(group => ({ ...group, page: pages.page("group", group.id)!, switchPage: pages.page("group-switch", group.id) ?? "" }));
  }

  private registered(device: Device, pages: PageDirectory, groups: readonly DeviceGroup[]): RegisteredDevice {
    const view = this.deviceView(device);
    const relationships: ElementLink[] = [];
    const add = (source: "device" | "group" | "group-switch" | "speaker-group" | "service", id: string, name: string, relation: ElementLink["relation"]) => {
      const page = pages.page(source, id); if (page && !relationships.some(link => link.page === page && link.relation === relation)) relationships.push({ id, name, page, relation });
    };
    if (device.parent) add("device", device.parent.id, this.get(device.parent.id)?.name ?? device.parent.id, "partOf");
    if (device instanceof StringLight) for (const light of device.lights) add("device", light.id, light.name, "contains");
    for (const group of groups) if (group.members.includes(device.id)) {
      add("group", group.id, group.name, "memberOf");
      if (group.asSwitch) add("group-switch", group.id, group.name, "groupSwitch");
    }
    if (view.groupLabel) add("speaker-group", view.groupLabel, view.groupLabel, "memberOf");
    // Device-to-device edges come from what provisioning actually resolved
    // (`DeviceCreationContext.device`), not from re-parsing config by model id.
    // A composite cannot obtain a sibling without going through that call, so
    // there is nothing here to keep in step with a new model.
    for (const reference of this.deviceReferences) {
      if (reference.from === device.id) add("device", reference.to, this.get(reference.to)?.name ?? reference.to, reference.relation);
      if (reference.to === device.id) add("device", reference.from, this.get(reference.from)?.name ?? reference.from, "usedBy");
    }
    for (const service of this.services) if (this.serviceSubjects(service.id).includes(device.id)) add("service", service.id, service.title, "services");
    return { ...view, page: pages.page("device", device.id)!, relationships, ...(view.groupLabel ? { groupPage: pages.page("speaker-group", view.groupLabel)! } : {}) };
  }

  /** Every device of one model. */
  ofModel<T extends Device>(type: abstract new (...args: never[]) => T): T[] {
    return this.devices.filter((device): device is T => device instanceof type);
  }

  modelList(): ModelListResponse {
    const body: ModelListResponse = {
      models: this.models.map((model) => ({
        id: model.id,
        title: model.title,
        manufacturer: model.manufacturer,
        product: model.product,
        capabilities: [...model.capabilities],
        connectionTypes: [...model.connectionTypes],
        ...(model.sensors ? { sensors: [...model.sensors] } : {}),
        configSchema: model.configSchema as Record<string, unknown>,
        ...(model.secretsSchema ? { secretsSchema: model.secretsSchema as Record<string, unknown> } : {}),
        objectSchemaId: model.objectSchemaId,
      })),
    };
    if (!validators.modelListResponse(body)) {
      throw new Error(`Invalid model list: ${describeValidationErrors(validators.modelListResponse.errors)}`);
    }
    return body;
  }

  /**
   * Summaries for the home page, each device's own status bounded to a few
   * seconds. The server may supply a reader that adds one-shot network
   * recovery around the same device document.
   */
  async summaries(describe?: (device: Device) => Promise<HomeTruthObject>): Promise<DeviceListResponse> {
    const pages = this.pages();
    const devices = await Promise.all(this.devices.map(async (device): Promise<DeviceSummary> => {
      const base = { ...this.deviceView(device), page: pages.page("device", device.id)! };
      if (!device.enabled) return { ...base, availability: "offline", detail: "Disabled" };
      try {
        const object = describe
          ? await describe(device)
          : await Promise.race([
            device.describe(),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), SUMMARY_TIMEOUT_MS)),
          ]);
        const detail = summaryDetail(object);
        return { ...base, availability: object.status ?? "unknown", ...(detail ? { detail } : {}) };
      } catch {
        return { ...base, availability: "offline", detail: "Not reachable" };
      }
    }));
    const body: DeviceListResponse = { devices, generatedAt: new Date().toISOString() };
    if (!validators.deviceListResponse(body)) {
      throw new Error(`Invalid device list: ${describeValidationErrors(validators.deviceListResponse.errors)}`);
    }
    return body;
  }
}
