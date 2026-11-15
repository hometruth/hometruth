import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { TokenStore } from "../auth/store";
import { FRESH_AUTH_MS, SESSION_MAX_MS } from "../auth/browser-store";
import { SESSION_COOKIE } from "../auth/browser-session";
import { CLIENT_ADDRESS_HEADER } from "../auth/network";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { BinarySwitch, type BinarySwitchState } from "../models/binary-switch";
import { CapabilityError, type InvokeOptions } from "../models/capability";
import { Device } from "../models/device";
import { createApp } from "../server/app";
import { Site } from "../site";
import { apiDispatcher, apiPath, responseBytes, responseResult } from "./api";
import { mcpRoutes } from "./routes";

class Relay extends BinarySwitch {
  state: BinarySwitchState = "off";
  calls = 0;
  async turnOn() { this.state = "on"; this.calls++; }
  async turnOff() { this.state = "off"; this.calls++; }
  async toggle() { this.state = this.state === "on" ? "off" : "on"; this.calls++; }
  async getState() { return this.state; }
  override async invoke(control: string, value?: unknown, options?: InvokeOptions) {
    if (control === "toggle" && !options?.confirmed) throw new CapabilityError("Confirm this synthetic action", "confirmation_required");
    return super.invoke(control, value, options);
  }
}
class SwitchDevice extends Device<{ host: string }> {
  readonly model = SHELLY_PLUS_1;
  readonly capabilities;
  constructor(id: string, name: string) { super(id, name, { host: "10.77.0.228" }); this.capabilities = { binarySwitch: new Relay(id) }; }
  async probe() { return {}; }
}

let tokens: TokenStore;
let app: ReturnType<typeof createApp>;
let garden: SwitchDevice;
let reading: SwitchDevice;
const clients: Client[] = [];
let oldPublicOrigin: string | undefined;
let oldTrustLan: string | undefined;
beforeEach(() => {
  oldPublicOrigin = process.env.HOMETRUTH_PUBLIC_ORIGIN;
  oldTrustLan = process.env.HOMETRUTH_TRUST_LAN;
  delete process.env.HOMETRUTH_PUBLIC_ORIGIN;
  process.env.HOMETRUTH_TRUST_LAN = "true";
  tokens = new TokenStore();
  garden = new SwitchDevice("relay-a", "Garden Relay");
  reading = new SwitchDevice("relay-b", "Reading Relay");
  app = createApp(undefined, new Site([garden, reading]), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, tokens);
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  tokens.close();
  if (oldPublicOrigin === undefined) delete process.env.HOMETRUTH_PUBLIC_ORIGIN; else process.env.HOMETRUTH_PUBLIC_ORIGIN = oldPublicOrigin;
  if (oldTrustLan === undefined) delete process.env.HOMETRUTH_TRUST_LAN; else process.env.HOMETRUTH_TRUST_LAN = oldTrustLan;
});

const issue = (permission: "read" | "write" | "admin", device?: string) => tokens.issue({ name: "Synthetic MCP agent", permissions: [permission], subject: device ? { device } : { all: true } });
const headers = (token: string) => ({ authorization: `Bearer ${token}` });
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
function rpc(body: unknown, extra: Record<string, string> = {}, url = "http://localhost/mcp") {
  return app.request(url, { method: "POST", headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
}
async function connect(extra: Record<string, string>, target: { fetch(request: Request): Response | Promise<Response> } = app) {
  const client = new Client({ name: "hometruth-integration-test", version: "1" });
  clients.push(client);
  // The SDK's getter is string | undefined while Transport declares an optional
  // string; this stateless test never supplies a session ID.
  const transport: Omit<StreamableHTTPClientTransport, "sessionId"> = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    requestInit: { headers: extra },
    fetch: async (input, init) => target.fetch(new Request(input, init)),
  });
  await client.connect(transport);
  return client;
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return await client.callTool({ name, arguments: args }) as CallToolResult;
}
function data(result: CallToolResult): any { return result.structuredContent; }
const request = (client: Client, method: string, path: string, body?: unknown) => call(client, "hometruth_request", { method, path, ...(body === undefined ? {} : { body }) });

test("the SDK initializes, lists tools and discovers/describes the entire visible installation by friendly names", async () => {
  const client = await connect(headers(issue("read").token));
  expect(client.getServerVersion()?.name).toBe("hometruth");
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["hometruth_discover", "hometruth_describe", "hometruth_request"]);
  const inventory = data(await call(client, "hometruth_discover", { kind: "device" })).data;
  expect(inventory.elements.map((element: any) => element.address).sort()).toEqual(["garden-relay", "reading-relay"]);
  expect(data(await call(client, "hometruth_describe", { address: "garden-relay" })).data.element.name).toBe("Garden Relay");
  const contract = data(await call(client, "hometruth_describe", { method: "GET", path: "/api/switches/garden-relay/state" })).data;
  expect(contract.path).toBe("/api/switches/{id}/state");
  expect(contract.operation.responses["200"]).toBeDefined();
  expect(data(await request(client, "GET", "/api/switches/garden-relay/state"))).toMatchObject({ status: 200, data: { value: "off" } });
});

