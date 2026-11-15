import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { z } from "zod";
import { isPrivateAddress } from "../auth/network";
import type { InventoryElement } from "../client/index";
import type { OpenApiDocument } from "../openapi/document";
import { assetVersion, errorJson, isAllowedChangeOrigin, type AppEnvironment } from "../server/http";
import { apiDispatcher, apiPath, documentedOperation, finiteOperation, responseJson, responseResult, toolResult, type AppFetch } from "./api";

export const MCP_PATH = "/mcp";
const methodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const queryValue = z.union([z.string(), z.number().finite(), z.boolean()]);

/** An explicitly configured origin, or local development address, prevents DNS rebinding. */
function trustedHost(url: URL): boolean {
  const configured = process.env.HOMETRUTH_PUBLIC_ORIGIN;
  if (configured) return url.origin === new URL(configured).origin;
  return url.hostname === "localhost" || url.hostname === "hometruth.localhost" || isPrivateAddress(url.hostname)
    || Boolean(process.env.HOST && !["0.0.0.0", "::"].includes(process.env.HOST) && url.hostname === process.env.HOST);
}

function serverFor(request: Request, dispatch: AppFetch) {
  const api = apiDispatcher(request, dispatch);
  const server = new McpServer({ name: "hometruth", version: assetVersion() }, {
    instructions: "HomeTruth covers this entire installation. Discover current friendly element addresses, describe the relevant element or API operation, and use documented requests. Only perform changes requested by the user; inspect schemas and preserve required confirmation fields. The same credentials and element permissions apply as REST. Each REST request has a 120-second deadline; response bodies are limited to 4 MiB and 30 seconds. Video, event streams, audio without a finite content length, binary uploads, and longer operations use their native REST endpoints. A cancelled change may already have happened: inspect state before retrying.",
    maxToolInputElements: 10000,
  });
  server.registerTool("hometruth_discover", {
    title: "Discover HomeTruth",
    description: "Find elements throughout this installation using their current friendly names and addresses. Results respect your access permissions.",
    inputSchema: z.object({ query: z.string().max(200).optional(), kind: z.string().max(100).optional(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(50) }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ query, kind, offset, limit }) => {
    const response = await api({ method: "GET", path: "/api/inventory" });
    if (!response.ok) return responseResult(response);
    const inventory = await responseJson<{ elements: InventoryElement[] }>(response);
    const search = query?.toLocaleLowerCase();
    const elements = inventory.elements.filter(element => (!kind || element.kind === kind)
      && (!search || `${element.name} ${element.address} ${element.context}`.toLocaleLowerCase().includes(search)));
    return toolResult({ elements: elements.slice(offset, offset + limit).map(({ address, name, kind, context, page }) => ({ address, name, kind, context, page })), total: elements.length,
      ...(offset + limit < elements.length ? { nextOffset: offset + limit } : {}) });
  });
  server.registerTool("hometruth_describe", {
    title: "Describe HomeTruth",
    description: "Describe an element by friendly address, or inspect the current OpenAPI contract. Supply method and path to inspect one REST operation and its schemas; no arguments returns the whole installation API document.",
    inputSchema: z.object({ address: z.string().min(1).max(300).optional(), method: methodSchema.optional(), path: z.string().max(2000).optional() }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ address, method, path }) => {
    if (address) {
      if (method || path) return toolResult({ error: "Choose an element address or a method and path" }, 400);
      const endpoint = `/api/inventory/${encodeURIComponent(address)}`;
      if (!apiPath(endpoint)) return toolResult({ error: "Use the friendly address returned by hometruth_discover" }, 400);
      return responseResult(await api({ method: "GET", path: endpoint }));
    }
    if (Boolean(method) !== Boolean(path)) return toolResult({ error: "Supply both method and path" }, 400);
    const response = await api({ method: "GET", path: "/api/openapi.json" });
    if (!response.ok || !method || !path) return responseResult(response);
    const document = await responseJson<OpenApiDocument>(response);
    const match = documentedOperation(document, method, path);
    return match ? toolResult({ ...match, components: document.components }) : toolResult({ error: "No documented operation matches that method and path" }, 404);
  });
  server.registerTool("hometruth_request", {
    title: "Request HomeTruth",
    description: "Call a documented REST operation anywhere in this installation. Use a current friendly address, a local /api/... path, separate query parameters, and the schema's JSON body. Existing authorization, validation and action confirmations are enforced. Finite images and audio are returned as MCP media, up to 4 MiB. Video, event streams and binary uploads use native REST.",
    inputSchema: z.object({ method: methodSchema, path: z.string().min(1).max(2000), query: z.record(z.string(), z.union([queryValue, z.array(queryValue).max(100)])).optional(), body: z.unknown().optional() }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (input) => {
    if (!apiPath(input.path)) return toolResult({ error: "Use a canonical /api/... path; put query parameters in query" }, 400);
    if (input.method === "GET" && input.body !== undefined) return toolResult({ error: "GET requests do not accept a body" }, 400);
    const response = await api({ method: "GET", path: "/api/openapi.json" });
    if (!response.ok) return responseResult(response);
    const document = await responseJson<OpenApiDocument>(response);
    const match = documentedOperation(document, input.method, input.path);
    if (!match) return toolResult({ error: "No documented operation matches that method and path" }, 404);
    if (!finiteOperation(match.operation)) return toolResult({ error: "This operation requires its native REST media or streaming transport", method: input.method, path: input.path }, 415);
    return responseResult(await api(input));
  });
  return server;
}

export function mcpRoutes(dispatch: AppFetch) {
  const app = new Hono<AppEnvironment>();
  app.use(MCP_PATH, async (context, next) => {
    context.header("Cache-Control", "no-store");
    if (!trustedHost(new URL(context.req.url))) return errorJson(context, 403, "forbidden", "Use this installation's configured origin for MCP");
    const origin = context.req.header("origin");
    if (origin && !isAllowedChangeOrigin(context, origin)) return errorJson(context, 403, "forbidden", "Cross-origin MCP requests are not allowed");
    await next();
    context.header("Cache-Control", "no-store");
  });
  app.post(MCP_PATH, async context => {
    const server = serverFor(context.req.raw, dispatch);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize: 1024 * 1024 });
    try {
      await server.connect(transport);
      return await transport.handleRequest(context.req.raw);
    } finally { await server.close(); }
  });
  // Stateless JSON transport has no resumable event stream or session to delete.
  app.get(MCP_PATH, context => context.json({ error: "MCP uses POST requests at this endpoint" }, 405, { Allow: "POST" }));
  app.delete(MCP_PATH, context => context.json({ error: "This MCP server has no persistent sessions" }, 405, { Allow: "POST" }));
  return app;
}
