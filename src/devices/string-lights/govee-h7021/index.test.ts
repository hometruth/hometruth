import { describe, expect, test } from "bun:test";
import { GoveeH7021, GoveeH7021Bulb, GOVEE_H7021, GOVEE_H7021_BULB, type GoveeH7021Config } from ".";
import type { GoveeLanTransport, GoveeStatus } from "../../../protocols/govee/lan";
import type { DevicesConfig } from "../../../schemas";
import { Site } from "../../../site";
import { validators } from "../../../validation";
import { createApp } from "../../../server/app";
import { StringLight, LightDevice } from "../../../models/string-light";

const host = "10.77.0.80";
const deviceId = "AA:BB:CC:DD:EE:FF:00:11";
export class FakeGovee implements GoveeLanTransport {
  status: GoveeStatus = { onOff: 1, brightness: 100, color: { r: 255, g: 127, b: 0 }, colorTemInKelvin: 0 };
  fail = false;
  ignoreWrites = false;
  wrongIdentity = false;
  malformed = false;
  readonly writes: { command: string; data: Record<string, unknown> }[] = [];
  async request(_host: string, command: "scan" | "devStatus") {
    if (this.fail) throw new Error("Unreachable");
    if (command === "scan") return { ip: host, sku: this.wrongIdentity ? "H6000" : "H7021", device: deviceId, bleVersionHard: "3.01.01", bleVersionSoft: "1.00.14", wifiVersionHard: "1.00.10", wifiVersionSoft: "1.02.11" };
    return this.malformed ? { onOff: "on" } : structuredClone(this.status);
  }
  async send(_host: string, command: "turn" | "brightness" | "colorwc" | "ptReal", data: Record<string, unknown>) {
    this.writes.push({ command, data });
    if (this.ignoreWrites) return;
    if (command === "turn") this.status.onOff = data.value as 0 | 1;
    if (command === "brightness") this.status.brightness = data.value as number;
    if (command === "colorwc") { this.status.color = data.color as GoveeStatus["color"]; this.status.colorTemInKelvin = data.colorTemInKelvin as number; }
  }
}
export function fixture(count = 3, transform?: (config: DevicesConfig) => void) {
  const transport = new FakeGovee();
  const lights = Array.from({ length: count }, (_, index) => `string-light-${index + 1}`);
  const config: DevicesConfig = { schemaVersion: 2, devices: [
    ...lights.map((id, index) => ({ id, name: `String light ${index + 1}`, model: "govee-h7021-bulb", config: { stringId: "string", index } })),
    { id: "string", name: "Patio string", model: "govee-h7021", config: { host, deviceId, lights } },
  ] };
  transform?.(config);
  const models = [{ ...GOVEE_H7021, create: (instance: { id: string; name: string }, config: GoveeH7021Config, _services: unknown, _secrets: unknown, context: Parameters<typeof GOVEE_H7021.create>[4]) => new GoveeH7021(instance, config, context!, transport) }, GOVEE_H7021_BULB];
  const site = Site.fromConfig(config, {}, undefined, models);
  const string = site.get("string") as GoveeH7021;
  return { transport, config, site, string };
}

