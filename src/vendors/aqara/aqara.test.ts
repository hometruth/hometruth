import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import { AqaraConnection, AqaraPairingStore, type AqaraSource } from "./connection";
import { AqaraContact, AqaraHubStatus, AqaraOccupancy, discoverContactSensors } from "./sensors";
import { parseAccessories, hapType, type HapAccessory, type HapSnapshot } from "../../protocols/homekit/snapshot";
import { isPairingData, validateAddress, readHomeKit } from "../../protocols/homekit/client";
import { Site, summaryDetail } from "../../site";
import { createApp } from "../../server/app";
import { AqaraHubM2 } from "../../devices/hubs/aqara-hub-m2";
import { AqaraPresenceSensorFP2 } from "../../devices/sensors/aqara-presence-sensor-fp2";
import { AqaraDoorWindowSensor } from "../../devices/sensors/aqara-door-window-sensor";
import type { DeviceConfigWriter } from "../../config/device-writer";
import type { DeviceConfigEntry } from "../../config/devices";
import { validators } from "../../validation";

// Synthetic HAP protocol fixtures, not captured readings from the user's devices.
const observedAt = "2026-09-09T12:00:00.000Z";
const address = { host: "10.77.0.2", port: 12345, homekitId: "AA:BB:CC:DD:EE:FF" };
const pairing = {
  AccessoryPairingID: Buffer.from(address.homekitId).toString("hex"),
  AccessoryLTPK: "ab".repeat(32), iOSDevicePairingID: Buffer.from("test-controller").toString("hex"),
  iOSDeviceLTPK: "cd".repeat(32), iOSDeviceLTSK: "ef".repeat(64),
};
function service(iid: number, type: string, values: Record<string, unknown>) {
  return { iid, type, characteristics: Object.entries(values).map(([type, value], n) => ({ iid: iid + n + 1, type, value })) };
}
function info(serial: string, name: string) { return service(1, "3E", { "30": serial, "23": name, "21": "AS006" }); }
function fixture(): HapSnapshot {
  return { observedAt, accessories: [
    { aid: 1, services: [info("hub", "Hub"), service(10, "7E", { "66": 3 })] },
    { aid: 2, services: [info("old-sensor", "Old contact"), service(10, "80", { "6A": 1 })] },
    { aid: 3, services: [info("target", "Door"), service(10, "80", { "6A": 0, "75": true, "7A": 0 }), service(20, "96", { "68": 100 })] },
  ] };
}
function source(snapshot: HapSnapshot): AqaraSource { return { read: async () => ({ availability: "online", snapshot }) }; }
const directories: string[] = [];
async function store() { const p = await mkdtemp(join(tmpdir(), "aqara-test-")); directories.push(p); return new AqaraPairingStore(p); }
afterEach(async () => { await Promise.all(directories.splice(0).map((p) => rm(p, { force: true, recursive: true }))); });

