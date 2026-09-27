/**
 * Turning an ego graph into coordinates. Pure maths, no DOM, run on the server.
 *
 * Doing this here rather than in the browser buys four things: one
 * implementation (browser modules may only `import type` from outside their own
 * folders), no first-paint flash because coordinates arrive with the page, a
 * diagram that renders with scripts off, and a layout that can be asserted in
 * ordinary unit tests.
 *
 * The layout is deterministic and needs no simulation. The focus sits at the
 * origin; depth-1 neighbours are grouped into sectors by relation, each sector
 * anchored on a compass direction so the *kind* of relationship is readable
 * from position alone (what a thing is part of sits above it, what it drives
 * sits to its right, what drives it to its left, its parts below). Depth-2
 * nodes sit further out within their parent's slice, and a node with several
 * parents is placed once, at their angular mean, keeping an edge to each.
 *
 * A force simulation would move nodes between reloads, which is unacceptable
 * for a page people navigate repeatedly; it would also need a library, and the
 * product ships no external scripts and has no build step.
 */
import type { Ego, EgoNode } from "./ego";
import type { GraphEdge, NodeId, RelationName } from "./types";

/** Radians, measured clockwise from twelve o'clock, which is how the table reads. */
const clock = (hour: number): number => (hour / 12) * Math.PI * 2;

/**
 * Where each relation prefers to sit. Opposites are opposite: `partOf` above
 * and `contains` below, `uses` right and `usedBy` left.
 */
const PREFERRED: Readonly<Partial<Record<RelationName, number>>> = {
  partOf: clock(12), memberOf: clock(12), basedOnGroup: clock(11.5),
  instanceOf: clock(1.5), instances: clock(10.5),
  implements: clock(1.5), implementedBy: clock(10.5),
  describesAs: clock(1), describedBy: clock(11),
  declares: clock(2), declaredBy: clock(10),
  references: clock(2.5), referencedBy: clock(9.5),
  refines: clock(1), refinedBy: clock(11),
  uses: clock(3), usedBy: clock(9),
  services: clock(4.5), servicedBy: clock(7.5),
  emits: clock(4), emittedBy: clock(8),
  sourcedBy: clock(10.5), sources: clock(4.5),
  contains: clock(6), members: clock(6), defines: clock(6), definedBy: clock(12),
  groupSwitch: clock(10.5),
  locatedIn: clock(7.5), locates: clock(4.5),
  // A tag reads like a placement: standing on a device, the room it is in sits
  // lower left, exactly where `locatedIn` used to put it.
  taggedWith: clock(7.5), tagged: clock(4.5),
};

export interface LayoutOptions {
  /** Radius of the first ring. */
  readonly innerRadius?: number;
  /** Extra radius for the second ring. */
  readonly ringGap?: number;
  /** Longest label drawn before it is cut; the full name stays in the title. */
  readonly labelChars?: number;
  /** Below this many depth-1 neighbours the ring tightens up. */
  readonly margin?: number;
}

export interface PlacedNode extends EgoNode {
  readonly x: number;
  readonly y: number;
  /** The name as drawn, cut to `labelChars`. */
  readonly label: string;
  readonly angle: number;
  /** Which side of the diagram it is on, so a label can hang away from the centre. */
  readonly anchor: "start" | "middle" | "end";
}

export interface PlacedTruncation {
  readonly from: NodeId;
  readonly relation: RelationName;
  readonly hidden: number;
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly anchor: "start" | "middle" | "end";
}

export interface Layout {
  readonly focus: NodeId;
  readonly nodes: readonly PlacedNode[];
  readonly edges: readonly GraphEdge[];
  readonly truncated: readonly PlacedTruncation[];
  /** `x y width height`, already padded for labels. */
  readonly viewBox: readonly [number, number, number, number];
}

const TAU = Math.PI * 2;
/** Angular spacing between two neighbours in the same bucket. */
const PER_ITEM = 0.42;
/** Clear air between one relation's arc and the next. */
const BUCKET_GAP = 0.34;
/** How far a `+N` chip sits beyond the node it belongs to. */
const CHIP_OFFSET = 52;

function normalise(angle: number): number {
  const wrapped = angle % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
}

/** Twelve o'clock is up, and SVG's y axis points down. */
function place(angle: number, radius: number): { x: number; y: number } {
  return { x: Math.sin(angle) * radius, y: -Math.cos(angle) * radius };
}

function anchorFor(angle: number): "start" | "middle" | "end" {
  const a = normalise(angle);
  if (a < 0.2 || a > TAU - 0.2 || Math.abs(a - Math.PI) < 0.2) return "middle";
  return a < Math.PI ? "start" : "end";
}