test("every MCP request authenticates again, including after a token is revoked", async () => {
  expect((await rpc(initialize)).status).toBe(401);
  expect((await rpc(initialize, headers("invalid"))).status).toBe(401);
  const token = issue("read");
  const client = await connect(headers(token.token));
  tokens.revoke(token.record.kid);
  await expect(call(client, "hometruth_discover")).rejects.toThrow();
  for (const method of ["GET", "DELETE"]) expect((await app.request("http://localhost/mcp", { method })).status).toBe(401);
});

test("read and narrow write permissions cannot escape device scope or operate on partly reachable groups", async () => {
  const reader = await connect(headers(issue("read", garden.id).token));
  const discovered = JSON.stringify(data(await call(reader, "hometruth_discover")));
  expect(discovered).toContain("Garden Relay");
  expect(discovered).not.toContain("Reading Relay");
  expect(data(await call(reader, "hometruth_describe", { address: "reading-relay" })).status).toBe(404);
  expect(data(await request(reader, "POST", "/api/switches/garden-relay/turn-on")).status).toBe(403);
  expect(data(await request(reader, "GET", "/api/switches/reading-relay/state")).status).toBe(403);
  const writer = await connect(headers(issue("write", garden.id).token));
  expect(data(await request(writer, "POST", "/api/switches/garden-relay/turn-on")).status).toBe(200);
  expect(garden.capabilities.binarySwitch.state).toBe("on");
  expect(data(await request(writer, "POST", "/api/switches/reading-relay/turn-on")).status).toBe(403);
  expect(reading.capabilities.binarySwitch.calls).toBe(0);
  expect(data(await request(writer, "GET", "/api/tokens")).status).toBe(403);
  const all = await app.request("/api/inventory", { headers: headers(issue("read").token) });
  const group = (await all.json() as any).elements.find((entry: any) => entry.kind === "group" && entry.id === "automatic:switches");
  expect(group).toBeDefined();
  expect(data(await request(writer, "GET", `/api/device-groups/${group.address}`)).status).toBe(403);
});

test("action validation and explicit confirmation remain enforced with no implicit retry", async () => {
  const client = await connect(headers(issue("write").token));
  const path = "/api/devices/garden-relay/controls/toggle";
  const denied = await request(client, "POST", path, {});
  expect(denied.isError).toBe(true);
  expect(data(denied).data.error.code).toBe("confirmation_required");
  expect(garden.capabilities.binarySwitch.calls).toBe(0);
  expect(data(await request(client, "POST", path, null)).status).toBe(400);
  expect(data(await request(client, "POST", path, { confirmed: "yes" })).status).toBe(400);
  expect(data(await request(client, "POST", path, { confirmed: true })).status).toBe(200);
  expect(garden.capabilities.binarySwitch.calls).toBe(1);
});

test("browser freshness and trusted LAN limits are preserved by internal dispatch", async () => {
  const admin = issue("admin");
  const stale = tokens.browsers.issue(admin.record.kid, "Synthetic browser", null, Date.now() - FRESH_AUTH_MS - 1000);
  const browser = await connect({ cookie: `${SESSION_COOKIE}=${stale.value}` });
  const create = { name: "Denied token", permissions: ["read"], subject: { all: true } };
  expect(data(await request(browser, "POST", "/api/tokens", create))).toMatchObject({ status: 403, data: { error: { code: "reauthentication_required" } } });
  const local = await connect({ [CLIENT_ADDRESS_HEADER]: "10.77.0.5" });
  expect(data(await request(local, "POST", "/api/tokens", create)).status).toBe(403);
  const expired = tokens.browsers.issue(admin.record.kid, "Expired", null, Date.now() - SESSION_MAX_MS - 1000);
  expect((await rpc(initialize, { cookie: `${SESSION_COOKIE}=${expired.value}` })).status).toBe(401);
});

