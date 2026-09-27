/**
 * The built graph: nodes, edges indexed from both ends, and the reads every
 * page and route does against it.
 *
 * Construction is pure. StateData supplies configuration and observed inventory
 * already in memory and invalidates this index only when those inputs change.
 *
 * Edges are stored once in their canonical direction. `edgesOf` returns the
 * ones touching a node from either end, which is what the ego view and the
 * observer's invalidation both want.
 */
import type { ElementKind } from "../tags/identity";
import { otherEnd, relationAsSeenFrom, type GraphEdge, type GraphNode, type NodeId, type RelationName } from "./types";

export interface GraphContents {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly generatedAt: string;
}

const edgeKey = (edge: GraphEdge) => `${edge.from}\u0000${edge.to}\u0000${edge.relation}`;

export class Graph {
  readonly generatedAt: string;
  readonly #nodes: ReadonlyMap<NodeId, GraphNode>;
  readonly #edges: readonly GraphEdge[];
  readonly #nodeList: readonly GraphNode[];
  readonly #incident: ReadonlyMap<NodeId, readonly GraphEdge[]>;
  readonly #byKind: ReadonlyMap<ElementKind, readonly GraphNode[]>;
  readonly #byPage: ReadonlyMap<string, GraphNode>;

  constructor(contents: GraphContents) {
    this.generatedAt = contents.generatedAt;
    const nodes = new Map<NodeId, GraphNode>();
    for (const node of contents.nodes) if (!nodes.has(node.id)) nodes.set(node.id, node);
    this.#nodes = nodes;
    this.#nodeList = [...nodes.values()];

    // An edge whose ends are not both present would produce a dangling line.
    const seen = new Set<string>();
    const edges: GraphEdge[] = [];
    for (const edge of contents.edges) {
      if (edge.from === edge.to) continue;
      if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
      const key = edgeKey(edge);
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(edge);
    }
    this.#edges = edges;

    const incident = new Map<NodeId, GraphEdge[]>();
    const touch = (id: NodeId, edge: GraphEdge) => {
      const list = incident.get(id);
      if (list) list.push(edge);
      else incident.set(id, [edge]);
    };
    for (const edge of edges) {
      touch(edge.from, edge);
      touch(edge.to, edge);
    }
    this.#incident = incident;

    const byKind = new Map<ElementKind, GraphNode[]>();
    const byPage = new Map<string, GraphNode>();
    for (const node of nodes.values()) {
      const list = byKind.get(node.kind);
      if (list) list.push(node);
      else byKind.set(node.kind, [node]);
      if (node.page && !byPage.has(node.page)) byPage.set(node.page, node);
    }
    this.#byKind = byKind;
    this.#byPage = byPage;
  }

  get size(): number { return this.#nodes.size; }
  get edgeCount(): number { return this.#edges.length; }

  node(id: NodeId): GraphNode | undefined { return this.#nodes.get(id); }
  nodes(): readonly GraphNode[] { return this.#nodeList; }
  edges(): readonly GraphEdge[] { return this.#edges; }

  /** Every edge touching `id`, from either end. */
  edgesOf(id: NodeId): readonly GraphEdge[] { return this.#incident.get(id) ?? []; }

  /** The ids `id` is connected to, each once, in edge order. */
  neighbours(id: NodeId): readonly NodeId[] {
    const out: NodeId[] = [];
    const seen = new Set<NodeId>();
    for (const edge of this.edgesOf(id)) {
      const other = otherEnd(edge, id);
      if (seen.has(other)) continue;
      seen.add(other);
      out.push(other);
    }
    return out;
  }

  /** Neighbours reached by one of `relations`, read from `id`'s point of view. */
  relatedBy(id: NodeId, relations: ReadonlySet<RelationName>): readonly NodeId[] {
    const out: NodeId[] = [];
    const seen = new Set<NodeId>();
    for (const edge of this.edgesOf(id)) {
      if (!relations.has(relationAsSeenFrom(edge, id))) continue;
      const other = otherEnd(edge, id);
      if (seen.has(other)) continue;
      seen.add(other);
      out.push(other);
    }
    return out;
  }

  byKind(kind: ElementKind): readonly GraphNode[] { return this.#byKind.get(kind) ?? []; }

  /** The node a page path renders, for resolving a URL to a node. */
  byPage(page: string): GraphNode | undefined { return this.#byPage.get(page); }

  /** Every instance node pointing at `schema` through the `instanceOf` bridge. */
  instancesOf(schema: NodeId): readonly GraphNode[] {
    return this.nodes().filter((node) => node.schema === schema);
  }

  /**
   * True when `to` is reachable from `from` over `relations` within `limit`
   * hops. Used to prune a group's automatic membership: a composite and the
   * device it drives must not both receive the same command.
   */
  reaches(from: NodeId, to: NodeId, relations: ReadonlySet<RelationName>, limit = 6): boolean {
    const seen = new Set<NodeId>([from]);
    let frontier: NodeId[] = [from];
    for (let depth = 0; depth < limit && frontier.length; depth += 1) {
      const next: NodeId[] = [];
      for (const id of frontier) {
        for (const candidate of this.relatedBy(id, relations)) {
          if (candidate === to) return true;
          if (seen.has(candidate)) continue;
          seen.add(candidate);
          next.push(candidate);
        }
      }
      frontier = next;
    }
    return false;
  }
}
