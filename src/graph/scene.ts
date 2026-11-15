/** Pure, bounded projections of known topology shared by the graph UI and API. */
import type { ElementKind } from "../tags/identity";
import { edgeIdentity, type Graph } from "./graph";
import { RELATION_NAMES, otherEnd, type GraphEdge, type GraphNode, type Relation } from "./types";

export type GraphView = "home" | "dependencies" | "model";
export interface GraphQuery {
  readonly view: GraphView;
  readonly focus?: string;
  readonly selected?: string;
  readonly q: string;
  readonly group: "room" | "kind";
  readonly expanded: readonly string[];
  readonly relations: readonly Relation[];
  readonly depth: number;
}
export interface SceneNode {
  /** An occurrence, distinct from the canonical identity in `node.id`. */
  readonly id: string;
  readonly node: GraphNode;
  readonly group?: string;
  /** Eligible, matching neighbours absent from the scene, counted once. */
  readonly hidden: number;
}
export interface SceneGroup {
  readonly id: string;
  readonly name: string;
  /** Matching members before the display cap, including multi-room occurrences. */
  readonly total: number;
  readonly hidden: number;
  readonly kind: "room" | "kind" | "unassigned";
}
export interface SceneEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly edge: GraphEdge;
}
export interface GraphScene {
  readonly query: GraphQuery;
  readonly nodes: readonly SceneNode[];
  readonly edges: readonly SceneEdge[];
  readonly groups: readonly SceneGroup[];
  /** Canonical elements in this lens's scope before search or display caps. */
  readonly total: number;
  readonly matched: number;
  /** Matching canonical elements omitted by display caps. */
  readonly omitted: number;
  readonly generatedAt: string;
}

const OPERATIONS: readonly Relation[] = ["uses", "members", "groupSwitch", "services", "sourcedBy"];
const DEFINITIONS: readonly Relation[] = ["instanceOf", "implements", "declares", "describesAs", "defines", "references", "refines"];
export const LENS_RELATIONS: Readonly<Record<GraphView, readonly Relation[]>> = {
  home: OPERATIONS,
  dependencies: OPERATIONS,
  model: [...DEFINITIONS, "tagged"],
};
const HOME_KINDS: ReadonlySet<ElementKind> = new Set(["device", "group", "group-switch", "speaker-group", "automation", "dashboard"]);
const GROUP_KINDS: ReadonlySet<ElementKind> = new Set(["group", "speaker-group", "group-switch"]);
const KIND_NAMES: Partial<Record<ElementKind, string>> = {
  device: "Devices", group: "Groups", "group-switch": "Switches", "speaker-group": "Speaker groups",
  automation: "Automations", dashboard: "Dashboards",
};
export const GRAPH_SCENE_NODE_LIMIT = 160;
const MAX_NODES = GRAPH_SCENE_NODE_LIMIT;
const GROUP_LIMIT = 6;
const EXPANDED_GROUP_LIMIT = 48;
const DEPENDENCY_LIMIT = 12;
const EXPANDED_DEPENDENCY_LIMIT = 48;
const relationSet = new Set<string>(RELATION_NAMES);
const compareIds = (a: string, b: string): number => a.localeCompare(b);
const unique = (values: readonly string[]) => [...new Set(values.filter(Boolean))].sort(compareIds);
const byName = (a: GraphNode, b: GraphNode): number => a.name.localeCompare(b.name) || compareIds(a.id, b.id);
const occurrence = (id: string, group?: string) => JSON.stringify([group ?? null, id]);

export function parseGraphQuery(params: URLSearchParams): GraphQuery {
  const requestedView = params.get("view");
  const view: GraphView = requestedView === "dependencies" || requestedView === "model" ? requestedView : "home";
  const rawDepth = params.get("depth");
  const depth = rawDepth === null || rawDepth.trim() === "" ? 2 : Number(rawDepth);
  const identity = (value: string | null) => value && value.length <= 4096 ? value : undefined;
  const focus = identity(params.get("focus"));
  const selected = identity(params.get("selected"));
  return {
    view,
    ...(focus ? { focus } : {}),
    ...(selected ? { selected } : {}),
    q: (params.get("q") ?? "").trim().slice(0, 200),
    group: params.get("group") === "kind" ? "kind" : "room",
    expanded: unique(params.getAll("expand").filter(value => identity(value) !== undefined)).slice(0, 64),
    relations: unique(params.getAll("relation")).filter((value): value is Relation => relationSet.has(value)),
    depth: Number.isFinite(depth) ? Math.max(0, Math.min(3, Math.trunc(depth))) : 2,
  };
}

