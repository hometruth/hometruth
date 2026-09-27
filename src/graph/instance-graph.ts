/**
 * The instance graph: configured elements and their relationships.
 * Nodes include the site, catalogs, devices, capabilities, groups and services.
 * Edges describe containment, membership, references and schema membership.
 * Building is pure and synchronous: all I/O-dependent information arrives in
 * the snapshot so graph construction does not wait on a device or bridge.
 */
import { DogAnnouncer } from "../automations/dog-announcer";
import type { KindleConfig } from "../kindle/config";
import type { CapabilityKind } from "../models/capability";
import type { Device } from "../models/device";
import type { DeviceGroup } from "../schemas";
import { StringLight, StringLightControl } from "../models/string-light";
import type { PageDirectory, PageSource } from "../page-urls";
import { registeredView, type Site } from "../site";
import { elementKey } from "../tags/identity";
import { STATE_HUB_SERVICE_ID } from "../state/service";
import { iconFor, parseIcon } from "./icons";
import { propertyPaths, modelNode, propertyDefNode, schemaIdForCapability, schemaNode } from "./schema-graph";
import { schemaCatalogEntries } from "../schema-catalog";
import type { TagSnapshot } from "./tag-graph";
import type { GraphEdge, GraphNode, Icon, NodeId, Relation } from "./types";

export interface DiscoveredSensor { readonly id: string; readonly name: string }
export interface SavedSignal { readonly id: string; readonly name: string }

/**
 * One device-to-device reference, as the composite that made it described it.
 * Provisioning records these when `DeviceCreationContext.device()` resolves
 * a reference; the site also supplies relationships derived across devices.
 */
export interface RecordedReference {
  readonly from: string;
  readonly to: string;
  readonly relation: Relation;
  readonly label?: string;
  readonly capability?: CapabilityKind;
}

export interface InstanceSnapshot {
  readonly site: Site;
  readonly groups: readonly DeviceGroup[];
  readonly pages: PageDirectory;
  readonly references: readonly RecordedReference[];
  readonly discoveredSensors: ReadonlyMap<string, readonly DiscoveredSensor[]>;
  readonly signals: ReadonlyMap<string, readonly SavedSignal[]>;
  readonly kindle?: KindleConfig;
  /** Per-instance icon overrides, by element key. */
  readonly icons?: ReadonlyMap<NodeId, Icon>;
  /** The tag ontology, when the caller has a store to read it from. */
  readonly tags?: TagSnapshot;
  readonly siteTitle?: string;
}

export const siteNode = (): NodeId => elementKey("site");
export const catalogNode = (id: string): NodeId => elementKey("catalog", id);
export const deviceElement = (id: string): NodeId => elementKey("device", id);

/**
 * The families that hang off the root, in navigation order.
 *
 * `page` is only set where an index page actually exists. HomeTruth has no
 * `/devices`, `/rooms`, or `/models` index today: devices are listed on the
 * home page, which is the root itself, and rooms and models have no index at
 * all. Those catalogs are still real nodes because they are real groupings —
 * a node with no page simply is not a link. The gap is worth filling later,
 * and the graph is what makes it visible.
 */
export const CATALOGS: readonly { readonly id: string; readonly name: string; readonly page: string; readonly kinds: readonly string[] }[] = [
  { id: "devices", name: "Devices", page: "", kinds: ["device"] },
  { id: "rooms", name: "Rooms", page: "", kinds: ["room"] },
  { id: "groups", name: "Groups", page: "/groups", kinds: ["group", "speaker-group"] },
  { id: "switches", name: "Switches", page: "/switches", kinds: ["group-switch"] },
  { id: "services", name: "Services", page: "/services", kinds: ["service"] },
  { id: "automations", name: "Automations", page: "/automations", kinds: ["automation"] },
  { id: "dashboards", name: "Dashboards", page: "/kindle/designer", kinds: ["dashboard"] },
  { id: "models", name: "Models", page: "", kinds: ["model"] },
  { id: "schemas", name: "Schemas", page: "/schemas", kinds: ["schema"] },
  { id: "events", name: "Event types", page: "", kinds: ["event-type"] },
  { id: "tags", name: "Tags", page: "/tags", kinds: ["tag-name"] },
];

/**
 * Relations that make one node a parent of another, and so give every node a
 * path back to the root. `contains` is the instance side's spine; `defines` is
 * the schema side's, because a capability schema is where its controls and
 * state properties come from; `declares` is the tag side's, because a tag value
 * comes from the name that declares it.
 */
export const HIERARCHY: ReadonlySet<string> = new Set(["contains", "defines", "declares"]);

/**
 * A device's icon, most specific first: the entry's own `icon:`, then the
 * model's, then the dominant capability's, then the kind's.
 */
function deviceIcon(device: Device): Icon {
  const override = parseIcon(device.icon);
  const modelIcon = parseIcon(device.model.icon);
  return iconFor({
    kind: "device",
    capabilities: device.model.capabilities,
    ...(override ? { override } : {}),
    ...(modelIcon ? { modelIcon } : {}),
  });
}

