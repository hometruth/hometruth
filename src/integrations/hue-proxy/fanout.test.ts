import { expect, test } from "bun:test";
import { Fanout, Destinations, matchesSource, transform } from "./fanout";
import type { HueEvent, Target } from "./config";
const event = (state: HueEvent["state"]): HueEvent => ({ id: "1", at: new Date().toISOString(), type: "light", origin: "bridge", source: "light/one", state: state!, changed: state! });
const target: Target = { id: "strip", kind: "wled", url: "http://10.77.0.99", minIntervalMs: 0 };

test("routes match exact ids, prefixes and v1 aliases; color and brightness transforms are independent", async () => {
  expect(matchesSource("light/*", "light/one")).toBe(true);
  expect(matchesSource("light/*", "resource/light/one")).toBe(false);
  const changed = transform(event({ color: "#ff0000", brightnessPercent: 40, on: false }), { id: "map", sources: ["light/*"], targets: [], fields: ["color", "brightnessPercent"], color: "#00ff00", brightnessScale: .5 });
  expect(changed.state).toEqual({ color: "#00ff00", brightnessPercent: 20 });
  const sent: HueEvent[] = [];
  const fanout = new Fanout({ targets: [target], routes: [{ id: "legacy", sources: ["light-v1/2"], targets: [target.id] }] }, async (_, e) => { sent.push(e); }, () => {});
  fanout.publish(event({ color: "#ff0000" }), ["light-v1/2"]);
  await fanout.idle(); await fanout.stop();
  expect(sent).toHaveLength(1);
});
test("one slow destination cannot block another; pending colors coalesce without losing off", async () => {
  let unblock!: () => void;
  const held = new Promise<void>(resolve => { unblock = resolve; });
  const slow: HueEvent[] = [], fast: HueEvent[] = [];
  const fanout = new Fanout({ targets: [target, { ...target, id: "fast" }], routes: [{ id: "sync", sources: ["*"], targets: ["strip", "fast"] }] }, async (t, e) => { (t.id === "strip" ? slow : fast).push(e); if (t.id === "strip" && slow.length === 1) await held; }, () => {});
  fanout.publish(event({ on: true, color: "#ff0000" }));
  fanout.publish(event({ on: false }));
  fanout.publish(event({ color: "#00ff00" }));
  await Bun.sleep(10);
  expect(fast.length).toBeGreaterThan(0);
  expect(slow).toHaveLength(1);
  unblock(); await fanout.idle();
  expect(slow).toHaveLength(2);
  expect(slow[1]!.state).toMatchObject({ on: false, color: "#00ff00" });
  await fanout.stop();
});
test("raw resource consumers receive ordered, bounded events", async () => {
  let unblock!: () => void;
  const held = new Promise<void>(resolve => { unblock = resolve; });
  const fanout = new Fanout({ targets: [{ ...target, kind: "webhook" }], routes: [{ id: "all", sources: ["*"], targets: [target.id] }] }, async () => held, () => {});
  for (let i = 0; i < 400; i++) fanout.publish({ ...event({}), id: String(i), type: "resource" });
  expect(fanout.status().strip!.queued).toBeLessThanOrEqual(256);
  expect(fanout.status().strip!.dropped).toBeGreaterThan(0);
  unblock(); await fanout.stop();
});
test("WLED adapter sends brightness separately from saturated color in one state write", async () => {
  const sent: any[] = [];
  const destinations = new Destinations((async (url, init) => { sent.push([String(url), JSON.parse(String(init?.body))]); return Response.json({ success: true }); }) as typeof fetch);
  await destinations.deliver(target, event({ color: "#ff0000", brightnessPercent: 50, on: false, transitionMs: 500 }), new AbortController().signal);
  expect(sent).toEqual([["http://10.77.0.99/json/state", { on: false, bri: 128, transition: 5, seg: [{ id: 0, col: [[255, 0, 0]], fx: 0, pal: 0 }] }]]);
});
test("HomeTruth adapter uses the actual device API, clamps bounds and writes off last", async () => {
  const requests: any[] = [];
  const destinations = new Destinations((async (url, init) => {
    if (init?.method === "GET") return Response.json({ model: { id: "elgato-key-light-air" }, object: { capabilities: { light: { actions: { turnOn: {}, turnOff: {}, setBrightness: { minimumPercent: 3, maximumPercent: 100 }, setColorTemperature: { minimumKelvin: 2900, maximumKelvin: 7000 } } } } } });
    requests.push([String(url).split("/").slice(-3).join("/"), JSON.parse(String(init?.body))]);
    return Response.json({});
  }) as typeof fetch);
  await destinations.deliver({ id: "lamp", kind: "hometruth", url: "http://127.0.0.1:3000", deviceId: "lamp" }, event({ colorTemperatureKelvin: 2000, brightnessPercent: 0, on: false }), new AbortController().signal);
  expect(requests).toEqual([["light/controls/setColorTemperature", { value: 2900 }], ["light/controls/setBrightness", { value: 3 }], ["light/controls/turnOff", {}]]);
});
test("HomeTruth refuses feedback into Hue devices", async () => {
  const destinations = new Destinations((async (_url, _init) => Response.json({ model: { id: "hue-light" } })) as typeof fetch);
  await expect(destinations.deliver({ id: "hue", kind: "hometruth", url: "http://127.0.0.1:3000", deviceId: "hue" }, event({ on: true }), new AbortController().signal)).rejects.toThrow("feedback");
});
test("WLED segment off leaves other segments' power and dimming alone", async () => {
  let sent: any;
  const destinations = new Destinations((async (_url, init) => { sent = JSON.parse(String(init?.body)); return Response.json({}); }) as typeof fetch);
  await destinations.deliver({ ...target, segment: 2 }, event({ color: "#00ff00", brightnessPercent: 30, on: false }), new AbortController().signal);
  expect(sent).not.toHaveProperty("on");
  expect(sent).not.toHaveProperty("bri");
  expect(sent.seg[0]).toMatchObject({ id: 2, on: false, bri: 77 });
});
test("webhook sends an unmodified resource event with optional bearer authentication", async () => {
  const old = process.env.HUE_TEST_WEBHOOK_TOKEN;
  process.env.HUE_TEST_WEBHOOK_TOKEN = "test-token";
  const incoming: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) { incoming.push([request.headers.get("authorization"), await request.json()]); return new Response(null, { status: 204 }); } });
  const destinations = new Destinations();
  const payload = { ...event({}), type: "resource" as const, source: "resource/button/one", data: { button: { last_event: "short_release" } } };
  try {
    await destinations.deliver({ id: "hook", kind: "webhook", url: server.url.toString(), tokenEnv: "HUE_TEST_WEBHOOK_TOKEN" }, payload, new AbortController().signal);
    expect(incoming).toEqual([["Bearer test-token", payload]]);
  } finally {
    await destinations.stop(); await server.stop(true);
    if (old === undefined) delete process.env.HUE_TEST_WEBHOOK_TOKEN; else process.env.HUE_TEST_WEBHOOK_TOKEN = old;
  }
});
test("MQTT destination connects and delivers normalized JSON to the existing broker", async () => {
  const { startMqttBroker } = await import("../../vendors/mqtt-broker");
  const broker = await startMqttBroker({ hostname: "127.0.0.1", port: 0 });
  const destinations = new Destinations();
  const messages: unknown[] = [];
  const stop = broker.onMessage("proxy/test", (_topic, payload) => messages.push(JSON.parse(payload.toString())));
  const payload = event({ color: "#00ff00" });
  try {
    await destinations.deliver({ id: "mqtt", kind: "mqtt", url: `mqtt://127.0.0.1:${broker.port}`, topic: "proxy/test" }, payload, new AbortController().signal);
    for (let i = 0; i < 100 && !messages.length; i++) await Bun.sleep(10);
    expect(messages).toEqual([payload]);
  } finally { stop(); await destinations.stop(); await broker.stop(); }
});
