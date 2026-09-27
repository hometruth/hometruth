export interface PublicSchemaDocument {
  readonly $id: string;
  readonly $schema: string;
  readonly [key: string]: unknown;
}

export const SCHEMA_BASE_URL = "https://hometruth.ai/schemas/";

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