describe("Aqara local connections", () => {
  test("a stalled HAP handshake is bounded and its worker connection is closed", async () => {
    const sockets = new Set<Socket>();
    let received = "";
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("data", (chunk) => { received += chunk.toString(); });
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const listening = server.address();
      if (!listening || typeof listening === "string") throw new Error("No test port");
      const began = Date.now();
      await expect(readHomeKit({ ...address, host: "127.0.0.1", port: listening.port }, pairing)).rejects.toThrow("HomeKit connection failed");
      expect(Date.now() - began).toBeLessThan(4000);
      expect(received).toContain("POST /pair-verify");
      // The kill closes the worker's socket; the server observes that close a poll turn or two later.
      for (let i = 0; i < 100 && sockets.size > 0; i++) await Bun.sleep(10);
      expect(sockets.size).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  test("missing pairing makes no network request and reports unknown, not a fabricated reading", async () => {
    let calls = 0;
    const c = new AqaraConnection("test", address, await store(), async () => { calls++; return fixture(); });
    expect(await c.read()).toEqual({ availability: "unknown", detail: "Pairing required" });
    expect(calls).toBe(0);
  });
  test("pairings are private, validated, and cannot escape their directory", async () => {
    const s = await store(); await s.save("test", pairing);
    expect((await stat(s.path("test"))).mode & 0o777).toBe(0o600);
    expect(await s.load("test")).toEqual(pairing);
    expect(() => s.path("../escape")).toThrow();
    await expect(s.save("test", {})).rejects.toThrow();
    expect(isPairingData(JSON.parse(await readFile(s.path("test"), "utf8")))).toBe(true);
  });
  test("hub reads are coalesced, refreshed after expiry, and failures discard the old reading", async () => {
    const s = await store(); await s.save("test", pairing);
    let time = 0; let calls = 0;
    const c = new AqaraConnection("test", address, s, async () => {
      calls++; if (calls === 2) throw new Error("private secret detail"); return fixture();
    }, () => time);
    await Promise.all([c.read(), c.read(), c.read()]); expect(calls).toBe(1);
    await c.read(); expect(calls).toBe(1);
    time = 5001;
    const failure = await c.read();
    expect(failure.availability).toBe("degraded"); expect("snapshot" in failure).toBe(false);
    expect(JSON.stringify(failure)).not.toContain("private secret");
    time = 10002; expect((await c.read()).availability).toBe("online");
  });
  test("credentials for another accessory never reach the network", async () => {
    const s = await store(); await s.save("test", pairing);
    let called = false;
    const c = new AqaraConnection("test", { ...address, homekitId: "11:22:33:44:55:66" }, s, async () => { called = true; return fixture(); });
    expect((await c.read()).availability).toBe("degraded"); expect(called).toBe(false);
  });
  test("public addresses and invalid ports are rejected", () => {
    expect(() => validateAddress({ ...address, host: "example.com" })).toThrow();
    expect(() => validateAddress({ ...address, port: 0 })).toThrow();
    expect(() => validateAddress(address)).not.toThrow();
  });
});

describe("Aqara observations", () => {
  test("door selection uses serial, not first contact or unstable accessory id", async () => {
    const sensor = new AqaraContact("door", source(fixture()), "TARGET");
    expect(await sensor.getState()).toEqual({ availability: "online", observedAt, open: false, batteryPercent: 100, tampered: false });
    expect(validators.contactSensor(await sensor.describe())).toBe(true);
  });
  test("unavailable, missing, and ambiguous contacts never become closed", async () => {
    const snapshot = fixture(); snapshot.accessories[2]!.services[1]!.characteristics.find((c) => c.type === "75")!.value = false;
    expect((await new AqaraContact("door", source(snapshot), "target").getState()).open).toBeUndefined();
    expect((await new AqaraContact("door", source(snapshot), "missing").getState()).availability).toBe("degraded");
    snapshot.accessories.push({ ...snapshot.accessories[2]!, aid: 4 });
    expect((await new AqaraContact("door", source(snapshot), "target").getState()).open).toBeUndefined();
  });
  test("FP2 exposes zones and lux; a missing zone cannot clear the room", async () => {
    const a: HapAccessory = { aid: 1, services: [
      info("fp2", "FP2"), service(10, "86", { "23": "Desk", "71": 0 }),
      service(20, "00000086-0000-1000-8000-0026BB765291", { "23": "Doorway", "71": 1 }),
      service(30, "84", { "6B": 42 }),
    ] };
    const sensor = new AqaraOccupancy("presence", source({ observedAt, accessories: [a] }));
    expect((await sensor.getState()).occupied).toBe(true);
    a.services[2]!.characteristics.find((c) => c.type === "71")!.status = -70402;
    const unknown = await sensor.getState();
    expect(unknown.occupied).toBeUndefined(); expect(unknown.availability).toBe("degraded"); expect(unknown.illuminanceLux).toBe(42);
    a.services[1]!.characteristics.find((c) => c.type === "71")!.value = 1;
    expect((await sensor.getState()).occupied).toBe(true);
    expect(validators.occupancySensor(await sensor.describe())).toBe(true);
  });
  test("hub lists bridged accessories without claiming they are online", async () => {
    const state = await new AqaraHubStatus("hub", source(fixture())).getState();
    expect(state.securityState).toBe("disarmed"); expect(state.accessories?.map((a) => a.id)).toEqual(["2", "3"]);
    expect(state.accessories?.[0]).not.toHaveProperty("availability");
  });
  test("discovers every bridged contact sensor by serial, whether or not HomeTruth has a device for it yet", async () => {
    expect(await discoverContactSensors(source(fixture()))).toEqual([
      { serialNumber: "old-sensor", name: "Old contact", model: "AS006" },
      { serialNumber: "target", name: "Door", model: "AS006" },
    ]);
    expect(await discoverContactSensors({ read: async () => ({ availability: "unknown", detail: "Pairing required" }) })).toEqual([]);
  });
  test("prefers the contact service's own name over the accessory's generic product name", async () => {
    const snapshot = fixture();
    snapshot.accessories[2]!.services[1]!.characteristics.push({ iid: 99, type: "23", value: "Back door" });
    expect(await discoverContactSensors(source(snapshot))).toEqual([
      { serialNumber: "old-sensor", name: "Old contact", model: "AS006" },
      { serialNumber: "target", name: "Back door", model: "AS006" },
    ]);
  });
  test("invalid HAP responses and duplicate accessory ids are rejected", () => {
    expect(hapType("0000006A-0000-1000-8000-0026BB765291")).toBe("6A");
    expect(() => parseAccessories({ accessories: [] })).toThrow();
    expect(() => parseAccessories({ accessories: [{ aid: 1, services: [] }, { aid: 1, services: [] }] })).toThrow();
    expect(parseAccessories(fixture(), observedAt)).toEqual(fixture());
  });
});

describe("Aqara inventory and pages", () => {
  const configs = [
    { id: "door", name: "Office door", model: "aqara-door-window-sensor", config: { hub: "hub", serialNumber: "target" } },
    { id: "presence", name: "Presence", model: "aqara-presence-sensor-fp2", config: address },
    { id: "hub", name: "Hub", model: "aqara-hub-m2", config: address },
  ];
  test("provisions forward hub references and keeps door off Wi-Fi recovery", () => {
    const site = Site.fromConfig({ schemaVersion: 2, devices: configs });
    expect(site.list().map((d) => d.kind)).toEqual(["sensor", "sensor", "hub"]);
    expect(site.get("door")?.config).not.toHaveProperty("host");
    expect(site.view("door")?.host).toBe("Via Hub");
    expect(site.get("presence")?.controls()).toEqual(["getState"]);
    expect(() => Site.fromConfig({ schemaVersion: 2, devices: configs.slice(0, 2) })).toThrow();
  });
  test("real API shape and schema include sensor readings; pages never include secret keys", async () => {
    const hub = new AqaraHubM2({ id: "hub", name: "Hub" }, address, source(fixture()));
    const presence = new AqaraPresenceSensorFP2({ id: "presence", name: "Presence" }, address, { read: async () => ({ availability: "unknown", detail: "Pairing required" }) });
    const door = new AqaraDoorWindowSensor({ id: "door", name: "<Office door>" }, { hub: "hub", serialNumber: "target" }, hub);
    const app = createApp(undefined, new Site(
      [hub, presence, door],
      undefined, undefined, undefined, undefined, undefined, undefined,
      // Constructed directly, so the hub reference the sensor makes while being
      // provisioned is declared here instead.
      [{ from: "door", to: "hub", relation: "uses", capability: "hub" }],
    ));
    const detail = await (await app.request("/api/devices/door")).json();
    expect(detail.object.capabilities.contactSensor.state.open).toBe(false);
    expect(summaryDetail(detail.object)).toBe("Closed · Battery 100%");
    expect(validators.homeTruthObject(detail.object)).toBe(true);
    expect(validators.deviceListResponse(await (await app.request("/api/devices")).json())).toBe(true);
    for (const [id, url] of [["hub", "/hubs/hub"], ["presence", "/sensors/presence"], ["door", "/sensors/office-door"]]) {
      const page = await app.request(url!);
      expect(page.status).toBe(200); const html = await page.text();
      expect(html).toContain("data-sensor-page"); expect(html).not.toContain(pairing.iOSDeviceLTSK);
      if (id === "door") { expect(html).toContain("&lt;Office door&gt;"); expect(html).not.toContain('id="pair-code"'); expect(html).toContain('href="/hubs/hub"'); }
      if (id === "hub") expect(html).toContain('href="/sensors/office-door"');
    }
    expect((await app.request("/api/aqara/door/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "111-22-333" }) })).status).toBe(404);
    expect((await app.request("/api/aqara/presence/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "bad" }) })).status).toBe(400);
  });
  test("sync adds bridged contact sensors HomeTruth has no device for yet, and leaves configured ones alone", async () => {
    const hub = new AqaraHubM2({ id: "hub", name: "Hub" }, address, source(fixture()));
    const door = new AqaraDoorWindowSensor({ id: "door", name: "Door" }, { hub: "hub", serialNumber: "target" }, hub);
    const site = new Site([hub, door]);
    const entries: DeviceConfigEntry[] = [];
    const writer: DeviceConfigWriter = { async add(entry) { entries.push(entry); }, async addAll(all) { entries.push(...all); }, async rename() {} };
    const app = createApp(undefined, site, undefined, undefined, undefined, undefined, undefined, writer);
    const headers = { "content-type": "application/json" };
    const response = await app.request("/api/aqara/hub/sync", { method: "POST", headers, body: "{}" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ added: [{ id: "hub-old-contact", name: "Old contact", page: "/devices/hub-old-contact" }] });
    expect(entries).toEqual([{ id: "hub-old-contact", name: "Old contact", model: "aqara-door-window-sensor", config: { hub: "hub", serialNumber: "old-sensor" } }]);
    expect((await app.request("/api/aqara/door/sync", { method: "POST", headers, body: "{}" })).status).toBe(404);
    expect((await createApp(undefined, site).request("/api/aqara/hub/sync", { method: "POST", headers, body: "{}" })).status).toBe(409);
  });
  test("schemas require observation times for known sensor values", () => {
    expect(validators.contactSensor({ id: "x", state: { availability: "online", open: false }, actions: {} })).toBe(false);
    expect(validators.occupancySensor({ id: "x", state: { availability: "online", occupied: false }, actions: {} })).toBe(false);
  });
});