function cut(name: string, limit: number): string {
  const trimmed = name.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

export function layout(graph: Ego, options: LayoutOptions = {}): Layout {
  const labelChars = options.labelChars ?? 18;
  const ringGap = options.ringGap ?? 130;
  const margin = options.margin ?? 24;

  const focus = graph.nodes.find((entry) => entry.depth === 0);
  const first = graph.nodes.filter((entry) => entry.depth === 1);
  const second = graph.nodes.filter((entry) => entry.depth === 2);

  // Sectors: each relation claims an arc centred on its preferred direction,
  // sized by its share of the ring.
  const buckets = new Map<RelationName, EgoNode[]>();
  for (const entry of first) {
    const relation = entry.via ?? "uses";
    const bucket = buckets.get(relation);
    if (bucket) bucket.push(entry);
    else buckets.set(relation, [entry]);
  }

  const angles = new Map<NodeId, number>();

  // Each bucket wants its preferred bearing and needs an arc wide enough for
  // its members. Two relations can prefer the same direction (what a device is
  // `partOf` and what it is a `memberOf` both read as "above"), so the buckets
  // are swept in bearing order and each is pushed just far enough past the last
  // to stop them landing on top of each other. When the ring cannot hold them
  // all, they share it evenly instead.
  const claims = [...buckets.entries()].map(([relation, entries]) => ({
    relation, entries,
    desired: normalise(PREFERRED[relation] ?? clock(3)),
    half: ((entries.length - 1) * PER_ITEM) / 2,
    centre: 0,
  })).sort((a, b) => a.desired - b.desired);

  const needed = claims.reduce((sum, claim) => sum + claim.half * 2 + BUCKET_GAP, 0);
  if (needed > TAU) {
    let cursor = claims[0]?.desired ?? 0;
    for (const claim of claims) {
      const share = ((claim.half * 2 + BUCKET_GAP) / needed) * TAU;
      claim.centre = cursor + share / 2;
      claim.half = Math.max(0, (share - BUCKET_GAP) / 2);
      cursor += share;
    }
  } else {
    let cursor = -Infinity;
    for (const claim of claims) {
      claim.centre = cursor === -Infinity ? claim.desired : Math.max(claim.desired, cursor + claim.half + BUCKET_GAP);
      cursor = claim.centre + claim.half;
    }
  }

  for (const claim of claims) {
    const { entries, centre, half } = claim;
    const step = entries.length > 1 ? (half * 2) / (entries.length - 1) : 0;
    entries.forEach((entry, index) => {
      angles.set(entry.node.id, entries.length > 1 ? centre - half + step * index : centre);
    });
  }

  // The ring has to be wide enough that neighbours do not collide.
  const innerRadius = options.innerRadius ?? Math.max(160, Math.round(46 / Math.max(0.12, Math.min(PER_ITEM, TAU / Math.max(1, first.length)))));

  const parents = new Map<NodeId, NodeId[]>();
  for (const edge of graph.edges) {
    for (const [child, parent] of [[edge.to, edge.from], [edge.from, edge.to]] as const) {
      if (!second.some((entry) => entry.node.id === child)) continue;
      if (!first.some((entry) => entry.node.id === parent)) continue;
      const list = parents.get(child);
      if (list) { if (!list.includes(parent)) list.push(parent); }
      else parents.set(child, [parent]);
    }
  }

  // A depth-2 node with several parents is placed once, at their mean bearing,
  // which is what makes two buttons visibly converge on one blaster.
  const byParent = new Map<string, EgoNode[]>();
  for (const entry of second) {
    const key = (parents.get(entry.node.id) ?? []).slice().sort().join("\u0000");
    const list = byParent.get(key);
    if (list) list.push(entry);
    else byParent.set(key, [entry]);
  }
  for (const [key, entries] of byParent) {
    const owners = key ? key.split("\u0000") : [];
    const bearings = owners.map((owner) => angles.get(owner)).filter((value): value is number => value !== undefined);
    const centre = bearings.length
      ? Math.atan2(bearings.reduce((sum, a) => sum + Math.sin(a), 0), bearings.reduce((sum, a) => sum + Math.cos(a), 0))
      : clock(6);
    const span = Math.min(0.5 * entries.length, TAU / 5);
    const step = entries.length > 1 ? span / (entries.length - 1) : 0;
    entries.forEach((entry, index) => {
      angles.set(entry.node.id, entries.length > 1 ? centre - span / 2 + step * index : centre);
    });
  }

  const placed: PlacedNode[] = [];
  if (focus) placed.push({ ...focus, x: 0, y: 0, label: cut(focus.node.name, labelChars), angle: 0, anchor: "middle" });
  for (const entry of first) {
    const angle = angles.get(entry.node.id) ?? 0;
    placed.push({ ...entry, ...place(angle, innerRadius), label: cut(entry.node.name, labelChars), angle, anchor: anchorFor(angle) });
  }
  for (const entry of second) {
    const angle = angles.get(entry.node.id) ?? clock(6);
    placed.push({ ...entry, ...place(angle, innerRadius + ringGap), label: cut(entry.node.name, labelChars), angle, anchor: anchorFor(angle) });
  }

  // A `+N` chip sits just beyond the node whose neighbours it stands for, so it
  // reads as belonging to that node rather than floating free.
  const depthOf = new Map(graph.nodes.map((entry) => [entry.node.id, entry.depth]));
  const truncated: PlacedTruncation[] = graph.truncated.map((entry) => {
    const isFocus = entry.from === graph.focus;
    const angle = isFocus ? PREFERRED[entry.relation] ?? clock(3) : angles.get(entry.from) ?? clock(6);
    const ownerRadius = isFocus ? 0 : depthOf.get(entry.from) === 2 ? innerRadius + ringGap : innerRadius;
    const radius = isFocus ? innerRadius * 0.55 : ownerRadius + CHIP_OFFSET;
    return { ...entry, ...place(angle, radius), angle, anchor: anchorFor(angle) };
  });

  const xs = [...placed.map((entry) => entry.x), ...truncated.map((entry) => entry.x), 0];
  const ys = [...placed.map((entry) => entry.y), ...truncated.map((entry) => entry.y), 0];
  // Labels hang past their node, so the box is widened rather than clipped.
  const pad = margin + labelChars * 4;
  const minX = Math.min(...xs) - pad;
  const maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - margin - 28;
  const maxY = Math.max(...ys) + margin + 28;

  return {
    focus: graph.focus,
    nodes: placed,
    edges: graph.edges,
    truncated,
    viewBox: [Math.round(minX), Math.round(minY), Math.round(maxX - minX), Math.round(maxY - minY)],
  };
}
