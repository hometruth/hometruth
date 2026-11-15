import { createHash } from "node:crypto";
import type { Graph } from "../graph/graph";
import { tagNode } from "../graph/tag-graph";
import type { GraphNode } from "../graph/types";
import { nameSlug } from "../page-urls";
import type { StateHub } from "../state/hub";
import { isNodeId, type NodeId } from "../state/protocol";
import { publicApiPath, type ApiAddressMappings } from "./address-paths";

export { publicApiPath, type ApiAddressMappings } from "./address-paths";

const topLevelKinds = new Set(["device", "group", "group-switch", "speaker-group", "service"]);
// These names are actual literal routes, never historical identities.
const reserved = new Set([
  "root", "preview", "export", "import", "help", "ls", "find", "graph", "watch", "tags",
  "enable", "disable", "reboot", "reconnect", "rescan", "network", "isolation", "isolate", "secrets", "tokens", "hub", "tkenpro",
]);
const hashFor = (key: string) => createHash("sha256").update(key).digest("hex");

function baseAddress(node: GraphNode): string {
  if (node.kind === "site") return "root";
  if (node.kind === "group-switch" && node.page) return `${decodeURIComponent(node.page.split("/").at(-1)!)}-switch`;
  if (topLevelKinds.has(node.kind) && node.page) return decodeURIComponent(node.page.split("/").at(-1)!);
  if (node.kind === "catalog") return nameSlug(node.name);
  if (node.kind === "tag") return nameSlug(node.ids.join(" "));
  return nameSlug([node.context, node.kind, node.name].filter(Boolean).join(" "));
}

/** One current, collision-free public name for each node in this topology. */
export class ElementAddresses {
  readonly mappings: ApiAddressMappings;
  private readonly byAddress = new Map<string, GraphNode>();
  private readonly reversed: ApiAddressMappings;

  constructor(readonly topology: Graph, tags: readonly { id: string; name: string; value: string }[] = []) {
    const nodes = [...topology.nodes()].sort((a, b) => a.id.localeCompare(b.id));
    const bases = new Map(nodes.map(node => [node.id, baseAddress(node)]));
    const counts = new Map<string, number>();
    for (const base of bases.values()) counts.set(base, (counts.get(base) ?? 0) + 1);
    const desired = new Map(nodes.map(node => {
      const base = bases.get(node.id)!;
      return [node.id, node.kind === "site" || counts.get(base) === 1 && !reserved.has(base) ? base : `${base}-${node.kind}`];
    }));
    const desiredCounts = new Map<string, number>();
    for (const value of desired.values()) desiredCounts.set(value, (desiredCounts.get(value) ?? 0) + 1);
    const elements: Record<string, string> = Object.create(null);
    const devices: Record<string, string> = Object.create(null);
    const groups: Record<string, string> = Object.create(null);
    const services: Record<string, string> = Object.create(null);
    const tagAddresses: Record<string, string> = Object.create(null);
    const stateNodes: Record<string, string> = Object.create(null);
    for (const node of nodes) {
      const base = desired.get(node.id)!;
      let address = base;
      if (desiredCounts.get(base)! > 1 || this.byAddress.has(address) || node.kind !== "site" && reserved.has(address)) {
        const hash = hashFor(node.id);
        let length = 8;
        do { address = `${base}-${hash.slice(0, length++)}`; } while (desiredCounts.has(address) || this.byAddress.has(address) || reserved.has(address));
      }
      elements[node.id] = address;
      this.byAddress.set(address, node);
      if (node.side === "instance" && node.ids[0]) {
        if (node.kind === "device") devices[node.ids[0]] = address;
        if (node.kind === "group") groups[node.ids[0]] = address;
        if (node.kind === "service") services[node.ids[0]] = address;
      }
    }
    for (const tag of tags) {
      const address = elements[tagNode(tag)];
      if (address) tagAddresses[tag.id] = address;
    }
    for (const node of nodes) {
      if (node.kind === "device") stateNodes[`device/${node.ids[0]}`] = elements[node.id]!;
      if (node.kind === "group") stateNodes[`group/${node.ids[0]}`] = elements[node.id]!;
      if (node.kind === "automation") stateNodes[`automation/${node.ids[0]}`] = elements[node.id]!;
    }
    this.mappings = { devices, groups, services, elements, tags: tagAddresses, stateNodes };
    const reverse = (entries: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(entries).map(([key, value]) => [value, key]));
    this.reversed = { devices: reverse(devices), groups: reverse(groups), services: reverse(services), elements: reverse(elements), tags: reverse(tagAddresses), stateNodes: reverse(stateNodes) };
  }

  address(key: string): string | undefined { return this.mappings.elements[key]; }
  node(address: string): GraphNode | undefined { return this.byAddress.get(address); }
  device(id: string): string | undefined { return this.mappings.devices[id]; }
  group(id: string): string | undefined { return this.mappings.groups[id]; }
  service(id: string): string | undefined { return this.mappings.services[id]; }
  stateAddress(node: string): string | undefined { return this.mappings.stateNodes[node]; }
  stateNode(address: string): NodeId | undefined { const node = this.reversed.stateNodes[address]; return node && isNodeId(node) ? node : undefined; }
  publicPath(path: string): string { return publicApiPath(path, this.mappings); }

  /** Resolve only current public addresses. No stored ID or previous name is an alias. */
  internalPath(path: string): string | undefined {
    const boundary = path.search(/[?#]/);
    const pathname = boundary < 0 ? path : path.slice(0, boundary);
    const suffix = boundary < 0 ? "" : path.slice(boundary);
    const parts = pathname.split("/");
    let valid = true;
    const replace = (index: number, names: Readonly<Record<string, string>>) => {
      if (!parts[index]) return;
      let address: string;
      try { address = decodeURIComponent(parts[index]!); } catch { valid = false; return; }
      const id = Object.hasOwn(names, address) ? names[address] : undefined;
      if (!id) { valid = false; return; }
      parts[index] = encodeURIComponent(id);
    };
    if (parts[1] === "elements") replace(2, this.reversed.elements);
    if (parts[1] === "api") {
      const collection = parts[2];
      if (["devices", "switches", "lights", "buttons", "cameras", "ir-rf-blasters", "radio-receivers", "aqara"].includes(collection!)) replace(3, this.reversed.devices);
      else if (collection === "device-groups" && parts[3] !== "preview") replace(3, this.reversed.groups);
      else if (collection === "services") {
        if (!(parts[3] === "frigate" && ["frames", "previews"].includes(parts[4]!))) replace(3, this.reversed.services);
      } else if (collection === "elements") {
        replace(3, this.reversed.elements);
        if (collection === "elements" && parts[4] === "tags") replace(5, this.reversed.tags);
      } else if (collection === "tags" && !["export", "import"].includes(parts[3]!)) replace(3, this.reversed.tags);
      else if (collection === "bridges") {
        if (parts[3] === "options") replace(4, this.reversed.elements);
        else if (parts[4] === "members") replace(5, this.reversed.elements);
      }
    }
    return valid ? parts.join("/") + suffix : undefined;
  }
}

const directories = new WeakMap<StateHub, ElementAddresses>();
export function addressesFor(hub: StateHub): ElementAddresses {
  const topology = hub.data.topology();
  let directory = directories.get(hub);
  if (!directory || directory.topology !== topology) {
    directory = new ElementAddresses(topology, hub.data.sources.tags.list());
    directories.set(hub, directory);
  }
  return directory;
}