/** One URL for the graph; repeated parameters preserve opaque identities. */
export function graphHref(query: GraphQuery, patch: Partial<GraphQuery> = {}): string {
  const next = { ...query, ...patch };
  const raw = new URLSearchParams();
  raw.set("view", next.view);
  if (next.focus) raw.set("focus", next.focus);
  if (next.selected) raw.set("selected", next.selected);
  raw.set("q", next.q);
  raw.set("group", next.group);
  raw.set("depth", String(next.depth));
  for (const id of next.expanded) raw.append("expand", id);
  for (const relation of next.relations) raw.append("relation", relation);
  const normalized = parseGraphQuery(raw);
  const params = new URLSearchParams();
  if (normalized.view !== "home") params.set("view", normalized.view);
  if (normalized.focus) params.set("focus", normalized.focus);
  if (normalized.selected) params.set("selected", normalized.selected);
  if (normalized.q) params.set("q", normalized.q);
  if (normalized.group !== "room") params.set("group", normalized.group);
  if (normalized.depth !== 2) params.set("depth", String(normalized.depth));
  for (const id of normalized.expanded) params.append("expand", id);
  for (const relation of normalized.relations) params.append("relation", relation);
  const search = params.toString();
  return search ? `/graph?${search}` : "/graph";
}

/** Defaults follow the focused element; explicit filters can use the full lens. */
export function defaultGraphRelations(query: GraphQuery, focus?: GraphNode): readonly Relation[] {
  if (query.view === "dependencies") {
    if (focus && GROUP_KINDS.has(focus.kind)) return ["members", "groupSwitch"];
    return focus?.kind === "service" ? ["services", "sourcedBy"] : ["uses"];
  }
  return query.view === "model" && focus?.side !== "tag" ? DEFINITIONS : LENS_RELATIONS[query.view];
}
function relationsFor(query: GraphQuery, focus?: GraphNode): ReadonlySet<Relation> {
  const defaults = defaultGraphRelations(query, focus);
  const allowed = query.view === "dependencies" ? LENS_RELATIONS.dependencies : defaults;
  return new Set(query.relations.length ? allowed.filter(relation => query.relations.includes(relation)) : defaults);
}
function matches(node: GraphNode, query: GraphQuery): boolean {
  return !query.q || `${node.name}\n${node.context}`.toLocaleLowerCase().includes(query.q.toLocaleLowerCase());
}
function neighbours(graph: Graph, id: string, admits: (node: GraphNode) => boolean, relations: ReadonlySet<Relation>): GraphNode[] {
  const nodes = new Map<string, GraphNode>();
  for (const edge of graph.edgesOf(id)) {
    if (!relations.has(edge.relation)) continue;
    const node = graph.node(otherEnd(edge, id));
    if (node && admits(node)) nodes.set(node.id, node);
  }
  return [...nodes.values()].sort(byName);
}

/** Model traversal is undirected, with explicit one-hop expansions. */
function modelNeighbourhood(graph: Graph, focus: GraphNode, query: GraphQuery, admits: (node: GraphNode) => boolean, relations: ReadonlySet<Relation>): GraphNode[] {
  const expanded = new Set(query.expanded);
  const found = new Map<string, GraphNode>([[focus.id, focus]]);
  let frontier = [focus];
  for (let level = 0; level < query.depth && frontier.length; level += 1) {
    const next: GraphNode[] = [];
    for (const node of frontier) {
      for (const other of neighbours(graph, node.id, admits, relations)) {
        if (found.has(other.id)) continue;
        found.set(other.id, other);
        next.push(other);
      }
    }
    frontier = next.sort(byName);
  }
  const processed = new Set<string>();
  for (;;) {
    const ready = [...found.values()].filter(node => expanded.has(node.id) && !processed.has(node.id)).sort(byName);
    if (!ready.length) break;
    for (const node of ready) {
      processed.add(node.id);
      for (const other of neighbours(graph, node.id, admits, relations)) found.set(other.id, other);
    }
  }
  return [...found.values()].sort(byName);
}

