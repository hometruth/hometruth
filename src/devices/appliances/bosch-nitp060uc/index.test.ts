import { expect, test } from "bun:test";
import { BoschNITP060UC, BOSCH_NITP060UC, COOKTOP_CHILD_LOCK, cooktopState } from "./index";
import { provision } from "../../../config/provision";
import { validators } from "../../../validation";
import type { HomeConnectSnapshot, HomeConnectTransport } from "../../../protocols/homeconnect/client";

const secrets = { key: Buffer.alloc(32).toString("base64url"), iv: Buffer.alloc(16).toString("base64url") };
function observation(): HomeConnectSnapshot {
  return { observedAt: "2026-09-13T20:00:00Z", descriptions: new Map(), values: new Map<number, unknown>([
    [539, 2], [524, false], [565, 123], [523, true],
    [8200, 2], [8204, 7], [8236, 3], [8240, 0], [8254, 2], [8258, 20], [8290, 1], [8294, 0],
  ]) };
}
class FakeTransport implements HomeConnectTransport {
  snapshot = observation(); offline = false; closed = false;
  writes: [number, number | boolean][] = [];
  async read() { if (this.offline) throw new Error("Unavailable"); return this.snapshot; }
  async set(uid: number, value: number | boolean) { this.writes.push([uid, value]); this.snapshot.values.set(uid, value); }
  close() { this.closed = true; }
}
test("maps a mixed cooking state, half levels, boost and residual heat", () => {
  const state = cooktopState(observation());
  expect(state.power).toBe("on"); expect(state.timerSeconds).toBe(123);
  expect(state.zones?.map(zone => [zone.position, zone.state, zone.level, zone.mode])).toEqual([
    ["frontLeft", "active", 3.5, "normal"], ["rearLeft", "hot", 0, "normal"],
    ["rearRight", "active", undefined, "boost"], ["frontRight", "off", 0, "normal"],
  ]);
  const missing = observation(); missing.values.delete(539); missing.values.delete(8200);
  const incomplete = cooktopState(missing);
  expect(incomplete.availability).toBe("degraded"); expect(incomplete.power).toBeUndefined();
  expect(incomplete.zones?.[0]?.state).toBe("unknown");
});
test("publishes a valid object, handles failures without stale state, and closes its connection", async () => {
  const transport = new FakeTransport();
  const device = new BoschNITP060UC({ id: "hob", name: "Cooktop" }, { host: "10.78.0.40" }, secrets, transport);
  const doc = await device.describe(); expect(validators.homeTruthObject(doc)).toBe(true);
  expect(JSON.stringify(doc)).not.toContain(secrets.key);
  expect(device.controls()).toEqual(["getState", "setChildLock", "setTimer"]);
  await device.invokeControl("setTimer", 180);
  expect(transport.writes).toEqual([[565, 180]]);
  await expect(device.invokeControl("setTimer", 5941)).rejects.toThrow("whole seconds");
  await expect(device.invokeControl("setChildLock", "false")).rejects.toThrow("boolean");
  await expect(device.invokeControl("turnOn")).rejects.toThrow("no control");
  transport.offline = true;
  const failed = await device.describe();
  expect(failed.status).toBe("offline"); expect(failed.capabilities.cooktop?.state.power).toBeUndefined();
  expect(failed.capabilities.cooktop?.actions).toEqual({ getState: {} });
  await device.close(); expect(transport.closed).toBe(true);
});
test("reports the FlexInduction combined zone only while it is available", () => {
  const snapshot = observation();
  snapshot.values.set(0x201a, 0);
  expect(cooktopState(snapshot).zones).toHaveLength(4);
  snapshot.values.set(0x201a, 2); snapshot.values.set(0x201e, 12);
  expect(cooktopState(snapshot).zones?.[4]).toEqual({ id: "120", position: "leftCombined", state: "active", level: 6, mode: "normal" });
});
test("child-lock accessory shares the parent and controls only its lock", async () => {
  const transport = new FakeTransport();
  const model = { ...BOSCH_NITP060UC, create: (instance: { id: string; name: string }, config: { host: string }) => new BoschNITP060UC(instance, config, secrets, transport) };
  const devices = provision({ schemaVersion: 2, devices: [
    { id: "lock", name: "Cooktop child lock", model: "cooktop-child-lock", config: { cooktop: "hob" } },
    { id: "hob", name: "Cooktop", model: "bosch-nitp060uc", config: { host: "10.78.0.40" } },
  ] }, [model, COOKTOP_CHILD_LOCK], {}, { schemaVersion: 1, devices: { hob: secrets } });
  const lock = devices[0]!;
  expect(lock.parent?.id).toBe("hob");
  expect(await lock.invokeControl("getState")).toBe("off");
  await lock.invokeControl("turnOn"); expect(transport.writes).toEqual([[524, true]]);
  expect((await lock.describe()).capabilities.binarySwitch?.state.value).toBe("on");
  transport.snapshot.values.delete(8200);
  expect((await devices[1]!.describe()).status).toBe("degraded");
  expect((await lock.describe()).capabilities.binarySwitch?.state.value).toBe("on");
  transport.snapshot.values.set(524, false);
  expect((await lock.describe()).capabilities.binarySwitch?.state.value).toBe("off");
  transport.snapshot.values.delete(524);
  const unknown = await lock.describe();
  expect(unknown.status).toBe("offline");
  expect(unknown.capabilities.binarySwitch?.state.value).toBeUndefined();
  transport.snapshot.values.set(524, false);
  transport.offline = true;
  expect((await lock.describe()).status).toBe("offline");
  expect(transport.writes).toEqual([[524, true]]);
});
