import { StateHub } from "../state/hub";
import { deviceNode } from "../state/protocol";
import { observedKindleState } from "./test-fixture";
import { expect, test } from "bun:test";
import { Device } from "../models/device";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { Site } from "../site";
import { createApp } from "../server/app";
import { createTranslator } from "../ui/i18n";
import { renderPrimitive } from "../ui/kindle-widget";
import { DEFAULT_KINDLE_CONFIG, parseKindleConfig, type KindleConfig } from "./config";
import { buildKindleSnapshot } from "./presentation";
import { MemoryKindleConfigStore } from "./store";
import { TestLight, TestRelay } from "./test-fixture";

class RelayDevice extends Device<{ host: string }> {
  readonly model = SHELLY_PLUS_1;
  readonly relay = new TestRelay("relay");
  readonly capabilities = { binarySwitch: this.relay };
  constructor(id: string) { super(id, id, { host: "private-host" }); }
  async probe() { return {}; }
}
class LightDevice extends Device<{ host: string }> {
  readonly model = { ...SHELLY_PLUS_1, id: "test-light", capabilities: ["light"] as const };
  readonly light = new TestLight("light");
  readonly capabilities = { light: this.light };
  constructor(id: string) { super(id, id, { host: "private-host" }); }
  async probe() { return {}; }
}

const fixture = () => {
  const fan = new RelayDevice("fan"), light = new LightDevice("light"), sameId = new RelayDevice("primary-bath");
  light.light.on = true;
  const group = { id: "primary-bath", name: "Primary Bath", room: "Master Bathroom", members: ["fan", "light"] };
  const site = new Site([fan, light, sameId], undefined, undefined, undefined, undefined, undefined, [group]);
  const config: KindleConfig = { ...DEFAULT_KINDLE_CONFIG, canvas: { width: 758, height: 1024, grid: 8, widgets: [
    { id: "bath", kind: "device", source: "group", deviceId: group.id, capability: "auto", mode: "auto", label: "", showLabel: true, x: 16, y: 16, width: 320, height: 220, fontSize: 24, align: "left", border: false },
    { id: "single", kind: "device", deviceId: sameId.id, capability: "auto", mode: "auto", label: "", showLabel: true, x: 352, y: 16, width: 320, height: 220, fontSize: 24, align: "left", border: false },
  ] } };
  const store = new MemoryKindleConfigStore(config);
  const hub = new StateHub();
  const app = createApp(undefined, site, undefined, undefined, undefined, undefined, undefined, undefined, undefined, store, undefined, undefined, hub);
  return { app, hub, site, config, store, fan, light, sameId };
};

test("the designer catalog includes saved groups separately from same-ID devices", async () => {
  const { app, store, config } = fixture();
  const catalog = await (await app.request("/api/kindle/catalog")).json();
  const matches = catalog.elements.filter((element: { id: string }) => element.id === "primary-bath");
  expect(matches).toHaveLength(2);
  expect(matches[0]).toMatchObject({ source: "device", page: "/switches/primary-bath" });
  expect(matches[1]).toMatchObject({ source: "group", name: "Primary Bath", room: "Master Bathroom", capabilities: ["binarySwitch"], page: "/groups/primary-bath" });
  expect(JSON.stringify(catalog)).not.toContain("private-host");
  const initial = await store.load();
  const response = await app.request("/api/kindle/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ config, revision: initial.revision }) });
  expect(response.status).toBe(200);
  expect((await store.load()).config.canvas?.widgets[0]).toMatchObject({ source: "group", deviceId: "primary-bath" });
  expect(() => parseKindleConfig({ ...config, items: [{ deviceId: "primary-bath", source: "invalid", capability: "auto", mode: "auto", label: "" }] })).toThrow();
});

test("group widgets retain mixed readings and dispatch shared controls only to the group", async () => {
  const { app, hub, fan, light, sameId } = fixture();
  await hub.data.refresh();
  await Promise.all([fan, light, sameId].map(device => hub.observer.refresh(deviceNode(device.id))));
  const snapshot = await (await app.request("/api/kindle/snapshot")).json();
  const [group, single] = snapshot.rows;
  expect(group).toMatchObject({ widgetId: "bath", source: "group", label: "Primary Bath", room: "Master Bathroom", missing: false });
  expect(group.primitives[0]).toMatchObject({ capability: "binarySwitch", detail: "Mixed", availability: "online" });
  expect(group.primitives[0].actions.map((action: { pressed?: boolean }) => action.pressed)).toEqual([undefined, undefined]);
  expect(renderPrimitive(group, group.primitives[0])).toContain('/api/device-groups/primary-bath/controls/power.turnOn');
  expect(renderPrimitive(single, single.primitives[0])).toContain('/api/devices/primary-bath/capabilities/binarySwitch/controls/turnOn');
  expect(fan.relay.writes + sameId.relay.writes).toBe(0);
  const response = await app.request(group.primitives[0].actions[0].url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect((await response.json()).ok).toBe(true);
  expect(fan.relay.state).toBe("on"); expect(light.light.on).toBe(true);
  expect(fan.relay.writes).toBe(1); expect(sameId.relay.writes).toBe(0);
  await Promise.all([fan, light].map(device => hub.observer.refresh(deviceNode(device.id))));
  const updated = await (await app.request("/api/kindle/snapshot")).json();
  expect(updated.rows[0].primitives[0]).toMatchObject({ detail: "On", actions: [{ pressed: true }, { pressed: false }] });
});

test("status-only, unavailable and removed group widgets do not invent controls or fall back to devices", async () => {
  const { site, config, fan, light, sameId } = fixture();
  const i18n = createTranslator("en");
  const widget = config.canvas!.widgets[0]!;
  if (widget.kind !== "device") throw new Error("Expected group widget");
  widget.mode = "status";
  let snapshot = await buildKindleSnapshot(site, config, await observedKindleState(site), i18n);
  expect(snapshot.rows[0]!.primitives[0]!.actions).toEqual([]);
  widget.mode = "auto"; fan.relay.offline = true;
  snapshot = await buildKindleSnapshot(site, config, await observedKindleState(site), i18n);
  expect(snapshot.rows[0]!.primitives[0]).toMatchObject({ detail: "Unknown", availability: "degraded" });
  expect(snapshot.rows[0]!.primitives[0]!.actions.every(action => action.pressed === undefined)).toBe(true);
  light.light.getState = async () => { throw new Error("offline"); };
  snapshot = await buildKindleSnapshot(site, config, await observedKindleState(site), i18n);
  expect(snapshot.rows[0]!.primitives[0]).toMatchObject({ actions: [], availability: "offline" });
  snapshot = await buildKindleSnapshot(new Site([sameId]), config, await observedKindleState(new Site([sameId])), i18n);
  expect(snapshot.rows[0]).toMatchObject({ source: "group", missing: true, primitives: [] });
  expect(snapshot.rows[1]).toMatchObject({ missing: false });
});