test("MCP rejects hostile origins, arbitrary hosts, wrong media types and oversized JSON bodies", async () => {
  const auth = headers(issue("read").token);
  expect((await rpc(initialize, { ...auth, origin: "https://untrusted.example" })).status).toBe(403);
  expect((await rpc(initialize, { ...auth, origin: "http://untrusted.example" }, "http://untrusted.example/mcp")).status).toBe(403);
  process.env.HOMETRUTH_PUBLIC_ORIGIN = "https://control.example.test";
  expect((await rpc(initialize, auth, "http://localhost/mcp")).status).toBe(403);
  const good = await rpc(initialize, { ...auth, origin: "https://control.example.test" }, "https://control.example.test/mcp");
  expect(good.status).toBe(200);
  expect(good.headers.get("cache-control")).toBe("no-store");
  delete process.env.HOMETRUTH_PUBLIC_ORIGIN;
  expect((await rpc(initialize, { ...auth, "content-type": "text/plain" })).status).toBe(415);
  const large = await rpc({ ...initialize, padding: "x".repeat(1024 * 1024) }, auth);
  expect(large.status).toBe(413);
});

test("tools reject external URLs, path ambiguity, headers, streams and binary uploads", async () => {
  const client = await connect(headers(issue("admin").token));
  for (const path of ["https://example.test/api/devices", "//example.test/api/devices", "/mcp", "/api/../mcp", "/api/%2e%2e/mcp", "/api/devices%2fgarden-relay", "/api/devices%5cgarden-relay", "/api/%252e%252e/mcp", "/api//devices", "/api/devices?x=1", "/api/devices#x"]) {
    expect(apiPath(path)).toBe(false);
    expect(data(await request(client, "GET", path)).status).toBe(400);
  }
  expect((await call(client, "hometruth_request", { method: "GET", path: "/api/devices", headers: { authorization: "anything" } })).isError).toBe(true);
  expect(data(await request(client, "GET", "/api/state/stream")).status).toBe(415);
  expect(data(await request(client, "POST", "/api/camera/devices/example/talkback/audio", {})).status).toBe(415);
  expect(data(await request(client, "POST", "/api/not-documented", {})).status).toBe(404);
});

test("the SDK returns finite image and audio downloads as MCP media", async () => {
  const media = new Hono();
  media.get("/api/openapi.json", context => context.json({ paths: {
    "/api/image": { get: { responses: { "200": { content: { "image/png": {} } } } } },
    "/api/audio": { get: { responses: { "200": { content: { "audio/wav": {} } } } } },
  } }));
  media.get("/api/image", () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
  media.get("/api/audio", () => new Response(new Uint8Array([4, 5]), { headers: { "content-type": "audio/wav", "content-length": "2" } }));
  media.route("/", mcpRoutes(request => media.fetch(request)));
  const client = await connect({}, media);
  expect((await request(client, "GET", "/api/image")).content).toEqual([{ type: "image", data: "AQID", mimeType: "image/png" }]);
  expect((await request(client, "GET", "/api/audio")).content).toEqual([{ type: "audio", data: "BAU=", mimeType: "audio/wav" }]);
});

test("responses have observed-byte caps and cancellation deadlines, and streaming audio is cancelled", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(10)); }, cancel() { cancelled = true; } }));
  await expect(responseBytes(response, 15)).rejects.toThrow("MCP limit");
  expect(cancelled).toBe(true);
  cancelled = false;
  const hanging = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  await expect(responseBytes(hanging, 15, AbortSignal.timeout(10))).rejects.toThrow("timed out");
  expect(cancelled).toBe(true);
  cancelled = false;
  const audio = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "audio/mpeg" } });
  expect((await responseResult(audio)).isError).toBe(true);
  expect(cancelled).toBe(true);
  const errored = new Response(new ReadableStream({ start(controller) { controller.error(new Error("Synthetic stream error")); } }));
  await expect(responseBytes(errored, 15, AbortSignal.abort())).rejects.toThrow("cancelled");
});

test("caller cancellation reaches the dispatched request and no fresh authority is invented", async () => {
  const controller = new AbortController();
  const outer = new Request("http://localhost/mcp", { signal: controller.signal, headers: { authorization: "Bearer original", cookie: "existing=session", origin: "http://localhost", [CLIENT_ADDRESS_HEADER]: "10.77.0.8", "x-forwarded-for": "10.77.0.1" } });
  let forwarded: Request | undefined;
  const api = apiDispatcher(outer, async request => { forwarded = request; return new Promise(() => {}); });
  const pending = api({ method: "GET", path: "/api/devices" });
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(forwarded?.signal.aborted).toBe(true);
  expect(forwarded?.headers.get("authorization")).toBe("Bearer original");
  expect(forwarded?.headers.get("origin")).toBe("http://localhost");
  expect(forwarded?.headers.get(CLIENT_ADDRESS_HEADER)).toBe("10.77.0.8");
  expect(forwarded?.headers.has("x-forwarded-for")).toBe(false);
  let called = false;
  const cancelled = apiDispatcher(outer, () => { called = true; return Response.json({}); });
  await expect(cancelled({ method: "POST", path: "/api/devices" })).rejects.toThrow();
  expect(called).toBe(false);
});
