/**
 * One element's own connections, plus one more level.
 *
 * The walk is breadth-first from the focus, capped per relation so a hub with
 * forty bridged accessories does not produce forty lines. What it keeps is not
 * only the edges it walked: once the node set is fixed, *every* edge whose ends
 * are both in that set is kept. Without that closure the interesting case does
 * not draw — a switch made of two buttons that both drive one blaster shows the
 * blaster twice, or the two converging lines not at all.
 *
 * A cap that hides something produces a `+N` node rather than silently
 * shortening the picture, so the diagram never lies about being complete.
 */
import type { Graph } from "./graph";
import { otherEnd, relationAsSeenFrom, type GraphEdge, type GraphNode, type NodeId, type RelationName } from "./types";

/**
 * Navigation scaffolding. The site root and its catalogs connect to everything,
 * so including them would put "Devices" and "HomeTruth" one hop from every
 * device and drown the relationships that actually mean something. They are
 * kept only when they are what you are looking at.
 */
const SPINE = new Set(["site", "catalog"]);

/**
 * Detail rather than connection. What a device is made of is worth seeing one
 * hop out; two hops out it is a neighbour's internals, and a page showing a
 * switch and its two buttons should not also list both buttons' capabilities
 * and every control on them. Kept in full when the detail is what you are
 * looking at.
 */
const DETAIL = new Set(["capability", "control", "property"]);

export interface EgoCaps {
  /** Neighbours kept per relation at depth 1. */
  readonly perRelation: number;
  /** Neighbours kept per depth-1 node at depth 2. */
  readonly perParent: number;
  /** Hard ceiling; depth-2 nodes are dropped from the largest buckets first. */
  readonly total: number;
}

/**
 * A node connected to more than this is a hub, and expanding it says nothing
 * about the focus. The MQTT broker services most of the house; opening a light
 * switch should not pull in every camera the broker also touches. The hub is
 * still drawn — it is a real connection — but its own neighbours are not.
 */
const HUB_DEGREE = 12;

export const DEFAULT_CAPS: EgoCaps = { perRelation: 12, perParent: 6, total: 60 };

export interface Truncation {
  readonly from: NodeId;
  readonly relation: RelationName;
  readonly hidden: number;
}

export interface EgoNode {
  readonly node: GraphNode;
  readonly depth: 0 | 1 | 2;
  /** How this node was reached, from the point of view of the node that reached it. */
  readonly via?: RelationName;
}

export interface Ego {
  readonly focus: NodeId;
  readonly depth: number;
  readonly nodes: readonly EgoNode[];
  readonly edges: readonly GraphEdge[];
  readonly truncated: readonly Truncation[];
}

/** Display order, which is also the order buckets claim space on the diagram. */
export const RELATION_ORDER: readonly RelationName[] = [
  "partOf", "memberOf", "instanceOf", "uses", "services", "emits", "sourcedBy",
  "contains", "members", "locatedIn", "usedBy", "groupSwitch", "basedOnGroup",
  "instances", "implements", "implementedBy", "declares", "declaredBy",
  "describesAs", "describedBy", "defines", "definedBy", "references",
  "referencedBy", "refines", "refinedBy", "servicedBy", "emittedBy",
  "locates", "sources",
];

function orderOf(relation: RelationName): number {
  const index = RELATION_ORDER.indexOf(relation);
  return index < 0 ? RELATION_ORDER.length : index;
}

/** Stable and name-based, so the same graph always produces the same picture. */
function sortNeighbours(graph: Graph, ids: readonly NodeId[]): NodeId[] {
  return [...ids].sort((a, b) => {
    const left = graph.node(a);
    const right = graph.node(b);
    return (left?.name ?? a).localeCompare(right?.name ?? b) || a.localeCompare(b);
  });
}

export function ego(graph: Graph, focus: NodeId, depth = 2, caps: EgoCaps = DEFAULT_CAPS): Ego | undefined {
  const start = graph.node(focus);
  if (!start) return undefined;

  const focusIsSpine = SPINE.has(start.kind);
  /** Whether a candidate is worth drawing, given what we are looking at. */
  const admits = (id: NodeId, level: number): boolean => {
    const node = graph.node(id);
    if (!node) return false;
    if (SPINE.has(node.kind) && !focusIsSpine) return false;
    if (level > 1 && DETAIL.has(node.kind) && !DETAIL.has(start.kind)) return false;
    return true;
  };

  const seen = new Map<NodeId, EgoNode>([[focus, { node: start, depth: 0 }]]);
  const truncated: Truncation[] = [];
  let frontier: NodeId[] = [focus];

  for (let level = 1 as 1 | 2; level <= depth && frontier.length; level = (level + 1) as 1 | 2) {
    const limit = level === 1 ? caps.perRelation : caps.perParent;
    const next: NodeId[] = [];
    for (const id of frontier) {
      const incident = graph.edgesOf(id);
      if (level > 1 && incident.length > HUB_DEGREE) {
        truncated.push({ from: id, relation: "contains", hidden: incident.length });
        continue;
      }
      const buckets = new Map<RelationName, NodeId[]>();
      for (const edge of incident) {
        const relation = relationAsSeenFrom(edge, id);
        const other = otherEnd(edge, id);
        const bucket = buckets.get(relation);
        if (bucket) { if (!bucket.includes(other)) bucket.push(other); }
        else buckets.set(relation, [other]);
      }
      for (const relation of [...buckets.keys()].sort((a, b) => orderOf(a) - orderOf(b))) {
        const all = sortNeighbours(graph, buckets.get(relation)!);
        // Something already on the diagram is not "hidden" by a cap.
        const fresh = all.filter((candidate) => !seen.has(candidate) && admits(candidate, level));
        const kept = fresh.slice(0, limit);
        if (fresh.length > kept.length) truncated.push({ from: id, relation, hidden: fresh.length - kept.length });
        for (const candidate of kept) {
          if (seen.size >= caps.total) {
            truncated.push({ from: id, relation, hidden: 1 });
            continue;
          }
          const node = graph.node(candidate);
          if (!node) continue;
          seen.set(candidate, { node, depth: level, via: relation });
          next.push(candidate);
        }
      }
    }
    frontier = next;
  }

  // Close over the kept set: every edge between two nodes on the diagram, not
  // only the ones the walk followed. This is what draws two buttons converging
  // on the one blaster they both drive.
  const edges = graph.edges().filter((edge) => seen.has(edge.from) && seen.has(edge.to));

  return {
    focus,
    depth,
    nodes: [...seen.values()],
    edges,
    truncated: mergeTruncations(truncated),
  };
}

function mergeTruncations(entries: readonly Truncation[]): Truncation[] {
  const merged = new Map<string, Truncation>();
  for (const entry of entries) {
    const key = `${entry.from}\u0000${entry.relation}`;
    const existing = merged.get(key);
    merged.set(key, existing ? { ...existing, hidden: existing.hidden + entry.hidden } : entry);
  }
  return [...merged.values()];
}
