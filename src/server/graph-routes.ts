/** The raw topology and the exact projected, positioned scene used by the graph page. */
import { Hono } from "hono";
import type { StateHub } from "../state/hub";
import { parseGraphQuery, projectGraph } from "../graph/scene";
import { layoutGraphScene, type PlacedGraphScene } from "../graph/scene-layout";
import { errorJson, pageContext, type AppEnvironment } from "./http";
import { renderGraphPage } from "../ui/graph-page";
import { addressesFor } from "../element-api/addresses";

/** Public request selectors use current names; projection identities stay internal. */
function graphParameters(hub: StateHub, params: URLSearchParams): URLSearchParams | undefined {
  const addresses = addressesFor(hub);
  const resolved = new URLSearchParams();
  for (const [key, value] of params) {
    if (!value || !["focus", "selected", "expand"].includes(key)) { resolved.append(key, value); continue; }
    const node = addresses.node(value);
    if (node) { resolved.append(key, node.id); continue; }
    if (key !== "expand") return undefined;
    let group: unknown;
    try { group = JSON.parse(value); } catch { return undefined; }
    if (!Array.isArray(group)) return undefined;
    if (group.length === 2 && group[0] === "room" && typeof group[1] === "string") {
      const room = addresses.node(group[1]);
      if (room?.kind !== "tag" || room.ids[0] !== "room") return undefined;
      resolved.append(key, JSON.stringify(["room", room.id]));
    } else if (group.length === 2 && group[0] === "kind" && typeof group[1] === "string" && addresses.topology.nodes().some(candidate => candidate.kind === group[1])) {
      resolved.append(key, JSON.stringify(group));
    } else if (group.length === 1 && group[0] === "unassigned") resolved.append(key, JSON.stringify(group));
    else return undefined;
  }
  return resolved;
}

export function graphRoutes(hub: StateHub, layoutScene: typeof layoutGraphScene = layoutGraphScene) {
  const app = new Hono<AppEnvironment>();
  const load = () => hub.data.topology();

  app.get("/graph", async (c) => {
    const graph = load();
    const params = graphParameters(hub, new URL(c.req.url).searchParams);
    if (!params) return errorJson(c, 404, "not_found", "No such element in the graph");
    const query = parseGraphQuery(params);
    if (query.focus && !graph.node(query.focus)) return errorJson(c, 404, "not_found", "No such element in the graph");
    let scene: PlacedGraphScene;
    try {
      scene = await layoutScene(projectGraph(graph, query));
    } catch {
      return errorJson(c, 503, "graph_unavailable", "The graph could not be laid out. Try a narrower view.");
    }
    c.header("Cache-Control", "no-store");
    return c.html(renderGraphPage({ ctx: pageContext(c), scene }));
  });

  app.get("/api/graph", (c) => {
    const graph = load();
    const side = c.req.query("side");
    const kind = c.req.query("kind");
    let nodes = graph.nodes();
    if (side === "schema" || side === "instance" || side === "tag") nodes = nodes.filter((node) => node.side === side);
    if (kind) nodes = nodes.filter((node) => node.kind === kind);
    const ids = new Set(nodes.map((node) => node.id));
    const edges = graph.edges().filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    return c.json({ nodes, edges, generatedAt: graph.generatedAt });
  });

  app.get("/api/graph/scene", async (c) => {
    const graph = load();
    const params = graphParameters(hub, new URL(c.req.url).searchParams);
    if (!params) return errorJson(c, 404, "not_found", "No such element in the graph");
    const query = parseGraphQuery(params);
    if (query.focus && !graph.node(query.focus)) return errorJson(c, 404, "not_found", "No such element in the graph");
    try {
      c.header("Cache-Control", "no-store");
      return c.json(await layoutScene(projectGraph(graph, query)));
    } catch {
      return errorJson(c, 503, "graph_unavailable", "The graph could not be laid out. Try a narrower view.");
    }
  });

  return app;
}
