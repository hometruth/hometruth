import { expect, test } from "bun:test";
import { Graph } from "../graph/graph";
import type { GraphEdge, GraphNode } from "../graph/types";
import { elementKey } from "../tags/identity";
import { elementScope } from "./element-scope";
import { Device } from "../models/device";
import { Service } from "../models/service";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { TestRelay } from "../kindle/test-fixture";
import { Site } from "../site";
import { StateHub } from "../state/hub";
import { TokenStore } from "./store";
import { createApp } from "../server/app";
import { addressesFor } from "../element-api/addresses";
import { HomeTruth, type InventoryElement } from "../client/index";
import { runHt } from "../ht/index";
import { MemorySecretStore } from "../config/secrets";

function node(kind: GraphNode["kind"], ids: string[], side: GraphNode["side"] = "instance"): GraphNode {
  return { id: elementKey(kind, ...ids), kind, ids, side, name: kind, context: "", page: "", icon: { kind: "emoji", value: "" } };
}
function contains(from: GraphNode, to: GraphNode): GraphEdge {
  return { from: from.id, to: to.id, relation: "contains", origin: "structure" };
}

test("element scope requires the right kind, side, and declared device containment", () => {
  const device = node("device", ["shared"]);
  const capability = node("capability", ["shared", "binarySwitch"]);
  const control = node("control", ["shared", "binarySwitch", "turnOn"]);
  const orphan = node("signal", ["shared", "orphan"]);
  const group = node("group", ["shared"]);
  const service = node("service", ["shared"]);
  const schema = node("property", ["shared", "state"], "schema");
  const automationDevice = node("device", ["automation"]);
  const automation = node("automation", ["example"]);
  const automationProperty = node("property", ["automation", "example", "enabled"]);
  const topology = new Graph({ nodes: [device, capability, control, orphan, group, service, schema, automationDevice, automation, automationProperty],
    edges: [contains(device, capability), contains(capability, control), contains(device, schema), contains(automation, automationProperty)], generatedAt: "test" });
  for (const entry of [device, capability, control]) expect(elementScope(topology, entry)).toEqual({ kind: "device", id: "shared" });
  expect(elementScope(topology, group)).toEqual({ kind: "group", id: "shared" });
  for (const entry of [orphan, service, schema, automationProperty]) expect(elementScope(topology, entry)).toBeUndefined();
});

class RelayDevice extends Device<{ host: string }> {
  readonly model = SHELLY_PLUS_1;
  readonly relay = new TestRelay("relay");
  readonly capabilities = { binarySwitch: this.relay };
  constructor(id: string, name: string) { super(id, name, { host: "" }); }
  async probe() { return {}; }
}
class SharedService extends Service {
  status() { return { availability: "online" as const, detail: "Synthetic service" }; }
  events() { return []; }
  subscribe() { return () => {}; }
}

test("scoped nested elements support CLI help, reads and controls without granting colliding groups or services", async () => {
  const device = new RelayDevice("shared", "Owned relay");
  // One current friendly address deliberately equals a different device's stable ID.
  const outside = new RelayDevice("owned-relay", "Other relay");
  const site = new Site([device, outside], undefined, undefined, [new SharedService("shared", "Shared service")], undefined, [],
    [{ id: "shared", name: "Shared group", members: [device.id, outside.id], asSwitch: true }]);
  const hub = new StateHub(), tokens = new TokenStore();
  const app = createApp(undefined, site, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, hub, tokens);
  const token = tokens.issue({ name: "Owned device", permissions: ["write"], subject: { device: device.id } }).token;
  const headers = { authorization: `Bearer ${token}` };
  const fetcher = ((input: URL | RequestInfo, init?: RequestInit) => app.request(String(input), init)) as typeof fetch;
  const out: string[] = [], errors: string[] = [];
  const run = (argv: string[]) => runHt(argv, { fetch: fetcher, env: { HOMETRUTH_URL: "http://localhost", HOMETRUTH_TOKEN: token },
    secretStore: new MemorySecretStore(), stdout: text => out.push(text), stderr: text => errors.push(text) });
  try {
    const addresses = addressesFor(hub), topology = hub.data.topology();
    const capability = addresses.address(elementKey("capability", device.id, "binarySwitch"))!;
    const control = addresses.address(elementKey("control", device.id, "binarySwitch", "turnOn"))!;
    const inventory = await (await app.request("/api/inventory", { headers })).json() as { elements: InventoryElement[] };
    expect(inventory.elements.some(entry => entry.address === capability)).toBe(true);
    expect(inventory.elements.some(entry => entry.address === control)).toBe(true);
    expect(await run([capability, "help"])).toBe(0);
    expect(out.join("")).toContain(`ht ${capability} on`);
    expect(await run([capability, "status", "--json"])).toBe(0);
    expect(await run([control, "on"])).toBe(0);
    expect(errors).toEqual([]);
    expect(device.relay.writes).toBe(1);
    const ht = new HomeTruth({ fetch: fetcher });
    await ht.connect("http://localhost", { token });
    expect(await ht.elements[capability]!.read()).toMatchObject({ state: { value: "on" } });

    const denied = [elementKey("device", outside.id), elementKey("capability", outside.id, "binarySwitch"),
      elementKey("group", "shared"), elementKey("group-switch", "shared"), elementKey("service", "shared"),
      topology.nodes().find(entry => entry.side === "schema" && entry.kind === "control")!.id];
    for (const key of denied) {
      const address = addresses.address(key)!;
      expect(inventory.elements.some(entry => entry.key === key)).toBe(false);
      expect((await app.request(`/api/inventory/${address}`, { headers })).status).toBe(404);
      expect((await app.request(`/elements/${address}/openapi.json`, { headers })).status).toBe(403);
      expect((await app.request(`/api/elements/${address}`, { headers })).status).toBe(403);
    }
    expect((await app.request("/api/devices/other-relay/controls/turnOn", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" })).status).toBe(403);
    expect(outside.relay.writes).toBe(0);
  } finally { hub.stop(); tokens.close(); }
});
