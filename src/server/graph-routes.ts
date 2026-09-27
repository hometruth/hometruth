/**
 * The graph over HTTP.
 *
 * `GET /api/graph/:key` is what the Graph tab shows, as data: an element, its
 * connections, one level beyond, and the coordinates they are drawn at. Because
 * the layout is computed on the server, a caller that wants to draw it
 * differently still gets a usable answer, and one that only wants the
 * relationships can ignore the geometry.
 *
 * `GET /api/graph` is the whole thing, for an agent or a script that wants to
 * ask a question the UI does not answer: which devices implement a capability,
 * what a schema is referenced by, what a service touches.
 */
import { Hono } from "hono";
import type { StateHub } from "../state/hub";
import { DEFAULT_CAPS, ego } from "../graph/ego";
import { layout } from "../graph/layout";
import { errorJson, pageContext, type AppEnvironment } from "./http";
import { parseViewState, renderFullGraphPage } from "../ui/graph-page";
import { siteNode } from "../graph/instance-graph";

const MAX_DEPTH = 3;

export function graphRoutes(hub: StateHub) {
  const app = new Hono<AppEnvironment>();
  const load = () => hub.data.topology();

  // The whole graph on its own page, reached from an element's Graph tab. Its
  // own destination rather than a mode of the tab, because it is a different
  // question: not "what is this made of" but "where does this sit in all of it".
  app.get("/graph", (c) => {
    const graph = load();
    const url = new URL(c.req.url);
    const focus = url.searchParams.get("focus") ?? undefined;
    const page = renderFullGraphPage({
      ctx: pageContext(c), graph, root: siteNode(),
      ...(focus && graph.node(focus) ? { focus } : {}),
      state: parseViewState(url.searchParams), base: url.pathname,
    });
    return page ? c.html(page) : errorJson(c, 404, "not_found", "No graph to show");
  });

  app.get("/api/graph", (c) => {
    const graph = load();
    const side = c.req.query("side");
    const kind = c.req.query("kind");
    let nodes = graph.nodes();
    if (side === "schema" || side === "instance") nodes = nodes.filter((node) => node.side === side);
    if (kind) nodes = nodes.filter((node) => node.kind === kind);
    const ids = new Set(nodes.map((node) => node.id));
    const edges = graph.edges().filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    return c.json({ nodes, edges, generatedAt: graph.generatedAt });
  });

  app.get("/api/graph/:key", (c) => {
    const graph = load();
    const key = c.req.param("key");
    if (!graph.node(key)) return errorJson(c, 404, "not_found", "No such element in the graph");
    const requested = Number(c.req.query("depth"));
    const depth = Number.isFinite(requested) ? Math.max(0, Math.min(MAX_DEPTH, Math.trunc(requested))) : 2;
    const view = ego(graph, key, depth, DEFAULT_CAPS);
    if (!view) return errorJson(c, 404, "not_found", "No such element in the graph");
    const placed = layout(view);
    return c.json({
      focus: placed.focus,
      depth,
      nodes: placed.nodes,
      edges: placed.edges,
      truncated: placed.truncated,
      viewBox: placed.viewBox,
      generatedAt: graph.generatedAt,
    });
  });

  return app;
}
