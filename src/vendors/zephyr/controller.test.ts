import { expect, test } from "bun:test";
import { allowedSubscription, initialState, ZephyrController, type EmulatorState } from "./controller";
import type { ShadowMessage } from "../../protocols/zephyr/shadow";

const fingerprint = Array(32).fill("AB").join(":");
const prefix = "$aws/things/hood_test/shadow";
function fixture() {
  const messages: ShadowMessage[] = [];
  const saved: EmulatorState[] = [];
  const options = { deviceIp: "192.0.2.1", enrollFirstCertificate: true, state: initialState(),
    save: async (value: EmulatorState) => { saved.push(structuredClone(value)); },
    publish: async (message: ShadowMessage) => { messages.push(message); }, audit: () => {}, now: () => 1000 };
  return { messages, saved, options, controller: new ZephyrController(options) };
}
test("enrolls only one IP, certificate and MQTT client ID; enrollment survives restart", async () => {
  const f = fixture();
  await expect(f.controller.authenticate("192.0.2.2", "hood", fingerprint)).rejects.toThrow("IP");
  await expect(f.controller.authenticate("192.0.2.1", "hood", undefined)).rejects.toThrow("certificate");
  await f.controller.authenticate("192.0.2.1", "hood", fingerprint);
  const restarted = new ZephyrController({ ...f.options, state: f.saved.at(-1)!, enrollFirstCertificate: false });
  await restarted.authenticate("192.0.2.1", "hood", fingerprint);
  await expect(restarted.authenticate("192.0.2.1", "other", fingerprint)).rejects.toThrow("enrollment");
  await expect(restarted.authenticate("192.0.2.1", "hood", fingerprint.replace("AB", "CD"))).rejects.toThrow("enrollment");
});
test("rejects wildcard thing names and cross-thing requests", async () => {
  const f = fixture();
  for (const topic of ["#", "$aws/things/+/shadow/#", `${prefix}/update`, `${prefix}/name/other/#`]) expect(allowedSubscription(topic)).toBe(false);
  await f.controller.subscribe(`${prefix}/#`);
  await expect(f.controller.subscribe("$aws/things/other/shadow/#")).rejects.toThrow("different thing");
  await expect(f.controller.receive("outside/topic", Buffer.from("x"))).rejects.toThrow("Unsupported");
});
test("serial state updates preserve both changes and are durable before accepted", async () => {
  const f = fixture();
  f.options.publish = async (message: ShadowMessage) => {
    if (message.topic.endsWith("/accepted")) expect(f.saved.at(-1)?.shadow.version).toBe(message.body.version as number);
    f.messages.push(message);
  };
  await Promise.all([1, 2, 3].map(value => f.controller.receive(`${prefix}/update`, Buffer.from(JSON.stringify({ state: { reported: { [`field${value}`]: value } } })))));
  expect(f.controller.snapshot().deviceReported).toEqual({ field1: 1, field2: 2, field3: 3 });
  expect(f.controller.snapshot().shadow.version).toBe(3);
});
test("failed persistence sends no false acceptance and preserves prior state", async () => {
  const f = fixture();
  await f.controller.subscribe(`${prefix}/#`);
  f.options.save = async () => { throw new Error("disk full"); };
  await expect(f.controller.receive(`${prefix}/update`, Buffer.from('{"state":{"reported":{"fan":2}}}'))).rejects.toThrow("disk full");
  expect(f.messages).toHaveLength(0);
  expect(f.controller.snapshot().shadow.document).toBeNull();
});
test("command uses reported, remains unconfirmed, and never fabricates a device report", async () => {
  const f = fixture();
  await expect(f.controller.command({ fan: 1 })).rejects.toThrow("Wait");
  await f.controller.receive(`${prefix}/update`, Buffer.from('{"state":{"reported":{"fan":0,"light":0}}}'));
  f.controller.connection("hood", true);
  const result = await f.controller.command({ fan: 1 });
  expect(result.status).toBe("published_unconfirmed");
  expect(f.controller.snapshot().shadow.document?.state.reported).toEqual({ fan: 1, light: 0 });
  expect(f.controller.snapshot().deviceReported).toEqual({ fan: 0, light: 0 });
  const acknowledgement = f.messages.find(m => m.topic.endsWith("/accepted") && m.body.clientToken === result.token)!;
  expect(acknowledgement.body.state).toEqual({ reported: { fan: 1 } });
  await expect(f.controller.command({ power: 2 })).rejects.toThrow("supported");
  await expect(f.controller.command({ resetgreasefilter: 1 })).rejects.toThrow("supported");
  await expect(f.controller.command({ fan: -1 })).rejects.toThrow("supported");
  f.controller.connection("hood", false);
  await expect(f.controller.command({ fan: 0 })).rejects.toThrow("Wait");
});
test("publish failure records uncertain delivery without claiming success", async () => {
  const f = fixture();
  await f.controller.receive(`${prefix}/update`, Buffer.from('{"state":{"reported":{"fan":0}}}'));
  f.controller.connection("hood", true);
  f.options.publish = async () => { throw new Error("broker stopped"); };
  await expect(f.controller.command({ fan: 1 })).rejects.toThrow("broker stopped");
  expect(f.controller.snapshot().lastCommand?.status).toBe("delivery_uncertain");
  expect(f.controller.snapshot().deviceReported.fan).toBe(0);
});
