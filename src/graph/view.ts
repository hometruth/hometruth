/**
 * The default Graph tab shows an element's ancestor path and immediate children.
 * High-degree services and detailed property/control nodes are hidden until
 * requested so dense installations remain legible. Expanders reveal more nodes.
 * Expansion is encoded in the URL, allowing links, reloads and script-free use.
 * The whole diagram is rendered on the server.
 */
import type { ElementKind } from "../tags/identity";
import type { Graph } from "./graph";
import { HIERARCHY } from "./instance-graph";
import { otherEnd, relationAsSeenFrom, type GraphEdge, type GraphNode, type NodeId, type RelationName } from "./types";

export type NodeRole = "focus" | "ancestor" | "child" | "expanded";

/**
 * Kinds left out until the menu asks for them. A service is `sourcedBy` or
 * `services` almost every device, so it is the one kind whose presence says
 * nothing about the element you are looking at.
 */
export const DEFAULT_HIDDEN_KINDS: readonly ElementKind[] = ["service"];

export interface ViewNode {
  readonly node: GraphNode;
  readonly role: NodeRole;
  /** Steps from the root along its own parent chain, whatever revealed it. */
  readonly depth: number;
  /**
   * What it hangs under when the diagram is laid out. Its real parent when that
   * is on screen, otherwise whatever revealed it, so nothing floats. The lines
   * between nodes are the actual relations, not this.
   */
  readonly parent?: NodeId;
  /** How many neighbours expanding this node would add. */
  readonly hidden: number;
  /** Which kinds those are, so the expander can say what is behind it. */
  readonly hiddenKinds: readonly ElementKind[];
}

export interface GraphView {
  readonly focus: NodeId;
  readonly nodes: readonly ViewNode[];
  readonly edges: readonly GraphEdge[];
  readonly expanded: readonly NodeId[];
  /** Kinds currently suppressed. */
  readonly hiddenKinds: readonly ElementKind[];
  /** Every kind this element could show, for the menu; suppressed ones included. */
  readonly offeredKinds: readonly ElementKind[];
}

export interface ViewOptions {
  readonly expanded?: Iterable<NodeId>;
  readonly hiddenKinds?: Iterable<ElementKind>;
  /** Children drawn before the rest become a count. */
  readonly maxChildren?: number;
}

const MAX_CHILDREN = 24;

/** A hierarchy edge read downwards: `from` is the parent. */
function parentsOf(graph: Graph, id: NodeId): NodeId[] {
  return graph.edgesOf(id)
    .filter((edge) => edge.to === id && HIERARCHY.has(edge.relation))
    .map((edge) => edge.from);
}

function childrenOf(graph: Graph, id: NodeId): NodeId[] {
  return graph.edgesOf(id)
    .filter((edge) => edge.from === id && HIERARCHY.has(edge.relation))
    .map((edge) => edge.to);
}

const SPINE: ReadonlySet<string> = new Set(["site", "catalog"]);

/**
 * The one parent a node hangs from.
 *
 * A node can have several: a bulb is filed under the Devices catalog *and*
 * contained by the string light it belongs to. The specific parent is the
 * informative one, so a catalog is only chosen when nothing else offers.
 */
function primaryParent(graph: Graph, id: NodeId): NodeId | undefined {
  const candidates = parentsOf(graph, id);
  if (!candidates.length) return undefined;
  const specific = candidates.filter((candidate) => !SPINE.has(graph.node(candidate)?.kind ?? ""));
  const pool = specific.length ? specific : candidates;
  return [...pool].sort((a, b) => (graph.node(a)?.name ?? a).localeCompare(graph.node(b)?.name ?? b) || a.localeCompare(b))[0];
}

/** Root first, focus last. Cycle-safe; a node with no parents is its own root. */
export function pathToRoot(graph: Graph, focus: NodeId): NodeId[] {
  const chain: NodeId[] = [];
  const seen = new Set<NodeId>();
  let current: NodeId | undefined = focus;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = primaryParent(graph, current);
  }
  return chain.reverse();
}

