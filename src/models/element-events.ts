import type { Graph } from "../graph/graph";
import type { GraphNode } from "../graph/types";
import { compileEventFilter, type EventFilter, type ServiceEvent } from "./event-log";

/** Event ownership follows containment and group membership, never unrelated neighbours. */
export function elementEventMatcher(graph: Graph, node: GraphNode, filter: EventFilter = {}): (event: ServiceEvent, service?: string) => boolean {
  const subjects = new Set<string>();
  const services = new Set<string>();
  const types = new Set<string>();
  const visited = new Set<string>();
  const visit = (current: GraphNode): void => {
    if (visited.has(current.id)) return;
    visited.add(current.id);
    subjects.add(current.id);
    if (current.kind === "device") { subjects.add(current.ids[0]!); return; }
    if (current.kind === "service" || current.kind === "automation") services.add(current.ids[0]!);
    if (current.kind === "event-type") types.add(current.ids[0]!);
    for (const edge of graph.edgesOf(current.id)) {
      const next = edge.from === current.id && ["contains", "members", "groupSwitch"].includes(edge.relation) ? edge.to
        : edge.to === current.id && edge.relation === "instanceOf" ? edge.from : undefined;
      const child = next && graph.node(next);
      if (child) visit(child);
    }
  };
  visit(node);
  // Nested primitives use their owning device's events. Controls narrow these
  // further to the named operation, while sensors retain availability events.
  const owner = node.side === "instance" && ["capability", "control", "property", "sensor", "scene", "show", "preset", "signal"].includes(node.kind) ? node.ids[0] : undefined;
  if (owner) subjects.add(owner);
  const matches = compileEventFilter(filter);
  return (event, service) => {
    if (!matches(event)) return false;
    if (node.kind === "site") return service !== "mqtt-broker";
    const owned = Boolean(event.subject && subjects.has(event.subject));
    if (!owned && !(service && services.has(service)) && !types.has(event.type)) return false;
    if (owner && node.kind === "control") {
      const control = event.data?.control;
      return typeof control === "string" && [node.ids[2], `${node.ids[1]}.${node.ids[2]}`, `power.${node.ids[2]}`].includes(control);
    }
    return service !== "mqtt-broker" || services.has(service);
  };
}