interface DependencyScope {
  nodes: readonly GraphNode[];
  expanded: ReadonlySet<string>;
  distance: ReadonlyMap<string, number>;
  parent: ReadonlyMap<string, string>;
}

/** Follow each direction independently: a shared target is not a route to its other users. */
function dependencyScope(graph: Graph, focus: GraphNode, query: GraphQuery, admits: (node: GraphNode) => boolean, relations: ReadonlySet<Relation>): DependencyScope {
  const found = new Map<string, GraphNode>([[focus.id, focus]]);
  for (const direction of ["from", "to"] as const) {
    const visited = new Set([focus.id]);
    let frontier = [focus];
    for (let level = 0; level < query.depth && frontier.length; level += 1) {
      const next = new Map<string, GraphNode>();
      for (const node of frontier) {
        for (const edge of graph.edgesOf(node.id)) {
          if (edge[direction] !== node.id || !relations.has(edge.relation)) continue;
          const other = graph.node(otherEnd(edge, node.id));
          if (!other || !admits(other) || visited.has(other.id)) continue;
          visited.add(other.id);
          found.set(other.id, other);
          next.set(other.id, other);
        }
      }
      frontier = [...next.values()].sort(byName);
    }
  }

  // An explicit expansion may cross direction once. Only expansions reached
  // from the current scope count, so unrelated URL values cannot widen the cap.
  const requested = new Set(query.expanded);
  const expanded = new Set<string>();
  for (;;) {
    const ready = [...found.values()].filter(node => requested.has(node.id) && !expanded.has(node.id)).sort(byName);
    if (!ready.length) break;
    for (const node of ready) {
      expanded.add(node.id);
      for (const other of neighbours(graph, node.id, admits, relations)) found.set(other.id, other);
    }
  }

  // Find shortest connecting paths inside the scope after all expansions. This
  // does not introduce other users of a shared target into the scope.
  const distance = new Map([[focus.id, 0]]);
  const parent = new Map<string, string>();
  let frontier = [focus];
  while (frontier.length) {
    const next: GraphNode[] = [];
    for (const node of frontier) {
      for (const other of neighbours(graph, node.id, candidate => found.has(candidate.id), relations)) {
        if (distance.has(other.id)) continue;
        distance.set(other.id, distance.get(node.id)! + 1);
        parent.set(other.id, node.id);
        next.push(other);
      }
    }
    frontier = next.sort(byName);
  }
  return { nodes: [...found.values()], expanded, distance, parent };
}

/** Keep nearby nodes and reserve a complete path for a requested selection. */
function dependencyNodes(scope: DependencyScope, filtered: readonly GraphNode[], query: GraphQuery): GraphNode[] {
  const cap = Math.min(EXPANDED_DEPENDENCY_LIMIT, DEPENDENCY_LIMIT * (1 + scope.expanded.size));
  const candidates = new Map(filtered.map(node => [node.id, node]));
  const byDistance = (a: GraphNode, b: GraphNode) => scope.distance.get(a.id)! - scope.distance.get(b.id)! || byName(a, b);
  const ordered = [...filtered].sort(byDistance);
  const chosen = new Set<string>();
  const addPath = (id: string) => {
    const path: string[] = [];
    for (let current: string | undefined = id; current; current = scope.parent.get(current)) {
      if (candidates.has(current) && !chosen.has(current)) path.push(current);
    }
    if (chosen.size + path.length <= cap) for (const part of path) chosen.add(part);
  };
  if (query.focus && candidates.has(query.focus)) chosen.add(query.focus);
  if (query.selected && candidates.has(query.selected)) {
    addPath(query.selected);
    // A long chain of explicit expansions may exceed the entire scene budget.
    // Still retain both requested endpoints when its complete path cannot fit.
    chosen.add(query.selected);
  }
  for (const node of ordered) if (scope.expanded.has(node.id)) addPath(node.id);
  for (const node of ordered) {
    if (chosen.size >= cap) break;
    addPath(node.id);
  }
  return ordered.filter(node => chosen.has(node.id));
}

