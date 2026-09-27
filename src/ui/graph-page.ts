/**
 * The Graph tab: where an element sits, and what it is made of.
 *
 * The default is deliberately small — the element's path back to HomeTruth
 * itself, and its immediate children. A neighbourhood view answers "what
 * touches this", which on a real house means the state hub, the room's other
 * thirty devices, and every group it falls into, with the two useful facts
 * buried somewhere inside. Anything not drawn is counted on the node it hangs
 * off, as a dotted stub ending in a `+`.
 *
 * Every control is a link and the whole view state lives in the URL: which
 * nodes are open, which kinds are shown. So a view is shareable, survives a
 * reload, needs no client state, and works with scripts off. That matters
 * because the SVG is rendered here, not in the browser: the layout is
 * server-side maths, so the page arrives complete and measures nothing after
 * paint.
 *
 * Geometry is attributes and everything else is classes over theme tokens,
 * because the CSP is nonce-only and the design system forbids inline styles.
 *
 * There is deliberately no `ht-graph` custom element. Every `ht-*` element binds
 * to exactly one node; a diagram is many at once, so live availability is
 * mirrored onto the drawn nodes through the same state client the elements use.
 */
import type { Graph } from "../graph/graph";
import { layoutRadial, layoutTree, type PlacedTreeNode, type TreeLayout } from "../graph/tree-layout";
import { buildFullView, buildView, DEFAULT_HIDDEN_KINDS, type GraphView } from "../graph/view";
import type { GraphEdge, GraphNode, NodeId, RelationName } from "../graph/types";
import { relationAsSeenFrom } from "../graph/types";
import { ELEMENT_KINDS, type ElementKind } from "../tags/identity";
import type { NodeId as StateNodeId } from "../state/protocol";
import { escapeHtml, renderPage, type PageContext } from "./shell";

const R = 15;
const LABEL_DROP = R + 20;

/** How an edge is drawn, by what it means. */
function edgeClass(relation: RelationName): string {
  if (relation === "contains" || relation === "partOf" || relation === "defines" || relation === "definedBy") return "structure";
  if (relation === "members" || relation === "memberOf") return "membership";
  if (relation === "uses" || relation === "usedBy") return "drives";
  if (relation === "sourcedBy" || relation === "sources") return "source";
  return "typed";
}

function iconGlyph(node: GraphNode): string {
  return node.icon.kind === "emoji"
    ? `<text class="graph-icon" y="5" text-anchor="middle">${escapeHtml(node.icon.value)}</text>`
    : `<image class="graph-image" href="${escapeHtml(node.icon.src)}" x="-10" y="-10" width="20" height="20"${node.icon.alt ? ` aria-label="${escapeHtml(node.icon.alt)}"` : ""} />`;
}

/** The current view state, carried in the URL so nothing depends on scripts. */
export interface ViewState {
  readonly expanded: readonly NodeId[];
  readonly hidden: readonly ElementKind[];
}

