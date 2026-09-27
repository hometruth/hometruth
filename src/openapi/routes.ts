/**
 * The two routes that expose this install's own API description: the document
 * and the page you drive it from.
 *
 * The routes are registered last, after everything else is mounted, and read
 * `app.routes` at request time rather than at wiring time — so the description
 * is of the app as it finally stands, this route included, and a route added
 * tomorrow appears without anyone remembering to add it here too.
 */
import { Hono } from "hono";
import type { Principal } from "../auth/scope";
import type { Site } from "../site";
import { assetVersion, pageContext, type AppEnvironment } from "../server/http";
import { renderApiPage } from "../ui/api-page";
import { buildOpenApiDocument, describedSite, type RegisteredRoute } from "./document";

export const OPENAPI_DOCUMENT_PATH = "/api/openapi.json";
export const OPENAPI_PAGE_PATH = "/api-docs";

export function openApiRoutes(
  site: Site,
  routes: () => readonly RegisteredRoute[],
  trustsLocalNetwork: boolean,
) {
  const app = new Hono<AppEnvironment>();

  const document = (context: Parameters<typeof pageContext>[0]) => {
    // A narrowed token gets a narrowed description: the same principal that
    // would refuse the call decides which ids it is even shown.
    const principal: Principal | undefined = context.get("principal");
    const reach = principal?.devices();
    const siteWide = reach === undefined || reach === "all";
    return buildOpenApiDocument({
      routes: routes(),
      site: describedSite(site, { reaches: id => siteWide || reach.has(id), siteWide }),
      origin: new URL(context.req.url).origin,
      version: assetVersion(),
      trustsLocalNetwork,
    });
  };

  app.get(OPENAPI_DOCUMENT_PATH, context => {
    context.header("Cache-Control", "no-store");
    return context.json(document(context));
  });

  app.get(OPENAPI_PAGE_PATH, context => {
    context.header("Cache-Control", "no-store");
    return context.html(renderApiPage({ ctx: pageContext(context), document: document(context) }));
  });

  return app;
}