interface Members { id: string; name: string; kind: SceneGroup["kind"]; nodes: GraphNode[] }
function homeGroups(graph: Graph, nodes: readonly GraphNode[], query: GraphQuery): Members[] {
  const groups = new Map<string, Members>();
  const add = (id: string, name: string, kind: SceneGroup["kind"], node: GraphNode) => {
    let group = groups.get(id);
    if (!group) { group = { id, name, kind, nodes: [] }; groups.set(id, group); }
    if (!group.nodes.some(member => member.id === node.id)) group.nodes.push(node);
  };
  for (const node of nodes) {
    if (query.group === "kind") {
      add(JSON.stringify(["kind", node.kind]), KIND_NAMES[node.kind] ?? node.kind, "kind", node);
      continue;
    }
    const rooms = graph.edgesOf(node.id).flatMap(edge => {
      if (edge.relation !== "tagged" || edge.to !== node.id) return [];
      const tag = graph.node(edge.from);
      return tag?.kind === "tag" && tag.ids[0] === "room" ? [tag] : [];
    });
    for (const room of rooms) add(JSON.stringify(["room", room.id]), room.name, "room", node);
    if (!rooms.length) add(JSON.stringify(["unassigned"]), "Unassigned", "unassigned", node);
  }
  return [...groups.values()].sort((a, b) => Number(a.kind === "unassigned") - Number(b.kind === "unassigned") || a.name.localeCompare(b.name) || compareIds(a.id, b.id));
}

function sceneEdges(graph: Graph, nodes: readonly SceneNode[], relations: ReadonlySet<Relation>): SceneEdge[] {
  const occurrences = new Map<string, SceneNode[]>();
  for (const node of nodes) {
    const list = occurrences.get(node.node.id) ?? [];
    list.push(node);
    occurrences.set(node.node.id, list);
  }
  const edges: SceneEdge[] = [];
  for (const edge of graph.edges()) {
    if (!relations.has(edge.relation)) continue;
    const from = occurrences.get(edge.from);
    const to = occurrences.get(edge.to);
    if (!from?.length || !to?.length) continue;
    // Show a connection once in each room shared by both elements; otherwise
    // connect their first occurrences without producing a Cartesian explosion.
    const pairs = from.flatMap(a => to.filter(b => b.group === a.group).map(b => [a, b] as const));
    if (!pairs.length) pairs.push([from[0]!, to[0]!]);
    for (const [a, b] of pairs) edges.push({ id: JSON.stringify([edgeIdentity(edge), a.id, b.id]), from: a.id, to: b.id, edge });
  }
  return edges.sort((a, b) => compareIds(a.id, b.id));
}

