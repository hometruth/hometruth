import { Hono } from "hono";
import type { GraphStore } from "../graph/store";
import type { StateHub } from "../state/hub";
import type { RegisteredRoute } from "../openapi/document";
import { buildElementApi } from "../element-api/contract";
import { assetVersion, errorJson, isAllowedChangeOrigin, requestJson, type AppEnvironment } from "../server/http";
import { inventoryFor, visibleElement } from "./inventory";
import { clientMethods } from "./methods";
import { clientSource, compilePlayground } from "./source";

export function clientRoutes(hub: StateHub, routes: () => readonly RegisteredRoute[], store?: GraphStore) {
  const app = new Hono<AppEnvironment>();
  app.get("/ht.ts", context => context.body(clientSource, 200, { "Content-Type": "text/plain; charset=utf-8" }));
  const javascript = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(clientSource);
  app.get("/ht.js", context => context.body(javascript, 200, { "Content-Type": "text/javascript; charset=utf-8" }));

  app.get("/api/inventory", context => {
    const inventory = inventoryFor(hub, store);
    const principal = context.get("principal");
    return context.json({ elements: inventory.entries.filter(entry => visibleElement(inventory.topology.node(entry.key)!, hub, principal)) });
  });
  app.get("/api/inventory/:uuid", context => {
    const inventory = inventoryFor(hub, store);
    const entry = inventory.byUuid.get(context.req.param("uuid"));
    const node = entry && inventory.topology.node(entry.key);
    if (!entry || !node || !visibleElement(node, hub, context.get("principal"))) return errorJson(context, 404, "not_found", "Element not found");
    const api = buildElementApi({ site: hub.data.sources.site, hub, node, page: entry.page === "/" ? "" : entry.page, origin: new URL(context.req.url).origin, routes: routes(), version: assetVersion(), uuid: entry.uuid });
    return context.json({ element: entry, properties: api.properties, methods: clientMethods(api) });
  });
  app.post("/api/playground", async context => {
    const origin = context.req.header("origin");
    if (origin && !isAllowedChangeOrigin(context, origin)) return errorJson(context, 403, "forbidden", "Use the playground from this install");
    if (Number(context.req.header("content-length") ?? 0) > 65536) return errorJson(context, 413, "too_large", "Code must be at most 64 KiB");
    const input = await requestJson(context) as { code?: unknown } | undefined;
    if (typeof input?.code !== "string" || input.code.length > 65536) return errorJson(context, 400, "invalid_request", "Send TypeScript code, at most 64 KiB");
    try { return context.json({ code: compilePlayground(input.code) }); }
    catch (error) { return errorJson(context, 400, "invalid_typescript", String(error)); }
  });
  return app;
}