export function buildView(graph: Graph, focus: NodeId, options: ViewOptions = {}): GraphView | undefined {
  const start = graph.node(focus);
  if (!start) return undefined;

  const hiddenKinds = new Set<ElementKind>(options.hiddenKinds ?? DEFAULT_HIDDEN_KINDS);
  const expanded = new Set<NodeId>(options.expanded ?? []);
  const maxChildren = options.maxChildren ?? MAX_CHILDREN;
  const visibleKind = (id: NodeId) => {
    const kind = graph.node(id)?.kind;
    return kind !== undefined && !hiddenKinds.has(kind);
  };

  const depths = new Map<NodeId, number>();
  const depthOf = (id: NodeId): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    const own = pathToRoot(graph, id).length - 1;
    depths.set(id, own);
    return own;
  };

  const path = pathToRoot(graph, focus);
  const found = new Map<NodeId, { role: NodeRole; revealedBy?: NodeId }>();

  path.forEach((id, index) => {
    found.set(id, { role: id === focus ? "focus" : "ancestor", ...(index > 0 ? { revealedBy: path[index - 1]! } : {}) });
    depths.set(id, index);
  });

  const byName = (a: NodeId, b: NodeId) =>
    (graph.node(a)?.name ?? a).localeCompare(graph.node(b)?.name ?? b) || a.localeCompare(b);

  // Immediate children: one step further from the root.
  for (const id of [...new Set(childrenOf(graph, focus))].filter(visibleKind).sort(byName).slice(0, maxChildren)) {
    if (!found.has(id) && graph.node(id)) found.set(id, { role: "child", revealedBy: focus });
  }

  // Anything explicitly opened, wherever it sits.
  for (const source of expanded) {
    if (!found.has(source)) continue;
    for (const id of [...new Set(graph.neighbours(source))].filter(visibleKind).sort(byName)) {
      if (!found.has(id) && graph.node(id)) found.set(id, { role: "expanded", revealedBy: source });
    }
  }

  // A node hangs under its real parent when that is on screen too, so the tree
  // stays the hierarchy rather than a record of the order things were opened.
  const entries = new Map<NodeId, ViewNode>();
  for (const [id, { role, revealedBy }] of found) {
    const node = graph.node(id)!;
    const real = primaryParent(graph, id);
    const parent = real && found.has(real) && real !== id ? real : revealedBy;
    entries.set(id, {
      node, role, depth: depthOf(id), hidden: 0, hiddenKinds: [],
      ...(parent && parent !== id ? { parent } : {}),
    });
  }

  // What each drawn node would still add. The count is what expanding would
  // actually reveal, so a suppressed kind is not promised by a number that then
  // does not appear; the same pass records which kinds are being suppressed, so
  // the viewer's menu can offer exactly those.
  const shown = new Set(entries.keys());
  const offered = new Set<ElementKind>();
  for (const [id, entry] of entries) {
    const missing = [...new Set(graph.neighbours(id))].filter((other) => !shown.has(other));
    const kinds = new Set<ElementKind>();
    let revealable = 0;
    for (const other of missing) {
      const kind = graph.node(other)?.kind;
      if (!kind) continue;
      if (hiddenKinds.has(kind)) { offered.add(kind); continue; }
      kinds.add(kind);
      revealable += 1;
    }
    entries.set(id, { ...entry, hidden: revealable, hiddenKinds: [...kinds].sort() });
  }

  // Close over what is drawn, so a link between two visible nodes is not lost
  // just because the walk reached them by different routes.
  const edges = graph.edges().filter((edge) => shown.has(edge.from) && shown.has(edge.to));

  return {
    focus,
    nodes: [...entries.values()].sort((a, b) => a.depth - b.depth || byName(a.node.id, b.node.id)),
    edges,
    expanded: [...expanded].filter((id) => shown.has(id)),
    hiddenKinds: [...hiddenKinds].sort(),
    offeredKinds: [...offered].sort(),
  };
}

/** How an edge reads from the node it is drawn under, for a label or a title. */
export function edgeLabel(edge: GraphEdge, from: NodeId): RelationName {
  return relationAsSeenFrom(edge, from);
}

