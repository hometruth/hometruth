import type { GraphStore } from "../graph/store";
import type { Graph } from "../graph/graph";
import type { GraphNode } from "../graph/types";
import type { StateHub } from "../state/hub";
import type { Principal } from "../auth/scope";
import type { InventoryElement } from "./index";
import { addressesFor } from "../element-api/addresses";
import { elementScope } from "../auth/element-scope";

interface Inventory {
  topology: Graph;
  entries: InventoryElement[];
  byKey: Map<string, InventoryElement>;
  byAddress: Map<string, InventoryElement>;
}
const inventories = new WeakMap<StateHub, { store: GraphStore | undefined; identities: Map<string, string>; current: Inventory }>();

/** Reconcile identities only when inventory changes, never once per element or measurement. */
export function inventoryFor(hub: StateHub, store?: GraphStore): Inventory {
  const topology = hub.data.topology();
  const cached = inventories.get(hub);
  if (cached?.current.topology === topology && cached.store === store) return cached.current;
  const identities = store ? new Map(store.reconcile(topology.nodes(), topology.edges()).nodes.map(node => [node.id, node.uuid]))
    : cached?.identities ?? new Map<string, string>();
  const addresses = addressesFor(hub);
  const entries = topology.nodes().map((node): InventoryElement => {
    let uuid = identities.get(node.id);
    if (!uuid) { uuid = crypto.randomUUID(); identities.set(node.id, uuid); }
    const address = addresses.address(node.id)!;
    const stateNode = node.stateNode ?? (node.kind === "group" ? `group/${node.ids[0]}` : undefined);
    const stateAddress = stateNode ? addresses.stateAddress(stateNode) : undefined;
    return { address, context: node.context, commandPage: node.kind === "site" ? "/" : `/elements/${encodeURIComponent(address)}`,
      ...(stateNode ? { stateNode } : {}), ...(stateAddress ? { stateAddress } : {}), uuid, key: node.id, id: node.ids.length === 1 ? node.ids[0]! : `${node.kind}:${node.ids.join("/")}`,
      name: node.name, kind: node.kind, side: node.side, page: node.page || `/elements/${encodeURIComponent(address)}`,
      ...(node.kind === "device" && node.side === "instance" ? { deviceId: node.ids[0]! } : {}),
    };
  });
  const current = { topology, entries, byKey: new Map(entries.map(entry => [entry.key, entry])), byAddress: new Map(entries.map(entry => [entry.address, entry])) };
  inventories.set(hub, { store, identities, current });
  return current;
}

/** A scoped inventory includes only devices and groups the caller can inspect. */
export function visibleElement(node: GraphNode, hub: StateHub, principal?: Principal): boolean {
  if (!principal || principal.allowsSite("read")) return true;
  const scope = elementScope(hub.data.topology(), node);
  if (scope?.kind === "group") {
    const group = hub.data.sources.site.deviceGroups.find(group => group.id === scope.id);
    return Boolean(principal.allows("read") && group && principal.reachesAll(group.members));
  }
  return scope?.kind === "device" && principal.allowsDevice(scope.id, "read");
}
