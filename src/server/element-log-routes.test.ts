import { afterEach, expect, test } from "bun:test";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { BinarySwitch, BinarySwitchError, type BinarySwitchState } from "../models/binary-switch";
import { Device } from "../models/device";
import { DeviceEventLogs } from "../models/device-event-log";
import { EventLog, type EventFilter, type ServiceEvent } from "../models/event-log";
import { Service } from "../models/service";
import { Site } from "../site";
import { StateHub } from "../state/hub";
import { groupNode } from "../state/protocol";
import { elementKey } from "../tags/identity";
import type { ElementKind } from "../tags/identity";
import { TokenStore } from "../auth/store";
import { createApp } from "./app";
import { addressesFor } from "../element-api/addresses";
import { SseFrameReader } from "./test-sse";

class Relay extends BinarySwitch {
  value: BinarySwitchState = "off";
  failure = false;
  ignore = false;
  unread = false;
  async turnOn() { if (this.failure) throw new BinarySwitchError("Relay connection timed out", "unreachable"); if (!this.ignore) this.value = "on"; }
  async turnOff() { if (!this.ignore) this.value = "off"; }
  async toggle() { if (!this.ignore) this.value = this.value === "on" ? "off" : "on"; }
  async getState() { if (this.unread) throw new Error("Reading unavailable"); return this.value; }
}
class SwitchDevice extends Device {
  readonly model = SHELLY_PLUS_1;
  readonly capabilities;
  constructor(id: string) { super(id, `${id} relay`, {}); this.capabilities = { binarySwitch: new Relay(id) }; }
  async probe() { return {}; }
}
class HistoryService extends Service {
  readonly log = new EventLog();
  status() { return { availability: "online" as const, detail: "Running" }; }
  events(limit?: number, filter?: EventFilter) { return this.log.recent(limit, filter); }
  subscribe(listener: (event: ServiceEvent) => void, filter?: EventFilter) { return this.log.subscribe(listener, filter); }
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function fixture(auth = false) {
  const left = new SwitchDevice("left"), right = new SwitchDevice("right"), other = new SwitchDevice("other");
  const service = new HistoryService("example", "Example service");
  const site = new Site([left, right, other], undefined, undefined, [service], undefined, undefined, [{ id: "desk", name: "Desk lights", members: ["left", "right"], asSwitch: true }]);
  const logs = new DeviceEventLogs(), hub = new StateHub(), tokens = auth ? new TokenStore() : undefined;
  const app = createApp(undefined, site, undefined, undefined, undefined, undefined, logs, undefined, undefined, undefined, undefined, undefined, hub, tokens);
  cleanup.push(() => hub.stop(), () => tokens?.close());
  const address = (kind: ElementKind, ...ids: string[]) => addressesFor(hub).address(elementKey(kind, ...ids))!;
  const device = (id: string) => addressesFor(hub).device(id)!;
  const group = (id: string) => addressesFor(hub).group(id)!;
  const events = async (kind: ElementKind = "group-switch", id = "desk", query = "") => (await (await app.request(`/api/elements/${address(kind, id)}/events${query}`)).json()).events as ServiceEvent[];
  const post = (path: string) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  return { app, site, logs, hub, tokens, left, right, other, service, events, post, address, device, group };
}

test("group and element pages expose a Log tab with member events and no unrelated events", async () => {
  const { app, logs, events, address } = fixture();
  logs.record("left", "device_control", "Left changed", { data: { control: "turnOn" } });
  logs.record("other", "device_control", "Unrelated change", { data: { control: "turnOn" } });
  expect((await events()).map(event => event.message)).toEqual(["Left changed"]);
  for (const page of ["/switches/desk-lights", "/groups/desk-lights"]) {
    expect(await (await app.request(page)).text()).toContain(`href="${page}/log"`);
    const response = await app.request(`${page}/log`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Left changed");
    expect(html).not.toContain("Unrelated change");
    expect(html).toContain('data-stream-path="/api/elements/');
  }
  const key = address("control", "left", "binarySwitch", "turnOff");
  expect(await (await app.request(`/elements/${key}`)).text()).toContain(`href="/elements/${key}/log"`);
  expect((await app.request(`/elements/${key}/log`)).status).toBe(200);
  expect((await app.request("/elements/missing/log")).status).toBe(404);
});

test("control logs narrow to their operation and service logs include events without a subject", async () => {
  const { app, logs, service, address } = fixture();
  logs.record("left", "device_control", "On", { data: { control: "binarySwitch.turnOn" } });
  logs.record("left", "device_control", "Off", { data: { control: "turnOff" } });
  service.log.record("started", "Service started");
  const control = address("control", "left", "binarySwitch", "turnOn");
  expect((await (await app.request(`/api/elements/${control}/events`)).json()).events.map((event: ServiceEvent) => event.message)).toEqual(["On"]);
  expect(await (await app.request("/services/example-service/log")).text()).toContain("Service started");
});

test("element log pages render cached events without reading devices or service histories", async () => {
  const { app, service, left, right } = fixture();
  service.log.record("started", "Cached service event");
  let reads = 0;
  service.events = () => { reads++; throw new Error("History unavailable"); };
  left.describe = right.describe = () => { reads++; return new Promise(() => {}); };
  const page = await app.request("/services/example-service/log");
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Cached service event");
  expect((await app.request("/switches/desk-lights/log")).status).toBe(200);
  expect(reads).toBe(0);
});

test("group history, page filters, and live stream use the same element scope", async () => {
  const { app, logs, events, address } = fixture();
  const query = `?where=${encodeURIComponent(JSON.stringify({ path: "/type", op: "eq", value: "device_control_failed" }))}`;
  logs.record("left", "device_control", "Sent", { data: { control: "turnOn" } });
  logs.record("right", "device_control_failed", "Saved failure", { data: { control: "turnOn", reason: "timeout" } });
  expect(await events("group-switch", "desk", query + "&limit=1")).toMatchObject([{ message: "Saved failure" }]);
  const html = await (await app.request(`/switches/desk-lights/log${query}`)).text();
  expect(html).toContain("Saved failure");
  expect(html).not.toContain('<div>Sent');
  const reader = new SseFrameReader(await app.request(`/api/elements/${address("group-switch", "desk")}/events/stream${query}`));
  try {
    expect(await reader.next(1)).toMatchObject([{ data: { message: "Saved failure" } }]);
    logs.record("other", "device_control_failed", "Unrelated failure", { data: { control: "turnOn", reason: "timeout" } });
    logs.record("left", "device_control", "Successful control", { data: { control: "turnOff" } });
    logs.record("left", "device_control_failed", "Live failure", { data: { control: "turnOff", reason: "timeout" } });
    expect(await reader.next(1)).toMatchObject([{ data: { message: "Live failure" } }]);
  } finally { await reader.close(); }
});

test("a partial group failure records the failed member and the overall action and publishes actual state", async () => {
  const { post, right, events, hub, app, group } = fixture();
  right.capabilities.binarySwitch.failure = true;
  const response = await post(`/api/device-groups/${group("desk")}/switch/turn-on`);
  expect(response.status).toBe(502);
  const failures = (await events()).filter(event => event.type === "device_control_failed");
  expect(failures).toHaveLength(2);
  expect(failures).toEqual(expect.arrayContaining([
    expect.objectContaining({ subject: "right", data: { control: "power.turnOn", reason: "Relay connection timed out" } }),
    expect.objectContaining({ subject: elementKey("group", "desk"), message: expect.stringContaining("right relay: Relay connection timed out") }),
  ]));
  expect(hub.snapshot([groupNode("desk")])[0]?.value).toMatchObject({ group: { mixed: true } });
  expect(await (await app.request("/switches/desk-lights/log")).text()).toContain("Relay connection timed out");
});

test("unchanged group state is a member failure even when its control returns successfully", async () => {
  const { post, right, events, group } = fixture();
  right.capabilities.binarySwitch.ignore = true;
  expect((await post(`/api/device-groups/${group("desk")}/switch/turn-on`)).status).toBe(502);
  expect((await events()).filter(event => event.subject === "right" && event.type === "device_control_failed")).toMatchObject([
    { data: { reason: "Requested On, but the device still reports Off" } },
  ]);
});

test("device actions retain thrown errors and report unconfirmed or unchanged on, off, and toggle states", async () => {
  const { post, left, logs, device } = fixture();
  const relay = left.capabilities.binarySwitch;
  relay.failure = true;
  expect((await post(`/api/switches/${device("left")}/turn-on`)).status).toBe(502);
  expect(logs.recent("left")).toEqual(expect.arrayContaining([expect.objectContaining({ type: "device_control_failed", data: { control: "turnOn", reason: "Relay connection timed out" } })]));
  relay.failure = false; relay.ignore = true;
  for (const [control, initial] of [["turnOn", "off"], ["turnOff", "on"], ["toggle", "off"]] as const) {
    relay.value = initial;
    const response = await post(`/api/devices/${device("left")}/capabilities/binarySwitch/controls/${control}`);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "state_not_applied", message: expect.stringContaining("still reports") } });
  }
  relay.ignore = false; relay.unread = true;
  const response = await post(`/api/switches/${device("left")}/turn-on`);
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining("could not be confirmed") } });
});

test("group logs require access to every member and reject unrelated devices", async () => {
  const { app, tokens, address } = fixture(true);
  const groupToken = tokens!.issue({ name: "Group reader", permissions: ["read"], subject: { group: "desk" } }).token;
  const deviceToken = tokens!.issue({ name: "One reader", permissions: ["read"], subject: { device: "left" } }).token;
  for (const path of ["/switches/desk-lights/log", `/api/elements/${address("group-switch", "desk")}/events`]) {
    expect((await app.request(path, { headers: { authorization: `Bearer ${groupToken}` } })).status).toBe(200);
    expect((await app.request(path, { headers: { authorization: `Bearer ${deviceToken}` } })).status).toBe(403);
  }
});