describe("H7021 StringLight", () => {
  test("is an ordered array of distinct registered Light devices, with stable IDs and reciprocal containment", async () => {
    const { string, site } = fixture(30);
    expect(string).toBeInstanceOf(StringLight);
    expect(string.lights).toHaveLength(30);
    expect(Object.isFrozen(string.lights)).toBe(true);
    expect(string.lights[0] === site.get("string-light-1")).toBe(true);
    expect(string.at(29)).toBeInstanceOf(LightDevice);
    expect(string.at(29)).toBeInstanceOf(GoveeH7021Bulb);
    expect(() => string.at(-1)).toThrow();
    expect(() => string.at(30)).toThrow();
    expect(() => string.at(0.5)).toThrow();
    expect(site.view("string")?.kind).toBe("string-light");
    expect(site.view("string")?.page).toBe("/string-lights/patio-string");
    expect(site.view("string-light-1")?.relationships).toContainEqual({ id: "string", name: "Patio string", relation: "partOf", page: "/string-lights/patio-string" });
    const doc = await string.describe();
    expect(validators.homeTruthObject(doc)).toBe(true);
    expect(doc.capabilities.light).toBeUndefined();
    expect(doc.capabilities.stringLight?.state).toMatchObject({ lightCount: 30, layout: "linear", on: true, color: "#ff7f00" });
    expect(doc.capabilities.stringLight?.state.lights[29]).toEqual({ id: "string-light-30", name: "String light 30", index: 29 });
    expect(await string.invokeControl("getLights")).toHaveLength(30);
    expect(validators.deviceListResponse(await site.summaries())).toBe(true);
  });
  test("rejects mismatched, duplicated, missing, or out-of-range bulbs and public hosts during provisioning", () => {
    expect(() => fixture(0)).toThrow();
    expect(() => fixture(31)).toThrow();
    expect(() => fixture(2, config => { config.devices![0]!.config = { stringId: "string", index: 1 }; })).toThrow("does not match");
    expect(() => fixture(2, config => { (config.devices!.at(-1)!.config as GoveeH7021Config).lights = ["string-light-1", "string-light-1"]; })).toThrow();
    expect(() => fixture(2, config => { (config.devices!.at(-1)!.config as GoveeH7021Config).lights[0] = "missing"; })).toThrow();
    expect(() => fixture(2, config => { (config.devices!.at(-1)!.config as GoveeH7021Config).host = "8.8.8.8"; })).toThrow();
  });
  test("routes each whole-string control to its packet and verifies a fresh status", async () => {
    const { string, transport } = fixture();
    await string.invokeControl("turnOff");
    await string.invokeControl("turnOn");
    await string.invokeControl("toggle");
    await string.invokeControl("setBrightness", 45);
    await string.invokeControl("setColor", "#123456");
    await string.invokeControl("setColorTemperature", 2700);
    expect(transport.writes).toEqual([
      { command: "turn", data: { value: 0 } }, { command: "turn", data: { value: 1 } }, { command: "turn", data: { value: 0 } },
      { command: "brightness", data: { value: 45 } },
      { command: "colorwc", data: { color: { r: 18, g: 52, b: 86 }, colorTemInKelvin: 0 } },
      { command: "colorwc", data: { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: 2700 } },
    ]);
    expect(await string.getState()).toEqual({ on: false, brightnessPercent: 45, colorTemperatureKelvin: 2700 });
    await expect(string.invokeControl("setBrightness", -1)).rejects.toThrow();
    await expect(string.invokeControl("setColor", "red")).rejects.toThrow();
    await expect(string.invokeControl("setColorTemperature", 999)).rejects.toThrow();
    expect(transport.writes).toHaveLength(6);
  });
  test("does not accept a UDP send as confirmation, serializes toggles, and blocks wrong identities", async () => {
    const { string, transport } = fixture();
    await Promise.all([string.toggle(), string.toggle()]);
    expect(Number(transport.status.onOff)).toBe(1);
    transport.ignoreWrites = true;
    await expect(string.turnOff()).rejects.toThrow("did not confirm");
    const wrong = fixture(); wrong.transport.wrongIdentity = true;
    await expect(wrong.string.turnOn()).rejects.toThrow("does not match");
    expect(wrong.transport.writes).toHaveLength(0);
  });
  test("never copies controller state onto a bulb or routes its controls to the whole string", async () => {
    const { string, transport } = fixture();
    const bulb = string.at(0);
    const doc = await bulb.describe();
    expect(doc.parent).toEqual({ id: "string", index: 0 });
    expect(doc.status).toBe("unknown");
    expect(doc.capabilities.light?.state.on).toBeUndefined();
    expect(doc.capabilities.light?.actions?.setColor).toEqual({ formats: ["hex"] });
    await expect(bulb.toggle()).rejects.toThrow("unknown");
    await bulb.setColor("#ff0000");
    expect(transport.writes.every(write => write.command === "ptReal")).toBe(true);
    expect((await bulb.describe()).capabilities.light?.state).toMatchObject({ availability: "unknown", stateSource: "commanded", color: "#ff0000" });
    expect((await bulb.describe()).capabilities.light?.state.observedAt).toBeUndefined();
    expect((await string.at(1).describe()).capabilities.light?.state.color).toBeUndefined();
    transport.fail = true;
    expect((await string.describe()).status).toBe("offline");
    transport.fail = false; transport.malformed = true;
    expect((await string.describe()).status).toBe("offline");
  });
  test("serves parent and child pages, API documents and controls without special device endpoints", async () => {
    const { site, transport } = fixture();
    const app = createApp(undefined, site);
    const detail = await app.request("/api/devices/string");
    expect(detail.status).toBe(200);
    const body = await detail.json();
    expect(body.model.capabilities).toEqual(["stringLight"]);
    expect(body.controls).toContain("getLights");
    const page = await app.request("/string-lights/patio-string");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('data-string-lights');
    const child = await app.request("/lights/string-light-1");
    expect(child.status).toBe(200);
    expect(await child.text()).toContain("Part of");
    const control = await app.request("/api/devices/string/controls/setBrightness", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: 42 }) });
    expect(control.status).toBe(200);
    expect(transport.status.brightness).toBe(42);
    expect((await app.request("/api/lights/string-light-1/turn-off", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(200);
    expect(Number(transport.status.onOff)).toBe(1);
  });
});

import { GoveeShows } from "./shows";

