import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpsRelay, type RelayExchange } from "./https-relay";

describe("HttpsRelay", () => {
  test("forwards a request for one of its hostnames to the real address, returns the answer, and keeps a private copy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relay-"));
    const forwarded: { address: string; hostname: string; method: string; path: string; body: string; host: string | null }[] = [];
    const exchanges: RelayExchange[] = [];
    const relay = new HttpsRelay({
      hostnames: ["apis-us-west.cloudedge360.com"],
      resolve: async () => ["3.136.187.63"],
      captureDirectory: directory,
      now: () => 1_788_700_000_000,
      onExchange: (exchange) => exchanges.push(exchange),
      forward: async (address, hostname, request, body) => {
        forwarded.push({ address, hostname, method: request.method, path: new URL(request.url).pathname, body: new TextDecoder().decode(body), host: request.headers.get("host") });
        return new Response(JSON.stringify({ resultCode: "1001", token: "secret" }), { status: 200, headers: { "content-type": "application/json", server: "openresty" } });
      },
    });
    const request = new Request("https://10.78.0.231/v14/devices/status?x=1", { method: "POST", headers: { host: "apis-us-west.cloudedge360.com", "content-type": "application/json" }, body: JSON.stringify({ deviceID: "ppsc1" }) });
    const response = await relay.handle(request, { address: "10.78.0.147", device: { id: "example-camera", name: "Kitchen", host: "10.78.0.147", cloudHostnames: [] } });
    expect(response?.status).toBe(200);
    expect(response?.headers.get("server")).toBe("openresty");
    expect(await response?.json()).toEqual({ resultCode: "1001", token: "secret" });
    expect(forwarded).toEqual([{ address: "3.136.187.63", hostname: "apis-us-west.cloudedge360.com", method: "POST", path: "/v14/devices/status", body: JSON.stringify({ deviceID: "ppsc1" }), host: "apis-us-west.cloudedge360.com" }]);
    expect(exchanges[0]).toMatchObject({ hostname: "apis-us-west.cloudedge360.com", method: "POST", path: "/v14/devices/status?x=1", status: 200, requestBytes: 20, responseBytes: 38 });
    const files = await readdir(join(directory, "apis-us-west.cloudedge360.com"));
    expect(files).toHaveLength(1);
    const kept = JSON.parse(await readFile(join(directory, "apis-us-west.cloudedge360.com", files[0]!), "utf8")) as { device: string; request: { path: string }; response: { status: number; body: string } };
    expect(kept.device).toBe("example-camera");
    expect(kept.request.path).toBe("/v14/devices/status?x=1");
    expect(kept.response.body).toContain("secret");
    expect(relay.count).toBe(1);
  });

  test("leaves other hostnames alone", async () => {
    const relay = new HttpsRelay({ hostnames: ["apis-us-west.cloudedge360.com"], resolve: async () => ["1.1.1.1"], captureDirectory: "", forward: async () => new Response("no") });
    expect(await relay.handle(new Request("https://10.78.0.231/", { headers: { host: "example.com" } }), { address: "10.78.0.147" })).toBeUndefined();
  });
});
