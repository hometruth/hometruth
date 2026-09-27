import { expect, test } from "bun:test";
import { HueProxySiteService } from "./site-service";
import { HueProxyService, type HueProxyOptions } from "./service";
import { Site } from "../../site";
import { createApp } from "../../server/app";
import { CameraService } from "../../vendors/tkenpro/camera-service";

const secrets = { schemaVersion: 1 as const, vendors: { hue: { host: "10.77.0.29", applicationKey: "test-application-key", clientKey: "aa".repeat(16) } } };
class FakeRuntime extends HueProxyService {
  didStart = false;
  stopped = false;
  override async start() { this.didStart = true; }
  override async stop() { this.stopped = true; }
  override status() { return { availability: "online" as const, detail: "Bridge event stream connected" }; }
}
test("saved Hue credentials automatically start the built-in service on dedicated ports", async () => {
  let runtime: FakeRuntime | undefined, options: HueProxyOptions | undefined;
  const service = new HueProxySiteService({ secrets, address: "10.78.0.231", exists: async path => path.endsWith("/dtls"), createRuntime: value => { options = value; return runtime = new FakeRuntime(value); } });
  await service.start();
  expect(runtime!.didStart).toBe(true);
  expect(options!.applicationKey).toBe("test-application-key");
  expect(options!.config.bridge.url).toBe("https://10.77.0.29");
  expect(options!.config.listen).toMatchObject({ host: "10.78.0.231", httpPort: 9080, httpsPort: 9443 });
  expect(service.status().detail).toContain("10.78.0.231:9080");
  expect(service.status().availability).toBe("online");
  const site = Site.fromConfig({ schemaVersion: 2, devices: [] }, { hueProxy: service });
  expect(site.getService("hue-proxy")).toBe(service);
  const camera = new CameraService({ cameraHosts: [], async connectCloud() { return { async discover() { return []; } }; }, async discoverLocal() { return []; } });
  const app = createApp(camera, site);
  const response = await app.request("/api/services");
  const data = await response.json() as { services: { id: string; availability: string; page: string }[] };
  expect(data.services[0]).toMatchObject({ id: "hue-proxy", availability: "online" });
  const page = await app.request(data.services[0]!.page);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Hue bridge proxy");
  await service.stop();
  expect(runtime!.stopped).toBe(true);
});
test("unconfigured and disabled Hue services remain visible with setup status", async () => {
  const service = new HueProxySiteService({ secrets: { schemaVersion: 1 }, exists: async () => false });
  await service.start();
  expect(service.status().availability).toBe("offline");
  expect(service.status().detail).toContain("vendors.hue.host");
  const disabled = new HueProxySiteService({ secrets, enabled: false });
  await disabled.start();
  expect(disabled.status().detail).toContain("HUE_PROXY_ENABLED=0");
});
test("a startup failure stays in the service log and does not fail HomeTruth startup", async () => {
  let runtime: FakeRuntime | undefined;
  const service = new HueProxySiteService({ secrets, address: "10.78.0.231", exists: async path => path.endsWith("/dtls"), createRuntime: options => {
    runtime = new FakeRuntime(options);
    runtime.start = async () => { throw new Error("Port 9080 is already in use"); };
    return runtime;
  } });
  await expect(service.start()).resolves.toBeUndefined();
  expect(runtime!.stopped).toBe(true);
  expect(service.status()).toEqual({ availability: "offline", detail: "Hue proxy could not start: Port 9080 is already in use" });
  expect(service.events()[0]!.level).toBe("error");
});
test("the local configuration file is picked up without an environment flag", async () => {
  let loaded: string | undefined;
  const service = new HueProxySiteService({ secrets, exists: async () => true, loadConfig: async path => { loaded = path; throw new Error("Test config validation failure"); } });
  await service.start();
  expect(loaded).toBe("hue-proxy.yml");
  expect(service.status().detail).toContain("config validation");
});
test("missing native helper is built before the runtime is started", async () => {
  const order: string[] = [];
  const service = new HueProxySiteService({ secrets, address: "10.78.0.231", exists: async () => false,
    buildHelper: async path => { order.push("build"); return path!; },
    createRuntime: options => { order.push("create"); return new FakeRuntime(options); },
  });
  await service.start();
  expect(order).toEqual(["build", "create"]);
  await service.stop();
});