test("individual dimming and off affect only the chosen bulb and preserve its requested color", async () => {
  const { string, transport } = fixture(30);
  const first = string.at(0);
  await first.setColor("#ff0000");
  await first.setBrightness(25);
  let commands = transport.writes.at(-1)!.data.command as string[];
  expect(Buffer.from(commands[1]!, "base64").subarray(4, 7)).toEqual(Buffer.from([64, 0, 0]));
  await first.turnOff();
  commands = transport.writes.at(-1)!.data.command as string[];
  expect(Buffer.from(commands[1]!, "base64").subarray(4, 7)).toEqual(Buffer.from([0, 0, 0]));
  await Promise.all([first.turnOn(), string.at(15).setColor("#0000ff")]);
  expect(await first.getState()).toMatchObject({ on: true, color: "#ff0000", brightnessPercent: 25, stateSource: "commanded" });
  expect(await string.at(15).getState()).toMatchObject({ color: "#0000ff" });
  expect(transport.writes.every(write => write.command === "ptReal")).toBe(true);
  expect(transport.status.color).toEqual({ r: 255, g: 127, b: 0 });
  expect(validators.homeTruthObject(await first.describe())).toBe(true);
  await string.setColor("#00ff00");
  expect((await first.describe()).capabilities.light?.state.color).toBeUndefined();
});

test("shows have truthful submission state, validate input, and restore prior solid settings", async () => {
  const { string, transport } = fixture();
  transport.status.onOff = 0;
  const baseline = structuredClone(transport.status);
  expect(string.getShows()).toHaveLength(46);
  await expect(string.playShow({ id: "wave", stepSeconds: 0 })).rejects.toThrow();
  await expect(string.playShow("firmware-update")).rejects.toThrow();
  expect(transport.writes).toHaveLength(0);
  await string.playShow("wave");
  expect(Number(transport.status.onOff)).toBe(1);
  expect(string.shows.getShowState()).toMatchObject({ status: "submitted", showId: "wave", effectId: "wave" });
  expect(validators.homeTruthObject(await string.describe())).toBe(true);
  await string.setBrightness(42);
  expect(string.shows.getShowState().showId).toBe("wave");
  await string.playShow("aurora");
  await string.stopShow();
  expect(string.shows.getShowState()).toEqual({ status: "idle" });
  expect(transport.status).toEqual(baseline);
  await string.close();
});

test("sequences advance, cancel stale queued steps after manual changes, and stop on a network error", async () => {
  const { string, transport } = fixture();
  const scheduled: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const shows = new GoveeShows(string.whole, (fn, ms) => {
    const entry = { fn, ms, cancelled: false }; scheduled.push(entry);
    return () => { entry.cancelled = true; };
  });
  string.whole.beforeManual = () => shows.cancel();
  await shows.playShow({ id: "seaside", stepSeconds: 10 });
  expect(shows.getShowState().effectId).toBe("wave");
  expect(scheduled[0]!.ms).toBe(10000);
  scheduled[0]!.fn();
  await string.whole.runExclusive(async () => {});
  expect(shows.getShowState().effectId).toBe("deep-sea");
  const stale = scheduled[1]!;
  await string.at(0).setColor("#0000ff");
  expect(stale.cancelled).toBe(true);
  const count = transport.writes.length;
  stale.fn();
  await string.whole.runExclusive(async () => {});
  expect(transport.writes).toHaveLength(count);
  expect(shows.getShowState().status).toBe("idle");
  await shows.playShow({ id: "stargazing", stepSeconds: 10 });
  transport.fail = true;
  const pending = scheduled.at(-1)!;
  pending.fn();
  await string.whole.runExclusive(async () => {});
  expect(shows.getShowState()).toMatchObject({ status: "error", detail: "Unreachable" });
  expect(scheduled.at(-1)).toBe(pending);
  transport.fail = false;
  await shows.stopShow();
  expect(shows.getShowState().status).toBe("idle");
});

