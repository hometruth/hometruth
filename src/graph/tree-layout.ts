/**
 * Placing the default view: a layered tree, the root at the top and every node
 * one row below its parent.
 *
 * The radial layout in `layout.ts` suits a neighbourhood, where the focus is
 * the middle of everything. This view is a hierarchy — where an element sits,
 * and what it is made of — so depth is the y axis and reading down the page is
 * reading away from the root. Relations that are not containment are drawn
 * across the rows, which is what makes a lateral link visibly lateral.
 *
 * Deterministic, like the radial one, and for the same reason: a page people
 * navigate repeatedly must not rearrange itself between visits.
 */
import type { GraphEdge, NodeId } from "./types";
import type { GraphView, ViewNode } from "./view";

export interface TreeLayoutOptions {
  readonly rowHeight?: number;
  readonly columnWidth?: number;
  readonly labelChars?: number;
  readonly margin?: number;
}

export interface PlacedTreeNode {
  readonly view: ViewNode;
  readonly x: number;
  readonly y: number;
  /** The name as drawn; the full one stays on the node. */
  readonly label: string;
  /** Where the expander stub ends, when this node has more to show. */
  readonly expander?: { readonly x: number; readonly y: number };
  /** False when there is no room for a name without it colliding with its neighbours. */
  readonly showLabel: boolean;
}

export interface TreeLayout {
  readonly focus: NodeId;
  readonly nodes: readonly PlacedTreeNode[];
  readonly edges: readonly GraphEdge[];
  readonly viewBox: readonly [number, number, number, number];
}

const ROW = 104;
const COLUMN = 156;
/**
 * The expander sits beside a node, not under it: under is where the label goes
 * and where the line to its children leaves, so a `+` there is invisible behind
 * one and tangled with the other.
 */
const EXPANDER_OFFSET = 30;

/**
 * The widest a drawing is allowed to be relative to its height.
 *
 * A four-node chain is naturally tall and thin. Scaled to the width of the
 * column it would be nearly two thousand pixels high, which is a scroll, not a
 * diagram. Padding the box sideways centres the drawing and keeps its height
 * where the eye can take it in; it costs empty margin, which is cheaper than
 * a page you have to scroll to read one line of.
 */
const MIN_ASPECT = 1.6;

/** Arc a node needs at its own radius before its name is worth drawing. */
const LABEL_ROOM = 34;

/**
 * How a branch's arc is worked out from the number of leaves under it.
 *
 * Not proportionally. A catalog of a hundred schemas would take a hundred times
 * the arc of one holding a single room, squeezing the small ones into slivers
 * too thin to label or to click, and the top ring is where the least crowded
 * and most useful nodes live. The square root keeps the big branches visibly
 * bigger while leaving the small ones usable, and the constant stops a leaf
 * collapsing to nothing.
 */
function arcWeight(leaves: number): number {
  return Math.sqrt(Math.max(1, leaves)) + 0.6;
}


/** Widen a box symmetrically until it is at least `MIN_ASPECT` times its height. */
function withMinAspect(minX: number, minY: number, width: number, height: number): [number, number, number, number] {
  if (height <= 0 || width / height >= MIN_ASPECT) return [minX, minY, width, height];
  const wanted = height * MIN_ASPECT;
  const grow = (wanted - width) / 2;
  return [Math.round(minX - grow), minY, Math.round(wanted), height];
}

