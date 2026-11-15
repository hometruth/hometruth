import { expect, test } from "bun:test";
import { Graph } from "../graph/graph";
import type { GraphNode } from "../graph/types";
import { elementKey } from "../tags/identity";
import { ElementAddresses, addressesFor } from "./addresses";
import { publicApiPath } from "./address-paths";
import { Device } from "../models/device";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { TestRelay } from "../kindle/test-fixture";
import { Site } from "../site";
import { createApp } from "../server/app";
import { StateHub } from "../state/hub";
import { TokenStore } from "../auth/store";

function node(kind: GraphNode["kind"], name: string, ids: string[], page = "", context = ""): GraphNode {
  return { id: elementKey(kind, ...ids), kind, name, ids, page, context, side: "instance", icon: { kind: "emoji", value: "" } };
}
function directory(nodes: GraphNode[]) { return new ElementAddresses(new Graph({ nodes, edges: [], generatedAt: "test" })); }

test("addresses use current friendly names, nested context, reserved commands, and deterministic collisions", () => {
  const nodes = [node("site", "HomeTruth", ["root"], "/"), node("catalog", "Switches", ["switches"], "/switches"),
    node("device", "Exhaust Fan", ["relay-74"], "/switches/exhaust-fan"),
    node("control", "turnOn", ["relay-74", "binarySwitch", "turnOn"], "/switches/exhaust-fan", "Exhaust Fan · binarySwitch"),
    node("device", "Help", ["hidden-id"], "/switches/help"),
    node("device", "Desk", ["lamp-a"], "/lights/desk"), node("device", "Desk", ["relay-b"], "/switches/desk")];
  const addresses = directory(nodes);
  expect(addresses.address(nodes[0]!.id)).toBe("root");
  expect(addresses.address(nodes[1]!.id)).toBe("switches");
  expect(addresses.device("relay-74")).toBe("exhaust-fan");
  expect(addresses.address(nodes[3]!.id)).toBe("exhaust-fan-binaryswitch-control-turnon");
  expect(addresses.device("hidden-id")).toBe("help-device");
  expect(addresses.device("lamp-a")).toMatch(/^desk-device-[a-f0-9]{8}$/);
  expect(new Set(Object.values(addresses.mappings.elements)).size).toBe(nodes.length);
  expect(directory([...nodes].reverse()).mappings).toEqual(addresses.mappings);
  const renamed = directory([{ ...nodes[2]!, name: "Ventilation", page: "/switches/ventilation" }]);
  expect(renamed.node("exhaust-fan")).toBeUndefined();
  expect(renamed.node("relay-74")).toBeUndefined();
  expect(renamed.node("ventilation")?.id).toBe(nodes[2]!.id);
});

test("transport names stay separate from internal IDs even when another element owns that name", () => {
  const a = node("device", "Desk", ["lamp"], "/lights/desk"), b = node("device", "Lamp", ["raw-2"], "/lights/lamp");
  const addresses = directory([a, b]);
  expect(addresses.publicPath("/api/devices/lamp/controls/turnOn?confirm=1")).toBe("/api/devices/desk/controls/turnOn?confirm=1");
  expect(addresses.internalPath("/api/devices/lamp/controls/turnOn")).toBe("/api/devices/raw-2/controls/turnOn");
  expect(addresses.internalPath("/api/devices/raw-2")).toBeUndefined();
  expect(addresses.internalPath("/api/camera/devices/vendor-serial/snapshot")).toBe("/api/camera/devices/vendor-serial/snapshot");
  expect(addresses.internalPath("/api/services/frigate/frames/front_door/track-2")).toBe("/api/services/frigate/frames/front_door/track-2");
  expect(addresses.publicPath(`/api/graph/scene?focus=${a.id}`)).toBe("/api/graph/scene?focus=desk");
  expect(addresses.internalPath("/api/graph/scene")).toBe("/api/graph/scene");
  expect(addresses.internalPath("/elements/desk/openapi.json")).toBe(`/elements/${a.id}/openapi.json`);
  expect(addresses.publicPath(`/api/bridges/options/${a.id}`)).toBe("/api/bridges/options/desk");
  expect(addresses.internalPath("/api/bridges/bridge-1/members/desk")).toBe(`/api/bridges/bridge-1/members/${a.id}`);
  expect(publicApiPath("/api/state/stream?node=device%2Flamp&node=device%2Fraw-2&tier=live", addresses.mappings)).toBe("/api/state/stream?node=desk&node=lamp&tier=live");
  expect(addresses.stateNode("desk")).toBe("device/lamp");
  expect(addresses.stateNode("device/lamp")).toBeUndefined();
});

