import type { Graph } from "../graph/graph";
import type { GraphNode } from "../graph/types";

export type ElementScope = { readonly kind: "device" | "group"; readonly id: string };

const DEVICE_PARTS = new Set<GraphNode["kind"]>(["capability", "control", "property", "sensor", "scene", "show", "preset", "signal", "region"]);

/** Scope follows declared containment, never an ID shared by unrelated kinds. */
export function elementScope(topology: Pick<Graph, "node" | "edgesOf">, node: GraphNode | undefined): ElementScope | undefined {
  if (!node || node.side !== "instance" || !node.ids[0]) return undefined;
  if (node.kind === "group" || node.kind === "group-switch") return { kind: "group", id: node.ids[0] };
  if (node.kind === "device") return { kind: "device", id: node.ids[0] };
  if (!DEVICE_PARTS.has(node.kind)) return undefined;

  const owners = new Set<string>();
  const seen = new Set<string>();
  const pending = [node.id];
  while (pending.length) {
    const key = pending.pop()!;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const edge of topology.edgesOf(key)) {
      if (edge.to !== key || edge.relation !== "contains" || edge.origin !== "structure") continue;
      const parent = topology.node(edge.from);
      if (parent?.side !== "instance") continue;
      if (parent.kind === "device") {
        if (parent.ids[0] === node.ids[0]) owners.add(parent.ids[0]);
      } else if (DEVICE_PARTS.has(parent.kind)) pending.push(parent.id);
    }
  }
  const [id] = owners;
  return owners.size === 1 && id ? { kind: "device", id } : undefined;
}
