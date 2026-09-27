/**
 * The tag graph: the ontology, beside the schema graph and the instance graph.
 *
 * A tag name (`room`, `floor`) is a node, and each value under it is a node
 * with a `declares` edge from its name. That is what makes this an ontology
 * rather than a table with a spare column: cardinality, display label and
 * ordering belong to the *name*, and it has somewhere to live. Plain tags all
 * hang off one implicit unnamed root.
 *
 *     tag-name:room ──declares──▶ tag:room=Master Bathroom ──tagged──▶ device:…
 *     tag-name:room ──declares──▶ tag:room=Kitchen
 *     (unnamed root) ──declares──▶ tag:#kitchen
 *
 * Exactly one relation crosses out of this side: `tagged`, from a value to the
 * element carrying it. Tags are never elements — `listElements()` projects only
 * the schema and instance sides — so nothing here can itself be tagged.
 */
import { elementKey } from "../tags/identity";
import { tagLabel, tagPage, UNNAMED, type Tag, type TagName } from "../tags/model";
import { iconFor } from "./icons";
import type { GraphEdge, GraphNode, NodeId } from "./types";

/** The node for a tag value. Keyed on the pair, which is its identity. */
export const tagNode = (tag: Pick<Tag, "name" | "value">): NodeId => elementKey("tag", tag.name || UNNAMED, tag.value);
/** The node for a tag name. The unnamed root is the empty name. */
export const tagNameNode = (name: string): NodeId => elementKey("tag-name", name || UNNAMED);

/** What the unnamed root is called where a name would otherwise be shown. */
export const UNNAMED_LABEL = "Tags";

export interface TagSnapshot {
  readonly tags: readonly Tag[];
  readonly names: readonly TagName[];
  /** Element key to the tag ids it carries, as the store records them. */
  readonly assignments: ReadonlyMap<string, readonly string[]>;
}

/**
 * Nodes and edges for the ontology. The `tagged` edges are emitted for every
 * assignment; `Graph` drops the ones whose element is not in the graph, which
 * is what keeps a stale assignment to a removed device from drawing a line to
 * nothing.
 */
export function buildTagGraph(snapshot: TagSnapshot): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const labels = new Map<string, TagName>(snapshot.names.map(name => [name.name, name]));
  // Every name a tag actually uses, plus every declared one, plus the root.
  const used = new Set<string>([UNNAMED, ...snapshot.names.map(name => name.name), ...snapshot.tags.map(tag => tag.name || UNNAMED)]);

  for (const name of [...used].sort()) {
    const declared = labels.get(name);
    nodes.push({
      id: tagNameNode(name),
      side: "tag",
      kind: "tag-name",
      name: declared?.label ?? (name || UNNAMED_LABEL),
      context: declared?.cardinality === "single" ? "one per element" : "",
      page: name ? `/tags/${encodeURIComponent(name)}` : "/tags",
      icon: iconFor({ kind: "tag-name" }),
      ids: [name || UNNAMED],
    });
  }

  const byId = new Map<string, Tag>(snapshot.tags.map(tag => [tag.id, tag]));
  for (const tag of snapshot.tags) {
    const name = tag.name || UNNAMED;
    nodes.push({
      id: tagNode(tag),
      side: "tag",
      kind: "tag",
      name: tag.value,
      context: name ? (labels.get(name)?.label ?? name) : "",
      page: tagPage(tag),
      icon: iconFor({ kind: "tag" }),
      ids: [name, tag.value],
    });
    edges.push({ from: tagNameNode(name), to: tagNode(tag), relation: "declares", origin: "structure" });
  }

  for (const [element, ids] of snapshot.assignments) {
    for (const id of ids) {
      const tag = byId.get(id);
      if (!tag) continue;
      edges.push({ from: tagNode(tag), to: element, relation: "tagged", label: tagLabel(tag), origin: "site" });
    }
  }

  return { nodes, edges };
}
