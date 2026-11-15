/** Server-rendered graph scenes. Selection is separate from opening an element. */
import { edgeIdentity } from "../graph/graph";
import { graphHref, GRAPH_SCENE_NODE_LIMIT, LENS_RELATIONS, type GraphQuery } from "../graph/scene";
import type { PlacedGraphScene, PlacedSceneNode } from "../graph/scene-layout";
import { relationAsSeenFrom, type GraphNode } from "../graph/types";
import type { NodeId as StateNodeId } from "../state/protocol";
import { escapeHtml as esc, renderPage, type PageContext } from "./shell";

function kind(ctx: PageContext, node: GraphNode): string { return ctx.i18n.lookup(`tags.kind.${node.kind}`) ?? node.kind; }
function stateAttributes(node: GraphNode): string { return node.stateNode ? ` data-graph-state="${esc(node.stateNode)}"` : ""; }
function href(ctx: PageContext, query: GraphQuery, patch: Partial<GraphQuery> = {}): string { return ctx.apiPath(graphHref(query, patch)); }
function selection(ctx: PageContext, query: GraphQuery, node: GraphNode): string { return esc(href(ctx, query, { selected: node.id })); }
function status(ctx: PageContext, node: GraphNode): string {
  if (node.present === false) return ctx.i18n.t("graph.notPresent");
  if (!node.stateNode) return "";
  const record = ctx.state.snapshot([node.stateNode as StateNodeId])[0];
  if (!record) return ctx.i18n.t("graph.notObserved");
  const value = record.value as { status?: string } | undefined;
  const label = record.fault?.code === "disabled" ? ctx.i18n.t("graph.disabled") : ctx.i18n.lookup(`status.${record.fault ? "offline" : value?.status ?? "unknown"}`) ?? ctx.i18n.t("status.unknown");
  return ctx.i18n.t("graph.snapshot", { status: label });
}
function card(ctx: PageContext, scene: PlacedGraphScene, placed: PlacedSceneNode, selected: string): string {
  const node = placed.node;
  return `<a class="graph-card" href="${selection(ctx, scene.query, node)}" data-graph-select="${esc(node.id)}" aria-current="${node.id === selected ? "true" : "false"}"${stateAttributes(node)}>
    <span class="graph-kind">${esc(kind(ctx, node))}</span><strong>${esc(node.name)}</strong>
    ${node.context ? `<span class="graph-context">${esc(node.context)}</span>` : ""}
    <span class="graph-status" data-graph-status>${esc(status(ctx, node))}</span>
  </a>`;
}
function home(ctx: PageContext, scene: PlacedGraphScene, selected: string): string {
  return `<div class="graph-home">${scene.groups.map((group, groupIndex) => {
    const preceding = new Set(scene.groups.slice(0, groupIndex).map(entry => entry.id));
    const shown = scene.nodes.filter(node => node.group === group.id).length;
    const canExpand = !scene.query.expanded.includes(group.id) && shown > 0 && GRAPH_SCENE_NODE_LIMIT - scene.nodes.filter(node => node.group && preceding.has(node.group)).length > shown;
    const expanded = scene.query.expanded.includes(group.id);
    const title = group.kind === "unassigned" ? ctx.i18n.t("graph.unassigned") : group.kind === "kind" ? ctx.i18n.lookup(`tags.kind.${scene.nodes.find(node => node.group === group.id)?.node.kind}`) ?? group.name : group.name;
    return `<section class="graph-room"><div class="graph-room-head"><h2>${esc(title)}</h2><span class="muted">${ctx.i18n.number(group.total)}</span></div><div class="graph-cards">${scene.nodes.filter(node => node.group === group.id).map(node => card(ctx, scene, node, selected)).join("")}</div>
    ${group.hidden && canExpand ? `<a class="graph-more" href="${esc(href(ctx, scene.query, { expanded: [...scene.query.expanded, group.id] }))}">${esc(ctx.i18n.t("graph.more", { count: group.hidden }))} →</a>` : ""}
    ${group.hidden && !canExpand ? `<a class="graph-more" href="#graph-search">${esc(ctx.i18n.t("graph.more", { count: group.hidden }))} · ${esc(ctx.i18n.t("graph.search"))}</a>` : ""}
    ${expanded ? `<a class="graph-more" href="${esc(href(ctx, scene.query, { expanded: scene.query.expanded.filter(id => id !== group.id) }))}">${esc(ctx.i18n.t("graph.collapse"))}</a>` : ""}</section>`;
  }).join("")}</div>`;
}
function diagram(ctx: PageContext, scene: PlacedGraphScene, selected: string): string {
  const { t } = ctx.i18n;
  const edges = scene.edges.map(edge => `<g class="graph-connection" data-graph-from="${esc(edge.edge.from)}" data-graph-to="${esc(edge.edge.to)}" data-related="${edge.edge.from === selected || edge.edge.to === selected}">` + edge.sections.map(section => {
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
    return `<path class="graph-edge" d="${points.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ")}" marker-end="url(#graph-arrow)"/>`;
  }).join("") + (edge.label ? `<g class="graph-edge-label"><rect x="${edge.label.x - 4}" y="${edge.label.y - 2}" width="${edge.label.width + 8}" height="${edge.label.height + 4}"/><text x="${edge.label.x + edge.label.width / 2}" y="${edge.label.y + edge.label.height / 2}" text-anchor="middle" dominant-baseline="middle">${esc(edge.label.text)}</text></g>` : "") + "</g>").join("");
  const nodes = scene.nodes.map(placed => {
    const node = placed.node;
    return `<a class="graph-node" href="${selection(ctx, scene.query, node)}" data-graph-select="${esc(node.id)}" data-x="${placed.x}" data-y="${placed.y}" data-width="${placed.width}" data-height="${placed.height}" aria-label="${esc(node.name)}" aria-current="${node.id === selected ? "true" : "false"}"${stateAttributes(node)} transform="translate(${placed.x} ${placed.y})">
      <title>${esc([node.name, node.context].filter(Boolean).join(" · "))}</title><rect class="graph-node-box" width="${placed.width}" height="${placed.height}"/>
      <text class="graph-node-kind" x="16" y="22">${esc(kind(ctx, node))}</text>
      <text class="graph-node-name" x="16" y="46">${placed.label.map((line, i) => `<tspan x="16" dy="${i ? 19 : 0}">${esc(line)}</tspan>`).join("")}</text>
      <text class="graph-node-status" x="16" y="${placed.height - 12}" data-graph-status>${esc(status(ctx, node))}</text>${placed.hidden ? `<text class="graph-node-more" x="${placed.width - 12}" y="${placed.height - 12}" text-anchor="end"><title>${esc(t("graph.more", { count: placed.hidden }))}</title>+${placed.hidden}</text>` : ""}</a>`;
  }).join("");
  return `<div class="graph-tools" data-graph-tools hidden><button type="button" class="btn btn-small" data-graph-zoom="in" aria-label="${esc(t("graph.zoomIn"))}">+</button><button type="button" class="btn btn-small" data-graph-zoom="out" aria-label="${esc(t("graph.zoomOut"))}">−</button><button type="button" class="btn btn-small" data-graph-fit>${esc(t("graph.fit"))}</button><button type="button" class="btn btn-small" data-graph-center>${esc(t("graph.center"))}</button><output data-graph-scale>100%</output></div>
    <div class="graph-viewport" tabindex="0" role="region" aria-label="${esc(t("graph.diagram"))}" aria-describedby="graph-pan-hint">
      <svg class="graph-canvas" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}" data-scene-width="${scene.width}" data-scene-height="${scene.height}" role="group" aria-label="${esc(t("graph.diagram"))}"><defs><marker id="graph-arrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8"/></marker></defs><g class="graph-world"><g>${edges}</g><g>${nodes}</g></g></svg>
    </div><p class="sr-only" id="graph-pan-hint">${esc(t("graph.panHint"))}</p>`;
}
function inspector(ctx: PageContext, scene: PlacedGraphScene, selected: string): string {
  const { t } = ctx.i18n;
  const nodes = new Map(scene.nodes.map(placed => [placed.node.id, placed]));
  return `<aside class="graph-inspector" aria-label="${esc(t("graph.inspect"))}"><p class="graph-eyebrow">${esc(t("graph.inspect"))}</p>${[...nodes.values()].map(placed => {
    const node = placed.node;
    const operational = node.side === "instance" && !["site", "catalog"].includes(node.kind);
    const hasModel = Boolean(node.schema) || scene.edges.some(({edge}) => (edge.from === node.id || edge.to === node.id) && LENS_RELATIONS.model.includes(edge.relation));
    const seen = new Set<string>();
    const connections = scene.edges.filter(edge => edge.edge.from === node.id || edge.edge.to === node.id).filter(edge => { if (seen.has(edgeIdentity(edge.edge))) return false; seen.add(edgeIdentity(edge.edge)); return true; }).map(({ edge }) => {
      const other = nodes.get(edge.from === node.id ? edge.to : edge.from)?.node;
      if (!other) return "";
      const relation = relationAsSeenFrom(edge, node.id);
      return `<li><span class="graph-relation">${esc(ctx.i18n.lookup(`relations.${relation}`) ?? relation)}${edge.label ? ` · ${esc(edge.label)}` : ""}</span><a href="${selection(ctx, scene.query, other)}" data-graph-select="${esc(other.id)}">${esc(other.name)}</a><details><summary>${esc(t("graph.origin"))}</summary><dl><dt>${esc(t("graph.origin"))}</dt><dd>${esc(edge.origin)}</dd>${edge.label ? `<dt>${esc(t("graph.role"))}</dt><dd>${esc(edge.label)}</dd>` : ""}${edge.via ? `<dt>${esc(t("graph.via"))}</dt><dd>${esc(edge.via)}</dd>` : ""}</dl></details></li>`;
    }).join("");
    return `<section data-graph-panel="${esc(node.id)}"${node.id !== selected ? " hidden" : ""}${stateAttributes(node)}><span class="graph-kind">${esc(kind(ctx, node))}</span><h2>${esc(node.name)}</h2>${node.context ? `<p class="muted">${esc(node.context)}</p>` : ""}<p class="graph-status" data-graph-status>${esc(status(ctx, node))}</p><p class="small muted" data-graph-observed></p>
      <a class="graph-open" href="${esc(node.page || ctx.apiPath(`/elements/${encodeURIComponent(node.id)}`))}">${esc(t("graph.open"))} ↗</a>
      <div class="graph-inspector-actions">${operational ? `<a href="${esc(href(ctx, scene.query, { view: "dependencies", focus: node.id, selected: node.id, q: "", expanded: [], relations: [] }))}">${esc(t("graph.trace"))} →</a>` : ""}${hasModel ? `<a href="${esc(href(ctx, scene.query, { view: "model", focus: node.schema ?? node.id, selected: node.id, q: "", expanded: [], relations: [] }))}">${esc(t("graph.definition"))} →</a>` : ""}</div>
      <h3>${esc(t("graph.connections"))}</h3>${connections ? `<ul class="graph-connections">${connections}</ul>` : `<p class="small muted">${esc(t("graph.noConnections"))}</p>`}
      ${placed.hidden ? scene.query.expanded.includes(node.id) && scene.query.view !== "home" ? `<a class="graph-more" href="#graph-search">${esc(t("graph.more", { count: placed.hidden }))} · ${esc(t("graph.search"))}</a>` : `<a class="graph-more" href="${esc(href(ctx, scene.query, { view: scene.query.view === "home" ? "dependencies" : scene.query.view, focus: scene.query.view === "home" ? node.id : scene.query.focus ?? "", selected: node.id, q: "", relations: scene.query.view === "home" ? [] : scene.query.relations, expanded: scene.query.view === "home" ? [] : [...new Set([...scene.query.expanded, node.id])] }))}">${esc(t("graph.more", { count: placed.hidden }))} · ${esc(t("graph.expand"))} →</a>` : ""}</section>`;
  }).join("")}</aside>`;
}
function controls(ctx: PageContext, query: GraphQuery): string {
  const { t } = ctx.i18n;
  const publicQuery = new URL(href(ctx, query), "http://localhost").searchParams;
  const hidden = (key: string, value: string) => `<input type="hidden" name="${key}" value="${esc(value)}">`;
  const option = (value: string, label: string, chosen: boolean) => `<option value="${esc(value)}"${chosen ? " selected" : ""}>${esc(label)}</option>`;
  return `<form class="graph-controls" method="get" action="/graph">${hidden("view", query.view)}${query.focus ? hidden("focus", publicQuery.get("focus")!) : ""}${hidden("depth", String(query.depth))}${publicQuery.getAll("expand").map(id => hidden("expand", id)).join("")}
  <label class="graph-search">${esc(t("graph.search"))}<input type="search" id="graph-search" name="q" value="${esc(query.q)}" maxlength="200" placeholder="${esc(t("graph.search"))}"></label>
  ${query.view === "home" ? `<label>${esc(t("graph.group"))}<select name="group">${option("room", t("graph.room"), query.group === "room")}${option("kind", t("graph.kind"), query.group === "kind")}</select></label>` : `<label>${esc(t("graph.relations"))}<select name="relation">${option("", t(query.view === "dependencies" ? "graph.dependencies" : "graph.allRelations"), query.relations.length === 0)}${LENS_RELATIONS[query.view].map(relation => option(relation, ctx.i18n.lookup(`relations.${relation}`) ?? relation, query.relations.includes(relation))).join("")}</select></label>`}
  <button class="btn" type="submit">${esc(t("graph.searchAction"))}</button>${query.q || query.focus || query.expanded.length || query.relations.length ? `<a href="${esc(href(ctx, { ...query, focus: "", selected: "", q: "", expanded: [], relations: [] }))}">${esc(t("graph.clear"))}</a>` : ""}</form>`;
}

