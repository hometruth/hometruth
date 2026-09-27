import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HueProxyService } from "./service";
import { parseProxyConfig } from "./config";
import { buildDtls } from "./build-dtls";
import { DtlsEndpoint } from "./dtls";
import { buildHueStreamFrame } from "../../vendors/hue/entertainment-protocol";
import { createSocket } from "node:dgram";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const appKey = "secret-app-key";
async function setup(handler: (request: Request) => Response | Promise<Response>, monitor = false, entertainment?: { helperPath: string; port: number; upstreamPort: number }) {
  const bridge = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  cleanup.push(async () => { await bridge.stop(true); });
  const stateDirectory = await mkdtemp(join(tmpdir(), "hue-proxy-test-"));
  cleanup.push(() => rm(stateDirectory, { recursive: true, force: true }));
  const config = parseProxyConfig({ listen: { host: "127.0.0.1", advertiseAddress: "127.0.0.1", httpPort: 18080, httpsPort: 18443, discovery: false }, bridge: { url: bridge.url.origin }, stateDirectory, monitor: { enabled: monitor, reconnectMs: 100, pollIntervalMs: 1000 }, entertainment: entertainment ? { ...entertainment, enabled: true } : { enabled: false } });
  // Ephemeral listeners are test-only; production config rejects port zero.
  config.listen.httpPort = 0; config.listen.httpsPort = 0;
  const service = new HueProxyService({ config, applicationKey: appKey, clientKey: "aa".repeat(16) });
  cleanup.push(() => service.stop());
  await service.start();
  const url = `http://127.0.0.1:${service.snapshot().httpPort}`;
  const get = (path: string, init?: RequestInit) => fetch(url + path, init);
  return { service, get, url, stateDirectory, config };
}

