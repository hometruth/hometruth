import { describe, expect, test } from "bun:test";
import { Graph } from "../graph/graph";
import { graphHref, parseGraphQuery, projectGraph, type GraphQuery, type GraphScene } from "../graph/scene";
import { layoutGraphScene, type PlacedGraphScene } from "../graph/scene-layout";
import type { GraphEdge, GraphNode } from "../graph/types";
import type { NodeRecord } from "../state/protocol";
import { renderGraphPage } from "./graph-page";
import { escapeHtml, type PageContext } from "./shell";
import { testPageContext } from "./test-context";

const node = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id, side: "instance", kind: "device", name: id, context: "", page: `/devices/${id}`,
  icon: { kind: "emoji", value: "●" }, ids: [id], ...extra,
});
const edge = (from: string, to: string, extra: Partial<GraphEdge> = {}): GraphEdge => ({ from, to, relation: "uses", origin: "resolution", ...extra });
const room = (id: string, name: string) => node(id, { kind: "tag", side: "tag", name, ids: ["room", name] });
const graph = (nodes: GraphNode[], edges: GraphEdge[] = []) => new Graph({ nodes, edges, generatedAt: "2026-01-01T00:00:00.000Z" });
const query = (patch: Partial<GraphQuery> = {}): GraphQuery => ({ ...parseGraphQuery(new URLSearchParams()), ...patch });
const decodeAttribute = (value: string) => value.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
const main = (html: string) => html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/u)![1]!;
const panel = (html: string, id: string) => main(html).split(`data-graph-panel="${escapeHtml(id)}"`)[1]?.split("</section>")[0] ?? "";
const links = (html: string, className: string) => [...html.matchAll(new RegExp(`<a class="${className}" href="([^"]*)"[^>]*>([\\s\\S]*?)<\\/a>`, "gu"))].map(match => ({ href: decodeAttribute(match[1]!), text: match[2]! }));

/** Renderer tests use simple deterministic geometry; ELK behaviour has its own tests. */
function placed(scene: GraphScene): PlacedGraphScene {
  return {
    ...scene, width: 900, height: 300,
    nodes: scene.nodes.map((entry, index) => ({ ...entry, x: index * 250, y: 50, width: 224, height: 104, label: [entry.node.name] })),
    edges: scene.edges.map(entry => ({ ...entry, sections: [{ startPoint: { x: 224, y: 100 }, endPoint: { x: 250, y: 100 } }] })),
  };
}
async function homeHtml(topology: Graph, state: GraphQuery = query(), ctx: PageContext = testPageContext()) {
  const scene = await layoutGraphScene(projectGraph(topology, state));
  return { scene, html: renderGraphPage({ ctx, scene }) };
}