test("H7021 exposes fixed warm white and rejects temperature adjustments without replacing a show", async () => {
  const { string, site, transport } = fixture();
  const app = createApp(undefined, site);
  expect((await string.describe()).capabilities.stringLight?.actions?.setColorTemperature).toEqual({ minimumKelvin: 2700, maximumKelvin: 2700 });
  await string.playShow("wave");
  const before = transport.writes.length;
  for (const value of [2000, 4000, 9000]) {
    const response = await app.request("/api/devices/string/capabilities/stringLight/controls/setColorTemperature", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain("fixed 2700K");
  }
  expect(transport.writes).toHaveLength(before);
  expect(string.shows.getShowState()).toMatchObject({ status: "submitted", showId: "wave" });
  await string.setColorTemperature(2700);
  expect(string.shows.getShowState().status).toBe("idle");
  expect(transport.writes.at(-1)).toEqual({ command: "colorwc", data: { color: { r: 0, g: 0, b: 0 }, colorTemInKelvin: 2700 } });
  transport.status.colorTemInKelvin = 9000;
  expect((await string.getState()).colorTemperatureKelvin).toBe(2700);
});


test("static scenes repeat along the physical array, cancel pending shows, and keep per-bulb commands", async () => {
  const { string, transport } = fixture(30);
  const scheduled: { fn: () => void; cancelled: boolean }[] = [];
  const shows = new GoveeShows(string.whole, (fn) => {
    const entry = { fn, cancelled: false }; scheduled.push(entry);
    return () => { entry.cancelled = true; };
  });
  expect(shows.getScenes()).toHaveLength(8);
  expect(shows.getShows().filter(show => show.kind === "animation")).toHaveLength(40);
  expect(shows.getPresets()).toHaveLength(11);
  expect(shows.getPresets().some(preset => preset.id === "night")).toBe(true);
  await shows.playShow({ id: "seaside", stepSeconds: 10 });
  const stale = scheduled[0]!;
  const before = transport.writes.length;
  await shows.applyScene("candy-cane");
  expect(stale.cancelled).toBe(true);
  expect(scheduled).toHaveLength(1);
  expect(transport.writes).toHaveLength(before + 1);
  expect(shows.getShowState()).toEqual({ status: "idle" });
  expect(shows.getSceneState()).toMatchObject({ status: "submitted", sceneId: "candy-cane" });
  for (let i = 0; i < 30; i++) {
    const state = (await string.at(i).describe()).capabilities.light!.state;
    expect(state).toMatchObject({ availability: "unknown", stateSource: "commanded", on: true, brightnessPercent: 100, color: i % 2 ? "#ffffff" : "#ff0000" });
    expect(state.observedAt).toBeUndefined();
  }
  stale.fn();
  await string.whole.runExclusive(async () => {});
  expect(transport.writes).toHaveLength(before + 1);
  await shows.stopShow();
  expect(shows.getSceneState().sceneId).toBe("candy-cane");
});

test("scene API validates choices, restoring the prior static arrangement after a show or unclassified preset", async () => {
  const { string, transport, site } = fixture(30);
  const app = createApp(undefined, site);
  for (const value of ["wave", "night", { id: "candy-cane" }]) {
    const response = await app.request("/api/devices/string/capabilities/stringLight/controls/applyScene", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }),
    });
    expect(response.status).toBe(400);
  }
  await expect(string.playShow("night")).rejects.toThrow();
  await expect(string.applyPreset("wave")).rejects.toThrow();
  expect(transport.writes).toHaveLength(0);
  const response = await app.request("/api/devices/string/capabilities/stringLight/controls/applyScene", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "ocean-colors" }),
  });
  expect(response.status).toBe(200);
  const doc = await response.json();
  expect(validators.homeTruthObject(doc.object)).toBe(true);
  expect(doc.object.capabilities.stringLight.state.scene).toMatchObject({ status: "submitted", sceneId: "ocean-colors" });
  const arrangement = structuredClone(transport.writes.at(-1));
  await string.playShow("wave");
  expect(string.shows.getSceneState().status).toBe("idle");
  expect((await string.at(0).describe()).capabilities.light!.state.color).toBeUndefined();
  await string.stopShow();
  expect(transport.writes.at(-1)).toEqual(arrangement);
  expect(string.shows.getSceneState().sceneId).toBe("ocean-colors");
  await string.applyPreset("night");
  expect(string.shows.getShowState()).toMatchObject({ status: "submitted", presetId: "night", effectId: "night" });
  expect(string.shows.getShowState().showId).toBeUndefined();
  expect(validators.homeTruthObject(await string.describe())).toBe(true);
  await string.stopShow();
  expect(transport.writes.at(-1)).toEqual(arrangement);
  await string.at(0).setColor("#cc0088");
  expect(string.shows.getSceneState().status).toBe("idle");
  expect((await string.at(1).describe()).capabilities.light!.state.color).toBe("#00c8d8");
});

test("failed static writes do not claim success, and failed show stops retain a retryable selection", async () => {
  const { string, transport } = fixture();
  const send = transport.send.bind(transport);
  transport.send = async () => { throw new Error("Write failed"); };
  await expect(string.applyScene("candy-cane")).rejects.toThrow("Write failed");
  expect(string.shows.getSceneState()).toEqual({ status: "error", detail: "Write failed" });
  expect((await string.at(0).describe()).capabilities.light!.state.color).toBeUndefined();
  transport.send = send;
  await string.playShow("wave");
  transport.fail = true;
  await expect(string.stopShow()).rejects.toThrow();
  expect(string.shows.getShowState()).toMatchObject({ status: "error", showId: "wave" });
  transport.fail = false;
  await string.stopShow();
  expect(string.shows.getShowState()).toEqual({ status: "idle" });
});