export { otherEnd };

/**
 * Kinds the whole-graph view leaves out on top of the usual ones. A control and
 * a property are details that can dominate a large graph by count. Omit them
 * from the overview while keeping them available in expanded views.
 */
export const FULL_VIEW_EXTRA_HIDDEN: readonly ElementKind[] = ["control", "property"];

export interface FullViewOptions {
  /** Highlighted, and always drawn with its path even if the cap bites. */
  readonly focus?: NodeId;
  readonly hiddenKinds?: Iterable<ElementKind>;
  readonly maxNodes?: number;
}

export interface FullView extends GraphView {
  /** How many nodes the graph holds in total, so the view can admit what it left out. */
  readonly total: number;
}

/**
 * Everything, from the root outwards, as one tree.
 *
 * Bounded rather than literally everything: past a few hundred nodes a diagram
 * stops being a picture of anything. What the cap drops is the deepest material
 * first, because depth is where the repetitive detail lives, and the view says
 * how many it is showing out of how many there are rather than quietly
 * truncating.
 */
export function buildFullView(graph: Graph, root: NodeId, options: FullViewOptions = {}): FullView | undefined {
  if (!graph.node(root)) return undefined;
  const hiddenKinds = new Set<ElementKind>([
    ...(options.hiddenKinds ?? DEFAULT_HIDDEN_KINDS),
    ...FULL_VIEW_EXTRA_HIDDEN,
  ]);
  // Sized for legibility rather than completeness: past this the disc is a band
  // of touching circles and the count below it does the honest work.
  const maxNodes = options.maxNodes ?? 260;
  const focus = options.focus;

  const byName = (a: NodeId, b: NodeId) =>
    (graph.node(a)?.name ?? a).localeCompare(graph.node(b)?.name ?? b) || a.localeCompare(b);

  // Breadth-first, so the cap takes the deepest material rather than an
  // arbitrary branch.
  const chosen = new Map<NodeId, { depth: number; parent?: NodeId }>([[root, { depth: 0 }]]);
  let frontier: NodeId[] = [root];
  let depth = 0;
  while (frontier.length && chosen.size < maxNodes) {
    const next: NodeId[] = [];
    depth += 1;
    for (const id of frontier) {
      for (const child of [...new Set(childrenOf(graph, id))].sort(byName)) {
        if (chosen.size >= maxNodes) break;
        if (chosen.has(child)) continue;
        const kind = graph.node(child)?.kind;
        if (!kind || hiddenKinds.has(kind)) continue;
        chosen.set(child, { depth, parent: id });
        next.push(child);
      }
    }
    frontier = next;
  }

  // The focus and its ancestors are the reason you opened this, so they are
  // never what the cap removed.
  if (focus && graph.node(focus)) {
    pathToRoot(graph, focus).forEach((id, index) => {
      if (chosen.has(id)) return;
      const parent = primaryParent(graph, id);
      chosen.set(id, { depth: index, ...(parent ? { parent } : {}) });
    });
  }

  const nodes: ViewNode[] = [...chosen].map(([id, { depth: own, parent }]) => ({
    node: graph.node(id)!,
    role: (id === focus ? "focus" : id === root ? "ancestor" : "child") as NodeRole,
    depth: own,
    ...(parent && chosen.has(parent) ? { parent } : {}),
    hidden: 0,
    hiddenKinds: [],
  })).sort((a, b) => a.depth - b.depth || byName(a.node.id, b.node.id));

  const shown = new Set(chosen.keys());
  return {
    focus: focus ?? root,
    nodes,
    // Hierarchy only. Every lateral relation in the house drawn at once is a
    // dark bundle across the middle that hides the shape it is drawn on; this
    // view answers where something sits, and the focused view answers what it
    // is wired to.
    edges: graph.edges().filter((edge) => HIERARCHY.has(edge.relation) && shown.has(edge.from) && shown.has(edge.to)),
    expanded: [],
    hiddenKinds: [...hiddenKinds].sort(),
    offeredKinds: [],
    total: graph.size,
  };
}