export function projectGraph(graph: Graph, query: GraphQuery): GraphScene {
  let effective = query;
  const explicitFocus = query.focus ? graph.node(query.focus) : undefined;
  let focus = explicitFocus;
  let scope: readonly GraphNode[];
  let relations: ReadonlySet<Relation>;
  let admits: (node: GraphNode) => boolean;
  let dependencies: DependencyScope | undefined;
  if (query.view === "home") {
    admits = node => node.side === "instance" && HOME_KINDS.has(node.kind) && node.present !== false;
    scope = graph.nodes().filter(admits).sort(byName);
    relations = relationsFor(query);
  } else {
    admits = query.view === "dependencies"
      ? node => node.side === "instance" && node.kind !== "site" && node.kind !== "catalog" && node.present !== false
      : node => node.kind !== "site" && node.kind !== "catalog" && node.present !== false;
    if (!query.focus) {
      const candidates = graph.nodes().filter(node => query.view === "dependencies" ? HOME_KINDS.has(node.kind) && admits(node) : node.kind === "model" || node.kind === "schema");
      const usefulRelations: ReadonlySet<Relation> = new Set((query.view === "dependencies"
        ? ["uses", "members", "groupSwitch"] as const : DEFINITIONS).filter(relation => !query.relations.length || query.relations.includes(relation)));
      const usefulEdges = (node: GraphNode) => graph.edgesOf(node.id).filter(edge => {
        const other = graph.node(otherEnd(edge, node.id));
        return usefulRelations.has(edge.relation) && other !== undefined && admits(other);
      });
      const scores = new Map(candidates.map(node => {
        const edges = usefulEdges(node);
        if (query.view === "model") return [node.id, Number(edges.length > 0)];
        const outgoing = edges.filter(edge => edge.from === node.id);
        const uses = outgoing.filter(edge => edge.relation === "uses");
        // Prefer a configured action chain. Two roles are more informative than
        // one, but large hubs do not receive an ever-increasing fanout bonus.
        const score = uses.length ? 3 + Math.min(uses.length, 2)
          : outgoing.some(edge => edge.relation === "groupSwitch" || edge.relation === "members") ? 2
          : edges.some(edge => edge.relation === "uses") ? 1 : 0;
        return [node.id, score];
      }));
      focus = candidates.sort((a, b) => scores.get(b.id)! - scores.get(a.id)!
        || (query.view === "model" ? Number(a.kind !== "model") - Number(b.kind !== "model") : 0) || byName(a, b))[0];
    }
    if (focus) effective = { ...query, focus: focus.id };
    relations = relationsFor(effective, focus);
    if (focus && admits(focus)) {
      if (effective.view === "dependencies") {
        dependencies = dependencyScope(graph, focus, effective, admits, relations);
        scope = dependencies.nodes;
      } else scope = modelNeighbourhood(graph, focus, effective, admits, relations);
    } else scope = [];
  }
  const filtered = scope.filter(node => matches(node, effective));
  const nodes: SceneNode[] = [];
  const groups: SceneGroup[] = [];
  const preferred = effective.selected ?? effective.focus;
  const prioritized = (a: GraphNode, b: GraphNode) => Number(b.id === preferred) - Number(a.id === preferred) || Number(b.id === focus?.id) - Number(a.id === focus?.id) || byName(a, b);
  if (effective.view === "home") {
    const expanded = new Set(effective.expanded);
    const memberships = homeGroups(graph, filtered, effective);
    for (const group of memberships) {
      const cap = expanded.has(group.id) ? EXPANDED_GROUP_LIMIT : GROUP_LIMIT;
      const shown = group.nodes.sort(byName).slice(0, Math.min(cap, Math.max(0, MAX_NODES - nodes.length)));
      for (const node of shown) nodes.push({ id: occurrence(node.id, group.id), node, group: group.id, hidden: 0 });
      groups.push({ id: group.id, name: group.name, kind: group.kind, total: group.nodes.length, hidden: group.nodes.length - shown.length });
    }
    // Selection never changes card order. Only make room for a matching selected
    // element when the ordinary caps would otherwise hide every occurrence.
    const selected = filtered.find(node => node.id === effective.selected) ?? filtered.find(node => node.id === effective.focus);
    if (selected && !nodes.some(entry => entry.node.id === selected.id)) {
      const group = memberships.find(entry => entry.nodes.some(node => node.id === selected.id))!;
      const lastInGroup = nodes.findLastIndex(entry => entry.group === group.id);
      if (lastInGroup >= 0) nodes.splice(lastInGroup, 1);
      else if (nodes.length >= MAX_NODES) nodes.pop();
      nodes.push({ id: occurrence(selected.id, group.id), node: selected, group: group.id, hidden: 0 });
      const groupOrder = new Map(memberships.map((entry, index) => [entry.id, index]));
      nodes.sort((a, b) => groupOrder.get(a.group!)! - groupOrder.get(b.group!)! || byName(a.node, b.node));
      for (let index = 0; index < groups.length; index += 1) {
        const entry = groups[index]!;
        groups[index] = { ...entry, hidden: entry.total - nodes.filter(node => node.group === entry.id).length };
      }
    }
  } else if (dependencies) {
    for (const node of dependencyNodes(dependencies, filtered, effective)) nodes.push({ id: occurrence(node.id), node, hidden: 0 });
  } else {
    for (const node of [...filtered].sort(prioritized).slice(0, MAX_NODES)) nodes.push({ id: occurrence(node.id), node, hidden: 0 });
  }
  const shownIds = new Set(nodes.map(entry => entry.node.id));
  const withCounts = nodes.map(entry => ({
    ...entry,
    hidden: neighbours(graph, entry.node.id, node => admits(node) && matches(node, effective), relations).filter(node => !shownIds.has(node.id)).length,
  }));
  const selected = effective.selected && shownIds.has(effective.selected) ? effective.selected
    : effective.focus && shownIds.has(effective.focus) ? effective.focus : nodes[0]?.node.id;
  const { selected: previousSelection, ...withoutSelection } = effective;
  effective = selected ? { ...withoutSelection, selected } : withoutSelection;
  return {
    query: effective,
    nodes: withCounts,
    edges: sceneEdges(graph, nodes, relations),
    groups,
    total: scope.length,
    matched: filtered.length,
    omitted: filtered.length - shownIds.size,
    generatedAt: graph.generatedAt,
  };
}
