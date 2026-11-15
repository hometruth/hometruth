import type { PublicHostingEnv } from "../../scripts/schema-hosting/worker-configuration";

export interface PublicSchemaDocument {
  readonly $id: string;
  readonly $schema: string;
  readonly [key: string]: unknown;
}

export const SCHEMA_BASE_URL = "https://hometruth.ai/schemas/";

export const DEMO_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Map the single public URL for each exported page to its static file. */
function demoAssetPath(path: string): string | undefined {
  if (path === "/demo") return "/demo/index.html";
  if (!path.startsWith("/demo/") || path.endsWith("/") || path.includes("%") || path.includes("//")) return;
  if (path.split("/").some(segment => segment.startsWith(".") || segment.startsWith("_"))) return;
  if (path.startsWith("/demo/assets/")) {
    return /\.(?:js|css|svg|png|jpg|jpeg|webp|gif|ico|woff|woff2|ttf|mp3|wav|mp4)$/i.test(path) ? path : undefined;
  }
  if (path === "/demo/index.html") return;
  return path.endsWith(".html") ? path : undefined;
}

/** Static files and schema definitions only: this host has no installation bindings. */
export function createPublicWorker(documents: readonly PublicSchemaDocument[]) {
  const schemas = createSchemaWorker(documents);
  return {
    async fetch(request: Request, env?: { ASSETS: Pick<PublicHostingEnv["ASSETS"], "fetch"> }): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== "/demo" && !url.pathname.startsWith("/demo/")) return schemas.fetch(request);
      const headers = new Headers({
        "Content-Security-Policy": DEMO_CONTENT_SECURITY_POLICY,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=()",
        "Cache-Control": "public, max-age=300, must-revalidate, no-transform",
      });
      const assetPath = demoAssetPath(url.pathname);
      if (!assetPath || !env?.ASSETS) return new Response(request.method === "HEAD" ? null : "Not found\n", { status: 404, headers });
      if (request.method !== "GET" && request.method !== "HEAD") {
        headers.set("Allow", "GET, HEAD");
        return new Response("Method not allowed\n", { status: 405, headers });
      }
      url.pathname = assetPath;
      url.search = "";
      const asset = await env.ASSETS.fetch(new Request(url, { method: request.method }));
      // HTML aliases and host redirects are never part of the exported app.
      if (asset.status >= 300 && asset.status < 400 && asset.status !== 304) {
        return new Response(request.method === "HEAD" ? null : "Not found\n", { status: 404, headers });
      }
      const result = new Response(request.method === "HEAD" ? null : asset.body, asset);
      headers.forEach((value, name) => result.headers.set(name, value));
      result.headers.delete("Set-Cookie");
      return result;
    },
  };
}

/** The deployed Worker receives only serialized definitions, never the device registry. */
export function createSchemaWorker(documents: readonly PublicSchemaDocument[]) {
  const schemas = new Map(documents.map(schema => [new URL(schema.$id).pathname, JSON.stringify(schema, null, 2) + "\n"]));
  const catalog = JSON.stringify({
    schemas: documents.map(schema => ({ $id: schema.$id, title: schema.title ?? schema.$id })),
  }, null, 2) + "\n";

  return {
    fetch(request: Request): Response {
      const path = new URL(request.url).pathname;
      const body = path === "/schemas/" ? catalog : schemas.get(path);
      const headers = new Headers({
        "Access-Control-Allow-Origin": "*",
        "X-Content-Type-Options": "nosniff",
      });
      if (body === undefined) {
        return new Response(request.method === "HEAD" ? null : "Not found\n", { status: 404, headers });
      }
      if (request.method === "OPTIONS") {
        headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        return new Response(null, { status: 204, headers });
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        headers.set("Allow", "GET, HEAD, OPTIONS");
        return new Response("Method not allowed\n", { status: 405, headers });
      }
      headers.set("Content-Type", path === "/schemas/" ? "application/json; charset=utf-8" : "application/schema+json; charset=utf-8");
      headers.set("Cache-Control", "public, max-age=300, must-revalidate");
      return new Response(request.method === "HEAD" ? null : body, { headers });
    },
  };
}
