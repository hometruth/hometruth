/**
 * The vocabulary of the graph: what a node is, what an edge is, and how a node
 * is identified.
 *
 * There are three graphs and two bridges between them. The *schema graph* is
 * abstract and identical on every install: schemas, models, capability kinds,
 * control and property definitions, event types. The *instance graph* is this
 * home: the site, its devices, capabilities, groups, services. The *tag graph*
 * is the ontology: names such as `room`, and the values under them.
 *
 * Exactly one relation crosses each way. Every instance node carries one
 * `instanceOf` edge into the schema graph; every tag value carries `tagged`
 * edges to the elements holding it. Nothing else crosses a side.
 *
 * Builders use deterministic element keys to reconcile desired nodes. The
 * store assigns persistent UUIDs and retains those keys as natural keys.
 * Display names and schema positions must not be treated as durable identity.
 */
import type { ElementKind } from "../tags/identity";

/** An element key: `root` for the site, otherwise base64url of `[kind, ...ids]`. */
export type NodeId = string;

/**
 * Which of the three graphs a node belongs to.
 *
 * The *tag graph* is the ontology: names and the values under them. It joins on
 * the same terms as the other crossing — exactly one relation crosses into it,
 * `tagged`, from a tag value to the element carrying it. Tags are never
 * elements, so `listElements()` projects only the schema and instance sides and
 * nothing can tag a tag.
 */
export type GraphSide = "schema" | "instance" | "tag";

/**
 * A node's icon. Emoji today; `image` is carried end to end so adopting real
 * artwork later is a data change rather than a code change. An image source is
 * always a local path under `/icons/`, never an external URL: the CSP is
 * nonce-only with no external origins.
 */
export type Icon =
  | { readonly kind: "emoji"; readonly value: string }
  | { readonly kind: "image"; readonly src: string; readonly alt?: string };

export interface GraphNode {
  readonly id: NodeId;
  readonly side: GraphSide;
  readonly kind: ElementKind;
  readonly name: string;
  /** Where this sits, for a list row: "Gate relay · binarySwitch". */
  readonly context: string;
  /** The page that renders this thing itself, when it has one. */
  readonly page: string;
  readonly icon: Icon;
  /** The decoded id parts of the key, for the CLI and for debugging. */
  readonly ids: readonly string[];
  /** The schema-graph node this is an instance of; absent on schema-side nodes. */
  readonly schema?: NodeId;
  /** The state node this maps to, when it is observable. */
  readonly stateNode?: string;
  /** False once the config no longer declares it, but something still refers to it. */
  readonly present?: boolean;
}

export interface GraphEdge {
  readonly from: NodeId;
  readonly to: NodeId;
  readonly relation: Relation;
  /** The role this reference plays, shown on the edge: "on", "off", "member 3". */
  readonly label?: string;
  /**
   * The capability the reference actually narrowed to, when it did. An
   * optimistic switch resolves its buttons to a `Button` capability, not to the
   * whole device. The edge still joins the two *devices*, because an edge into
   * a capability node disconnects the graph: traversal from the switch would
   * stop there instead of reaching the blaster the button drives. The narrowing
   * is kept here so nothing is lost and the diagram can name it.
   */
  readonly via?: string;
  readonly origin: EdgeOrigin;
}

/**
 * Where an edge came from. Kept so `ht graph <id> --explain` can answer
 * "why is this line here" without guessing from its endpoints.
 */
export type EdgeOrigin =
  /** Containment: `parentKey`, `Device.parent`, the site/catalog spine. */
  | "structure"
  /** Recorded when a composite resolved a sibling during provisioning. */
  | "resolution"
  /** Derived by the site from config it can see across devices. */
  | "site"
  /** Walked out of the schema documents themselves. */
  | "schema"
  /** Projected from what writes a node's state. */
  | "source";

/**
 * Every relation, with the name for reading it from the other end. An edge is
 * stored once in the canonical direction; the ego view labels it with
 * `relation` when you stand on `from` and `inverse` when you stand on `to`, so
 * "A uses B" and "B used by A" can never disagree.
 */
export const RELATIONS = {
  contains: "partOf",
  members: "memberOf",
  uses: "usedBy",
  groupSwitch: "basedOnGroup",
  services: "servicedBy",
  locatedIn: "locates",
  emits: "emittedBy",
  sourcedBy: "sources",
  instanceOf: "instances",
  implements: "implementedBy",
  declares: "declaredBy",
  describesAs: "describedBy",
  defines: "definedBy",
  references: "referencedBy",
  refines: "refinedBy",
  tagged: "taggedWith",
} as const satisfies Record<string, string>;

export type Relation = keyof typeof RELATIONS;
export type Inverse = typeof RELATIONS[Relation];
/** Either direction's name, which is what a label and an i18n key are keyed on. */
export type RelationName = Relation | Inverse;

export const RELATION_NAMES = Object.keys(RELATIONS) as readonly Relation[];

/** Both directions of every relation: what an edge can read as from either end. */
export const ALL_RELATION_NAMES: readonly RelationName[] = [
  ...RELATION_NAMES,
  ...RELATION_NAMES.map((relation) => RELATIONS[relation]),
];

export function inverseOf(relation: Relation): Inverse {
  return RELATIONS[relation];
}

/** True when `id` is the `from` end, so the edge reads in its canonical direction. */
export function relationAsSeenFrom(edge: GraphEdge, id: NodeId): RelationName {
  return edge.from === id ? edge.relation : inverseOf(edge.relation);
}

export function otherEnd(edge: GraphEdge, id: NodeId): NodeId {
  return edge.from === id ? edge.to : edge.from;
}