describe("graph page", () => {
  test("selecting a card reloads the inspector while opening the element is explicit", async () => {
    const topology = graph([node("a", { name: "First lamp" }), node("b", { name: "Second lamp" })]);
    const { html } = await homeHtml(topology);
    const cards = links(main(html), "graph-card");
    expect(cards).toHaveLength(2);
    const second = cards.find(link => new URL(link.href, "https://example.test").searchParams.get("selected") === "b")!;
    expect(new URL(second.href, "https://example.test").pathname).toBe("/graph");
    expect(second.href).not.toBe("/devices/b");
    const selected = parseGraphQuery(new URL(second.href, "https://example.test").searchParams);
    const reloaded = await homeHtml(topology, selected);
    expect(main(reloaded.html)).toContain('data-graph-panel="b"><span');
    expect(main(reloaded.html)).toContain('data-graph-panel="a" hidden');
    expect(panel(reloaded.html, "b")).toContain('class="graph-open" href="/devices/b"');
  });

  test("a no-JavaScript dependency view includes canonical connection details and usable selection URLs", () => {
    const topology = graph([node("switch"), node("action")], [edge("switch", "action", { label: "on", via: "button" })]);
    const scene = placed(projectGraph(topology, query({ view: "dependencies", focus: "switch" })));
    const html = main(renderGraphPage({ ctx: testPageContext(), scene }));
    expect(html).toContain('<svg class="graph-canvas"');
    expect(html).toContain('data-graph-tools hidden');
    expect(html).toContain('data-graph-from="switch" data-graph-to="action" data-related="true"');
    const expected = escapeHtml(graphHref(scene.query, { selected: "action" }));
    expect(html).toContain(`href="${expected}" data-graph-select="action"`);
    expect(panel(renderGraphPage({ ctx: testPageContext(), scene }), "switch")).toContain("Uses · on");
    expect(html).toContain("<dd>resolution</dd>"); expect(html).toContain("<dd>button</dd>");
  });

  test("explicit membership expansion retains focus and relation while bounding shared groups", () => {
    const members = Array.from({ length: 80 }, (_, index) => node(`member-${index}`));
    const topology = graph([node("focus"), node("group", { kind: "group", name: "Shared lights" }), ...members], [
      edge("group", "focus", { relation: "members" }), ...members.map(member => edge("group", member.id, { relation: "members" })),
    ]);
    const scene = placed(projectGraph(topology, query({ view: "dependencies", focus: "focus", selected: "focus", relations: ["members"] })));
    const html = renderGraphPage({ ctx: testPageContext(), scene });
    const groupCard = main(html).split('data-graph-select="group"')[1]!.split("</a>")[0]!;
    expect(scene.nodes).toHaveLength(2);
    expect(groupCard).toMatch(/<text class="graph-node-more"[^>]*><title>80 more<\/title>\+80<\/text>/u);
    const expand = links(panel(html, "group"), "graph-more")[0]!;
    expect(expand.text).toContain("80 more"); expect(expand.text).toContain("Expand");
    const expandedQuery = parseGraphQuery(new URL(expand.href, "https://example.test").searchParams);
    expect(expandedQuery.expanded).toContain("group");
    expect(expandedQuery.selected).toBe("group");
    expect(expandedQuery.focus).toBe("focus");
    expect(expandedQuery.relations).toEqual(["members"]);
    const expanded = projectGraph(topology, expandedQuery);
    expect(expanded.nodes).toHaveLength(24);
    expect(expanded.nodes.find(entry => entry.node.id === "group")?.hidden).toBe(58);
    const expandedHtml = renderGraphPage({ ctx: testPageContext(), scene: placed(expanded) });
    expect(links(panel(expandedHtml, "group"), "graph-more")[0]!.href).toBe("#graph-search");
  });

  test("names, context, roles and search text are escaped in server HTML", async () => {
    const hostile = '<img src=x onerror="boom">';
    const topology = graph([node("a", { name: hostile, context: '<script>boom()</script>' }), node("b")], [edge("a", "b", { label: hostile, via: '<svg onload="boom">' })]);
    const { html } = await homeHtml(topology, query({ q: hostile }));
    const body = main(html);
    expect(body).toContain(escapeHtml(hostile)); expect(body).toContain(escapeHtml('<script>boom()</script>'));
    expect(body).not.toContain(hostile); expect(body).not.toContain('<script>boom()</script>');
    const connected = main(renderGraphPage({ ctx: testPageContext(), scene: placed(projectGraph(topology, query({ view: "dependencies", focus: "a" }))) }));
    expect(connected).toContain(escapeHtml('<svg onload="boom">'));
    expect(connected).not.toContain('<svg onload="boom">');
  });

  test("public graph focus and element links use the current friendly addresses", () => {
    const topology = graph([node("canonical", { page: "", name: "Reading lamp" })]);
    const ctx = testPageContext({ apiAddresses: { devices: {}, groups: {}, services: {}, tags: {}, stateNodes: {}, elements: { canonical: "reading-lamp" } } });
    const html = main(renderGraphPage({ ctx, scene: placed(projectGraph(topology, query({ view: "dependencies", focus: "canonical", selected: "canonical", expanded: ["canonical"] }))) }));
    expect(html).toContain('name="focus" value="reading-lamp"');
    expect(html).toContain('class="graph-open" href="/elements/reading-lamp"');
    expect(html).toContain('focus=reading-lamp');
    expect(html).toContain('selected=reading-lamp');
    expect(html).toContain('expand=reading-lamp');
    expect(html).toContain('name="expand" value="reading-lamp"');
    expect(html).not.toContain('focus=canonical');
    expect(html).not.toContain('selected=canonical');
    // Selection and panel binding continue to use internal IDs.
    expect(html).toContain('data-graph-panel="canonical"');
  });

  test("Home reports cap counts and an expanded group offers search instead of a no-op expansion", async () => {
    const devices = Array.from({ length: 60 }, (_, index) => node(`lamp-${index}`));
    const topology = graph([...devices, room("room", "Study")], devices.map(device => edge("room", device.id, { relation: "tagged" })));
    const first = await homeHtml(topology);
    expect(main(first.html)).toContain("6 of 60 elements");
    const groupId = first.scene.groups[0]!.id;
    const more = links(main(first.html), "graph-more").find(link => link.text.includes("54 more"))!;
    expect(parseGraphQuery(new URL(more.href, "https://example.test").searchParams).expanded).toContain(groupId);
    const expanded = await homeHtml(topology, query({ expanded: [groupId] }));
    expect(main(expanded.html)).toContain("48 of 60 elements");
    const capped = links(main(expanded.html), "graph-more").find(link => link.text.includes("12 more"))!;
    expect(capped.href).toBe("#graph-search");
    expect(main(expanded.html)).toContain('id="graph-search"');
    expect(links(main(expanded.html), "graph-more").some(link => link.text === "Collapse")).toBe(true);
  });

  test("kind group headings are translated without decoding opaque group IDs", async () => {
    const { html } = await homeHtml(graph([node("lamp")]), query({ group: "kind" }), testPageContext({ locale: "de" }));
    const expected = testPageContext({ locale: "de" }).i18n.lookup("tags.kind.device")!;
    expect(main(html)).toContain(`<h2>${escapeHtml(expected)}</h2>`);
    expect(main(html)).not.toContain('<h2>Devices</h2>');
  });

  test("multi-room edge occurrences appear once per canonical role in the inspector", async () => {
    const topology = graph([node("switch"), node("target"), room("a", "Atrium"), room("b", "Study")], [
      edge("a", "switch", { relation: "tagged" }), edge("a", "target", { relation: "tagged" }),
      edge("b", "switch", { relation: "tagged" }), edge("b", "target", { relation: "tagged" }),
      edge("switch", "target", { label: "on" }), edge("switch", "target", { label: "off" }),
    ]);
    const { html, scene } = await homeHtml(topology, query({ selected: "switch" }));
    expect(scene.edges).toHaveLength(4);
    expect((panel(html, "switch").match(/<li>/gu) ?? [])).toHaveLength(2);
    expect(panel(html, "switch")).toContain("Uses · on"); expect(panel(html, "switch")).toContain("Uses · off");
  });

  test("the graph module and only visible canonical observation records are seeded", async () => {
    const topology = graph([node("lamp", { stateNode: "device/lamp" }), node("hidden", { stateNode: "device/hidden" }), room("a", "Atrium"), room("b", "Study")], [edge("a", "lamp", { relation: "tagged" }), edge("b", "lamp", { relation: "tagged" })]);
    const record: NodeRecord = { node: "device/lamp", version: 3, value: { status: "online" }, observedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const reads: string[][] = [];
    const ctx: PageContext = { ...testPageContext(), assetVersion: "graph-test", state: { snapshot(ids) { reads.push([...ids]); return ids.includes(record.node) ? [record] : []; } } };
    const { html } = await homeHtml(topology, query({ q: "lamp" }), ctx);
    expect(html).toContain('src="/ui/graph-test/browser/graph.ts"');
    const seed = JSON.parse(html.match(/<script type="application\/json" id="ht-state"[^>]*>(.*?)<\/script>/su)![1]!);
    expect(seed).toEqual([record]); expect(reads.at(-1)).toEqual(["device/lamp"]);
    expect(main(html)).toContain("Last known: Online");
    expect(main(html)).not.toContain('data-graph-state="device/hidden"');
  });

  test("a model definition does not offer an incompatible operational trace", () => {
    const topology = graph([node("model", { kind: "model", side: "schema", page: "/schemas/switch" })]);
    const html = renderGraphPage({ ctx: testPageContext(), scene: placed(projectGraph(topology, query({ view: "model", focus: "model" }))) });
    expect(panel(html, "model")).not.toContain("Trace dependencies");
    const tabBlock = main(html).match(/<nav class="graph-tabs"[^>]*>([\s\S]*?)<\/nav>/u)![1]!;
    expect(tabBlock).not.toContain("focus=model");
  });
});