export function parseViewState(query: URLSearchParams): ViewState {
  const list = (value: string | null) => (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const hiddenParam = query.get("hidden");
  // Absent means the defaults; present but empty means nothing is hidden, which
  // is a real choice and has to be distinguishable from not having chosen.
  const hidden = hiddenParam === null
    ? [...DEFAULT_HIDDEN_KINDS]
    : list(hiddenParam).filter((kind): kind is ElementKind => (ELEMENT_KINDS as readonly string[]).includes(kind));
  return { expanded: list(query.get("expand")), hidden };
}

export function viewHref(base: string, state: ViewState): string {
  const query = new URLSearchParams();
  if (state.expanded.length) query.set("expand", [...state.expanded].sort().join(","));
  const defaults = [...DEFAULT_HIDDEN_KINDS].sort().join(",");
  const hidden = [...state.hidden].sort().join(",");
  if (hidden !== defaults) query.set("hidden", hidden);
  const search = query.toString();
  return search ? `${base}?${search}` : base;
}

function renderNode(placed: PlacedTreeNode): string {
  const { view } = placed;
  const { node } = view;
  const title = [node.name, node.context].filter(Boolean).join(" · ");
  const body = `<g class="graph-node" data-role="${view.role}"${node.stateNode ? ` data-node="${escapeHtml(node.stateNode)}" data-availability="unknown"` : ""} transform="translate(${placed.x} ${placed.y})">
      <title>${escapeHtml(title)}</title>
      <circle class="graph-mark" r="${R}" />
      ${iconGlyph(node)}
      ${placed.showLabel ? `<text class="graph-label" y="${LABEL_DROP}" text-anchor="middle">${escapeHtml(placed.label)}</text>` : ""}
    </g>`;
  const link = node.page || `/elements/${node.id}`;
  return view.role === "focus" ? body : `<a href="${escapeHtml(link)}">${body}</a>`;
}

/**
 * The dotted stub and `+` under a node with more to show. A link rather than a
 * script, so opening a branch is a URL you can share and go back from.
 */
function renderExpander(ctx: PageContext, base: string, state: ViewState, placed: PlacedTreeNode): string {
  if (!placed.expander) return "";
  const kinds = placed.view.hiddenKinds.map((kind) => ctx.i18n.lookup(`tags.kind.${kind}`) ?? kind).join(", ");
  const label = ctx.i18n.t("graph.expandBy", { count: placed.view.hidden, kinds });
  const next = viewHref(base, { ...state, expanded: [...new Set([...state.expanded, placed.view.node.id])] });
  return `<a class="graph-expander" href="${escapeHtml(next)}" aria-label="${escapeHtml(label)}">
      <title>${escapeHtml(label)}</title>
      <line class="graph-stub" x1="${placed.x + R}" y1="${placed.y}" x2="${placed.expander.x - 8}" y2="${placed.expander.y}" />
      <circle class="graph-plus-mark" cx="${placed.expander.x}" cy="${placed.expander.y}" r="8" />
      <text class="graph-plus" x="${placed.expander.x}" y="${placed.expander.y + 4}" text-anchor="middle">+</text>
    </a>`;
}

function renderEdge(placed: TreeLayout, edge: GraphEdge): string {
  const from = placed.nodes.find((entry) => entry.view.node.id === edge.from);
  const to = placed.nodes.find((entry) => entry.view.node.id === edge.to);
  if (!from || !to) return "";
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const gap = R + 4;
  const x1 = Math.round(from.x + (dx / length) * gap);
  const y1 = Math.round(from.y + (dy / length) * gap);
  const x2 = Math.round(to.x - (dx / length) * gap);
  const y2 = Math.round(to.y - (dy / length) * gap);
  // A link between two nodes on the same row is lateral, not hierarchy, so it
  // bows above the row rather than cutting through whatever sits between them.
  const lift = from.y === to.y ? Math.min(58, Math.abs(dx) / 2.2) : 0;
  const midX = Math.round((x1 + x2) / 2);
  const shape = lift
    ? `<path class="graph-edge" data-relation="${edgeClass(edge.relation)}" d="M${x1} ${y1} Q ${midX} ${Math.round(y1 - lift * 2)} ${x2} ${y2}" marker-end="url(#graph-arrow)" />`
    : `<line class="graph-edge" data-relation="${edgeClass(edge.relation)}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#graph-arrow)" />`;
  const labelY = Math.round(lift ? y1 - lift - 4 : (y1 + y2) / 2 - 4);
  const label = edge.label
    ? `<text class="graph-edge-label" x="${midX}" y="${labelY}" text-anchor="middle">${escapeHtml(edge.label)}</text>`
    : "";
  return `${shape}${label}`;
}

function renderDiagram(ctx: PageContext, base: string, state: ViewState, placed: TreeLayout): string {
  const [x, y, width, height] = placed.viewBox;
  const edges = placed.edges.map((edge) => renderEdge(placed, edge)).join("");
  const expanders = placed.nodes.map((node) => renderExpander(ctx, base, state, node)).join("");
  const nodes = placed.nodes.map((node) => renderNode(node)).join("");
  return `<svg class="graph" viewBox="${x} ${y} ${width} ${height}" role="group" aria-label="${escapeHtml(ctx.i18n.t("graph.diagram"))}" preserveAspectRatio="xMidYMid meet">
    <defs><marker id="graph-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path class="graph-arrow" d="M0 0 L8 4 L0 8 z" /></marker></defs>
    <g class="graph-edges">${edges}</g>
    <g class="graph-expanders">${expanders}</g>
    <g class="graph-nodes">${nodes}</g>
  </svg>`;
}

/** The viewer's own menu: which kinds are drawn, and how to get out of here. */
function renderControls(ctx: PageContext, base: string, state: ViewState, view: GraphView, fullGraph: string): string {
  const { t } = ctx.i18n;
  const kinds = [...new Set([...DEFAULT_HIDDEN_KINDS, ...state.hidden, ...view.offeredKinds])].sort();
  const toggles = kinds.map((kind) => {
    const on = !state.hidden.includes(kind);
    const next = on ? [...state.hidden, kind] : state.hidden.filter((entry) => entry !== kind);
    const name = ctx.i18n.lookup(`tags.kind.${kind}`) ?? kind;
    return `<a class="btn btn-small" href="${escapeHtml(viewHref(base, { ...state, hidden: next }))}" aria-pressed="${on ? "true" : "false"}">${escapeHtml(name)}</a>`;
  }).join("");

  const collapse = state.expanded.length
    ? `<a class="btn btn-small" href="${escapeHtml(viewHref(base, { ...state, expanded: [] }))}">${escapeHtml(t("graph.collapse"))}</a>`
    : "";

  return `<div class="graph-controls">
    <p class="small graph-scope">${escapeHtml(t("graph.scope"))}</p>
    <div class="bar">
      ${collapse}<a class="btn btn-small" href="${escapeHtml(fullGraph)}">${escapeHtml(t("graph.full"))}</a>
      ${toggles ? `<span class="graph-toggles" role="group" aria-label="${escapeHtml(t("graph.show"))}"><span class="small">${escapeHtml(t("graph.show"))}</span>${toggles}</span>` : ""}
    </div>
  </div>`;
}

/** The same connections in words: the accessible equivalent, and the no-JS one. */
function renderConnections(ctx: PageContext, graph: Graph, view: GraphView): string {
  const { t } = ctx.i18n;
  const focus = view.focus;
  const buckets = new Map<RelationName, GraphNode[]>();
  for (const edge of graph.edgesOf(focus)) {
    const relation = relationAsSeenFrom(edge, focus);
    const other = graph.node(edge.from === focus ? edge.to : edge.from);
    if (!other || view.hiddenKinds.includes(other.kind)) continue;
    const bucket = buckets.get(relation);
    if (bucket) { if (!bucket.includes(other)) bucket.push(other); }
    else buckets.set(relation, [other]);
  }
  if (!buckets.size) return `<p class="note">${escapeHtml(t("graph.empty"))}</p>`;
  const rows = [...buckets].map(([relation, nodes]) => {
    const links = nodes
      .map((node) => `<a href="${escapeHtml(node.page || `/elements/${node.id}`)}">${escapeHtml(node.name)}</a>`)
      .join(" · ");
    return `<p class="small"><span class="graph-relation">${escapeHtml(ctx.i18n.lookup(`relations.${relation}`) ?? relation)}</span>: ${links}</p>`;
  }).join("");
  return `<section class="element-relations" aria-label="${escapeHtml(t("graph.connections"))}">${rows}</section>`;
}

export const GRAPH_CSS = String.raw`
  /* height:auto makes the box match the viewBox aspect exactly, so the drawing
     fills it instead of being letterboxed inside a wider one. */
  .graph { display: block; width: 100%; max-width: 54rem; margin-inline: auto; height: auto; margin-block: var(--s4); }
  /* The overview is the page rather than an illustration on it, so it takes the
     whole wide column instead of the reading measure. */
  .graph-whole .graph { max-width: 100%; }
  .graph-edge { stroke: var(--rule); stroke-width: 1; fill: none; vector-effect: non-scaling-stroke; }
  .graph-edge[data-relation="structure"] { stroke: var(--hair); }
  .graph-edge[data-relation="membership"] { stroke-dasharray: 6 4; }
  .graph-edge[data-relation="drives"] { stroke-dasharray: 5 4; }
  .graph-edge[data-relation="source"] { stroke-dasharray: 2 3; }
  .graph-edge[data-relation="typed"] { stroke: var(--hair); stroke-dasharray: 2 4; }
  .graph-arrow { fill: var(--rule); }
  .graph-mark { fill: var(--bg); stroke: var(--rule); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .graph-node[data-role="focus"] .graph-mark { stroke-width: var(--rule-w); stroke: var(--accent); }
  .graph-node[data-role="focus"] .graph-label { font-weight: 600; }
  .graph-node[data-role="ancestor"] .graph-mark { stroke: var(--hair); }
  .graph-node[data-availability="offline"] .graph-mark { stroke: var(--bad); }
  .graph-node[data-availability="degraded"] .graph-mark { stroke: var(--warn); }
  .graph-node[data-availability="online"] .graph-mark { stroke: var(--ok); }
  .graph-icon { font-size: 15px; filter: var(--ht-graph-icon-filter, none); }
  .graph-label { fill: var(--fg); font-size: 12px; font-family: inherit; }
  .graph-edge-label { fill: var(--fg-2); font-size: 10px; font-family: inherit; }
  .graph-stub { stroke: var(--hair); stroke-width: 1; stroke-dasharray: 2 3; vector-effect: non-scaling-stroke; }
  .graph-plus-mark { fill: var(--bg); stroke: var(--hair); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .graph-plus { fill: var(--fg-2); font-size: 12px; font-family: inherit; }
  .graph-expander:hover .graph-plus-mark, .graph-expander:focus-visible .graph-plus-mark { stroke: var(--rule); fill: var(--ok-soft); }
  .graph-expander:hover .graph-plus, .graph-expander:focus-visible .graph-plus { fill: var(--fg); }
  .graph a { text-decoration: none; }
  .graph a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .graph a:hover .graph-mark { fill: var(--ok-soft); }
  .graph-relation { color: var(--fg-2); }
  .graph-controls { padding-block: var(--s3); border-block-end: 1px solid var(--hair); }
  .graph-scope { margin: 0 0 var(--s2); color: var(--fg-2); }
  .graph-toggles { display: inline-flex; align-items: center; gap: var(--s2); flex-wrap: wrap; }
  .graph-toggles [aria-pressed="true"] { background: var(--fg); color: var(--bg); border-color: var(--fg); }
`;

/**
 * Mirrors live availability onto the drawn nodes. Every `ht-*` element binds to
 * one node, so rather than inventing an element that binds to many, this uses
 * the same state client directly for the nodes the diagram happens to show.
 */
export const GRAPH_SCRIPT = String.raw`
(() => {
  const svg = document.querySelector('.graph');
  if (!svg || !ht.state) return;
  const seen = new Set();
  for (const node of svg.querySelectorAll('[data-node]')) {
    const id = node.dataset.node;
    if (seen.has(id)) continue;
    seen.add(id);
    const apply = (record) => {
      const value = record && record.value;
      const availability = record && record.fault ? 'offline'
        : value && typeof value === 'object' && value.status ? value.status
        : 'unknown';
      for (const target of svg.querySelectorAll('[data-node="' + id + '"]')) {
        target.dataset.availability = availability;
        // A node's availability is state like any other, so it carries the same freshness on hover.
        ht.live(target, record && record.observedAt);
      }
    };
    apply(ht.state.read(id));
    ht.state.subscribe(id, apply, 'glance');
  }
})();
`;

export interface GraphPageOptions {
  readonly ctx: PageContext;
  readonly graph: Graph;
  readonly focus: NodeId;
  readonly state: ViewState;
  /** The path this view is rendered at, which the expander and menu links keep. */
  readonly base: string;
  /** Rendered above the diagram: a device page's own title and tab bar. */
  readonly header?: string;
  readonly nav?: Parameters<typeof renderPage>[0]["nav"];
}

/** The Graph tab for any element, from a device page or from `/elements/<key>`. */
export function renderGraphPage(options: GraphPageOptions): string | undefined {
  const { ctx, graph, focus, state, base } = options;
  const { t } = ctx.i18n;
  const node = graph.node(focus);
  const view = buildView(graph, focus, { expanded: state.expanded, hiddenKinds: state.hidden });
  if (!node || !view) return undefined;
  const placed = layoutTree(view);

  const stateNodes = [...new Set(placed.nodes.flatMap((entry) => entry.view.node.stateNode ? [entry.view.node.stateNode] : []))] as StateNodeId[];
  const header = options.header ?? `<h1>${escapeHtml(node.name)}</h1>`;
  const fullGraph = `/graph?focus=${encodeURIComponent(focus)}`;

  return renderPage({
    ctx,
    title: node.name,
    ...(options.nav ? { nav: options.nav } : {}),
    wide: true,
    css: GRAPH_CSS,
    script: GRAPH_SCRIPT,
    messages: ["graph.", "relations.", "state.", "tags.kind."],
    nodes: stateNodes,
    body: `${header}
      ${renderControls(ctx, base, state, view, fullGraph)}
      ${renderDiagram(ctx, base, state, placed)}
      <h2>${escapeHtml(t("graph.connections"))}</h2>
      ${renderConnections(ctx, graph, view)}`,
  });
}

export interface FullGraphPageOptions {
  readonly ctx: PageContext;
  readonly graph: Graph;
  readonly root: NodeId;
  /** Highlighted, and kept even if the cap bites. */
  readonly focus?: NodeId;
  readonly state: ViewState;
  readonly base: string;
}

/**
 * The whole graph on one page, with an element highlighted: the escape hatch
 * from the focused view, and its own destination rather than a mode of the tab.
 *
 * Bounded, because past a few hundred nodes a diagram stops being a picture of
 * anything, and honest about it: the count says what is drawn out of what
 * exists rather than quietly stopping.
 */
export function renderFullGraphPage(options: FullGraphPageOptions): string | undefined {
  const { ctx, graph, root, focus, state, base } = options;
  const { t } = ctx.i18n;
  const view = buildFullView(graph, root, {
    ...(focus ? { focus } : {}),
    hiddenKinds: state.hidden,
  });
  if (!view) return undefined;
  const placed = layoutRadial(view);
  const back = focus ? graph.node(focus) : undefined;

  return renderPage({
    ctx,
    title: t("graph.fullTitle"),
    nav: "tags",
    wide: true,
    css: GRAPH_CSS,
    messages: ["graph.", "relations.", "tags.kind."],
    mainAttributes: 'class="graph-whole"',
    body: `<h1>${escapeHtml(t("graph.fullTitle"))}</h1>
      <div class="graph-controls">
        <p class="small graph-scope">${escapeHtml(t("graph.fullScope"))} ${escapeHtml(t("graph.showing", { shown: view.nodes.length, total: view.total }))}</p>
        ${back ? `<div class="bar"><a class="btn btn-small" href="${escapeHtml(`${back.page || `/elements/${back.id}`}/graph`)}">${escapeHtml(back.name)}</a></div>` : ""}
      </div>
      ${renderDiagram(ctx, base, state, placed)}`,
  });
}