test("v1/v2 writes, credentials, paths and Hue errors are forwarded; discovery identity is replaced", async () => {
  const requests: any[] = [];
  const { get } = await setup(async request => {
    const path = new URL(request.url).pathname;
    requests.push({ path, method: request.method, key: request.headers.get("hue-application-key"), body: await request.text() });
    if (path.endsWith("/config")) return Response.json({ name: "Real bridge", ipaddress: "10.77.0.2", bridgeid: "real", mac: "00:01:02:03:04:05", apiversion: "1.68.0" });
    if (path.includes("/lights/")) return Response.json([{ error: { type: 7, address: "/lights/1/state/xy", description: "invalid value" } }]);
    return Response.json({ errors: [], data: [{ rid: "one", rtype: "light" }] });
  });
  const config = await (await get("/api/config")).json() as any;
  expect(config.name).toBe("HomeTruth Hue"); expect(config.bridgeid).not.toBe("real"); expect(config.apiversion).toBe("1.68.0");
  const result = await (await get("/api/client-key/lights/1/state", { method: "PUT", body: JSON.stringify({ xy: [.5, .3] }) })).json() as any;
  expect(result[0].error.type).toBe(7);
  await get("/clip/v2/resource/light/one", { method: "PUT", headers: { "hue-application-key": "other-key" }, body: JSON.stringify({ on: { on: false } }) });
  expect(requests[1]).toMatchObject({ path: "/api/client-key/lights/1/state", method: "PUT", body: '{"xy":[0.5,0.3]}' });
  expect(requests[2]).toMatchObject({ key: "other-key", path: "/clip/v2/resource/light/one" });
  const events = await (await get("/hometruth/events", { headers: { "hue-application-key": appKey } })).text();
  expect(events).not.toContain("client-key"); expect(events).not.toContain("other-key");
});
test("this bridge answers pairing itself, mints private credentials, and presents its own key upstream", async () => {
  const requests: any[] = [];
  const { service, get, stateDirectory } = await setup(async request => {
    requests.push({ path: new URL(request.url).pathname, key: request.headers.get("hue-application-key") });
    return Response.json({ errors: [], data: [] });
  });
  const body = '{"devicetype":"test","generateclientkey":true}';
  // Unpressed it answers 101 exactly as a real bridge does, and registers nothing anywhere.
  expect(service.linkButton().open).toBe(false);
  expect((await (await get("/api", { method: "POST", body })).json() as any)[0].error.type).toBe(101);
  expect(requests).toHaveLength(0);

  expect(service.pressLinkButton().open).toBe(true);
  const [{ success }] = await (await get("/api", { method: "POST", body })).json() as any;
  expect(success.username).toMatch(/^[a-f\d]{40}$/u);
  expect(success.clientkey).toMatch(/^[A-F\d]{32}$/u);
  expect(success.username).not.toBe(appKey);
  const stored = await Bun.file(join(stateDirectory, "bridge.json")).json();
  expect(stored.keys[success.username]).toBe(success.clientkey);
  const { stat } = await import("node:fs/promises");
  expect((await stat(join(stateDirectory, "bridge.json"))).mode & 0o777).toBe(0o600);

  // A credential minted here means nothing upstream, so ours is presented instead.
  await get(`/api/${success.username}/lights/1/state`, { method: "PUT", body: "{}" });
  await get("/clip/v2/resource/light/one", { method: "PUT", headers: { "hue-application-key": success.username }, body: "{}" });
  expect(requests).toMatchObject([{ path: `/api/${appKey}/lights/1/state` }, { key: appKey }]);

  // The paired client shows on the summary by its own name, the real bridge is the upstream, and our own key is not a client.
  const summary = service.connectionSummary();
  expect(summary.clients).toEqual([{ label: "test", streaming: false }]);
  expect(summary.bridge.host).toMatch(/^127\.0\.0\.1$/u);
  expect(Object.keys(await Bun.file(join(stateDirectory, "bridge.json")).json().then((s: any) => s.labels))).toEqual([success.username]);

  // The window closes on its own, so pairing is not left open after one press.
  service.pressLinkButton(0);
  expect(service.linkButton().open).toBe(false);
  expect((await (await get("/api", { method: "POST", body })).json() as any)[0].error.type).toBe(101);
  expect((await get("/hometruth/events")).status).toBe(401);
});
test("bridge events merge partial updates, deduplicate reconnect replay, and keep all resource events", async () => {
  const { service, get } = await setup(() => Response.json({ errors: [], data: [] }));
  service.tracker.ingest({ id: "one", type: "light", on: { on: false }, dimming: { brightness: 30 } }, false);
  const event = [{ id: "event-1", type: "update", data: [{ id: "one", type: "light", color: { xy: { x: .7, y: .3 } } }, { id: "button-1", type: "button", button: { last_event: "short_release" } }] }];
  service.ingestEvents(event); service.ingestEvents(event);
  const events = await (await get("/hometruth/events", { headers: { "hue-application-key": appKey } })).json() as any[];
  expect(events.filter(e => e.type === "light")).toHaveLength(1);
  expect(events.find(e => e.type === "light").state).toMatchObject({ on: false, brightnessPercent: 30 });
  expect(events.filter(e => e.type === "resource")).toHaveLength(2);
});
test("SSE monitoring reconnects and polling resolves group/scene changes", async () => {
  let streams = 0, polls = 0;
  const { service } = await setup(request => {
    if (new URL(request.url).pathname.startsWith("/eventstream")) {
      streams++;
      return new Response('id: change-1\r\ndata: [{"id":"envelope-1","type":"update","data":[{"id":"one","type":"light","color":{"xy":{"x":0.7,"y":0.3}}}]}]\r\n\r\n', { headers: { "content-type": "text/event-stream" } });
    }
    polls++;
    return Response.json({ errors: [], data: [{ type: "light", id: "one", on: { on: polls > 1 }, dimming: { brightness: 55 } }] });
  }, true);
  // The second poll is only resolved once its body has been tracked, not when the request arrives.
  await until(() => streams >= 2 && polls >= 2 && service.tracker.states.get("light/one")?.on === true);
  expect(service.tracker.states.get("light/one")).toMatchObject({ on: true, brightnessPercent: 55 });
  // The colour from the SSE reached the tracker (and so the /hometruth stream and routing), but colour is deliberately kept out of the service log.
  expect(service.tracker.states.get("light/one")?.color).toMatch(/^#[0-9a-f]{6}$/u);
  expect(service.events().some(e => /colou?r|Color\/state/u.test(e.message))).toBe(false);
});
test("proxy streams SSE without buffering the open response", async () => {
  const encoder = new TextEncoder();
  const { get } = await setup(() => new Response(new ReadableStream({ start(c) { c.enqueue(encoder.encode("data: []\n\n")); } }), { headers: { "content-type": "text/event-stream" } }));
  const controller = new AbortController();
  const response = await get("/eventstream/clip/v2", { signal: controller.signal, headers: { "hue-application-key": appKey } });
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: []\n\n");
  controller.abort(); await reader.cancel().catch(() => undefined);
});
test("disabled Entertainment is explicit and never claims the real bridge", async () => {
  let calls = 0;
  const { get } = await setup(() => { calls++; return Response.json({ errors: [], data: [] }); });
  const response = await get("/clip/v2/resource/entertainment_configuration/area", { method: "PUT", headers: { "hue-application-key": appKey }, body: '{"action":"start"}' });
  expect(response.status).toBe(503); expect(calls).toBe(0);
});
test("complete Entertainment proxy relays encrypted records unchanged, emits colors and releases the bridge", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hue-proxy-native-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const helperPath = await buildDtls(join(directory, "dtls"));
  const port = await udpPort(), upstreamPort = await udpPort();
  let realBridge: DtlsEndpoint | undefined;
  const frames: Buffer[] = [];
  let stops = 0;
  const { get, service } = await setup(async request => {
    const body = await request.json() as any;
    if (body.action === "start") {
      realBridge = new DtlsEndpoint({ helperPath, mode: "server", host: "127.0.0.1", port: upstreamPort, identity: appKey, key: "aa".repeat(16), frame: frame => frames.push(frame), closed() {} });
      await realBridge.ready;
    } else { stops++; await realBridge?.stop(); }
    return Response.json({ errors: [], data: [] });
  }, false, { helperPath, port, upstreamPort });
  cleanup.push(async () => { await realBridge?.stop(); });
  const area = "12345678-1234-1234-1234-123456789abc";
  const path = `/clip/v2/resource/entertainment_configuration/${area}`;
  const start = await get(path, { method: "PUT", headers: { "hue-application-key": appKey }, body: '{"action":"start"}' });
  expect(start.status).toBe(200);
  const app = new DtlsEndpoint({ helperPath, mode: "client", host: "127.0.0.1", port, identity: appKey, key: "aa".repeat(16), frame() {}, closed() {} });
  cleanup.push(() => app.stop());
  await app.connected;
  const originals = [buildHueStreamFrame(area, 0, [{ channel: 1, r: 128, g: 0, b: 0 }]), buildHueStreamFrame(area, 1, [{ channel: 1, r: 0, g: 255, b: 0 }, { channel: 2, r: 0, g: 0, b: 32 }])];
  for (const frame of originals) app.send(frame);
  // The receiver splits the decrypted stream on the HueStream magic that starts each frame, so a frame is delivered once the
  // next one begins — a third frame delimits the second, exactly as the next frame does in a live stream. It stays pending.
  app.send(buildHueStreamFrame(area, 2, [{ channel: 1, r: 0, g: 0, b: 0 }]));
  await until(() => frames.length === 2);
  expect(frames).toEqual(originals.map(frame => Buffer.from(frame)));
  expect(service.tracker.states.get(`entertainment/${area}/1`)).toMatchObject({ color: "#00ff00", brightnessPercent: 100 });
  expect(service.tracker.states.get(`entertainment/${area}/2`)!.brightnessPercent).toBeCloseTo(12.55, 1);
  await get(path, { method: "PUT", headers: { "hue-application-key": appKey }, body: '{"action":"stop"}' });
  expect(stops).toBe(1); expect(service.snapshot().entertainment).toBe(false);
}, 15000);
async function udpPort(): Promise<number> {
  const socket = createSocket("udp4");
  await new Promise<void>(resolve => socket.bind(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return port;
}
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !predicate(); i++) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}