/** Which capabilities a model declares, which is what `describe()` reports. */
function declaredCapabilities(device: Device): readonly CapabilityKind[] {
  return device.model.capabilities;
}

export function buildInstanceGraph(snapshot: InstanceSnapshot): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const { site, groups, pages, references } = snapshot;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const overrides = snapshot.icons ?? new Map<NodeId, Icon>();

  const add = (node: Omit<GraphNode, "side" | "icon"> & { icon?: Icon }): NodeId => {
    nodes.push({
      ...node,
      side: "instance",
      icon: node.icon ?? overrides.get(node.id) ?? iconFor({ kind: node.kind }),
    });
    return node.id;
  };
  const link = (from: NodeId, to: NodeId, relation: Relation, origin: GraphEdge["origin"], label?: string) => {
    edges.push({ from, to, relation, origin, ...(label ? { label } : {}) });
  };

  const root = siteNode();
  add({ id: root, kind: "site", name: snapshot.siteTitle ?? "HomeTruth", context: "", page: "/", ids: [root] });

  const catalogFor = new Map<string, NodeId>();
  for (const catalog of CATALOGS) {
    const id = catalogNode(catalog.id);
    add({ id, kind: "catalog", name: catalog.name, context: "", page: catalog.page, ids: [catalog.id] });
    link(root, id, "contains", "structure");
    for (const kind of catalog.kinds) catalogFor.set(kind, id);
  }
  const fileUnder = (id: NodeId, kind: string) => {
    const catalog = catalogFor.get(kind);
    if (catalog) link(catalog, id, "contains", "structure");
  };

  // Top-level entries: devices, groups, group switches, speaker groups, services.
  for (const entry of pages.entries) {
    const id = elementKey(entry.source, entry.id);
    const device = entry.source === "device" ? site.get(entry.id) : undefined;
    add({
      id, kind: entry.source, name: entry.name, context: "", page: entry.page,
      ids: [entry.id],
      icon: overrides.get(id) ?? (device ? deviceIcon(device) : iconFor({ kind: entry.source })),
      ...(device ? { schema: modelNode(device.model.id), stateNode: `device/${entry.id}` } : {}),
      ...(entry.source === "group-switch" ? { stateNode: `group/${entry.id}` } : {}),
    });
    fileUnder(id, entry.source);
  }

  // A group switch is the same group, exposed as a switch.
  for (const group of groups) {
    const groupId = elementKey("group", group.id);
    if (group.asSwitch) link(elementKey("group-switch", group.id), groupId, "groupSwitch", "site");
    for (const member of group.members) {
      const memberId = deviceElement(member);
      if (site.get(member)) link(groupId, memberId, "members", "site");
    }
  }

  // Rooms are not instance nodes any more: a room is the tag `room = <name>`,
  // and `buildTagGraph` owns it. The `locatedIn` edges below are gone with
  // them — a device's room reaches it as a `tagged` edge from the tag side.

  for (const device of site.devices) {
    const deviceId = deviceElement(device.id);
    const page = pages.page("device", device.id) ?? "";
    const view = site.deviceView(device);

    if (device.parent) link(deviceElement(device.parent.id), deviceId, "contains", "structure", `#${device.parent.index}`);
    if (device instanceof StringLight) {
      for (const light of device.lights) link(deviceId, deviceElement(light.id), "contains", "structure");
    }
    if (view.groupLabel) {
      const label = elementKey("speaker-group", view.groupLabel);
      link(label, deviceId, "members", "site");
    }

    for (const kind of declaredCapabilities(device)) {
      const capability = device.capabilities[kind];
      if (!capability) continue;
      const capabilityId = elementKey("capability", device.id, kind);
      const capabilitySchema = schemaIdForCapability(kind);
      add({
        id: capabilityId, kind: "capability", name: kind, context: device.name, page,
        ids: [device.id, kind], icon: overrides.get(capabilityId) ?? iconFor({ kind: "capability", capabilities: [kind] }),
        ...(capabilitySchema ? { schema: schemaNode(capabilitySchema) } : {}),
      });
      link(deviceId, capabilityId, "contains", "structure");

      for (const control of capability.controlIds) {
        const controlId = elementKey("control", device.id, kind, control);
        add({ id: controlId, kind: "control", name: control, context: `${device.name} · ${kind}`, page, ids: [device.id, kind, control] });
        link(capabilityId, controlId, "contains", "structure");
      }
      if (capabilitySchema) {
        for (const path of statePathsOf(capabilitySchema)) {
          const propertyId = elementKey("property", device.id, kind, path);
          add({
            id: propertyId, kind: "property", name: path, context: `${device.name} · ${kind}`, page,
            ids: [device.id, kind, path], schema: propertyDefNode(capabilitySchema, path),
          });
          link(capabilityId, propertyId, "contains", "structure");
        }
      }

      if (capability instanceof StringLightControl) {
        for (const [kindName, entries] of [["scene", capability.getScenes()], ["show", capability.getShows()], ["preset", capability.getPresets()]] as const) {
          for (const entry of entries) {
            const id = elementKey(kindName, device.id, entry.id);
            add({ id, kind: kindName, name: entry.name, context: device.name, page, ids: [device.id, entry.id] });
            link(capabilityId, id, "contains", "structure");
          }
        }
      }
    }

    for (const sensor of [...device.sensors, ...(snapshot.discoveredSensors.get(device.id) ?? [])]) {
      const sensorId = elementKey("sensor", device.id, sensor.id);
      const schemaId = "schemaId" in sensor && typeof sensor.schemaId === "string" ? sensor.schemaId : undefined;
      add({
        id: sensorId, kind: "sensor", name: sensor.name, context: device.name, page,
        ids: [device.id, sensor.id], ...(schemaId ? { schema: schemaNode(schemaId) } : {}),
      });
      link(deviceId, sensorId, "contains", "structure");
      for (const property of ["value", "availability", "observedAt"]) {
        const propertyId = elementKey("property", device.id, "sensor", sensor.id, property);
        add({ id: propertyId, kind: "property", name: property, context: `${device.name} · ${sensor.name}`, page, ids: [device.id, "sensor", sensor.id, property] });
        link(sensorId, propertyId, "contains", "structure");
      }
    }

    if (device.capabilities.camera) {
      const id = elementKey("region", device.id, "light-sync");
      add({ id, kind: "region", name: "Light sync region", context: device.name, page: `${page}/light-sync`, ids: [device.id, "light-sync"] });
      link(deviceId, id, "contains", "structure");
    }
    for (const signal of snapshot.signals.get(device.id) ?? []) {
      const id = elementKey("signal", device.id, signal.id);
      add({ id, kind: "signal", name: signal.name, context: device.name, page, ids: [device.id, signal.id] });
      link(deviceId, id, "contains", "structure");
    }
  }

  for (const reference of references) {
    edges.push({
      from: deviceElement(reference.from),
      to: deviceElement(reference.to),
      relation: reference.relation,
      origin: "resolution",
      ...(reference.label ? { label: reference.label } : {}),
      ...(reference.capability ? { via: reference.capability } : {}),
    });
  }

  for (const service of site.services) {
    const serviceId = elementKey("service", service.id);
    for (const subject of site.serviceSubjects(service.id)) {
      if (site.get(subject)) link(serviceId, deviceElement(subject), "services", "site");
    }
  }

  // What maintains a node's state. Every observable node is maintained by the
  // state hub, because the hub is the only writer even for a push; whether it
  // had to ask is the difference between `poll` and `push`, and that is what
  // separates a door that reports as it opens from one seen on the next sweep.
  const stateHub = site.services.find((service) => service.id === STATE_HUB_SERVICE_ID);
  if (stateHub) {
    const hubId = elementKey("service", stateHub.id);
    for (const device of site.devices) {
      link(deviceElement(device.id), hubId, "sourcedBy", "source", device.watch ? "push" : "poll");
    }
  }

  const dog = site.getService("dog-announcer");
  if (dog instanceof DogAnnouncer) {
    const page = "/automations/dog-announcer";
    const id = elementKey("automation", dog.id);
    add({ id, kind: "automation", name: dog.title, context: "", page, ids: [dog.id], stateNode: `automation/${dog.id}` });
    fileUnder(id, "automation");
    for (const key of Object.keys(dog.view().config)) {
      const propertyId = elementKey("property", "automation", dog.id, key);
      add({ id: propertyId, kind: "property", name: key, context: dog.title, page, ids: ["automation", dog.id, key] });
      link(id, propertyId, "contains", "structure");
    }
  }

  const dashboard = elementKey("dashboard", "kindle");
  add({ id: dashboard, kind: "dashboard", name: "Kindle", context: "", page: "/kindle/designer", ids: ["kindle"] });
  fileUnder(dashboard, "dashboard");
  for (const widget of snapshot.kindle?.canvas?.widgets ?? []) {
    const name = widget.kind === "device"
      ? widget.label || site.get(widget.deviceId)?.name || widget.deviceId
      : "text" in widget ? String(widget.text) : widget.kind;
    const id = elementKey("widget", "kindle", widget.id);
    add({ id, kind: "widget", name, context: "Kindle", page: "/kindle/designer", ids: ["kindle", widget.id] });
    link(dashboard, id, "contains", "structure");
    if (widget.kind === "device" && site.get(widget.deviceId)) link(id, deviceElement(widget.deviceId), "uses", "site");
  }

  return { nodes, edges };
}

/**
 * The dotted `state` paths a capability schema declares. Memoised: every device
 * of the same model would otherwise walk the identical document.
 */
const pathCache = new Map<string, readonly string[]>();
function statePathsOf(schemaId: string): readonly string[] {
  const cached = pathCache.get(schemaId);
  if (cached) return cached;
  const entry = schemaCatalogEntries.find((candidate) => candidate.schema.$id === schemaId);
  const state = (entry?.schema as { properties?: { state?: unknown } } | undefined)?.properties?.state;
  const paths = state ? propertyPaths(state) : [];
  pathCache.set(schemaId, paths);
  return paths;
}