function cut(name: string, limit: number): string {
  const trimmed = name.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

export function layoutTree(view: GraphView, options: TreeLayoutOptions = {}): TreeLayout {
  const rowHeight = options.rowHeight ?? ROW;
  const columnWidth = options.columnWidth ?? COLUMN;
  const labelChars = options.labelChars ?? 20;
  const margin = options.margin ?? 40;

  const rows = new Map<number, ViewNode[]>();
  for (const entry of view.nodes) {
    const row = rows.get(entry.depth);
    if (row) row.push(entry);
    else rows.set(entry.depth, [entry]);
  }
  const depths = [...rows.keys()].sort((a, b) => a - b);

  // Ordered top-down: a node sits under the parent it hangs from, so a row
  // follows the order of the row above rather than being sorted on its own.
  const position = new Map<NodeId, number>();
  const x = new Map<NodeId, number>();
  for (const depth of depths) {
    const row = rows.get(depth)!;
    row.sort((a, b) => {
      const left = a.parent === undefined ? Number.POSITIVE_INFINITY : position.get(a.parent) ?? Number.POSITIVE_INFINITY;
      const right = b.parent === undefined ? Number.POSITIVE_INFINITY : position.get(b.parent) ?? Number.POSITIVE_INFINITY;
      return left - right || a.node.name.localeCompare(b.node.name) || a.node.id.localeCompare(b.node.id);
    });
    row.forEach((entry, index) => {
      position.set(entry.node.id, index);
      x.set(entry.node.id, (index - (row.length - 1) / 2) * columnWidth);
    });
  }

  // Then settle each parent over the children it actually has, which stops a
  // long row dragging its parent away from the branch it belongs to.
  for (const depth of [...depths].reverse()) {
    for (const entry of rows.get(depth)!) {
      const children = view.nodes.filter((candidate) => candidate.parent === entry.node.id && candidate.depth > depth);
      if (!children.length) continue;
      const positions = children.map((child) => x.get(child.node.id) ?? 0);
      const centre = (Math.min(...positions) + Math.max(...positions)) / 2;
      const row = rows.get(depth)!;
      const index = position.get(entry.node.id) ?? 0;
      const before = row[index - 1] ? (x.get(row[index - 1]!.node.id) ?? 0) + columnWidth : Number.NEGATIVE_INFINITY;
      const after = row[index + 1] ? (x.get(row[index + 1]!.node.id) ?? 0) - columnWidth : Number.POSITIVE_INFINITY;
      x.set(entry.node.id, Math.min(Math.max(centre, before), after));
    }
  }

  const placed: PlacedTreeNode[] = view.nodes.map((entry) => {
    const px = Math.round(x.get(entry.node.id) ?? 0);
    const py = entry.depth * rowHeight;
    return {
      view: entry, x: px, y: py, label: cut(entry.node.name, labelChars), showLabel: true,
      ...(entry.hidden > 0 ? { expander: { x: px + EXPANDER_OFFSET, y: py } } : {}),
    };
  });

  const xs = placed.flatMap((entry) => entry.expander ? [entry.x, entry.expander.x + 10] : [entry.x]);
  const ys = placed.map((entry) => entry.y);
  const pad = margin + labelChars * 3.6;
  const minX = Math.round(Math.min(...xs, 0) - pad);
  const maxX = Math.round(Math.max(...xs, 0) + pad);
  const minY = Math.round(Math.min(...ys, 0) - margin);
  const maxY = Math.round(Math.max(...ys, 0) + margin + 26);

  return {
    focus: view.focus,
    nodes: placed,
    edges: view.edges,
    viewBox: withMinAspect(minX, minY, maxX - minX, maxY - minY),
  };
}

/**
 * The whole graph, as a radial tree: the root in the middle, each depth a ring
 * further out, every branch given an angular share of the circle proportional
 * to how many leaves it carries.
 *
 * The column tree above is right for a handful of nodes and hopeless for two
 * hundred, where it would be tens of thousands of pixels wide. A radial tree
 * packs the same hierarchy into a disc, which is the difference between an
 * overview you can take in and one you have to scroll along.
 */
export function layoutRadial(view: GraphView, options: TreeLayoutOptions = {}): TreeLayout {
  // Fixed rings, deliberately. Growing the disc to give crowded rings more arc
  // does not help: the drawing is scaled to the width it is given, so a bigger
  // viewBox just makes every node smaller. What actually buys room is showing
  // fewer nodes, which is what the cap is for.
  const ring = options.rowHeight ?? 128;
  const labelChars = options.labelChars ?? 16;
  const margin = options.margin ?? 48;

  const children = new Map<NodeId, ViewNode[]>();
  const roots: ViewNode[] = [];
  for (const entry of view.nodes) {
    if (entry.parent === undefined) { roots.push(entry); continue; }
    const list = children.get(entry.parent);
    if (list) list.push(entry);
    else children.set(entry.parent, [entry]);
  }
  for (const list of children.values()) list.sort((a, b) => a.node.name.localeCompare(b.node.name) || a.node.id.localeCompare(b.node.id));

  // A branch's width is how many leaves hang off it, so a catalog of a hundred
  // schemas gets a hundred times the arc of one that holds a single thing.
  const weights = new Map<NodeId, number>();
  const weigh = (entry: ViewNode, guard: Set<NodeId>): number => {
    if (weights.has(entry.node.id)) return weights.get(entry.node.id)!;
    if (guard.has(entry.node.id)) return 1;
    guard.add(entry.node.id);
    const kids = children.get(entry.node.id) ?? [];
    const weight = kids.length ? kids.reduce((sum, kid) => sum + weigh(kid, guard), 0) : 1;
    weights.set(entry.node.id, weight);
    return weight;
  };
  for (const entry of roots) weigh(entry, new Set());

  const angles = new Map<NodeId, number>();
  const assign = (entry: ViewNode, start: number, span: number, guard: Set<NodeId>) => {
    if (guard.has(entry.node.id)) return;
    guard.add(entry.node.id);
    angles.set(entry.node.id, start + span / 2);
    const kids = children.get(entry.node.id) ?? [];
    // The root's own children are the catalogs: a fixed, small, navigational
    // set whose relative sizes are not the point, and the ring with the most
    // room to say what things are. They share the circle equally; everything
    // deeper is weighted by what it carries.
    const equal = entry.depth === 0;
    const effective = (kid: ViewNode) => equal ? 1 : arcWeight(weights.get(kid.node.id) ?? 1);
    const total = kids.reduce((sum, kid) => sum + effective(kid), 0) || 1;
    let cursor = start;
    for (const kid of kids) {
      const share = (effective(kid) / total) * span;
      assign(kid, cursor, share, guard);
      cursor += share;
    }
  };
  const guard = new Set<NodeId>();
  const totalWeight = roots.reduce((sum, entry) => sum + arcWeight(weights.get(entry.node.id) ?? 1), 0) || 1;
  let cursor = 0;
  for (const entry of roots) {
    const share = (arcWeight(weights.get(entry.node.id) ?? 1) / totalWeight) * Math.PI * 2;
    assign(entry, cursor, share, guard);
    cursor += share;
  }

  // Four hundred names crammed onto one ring is not a label, it is a smudge, so
  // a node only carries one where there is arc to put it in. What decides that
  // is the gap to its neighbours on the same ring, not the size of its own
  // subtree: a branch with one child is the *least* crowded thing on the ring
  // and must not lose its name because the branch beside it is enormous.
  const ringOf = new Map<number, { id: NodeId; angle: number }[]>();
  for (const entry of view.nodes) {
    const row = ringOf.get(entry.depth);
    const at = { id: entry.node.id, angle: angles.get(entry.node.id) ?? 0 };
    if (row) row.push(at);
    else ringOf.set(entry.depth, [at]);
  }
  const gaps = new Map<NodeId, number>();
  for (const row of ringOf.values()) {
    row.sort((a, b) => a.angle - b.angle);
    row.forEach((at, index) => {
      if (row.length < 2) { gaps.set(at.id, Math.PI * 2); return; }
      const before = row[(index - 1 + row.length) % row.length]!;
      const after = row[(index + 1) % row.length]!;
      const wrap = (value: number) => Math.abs(((value + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      gaps.set(at.id, Math.min(wrap(at.angle - before.angle), wrap(after.angle - at.angle)));
    });
  }

  const placed: PlacedTreeNode[] = view.nodes.map((entry) => {
    const angle = angles.get(entry.node.id) ?? 0;
    const radius = entry.depth * ring;
    const room = radius === 0 ? Number.POSITIVE_INFINITY : radius * (gaps.get(entry.node.id) ?? 0);
    return {
      view: entry,
      x: Math.round(Math.sin(angle) * radius),
      y: Math.round(-Math.cos(angle) * radius),
      label: cut(entry.node.name, labelChars),
      showLabel: entry.role === "focus" || room >= LABEL_ROOM,
    };
  });

  const xs = placed.map((entry) => entry.x);
  const ys = placed.map((entry) => entry.y);
  const pad = margin + labelChars * 3.6;
  const minX = Math.round(Math.min(...xs, 0) - pad);
  const maxX = Math.round(Math.max(...xs, 0) + pad);
  const minY = Math.round(Math.min(...ys, 0) - margin);
  const maxY = Math.round(Math.max(...ys, 0) + margin + 26);

  return { focus: view.focus, nodes: placed, edges: view.edges, viewBox: withMinAspect(minX, minY, maxX - minX, maxY - minY) };
}
