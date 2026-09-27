import { Hono } from "hono";
import type { Site } from "../site";
import type { StateHub } from "../state/hub";
import type { RegisteredRoute } from "../openapi/document";
import { assetVersion, errorJson, type AppEnvironment } from "../server/http";
import { buildElementApi, elementForPage, skillMarkdown } from "./contract";

import { API_FILES, API_PAGE_PATTERNS } from "./paths";

export function elementApiRoutes(site: Site, hub: StateHub, routes: () => readonly RegisteredRoute[]) {
  const app = new Hono<AppEnvironment>();
  for (const pattern of API_PAGE_PATTERNS) {
    for (const file of API_FILES) app.get(`${pattern}/${file}`, context => {
      const page = new URL(context.req.url).pathname.slice(0, -file.length - 1);
      const node = elementForPage(site, hub, page || "/");
      if (!node) return errorJson(context, 404, "not_found", "Element not found");
      const api = buildElementApi({ site, hub, node, page, origin: new URL(context.req.url).origin, routes: routes(), version: assetVersion() });
      context.header("Cache-Control", "no-store");
      if (file === "openapi.json") return context.json(api.document);
      context.header("Content-Type", "text/markdown; charset=utf-8");
      return context.body(skillMarkdown(api));
    });

  }
  return app;
}