test("presenting a group as a switch keeps the group's current address stable", () => {
  const group = node("group", "Evening lights", ["internal-group"], "/device-groups/evening-lights");
  const control = node("group-switch", "Evening lights", ["internal-group"], "/switches/evening-lights");
  const plain = directory([group]), switchable = directory([group, control]);
  expect(plain.group("internal-group")).toBe("evening-lights");
  expect(switchable.group("internal-group")).toBe("evening-lights");
  expect(switchable.address(control.id)).toBe("evening-lights-switch");
});

test("graph links format focus, selection, and repeated element and room expansions", () => {
  const lamp = node("device", "Desk", ["hidden-lamp"], "/lights/desk");
  const room = node("tag", "Lounge", ["room", "Lounge"], "/rooms/lounge");
  const addresses = directory([lamp, room]);
  const params = new URLSearchParams({ focus: lamp.id, selected: lamp.id });
  params.append("expand", lamp.id);
  params.append("expand", JSON.stringify(["room", room.id]));
  params.append("expand", JSON.stringify(["kind", "device"]));
  params.append("expand", JSON.stringify(["unassigned"]));
  for (const path of ["/graph", "/api/graph/scene"]) {
    const result = new URL(addresses.publicPath(`${path}?${params}#view`), "http://localhost");
    expect(result.pathname).toBe(path);
    expect(result.searchParams.get("focus")).toBe("desk");
    expect(result.searchParams.get("selected")).toBe("desk");
    expect(result.searchParams.getAll("expand")).toEqual(["desk", '["room","room-lounge"]', '["kind","device"]', '["unassigned"]']);
    expect(result.hash).toBe("#view");
  }
});

class RelayDevice extends Device<{ host: string }> {
  readonly model = SHELLY_PLUS_1;
  readonly relay = new TestRelay("relay");
  readonly capabilities = { binarySwitch: this.relay };
  constructor(id: string, name: string) { super(id, name, { host: "" }); }
  async probe() { return {}; }
}
function fixture() {
  const device = new RelayDevice("relay-74", "Exhaust Fan"), hidden = new RelayDevice("relay-91", "Study Lamp");
  const site = new Site([device, hidden]);
  const hub = new StateHub(), tokens = new TokenStore();
  const app = createApp(undefined, site, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, hub, tokens);
  const issue = (id: string) => tokens.issue({ name: "Synthetic operator", permissions: ["write"], subject: { device: id } }).token;
  const token = issue(device.id);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return { app, device, hidden, hub, headers };
}

test("friendly REST names resolve before scoped authorization and never retain raw-ID routes", async () => {
  const { app, device, hidden, hub, headers } = fixture();
  try {
    expect((await app.request("/api/switches/exhaust-fan", { headers })).status).toBe(200);
    expect((await app.request("/api/devices/exhaust-fan", { headers })).status).toBe(200);
    expect((await app.request("/api/switches/study-lamp", { headers })).status).toBe(403);
    const changed = await app.request("/api/switches/exhaust-fan/turn-on", { method: "POST", headers, body: "{}" });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ state: { value: "on" } });
    expect(device.relay.writes).toBe(1);
    expect(hidden.relay.writes).toBe(0);
    for (const path of ["/api/switches/relay-74", "/api/devices/relay-74", `/api/elements/${elementKey("device", device.id)}`, `/elements/${elementKey("device", device.id)}`]) {
      const response = await app.request(path, { headers });
      expect(response.status).toBe(404);
      expect(response.headers.get("location")).toBeNull();
    }
    const element = await app.request("/api/elements/exhaust-fan", { headers });
    expect(element.status).toBe(200);
    expect(await element.json()).toMatchObject({ element: { name: "Exhaust Fan" } });
    const snapshot = await app.request("/api/state?node=exhaust-fan", { headers });
    expect(snapshot.status).toBe(200);
    expect((await snapshot.json()).records[0].node).toBe("device/relay-74");
    expect((await app.request("/api/state?node=device%2Frelay-74", { headers })).status).toBe(400);
  } finally { hub.stop(); }
});

test("scoped page transport mappings contain only reachable element names", async () => {
  const { app, hub, headers } = fixture();
  try {
    const response = await app.request("/switches/exhaust-fan", { headers });
    expect(response.status).toBe(200);
    const html = await response.text();
    const json = /<script[^>]*id="ht-api-addresses"[^>]*>([^<]*)<\/script>/.exec(html)?.[1];
    expect(json).toBeDefined();
    const mappings = JSON.parse(json!);
    expect(mappings.devices).toEqual({ "relay-74": "exhaust-fan" });
    expect(Object.values(mappings.elements)).not.toContain("study-lamp");
    expect(addressesFor(hub).device("relay-91")).toBe("study-lamp");
  } finally { hub.stop(); }
});