export const GRAPH_CSS = String.raw`
main[data-wide] { --page-wide:100rem; }
.graph-header { margin-bottom: var(--s4); }
.graph-header h1 { margin-bottom: var(--s2); }
.graph-tabs { display:flex; gap:var(--s4); border-bottom:1px solid var(--hair); margin-block:var(--s4); }
.graph-tabs a { padding-block:var(--s2); text-decoration:none; color:var(--fg-2); border-bottom:3px solid transparent; }
.graph-tabs a[aria-current=page] { color:var(--accent); border-color:var(--accent); }
.graph-controls { display:flex; gap:var(--s3); align-items:end; flex-wrap:wrap; margin-block:var(--s4); }
.graph-controls label { display:grid; gap:var(--s1); font-size:.8rem; min-width:0; }
.graph-controls input,.graph-controls select { max-width:100%; min-height:2.5rem; }
.graph-search { flex:1; min-width:12rem!important; }
.graph-summary { display:flex; flex-wrap:wrap; justify-content:space-between; gap:var(--s2); padding-block:var(--s3); border-top:var(--rule-w) solid var(--rule); font-size:.8rem; color:var(--fg-2); }
.graph-workspace { display:grid; grid-template-columns:minmax(0,1fr) 15rem; align-items:start; gap:var(--s4); }
.graph-main { min-width:0; }
.graph-room { margin-block:0 var(--s5); }
.graph-room-head { display:flex; align-items:baseline; justify-content:space-between; gap:var(--s2); border-bottom:1px solid var(--hair); margin-bottom:var(--s3); }
.graph-room h2 { font-size:1.3rem; margin:0 0 var(--s2); }
.graph-cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(100%,13rem),1fr)); gap:var(--s3); }
.graph-card { display:flex; flex-direction:column; align-items:start; gap:var(--s2); padding:var(--s3); border:1px solid var(--hair); background:var(--panel,var(--bg)); text-decoration:none; color:var(--fg); min-height:8rem; overflow-wrap:anywhere; }
.graph-card strong { font-size:1.05rem; font-weight:500; line-height:1.3; }
.graph-card[aria-current=true] { border-color:var(--accent); outline:1px solid var(--accent); }
.graph-kind,.graph-eyebrow { font-size:.66rem; text-transform:uppercase; letter-spacing:.09em; color:var(--fg-2); }
.graph-context,.graph-status { font-size:.72rem; color:var(--fg-2); }
.graph-card .graph-status { margin-top:auto; }
[data-availability=offline] > [data-graph-status] { color:var(--bad); }
.graph-more { display:inline-block; font-size:.8rem; margin:var(--s3) var(--s3) 0 0; }
.graph-inspector { border-inline-start:1px solid var(--hair); padding-inline-start:var(--s4); min-width:0; position:sticky; top:var(--s4); max-height:calc(100vh - 3rem); overflow:auto; overflow-wrap:anywhere; }
.graph-inspector h2 { font-size:1.3rem; line-height:1.3; margin-block:var(--s2); text-transform:none; letter-spacing:normal; font-variant:normal; }
.graph-inspector h3 { text-transform:none; letter-spacing:normal; font-size:.85rem; margin-block:var(--s4) var(--s2); }
.graph-inspector-actions { display:grid; gap:var(--s2); font-size:.8rem; margin-top:var(--s4); }
.graph-open { display:inline-block; margin-top:var(--s2); font-size:.85rem; }
.graph-connections { padding:0; margin:0; list-style:none; }
.graph-connections li { padding-block:var(--s3); border-top:1px solid var(--hair); font-size:.85rem; }
.graph-connections li > a,.graph-relation { display:block; }
.graph-relation { color:var(--fg-2); font-size:.7rem; margin-bottom:var(--s1); }
.graph-connections details { font-size:.7rem; color:var(--fg-2); margin-top:var(--s2); }
.graph-connections dl { display:grid; grid-template-columns:auto 1fr; gap:var(--s2); }
.graph-connections dd { margin:0; }
.graph-tools { display:flex; flex-wrap:wrap; align-items:center; gap:var(--s2); padding-bottom:var(--s3); }
.graph-tools[hidden] { display:none; }
.graph-tools output { font-size:.7rem; color:var(--fg-2); margin-inline-start:auto; }
.graph-viewport { height:clamp(22rem,54vh,40rem); max-width:100%; overflow:auto; border-block:1px solid var(--hair); background:var(--bg); }
.graph-viewport[data-enhanced] { overflow:hidden; cursor:grab; touch-action:pan-y; }
.graph-viewport[data-panning] { cursor:grabbing; touch-action:none; }
.graph-canvas { display:block; max-width:none; }
.graph-world { transform-origin:0 0; }
.graph-edge { opacity:.55; fill:none; stroke:var(--fg-2); stroke-width:1.25; }
.graph-connection[data-related=true] .graph-edge { opacity:1; stroke:var(--accent); stroke-width:1.75; }
#graph-arrow path { fill:context-stroke; }
.graph-edge-label rect { fill:var(--bg); }
.graph-edge-label text { fill:var(--fg-2); font-size:12px; }
.graph-node { cursor:pointer; text-decoration:none; }
.graph-node-box { fill:var(--bg); stroke:var(--fg-2); stroke-width:1; }
.graph-node[aria-current=true] .graph-node-box { stroke:var(--accent); stroke-width:2; }
.graph-node:focus .graph-node-box { stroke:var(--accent); stroke-width:3; }
.graph-node-name { fill:var(--fg); font-size:16px; }
.graph-node-kind { fill:var(--fg-2); font-size:11px; letter-spacing:.5px; text-transform:uppercase; }
.graph-node-status { fill:var(--fg-2); font-size:11px; }
.graph-node-more { fill:var(--accent); font-size:12px; }
.graph-node[data-availability=offline] .graph-node-status { fill:var(--bad); }
.graph-empty { padding:var(--s5) 0; }
@media(max-width:1400px) { .graph-workspace { grid-template-columns:minmax(0,1fr); } .graph-inspector { position:static; max-height:none; border-inline-start:0; border-top:var(--rule-w) solid var(--rule); padding:var(--s4) 0; } .graph-inspector [data-graph-panel] { max-width:42rem; } }
@media(max-width:520px) { .graph-tabs { gap:var(--s3); } .graph-controls { gap:var(--s2); } .graph-search { flex-basis:100%; } .graph-viewport { height:28rem; } }
`;

