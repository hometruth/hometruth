/**
 * The flat element list the tags UI and `/api/elements` speak.
 *
 * This is now a view over `src/graph`: the graph owns what exists and how it is
 * connected, and this projects each node into the shape those callers already
 * expect. Nothing about the `Element` record changed, so every stored tag
 * assignment and every `/elements/<key>` URL keeps working.
 *
 * This projection receives the state service's in-memory topology. It performs
 * no discovery or storage reads, including when a device has never answered.
 *
 * New primitive types contribute by becoming graph nodes rather than by
 * implementing a separate tagging system. Tags themselves are never elements.
 */
import type { Graph } from "../graph/graph";
import type { GraphNode } from "../graph/types";
import { elementKey, type ElementKind } from "./identity";

export { elementKey } from "./identity";

export interface Element {
  key: string;
  kind: ElementKind;
  name: string;
  context: string;
  page: string;
  sourcePage?: string;
  parentKey?: string;
}

export function elementPage(key: string): string { return `/elements/${key}`; }

/** Containment through the site and its catalogs is navigation, not parentage. */
const SPINE: ReadonlySet<ElementKind> = new Set<ElementKind>(["site", "catalog"]);

function project(node: GraphNode, parents: ReadonlyMap<string, string>): Element {
  const parentKey = parents.get(node.id);
  return {
    key: node.id,
    kind: node.kind,
    name: node.name,
    context: node.context,
    page: elementPage(node.id),
    ...(node.page ? { sourcePage: node.page } : {}),
    ...(parentKey ? { parentKey } : {}),
  };
}

/**
 * Lists identities and metadata; no control, scene, or automation is executed.
 * Instance nodes come first, because those are the things people tag; the
 * schema side follows.
 */
export function listElements(graph: Graph): Element[] {
  const parents = new Map<string, string>();
  for (const edge of graph.edges()) {
    if (edge.relation !== "contains") continue;
    if (SPINE.has(graph.node(edge.from)?.kind ?? "device")) continue;
    if (!parents.has(edge.to)) parents.set(edge.to, edge.from);
  }

  const instances: Element[] = [];
  const schemas: Element[] = [];
  for (const node of graph.nodes()) {
    // The tag side is not projected: tags are not elements, so nothing can tag
    // one and `/api/elements` never lists one. A plain `side !== "instance"`
    // test would file them under the schema side instead.
    if (node.side === "tag") continue;
    (node.side === "instance" ? instances : schemas).push(project(node, parents));
  }
  return [...instances, ...schemas];
}

/** One element by key, without projecting the whole list. */
export function findElement(graph: Graph, key: string): Element | undefined {
  const node = graph.node(key);
  // Same reason as `listElements`: a tag is not an element, so it is not one
  // that can be found, tagged, or shown an element page.
  if (!node || node.side === "tag") return undefined;
  const parents = new Map<string, string>();
  for (const edge of graph.edgesOf(key)) {
    if (edge.relation !== "contains" || edge.to !== key) continue;
    if (SPINE.has(graph.node(edge.from)?.kind ?? "device")) continue;
    parents.set(key, edge.from);
    break;
  }
  return project(node, parents);
}

/** The key for an element, for callers that only have its parts. */
export function keyFor(kind: ElementKind, ...ids: string[]): string {
  return elementKey(kind, ...ids);
}