export function renderGraphPage({ ctx, scene }: { ctx: PageContext; scene: PlacedGraphScene }): string {
  const { t } = ctx.i18n;
  const selected = [scene.query.selected, scene.query.focus].find(id => scene.nodes.some(node => node.node.id === id)) ?? scene.nodes[0]?.node.id ?? "";
  const canonical = new Set(scene.nodes.map(node => node.node.id));
  const tabs = (["home", "dependencies", "model"] as const).map(view => `<a href="${esc(href(ctx, scene.query, { view, focus: "", selected: "", q: "", expanded: [], relations: [] }))}"${view === scene.query.view ? ' aria-current="page"' : ""}>${esc(t(`graph.${view}`))}</a>`).join("");
  const body = `<div data-graph-view="${scene.query.view}" data-graph-selected="${esc(selected)}"><header class="graph-header"><h1>${esc(t("graph.title"))}</h1><nav class="graph-tabs" aria-label="${esc(t("graph.title"))}">${tabs}</nav></header>${controls(ctx, scene.query)}
    <div class="graph-summary"><span>${esc(t("graph.showing", { shown: canonical.size, total: scene.total }))}</span>${scene.query.q ? `<span>${esc(t("graph.scope", { count: scene.matched }))}</span>` : ""}</div>
    ${scene.nodes.length ? `<div class="graph-workspace"><div class="graph-main">${scene.query.view === "home" ? home(ctx, scene, selected) : diagram(ctx, scene, selected)}${scene.omitted ? `<p class="note small">${esc(t("graph.omitted", { count: scene.omitted }))}</p>` : ""}</div>${inspector(ctx, scene, selected)}</div>` : `<p class="graph-empty">${esc(t("graph.empty"))}</p>`}</div>`;
  return renderPage({ ctx, title: t("graph.title"), nav: "graph", body, css: GRAPH_CSS, wide: true, modules: ["browser/graph.ts"], messages: ["graph."], nodes: [...new Set(scene.nodes.flatMap(node => node.node.stateNode ? [node.node.stateNode as StateNodeId] : []))] });
}
