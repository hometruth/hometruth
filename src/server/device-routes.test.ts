import { describe, expect, spyOn, test } from "bun:test";
import { StateHub } from "../state/hub";
import { createApp } from "./app";
import { CameraService } from "../vendors/tkenpro/camera-service";
import { SHELLY_PLUS_1 } from "../devices/switches/shelly-plus-1";
import { LutronCasetaDimmerDevice, LutronCasetaSwitchDevice } from "../devices/switches/lutron-caseta";
import { TkenproPet3T } from "../devices/treat-dispensers/tkenpro-2k-pet-camera-treat-dispenser";
import { BinarySwitch, BinarySwitchError, type BinarySwitchState } from "../models/binary-switch";
import { Device, type DeviceIdentity } from "../models/device";
import { DeviceEventLogs } from "../models/device-event-log";
import { EventBusForwarder } from "../event-bus";
import { TactacamReveal } from "../devices/cameras/tactacam-reveal";
import { EventLog, type EventFilter, type ServiceEvent } from "../models/event-log";
import { Service, type ServiceStatus } from "../models/service";
import type { NetworkAdapter } from "../network/adapter";
import { DeviceNetworkRecovery } from "../network/recovery";
import type { CameraDiscoverRequest } from "../schemas";
import { Site } from "../site";
import { validators } from "../validation";
import type { MatterSettingsSource } from "../integrations/matter/settings";

class MemorySwitch extends BinarySwitch {
  constructor(id: string, private state: BinarySwitchState = "off") {
    super(id);
  }
  async turnOn(): Promise<void> { this.state = "on"; }
  async turnOff(): Promise<void> { this.state = "off"; }
  async toggle(): Promise<void> { this.state = this.state === "on" ? "off" : "on"; }
  async getState(): Promise<BinarySwitchState> { return this.state; }
}

class UnreachableSwitch extends MemorySwitch {
  override async turnOn(): Promise<void> {
    throw new BinarySwitchError("relay is unreachable", "unreachable");
  }
}

class OfflineUntilReconnectedSwitch extends MemorySwitch {
  online = false;
  override async getState(): Promise<BinarySwitchState> {
    if (!this.online) throw new BinarySwitchError("relay is unreachable", "unreachable");
    return await super.getState();
  }
}

class SubjectService extends Service {
  readonly log = new EventLog();
  constructor(id = "subject-service") { super(id, "Subject service"); }
  status(): ServiceStatus { return { availability: "online", detail: "Running" }; }
  events(limit?: number, filter?: EventFilter): readonly ServiceEvent[] { return this.log.recent(limit, filter); }
  subscribe(listener: (event: ServiceEvent) => void, filter?: EventFilter): () => void { return this.log.subscribe(listener, filter); }
}

/** A Shelly Plus 1 whose relay is a test double. */
class SwitchDevice extends Device<{ host: string }> {
  readonly model = SHELLY_PLUS_1;
  readonly capabilities;
  constructor(id: string, name: string, relay: BinarySwitch) {
    super(id, name, { host: "10.77.0.228" });
    this.capabilities = { binarySwitch: relay };
  }
  async probe(): Promise<DeviceIdentity> { return {}; }
}

function fixture(matterSettings?: MatterSettingsSource) {
  const discoverRequests: CameraDiscoverRequest[] = [];
  const service = new CameraService({
    cameraHosts: ["10.78.0.147"],
    async connectCloud() { return { async discover() { return []; } }; },
    async discoverLocal(request) {
      discoverRequests.push(request);
      return [{
        view: {
          id: "100000001",
          name: "100000001",
          host: "10.78.0.147",
          model: "Pet 3T",
          status: "online" as const,
          stream: "unknown" as const,
          snapshot: "unknown" as const,
          capabilities: [{
            id: "device.statusLed",
            category: "privacy" as const,
            label: "Status LED",
            kind: "toggle" as const,
            availability: "available" as const,
            value: true,
          }],
        },
        controller: { async control() {}, async ptzStart() {}, async ptzStop() {} },
      }];
    },
  });
  const site = new Site([
    new TkenproPet3T({ id: "kitchen", name: "Kitchen pet camera" }, { host: "10.78.0.147" }, service),
    new SwitchDevice("relay", "Porch relay", new MemorySwitch("relay", "off")),
    new SwitchDevice("dead", "dead", new UnreachableSwitch("dead")),
  ]);
  const hub = new StateHub();
  const app = createApp(service, site, undefined, undefined, undefined, undefined, undefined, undefined, matterSettings, undefined, undefined, undefined, hub);
  const json = (path: string, method = "GET") => app.request(path, method === "POST"
    ? { method, headers: { "content-type": "application/json" }, body: "{}" }
    : { method });
  return { app, hub, json, discoverRequests };
}

describe("device pages", () => {
  test("derives every page from its URL without persisted browser state", async () => {
    const { app } = fixture();
    const pages = [
      ["/", "<title>HomeTruth</title>"],
      ["/devices", "<title>Devices · HomeTruth</title>"],
      ["/switches", "<title>Switches · HomeTruth</title>"],
      ["/services", "<title>Services · HomeTruth</title>"],
      ["/schemas", "<title>Schemas · HomeTruth</title>"],
      ["/schemas/cooktop", 'data-schema-page data-schema-id="https://hometruth.ai/schemas/cooktop"'],
      ["/switches/porch-relay", 'data-switch-page data-device-id="relay"'],
      ["/switches/porch-relay/log", 'data-event-log data-device-id="relay"'],
      ["/switches/porch-relay/settings", 'data-device-settings data-device-id="relay"'],
      ["/cameras/kitchen-pet-camera", "<title>Kitchen pet camera · HomeTruth</title>"],
      ["/cameras/kitchen-pet-camera/settings", 'data-device-settings data-device-id="kitchen"'],
    ] as const;

    for (const [path, marker] of pages) {
      const response = await app.request(path, { headers: { cookie: "lastPage=%2Fdevices%2Frelay" } });
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-location")).toBe(path);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(html).toContain(marker);
      expect(html).not.toMatch(/document\.cookie|localStorage|sessionStorage/u);
    }
  });

  test("shows bridge pairing on an exported switch's Settings tab only", async () => {
    const matterSettings: MatterSettingsSource = {
      async read() {
        return {
          running: true,
          commissioned: false,
          switchIds: ["relay", "dead"],
          qrCodeDataUrl: "data:image/png;base64,AQID",
          manualPairingCode: "12345678901",
        };
      },
    };
    const { app, hub } = fixture(matterSettings);
    await hub.data.refresh();
    const relayHtml = await (await app.request("/switches/porch-relay/settings")).text();
    expect(relayHtml).toContain("data-matter-pairing-qr");
    expect(relayHtml).toContain("12345678901");
    const cameraHtml = await (await app.request("/cameras/kitchen-pet-camera/settings")).text();
    expect(cameraHtml).toContain("The Matter bridge exports switches only.");
    expect(cameraHtml).not.toContain("data-matter-pairing-qr");
  });

  test("lists configured devices at /devices and links to each device page", async () => {
    const { app } = fixture();
    const response = await app.request("/devices");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("<title>Devices · HomeTruth</title>");
    expect(html).toContain('href="/cameras/kitchen-pet-camera"');
    expect(html).toContain('href="/switches/porch-relay"');
    expect(html).not.toContain("Camera connection");
  });

  test("renders the switch template for a binary switch and the camera dashboard for a camera", async () => {
    const { app, json } = fixture();
    const relay = await app.request("/switches/porch-relay");
    expect(relay.status).toBe(200);
    const relayHtml = await relay.text();
    expect(relayHtml).toContain('data-switch-page data-device-id="relay"');
    expect(relayHtml).toContain('href="/switches/porch-relay/log"');

    const undiscovered = await app.request("/cameras/kitchen-pet-camera");
    const undiscoveredHtml = await undiscovered.text();
    expect(undiscovered.status).toBe(200);
    expect(undiscoveredHtml).toContain("<title>Kitchen pet camera · HomeTruth</title>");
    expect(undiscoveredHtml).toContain("Camera connection");
    expect(undiscoveredHtml).toContain('data-device-id="kitchen"');

    expect((await json("/api/camera/discover", "POST")).status).toBe(200);
    const discovered = await app.request("/cameras/kitchen-pet-camera");
    const discoveredHtml = await discovered.text();
    expect(discoveredHtml).toContain('data-device-id="100000001"');
    expect(discoveredHtml).toContain('data-device-name="Kitchen pet camera"');
    expect(discoveredHtml).not.toContain("<option value=\"other\"");

    const missing = await app.request("/devices/nope");
    expect(missing.status).toBe(404);
  });

  test("every device has a live aggregate log page and ring-buffer API", async () => {
    const { app, json } = fixture();
    expect((await json("/api/switches/relay/turn-on", "POST")).status).toBe(200);

    const response = await json("/api/devices/relay/events");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(validators.deviceEventsResponse(body)).toBe(true);
    expect(body.deviceId).toBe("relay");
    expect(body.events.map((event: { type: string }) => event.type)).toEqual(expect.arrayContaining(["device_control", "availability_changed"]));
    expect(body.events.every((event: { subject?: string }) => event.subject === "relay")).toBe(true);

    const page = await app.request("/switches/porch-relay/log");
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('data-events-path="/api/devices/relay/events"');
    expect(html).toContain('data-stream-path="/api/devices/relay/events/stream"');
    expect(html).toContain('href="/switches/porch-relay"');
    expect(html).toContain('Log</a>');
    expect((await app.request("/devices/nope/log")).status).toBe(404);
    expect((await json("/api/devices/nope/events")).status).toBe(404);
  });

  test("a device log aggregates events tagged by any service", async () => {
    const device = new SwitchDevice("relay", "Relay", new MemorySwitch("relay"));
    const service = new SubjectService();
    service.log.record("network_error", "Gateway could not find the relay", { subject: "relay", data: { what: "client lookup" } });
    service.log.record("network_error", "Different device", { subject: "other", data: { what: "client lookup" } });
    const app = createApp(undefined, new Site([device], undefined, undefined, [service]));
    const response = await app.request("/api/devices/relay/events");
    const body = await response.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ type: "network_error", subject: "relay" });
  });

  test("a device log does not duplicate events mirrored by the MQTT event bus", async () => {
    const device = new SwitchDevice("relay", "Relay", new MemorySwitch("relay"));
    const source = new SubjectService();
    source.log.record("network_error", "Gateway could not find the relay", { subject: "relay", data: { what: "client lookup" } });
    const mirror = new SubjectService("mqtt-broker");
    mirror.log.record("network_error", "Gateway could not find the relay", { subject: "relay", data: { what: "client lookup" } });
    const app = createApp(undefined, new Site([device], undefined, undefined, [source, mirror]));

    const body = await (await app.request("/api/devices/relay/events")).json() as { events: unknown[] };

    expect(body.events).toHaveLength(1);
  });

  test("the events page and API aggregate every device and service once, filtered at the source", async () => {
    const device = new SwitchDevice("relay", "Relay", new MemorySwitch("relay"));
    const source = new SubjectService();
    source.log.record("network_error", "Gateway could not find the relay", { subject: "relay", data: { what: "client lookup" } });
    source.log.record("started", "Gateway started");
    const mirror = new SubjectService("mqtt-broker");
    mirror.log.record("network_error", "Gateway could not find the relay", { subject: "relay", data: { what: "client lookup" } });
    const app = createApp(undefined, new Site([device], undefined, undefined, [source, mirror]));
    expect((await app.request("/api/switches/relay/turn-on", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(200);

    const body = await (await app.request("/api/events")).json();
    expect(validators.eventsResponse(body)).toBe(true);
    expect(body.events.map((event: { type: string }) => event.type).sort()).toEqual(["availability_changed", "device_control", "network_error", "started"]);
    expect(body.subjects).toEqual(["relay"]);
    expect(body.events.map((event: { at: string }) => event.at)).toEqual(body.events.map((event: { at: string }) => event.at).toSorted().reverse());

    const where = encodeURIComponent(JSON.stringify({ path: "/type", op: "eq", value: "network_error" }));
    const filtered = await (await app.request(`/api/events?where=${where}`)).json();
    expect(filtered.events).toMatchObject([{ type: "network_error", subject: "relay" }]);

    const page = await app.request("/events");
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('data-events-path="/api/events"');
    expect(html).toContain('data-stream-path="/api/events/stream"');
    expect(html).toContain('id="saved-filter-form"');
    expect(html).toContain('value="relay"');
    expect(html).toContain('href="/events" aria-current="page"');
  });

  test("always probes the configured camera hosts during discovery", async () => {
    const { json, discoverRequests } = fixture();
    await json("/api/camera/discover", "POST");
    expect(discoverRequests[0]?.hosts).toEqual(["10.78.0.147"]);
    expect(discoverRequests[0]?.cidrs).toBeUndefined();
  });

  test("reports every device's availability through the device list contract", async () => {
    const { json } = fixture();
    const before = await json("/api/devices");
    expect(before.status).toBe(200);
    expect(before.headers.get("cache-control")).toBe("no-store");
    const beforeBody: unknown = await before.json();
    expect(validators.deviceListResponse(beforeBody)).toBe(true);
    expect((beforeBody as { devices: { id: string; availability: string }[] }).devices.map((device) => [device.id, device.availability]))
      .toEqual([["kitchen", "offline"], ["relay", "online"], ["dead", "online"]]);

    await json("/api/camera/discover", "POST");
    const afterBody = await (await json("/api/devices")).json() as { devices: { id: string; availability: string; detail?: string }[] };
    expect(afterBody.devices[0]).toMatchObject({ id: "kitchen", availability: "online", detail: "Pet 3T" });
  });

  test("a camera with no network host keeps /api/devices valid", async () => {
    const devices = [
      new SwitchDevice("relay", "Relay", new MemorySwitch("relay")),
      new TactacamReveal({ id: "reveal", name: "REVEAL" }, { cameraId: "camera-1" }),
    ];
    const app = createApp(undefined, new Site(devices));
    const response = await app.request("/api/devices");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(validators.deviceListResponse(body)).toBe(true);
    expect(body.devices).toHaveLength(2);
    expect(body.devices[1]).toMatchObject({ id: "reveal", host: "", availability: "unknown" });
  });

  test("a device read finishing after shutdown does not publish to the closed broker", async () => {
    const reading = Promise.withResolvers<void>();
    const state = Promise.withResolvers<BinarySwitchState>();
    class PendingSwitch extends MemorySwitch {
      override async getState(): Promise<BinarySwitchState> {
        reading.resolve();
        return state.promise;
      }
    }
    let brokerClosed = false;
    const publications: ServiceEvent[] = [];
    const errors: unknown[] = [];
    const forwarder = new EventBusForwarder({
      async publishEvent(event) {
        if (brokerClosed) throw new Error("mqemitter is closed");
        publications.push(event);
      },
    }, (error) => errors.push(error));
    const logs = new DeviceEventLogs(200, undefined, forwarder.publish);
    const app = createApp(undefined, new Site([
      new SwitchDevice("relay", "Relay", new PendingSwitch("relay")),
    ]), undefined, undefined, undefined, undefined, logs);
    const response = app.request("/api/devices");
    await reading.promise;
    await forwarder.stop();
    brokerClosed = true;
    state.resolve("off");
    expect((await response).status).toBe(200);
    expect(logs.recent("relay")[0]).toMatchObject({ type: "availability_changed", data: { current: "online" } });
    expect(publications).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("page and status reads leave offline devices alone; reconnect requires an explicit action", async () => {
    const relay = new OfflineUntilReconnectedSwitch("keylight");
    const device = new SwitchDevice("keylight", "Key Light", relay);
    const kicked: string[] = [];
    const lookedUp: string[] = [];
    const client = { mac: "02:00:00:79:a4:08", address: "169.254.18.41", fixedAddress: "10.77.0.228" };
    const adapter: NetworkAdapter = {
      name: "fake",
      wifi: {
        async findClientByMac(mac) { lookedUp.push(mac); return mac === client.mac ? client : undefined; },
        async findClientByAddress(address) { return address === client.fixedAddress ? client : undefined; },
        async kickClient(found) { kicked.push(found.mac); relay.online = true; },
      },
    };
    const recovery = new DeviceNetworkRecovery({
      adapter: () => adapter,
      logger: () => undefined,
    });
    const app = createApp(
      undefined,
      new Site([device], undefined, undefined, undefined, new Map([[device.id, client.mac]])),
      undefined,
      undefined,
      undefined,
      recovery,
    );

    const network = await app.request("/api/devices/keylight/network");
    expect(network.status).toBe(200);
    expect(await network.json()).toMatchObject({
      configuredMac: client.mac,
      configuredAddress: "10.77.0.228",
      currentAddress: "169.254.18.41",
      addressMatches: false,
    });

    for (const online of [false, true, false, true, false]) {
      relay.online = online;
      const [home, list, detail, state] = await Promise.all([
        app.request("/devices"), app.request("/api/devices"), app.request("/api/devices/keylight"), app.request("/api/switches/keylight"),
      ]);
      expect(home.status).toBe(200);
      expect(list.status).toBe(200);
      expect(detail.status).toBe(200);
      expect(state.status).toBe(200);
      expect(await list.json()).toMatchObject({ devices: [{ id: "keylight", availability: online ? "online" : "offline" }] });
    }
    expect(kicked).toEqual([]);
    expect(lookedUp).toEqual([client.mac]);

    const manual = await app.request("/api/devices/keylight/network/reconnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(manual.status).toBe(200);
    expect(await manual.json()).toMatchObject({
      deviceId: "keylight",
      address: "10.77.0.228",
      currentAddress: "169.254.18.41",
      mac: client.mac,
    });
    expect(kicked).toEqual([client.mac]);
    expect(lookedUp).toEqual([client.mac, client.mac]);
    expect(await (await app.request("/api/devices")).json()).toMatchObject({ devices: [{ id: "keylight", availability: "online" }] });
  });

  test("the reconnect route rejects unknown devices and servers without managed Wi-Fi", async () => {
    const { app, json } = fixture();
    expect((await json("/api/devices/nope/network/reconnect", "POST")).status).toBe(404);
    const unavailable = await json("/api/devices/relay/network/reconnect", "POST");
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toMatchObject({ error: { code: "not_supported" } });
  });

  test("failed Lutron zone reads never treat the shared bridge as managed Wi-Fi", async () => {
    const fan = new LutronCasetaSwitchDevice({ id: "fan", name: "Exhaust Fan" }, { host: "10.77.0.32", zone: 1 });
    const light = new LutronCasetaDimmerDevice({ id: "light", name: "Kitchen Lights" }, { host: "10.77.0.32", zone: 2 });
    const fanRead = spyOn(fan.switch, "getState").mockRejectedValue(new BinarySwitchError("Bridge unavailable", "unreachable"));
    const lightRead = spyOn(light.light, "getState").mockRejectedValue(new Error("Bridge unavailable"));
    const events: Record<string, unknown>[] = [];
    let networkLookups = 0;
    const recovery = new DeviceNetworkRecovery({
      adapter() { networkLookups++; throw new Error("A status read must not initialize the network adapter"); },
      logger: event => events.push(event),
    });
    const app = createApp(undefined, new Site([fan, light]), undefined, undefined, undefined, recovery);
    try {
      for (let load = 0; load < 5; load++) {
        const responses = await Promise.all(["/api/devices", "/api/devices/fan", "/api/devices/light", "/api/switches/fan", "/api/lights/light"].map(path => app.request(path)));
        expect(responses.every(response => response.status === 200)).toBe(true);
        expect(await responses[0]!.json()).toMatchObject({ devices: [{ id: "fan", availability: "offline" }, { id: "light", availability: "offline" }] });
      }
      expect(networkLookups).toBe(0);
      expect(events).toEqual([]);
    } finally {
      fanRead.mockRestore();
      lightRead.mockRestore();
    }
  });

  test("exposes turn-on, turn-off, toggle, and state for a switch as BinarySwitch documents", async () => {
    const { json } = fixture();
    const read = async (response: Response) => {
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(validators.binarySwitch(body)).toBe(true);
      return (body as { state: { value?: string } }).state.value;
    };
    expect(await read(await json("/api/switches/relay"))).toBe("off");
    expect(await read(await json("/api/switches/relay/turn-on", "POST"))).toBe("on");
    expect(await read(await json("/api/switches/relay/toggle", "POST"))).toBe("off");
    expect(await read(await json("/api/switches/relay/toggle", "POST"))).toBe("on");
    expect(await read(await json("/api/switches/relay/turn-off", "POST"))).toBe("off");
  });

  test("GET state reads a switch without a control event and supersedes POST getState", async () => {
    const { hub, json } = fixture();
    try {
      const response = await json("/api/switches/relay/state");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ availability: "online", value: "off", observedAt: expect.any(String) });
      expect(hub.snapshot(["device/relay"])[0]?.value).toMatchObject({ capabilities: { binarySwitch: { state: { value: "off" } } } });
      const events = await (await json("/api/devices/relay/events")).json();
      expect(JSON.stringify(events)).not.toContain('"type":"device_control"');
      for (const path of ["/api/devices/relay/controls/getState", "/api/devices/relay/controls/binarySwitch.getState", "/api/devices/relay/capabilities/binarySwitch/controls/getState"]) {
        expect((await json(path, "POST")).status).toBe(404);
      }
      expect((await json("/api/switches/missing/state")).status).toBe(404);
      expect((await json("/api/switches/kitchen/state")).status).toBe(404);
      expect((await json("/api/switches/relay/state", "POST")).status).toBe(404);
    } finally { hub.stop(); }
  });

  test("guards switch changes the same way as camera changes and maps switch errors", async () => {
    const { app, json } = fixture();
    const formPost = await app.request("/api/switches/relay/turn-on", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "on=1",
    });
    expect(formPost.status).toBe(415);

    const crossOrigin = await app.request("http://127.0.0.1/api/switches/relay/turn-on", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });
    expect(crossOrigin.status).toBe(403);

    const missing = await json("/api/switches/nope/toggle", "POST");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });

    const notASwitch = await json("/api/switches/kitchen");
    expect(notASwitch.status).toBe(404);

    const unreachable = await json("/api/switches/dead/turn-on", "POST");
    expect(unreachable.status).toBe(502);
    expect(await unreachable.json()).toMatchObject({ error: { code: "switch_unreachable" } });
  });

  test("enumerates the models and describes each device as model + config + object", async () => {
    const { app, json } = fixture();
    const models = await json("/api/models");
    expect(models.status).toBe(200);
    const modelsBody = await models.json() as { models: { id: string; capabilities: string[]; configSchema: { properties: Record<string, unknown> } }[] };
    expect(validators.modelListResponse(modelsBody)).toBe(true);
    expect(modelsBody.models.map((model) => [model.id, model.capabilities])).toEqual([
      ["bosch-nitp060uc", ["cooktop"]],
      ["cooktop-child-lock", ["binarySwitch"]],
      ["tkenpro-2k-pet-camera-treat-dispenser", ["camera", "treatDispenser", "motionSensor"]],
      ["shelly-plus-1", ["binarySwitch"]],
      ["lutron-caseta-switch", ["binarySwitch"]],
      ["lutron-caseta-dimmer", ["light"]],
      ["elgato-key-light-air", ["light"]],
      ["hue-entertainment-light", ["light"]],
      ["hue-light", ["light"]],
      ["hue-motion-sensor", ["sensor", "motionSensor"]],
      ["hue-switch", ["sensor"]],
      ["broadlink-rm4-pro", ["infraredBlaster", "radioFrequencyBlaster"]],
      ["esp32-nrf24-bridge", ["radioFrequencyReceiver"]],
      ["wyze-cam-v3", ["camera", "motionSensor"]],
      ["rtsp-camera", ["camera"]],
      ["tactacam-reveal", ["camera"]],
      ["sonos", ["speaker"]],
      ["sonos-group", ["speaker"]],
      ["samsung-frame", ["television"]],
      ["light-group", ["light"]],
      ["synthetic-switch", ["binarySwitch"]],
      ["action-button", ["button"]],
      ["workflow-button", ["button"]],
      ["optimistic-switch", ["binarySwitch"]],
      ["aqara-hub-m2", ["hub"]],
      ["aqara-presence-sensor-fp2", ["occupancySensor"]],
      ["aqara-door-window-sensor", ["contactSensor"]],
      ["ring-bridge", ["hub"]],
      ["ring-smart-light", ["light"]],
      ["airgradient-one", ["sensor"]],
      ["govee-h5075", []],
      ["govee-h7021", ["stringLight"]],
      ["govee-h7021-bulb", ["light"]],
    ]);
    expect(modelsBody.models.find((model) => model.id === "tkenpro-2k-pet-camera-treat-dispenser")?.configSchema.properties).toHaveProperty("serialNumber");

    const relay = await json("/api/devices/relay");
    expect(relay.status).toBe(200);
    const relayBody = await relay.json() as { model: { id: string; capabilities: string[] }; config: unknown; object: { status: string; capabilities: Record<string, unknown> } };
    expect(validators.deviceDetailResponse(relayBody)).toBe(true);
    expect(relayBody.model).toMatchObject({ id: "shelly-plus-1", title: "Shelly Plus 1", capabilities: ["binarySwitch"] });
    expect(relayBody.config).toEqual({ host: "10.77.0.228" });
    expect(relayBody.object.status).toBe("online");
    expect(Object.keys(relayBody.object.capabilities)).toEqual(["binarySwitch"]);

    await json("/api/camera/discover", "POST");
    const kitchen = await (await json("/api/devices/kitchen")).json() as { model: { id: string }; object: { status: string; model: string; capabilities: Record<string, unknown> } };
    expect(validators.petTreatDispenserCamera(kitchen.object)).toBe(true);
    expect(kitchen.model.id).toBe("tkenpro-2k-pet-camera-treat-dispenser");
    expect(kitchen.object).toMatchObject({ status: "online", model: "Pet 3T" });
    expect(Object.keys(kitchen.object.capabilities)).toEqual(["camera", "treatDispenser", "motionSensor"]);

    expect((await json("/api/devices/nope")).status).toBe(404);
  });

  test("invokes one control of one capability through the generic route", async () => {
    const { app, json } = fixture();
    const invoke = (path: string, body: unknown = {}) => app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const on = await invoke("/api/devices/relay/capabilities/binarySwitch/controls/turnOn");
    expect(on.status).toBe(200);
    const onBody = await on.json() as { object: { capabilities: { binarySwitch: { state: { value: string } } } } };
    expect(onBody.object.capabilities.binarySwitch.state.value).toBe("on");
    expect((await json("/api/switches/relay")).status).toBe(200);
    expect(((await (await json("/api/switches/relay")).json()) as { state: { value: string } }).state.value).toBe("on");

    const unknownControl = await invoke("/api/devices/relay/capabilities/binarySwitch/controls/explode");
    expect(unknownControl.status).toBe(404);
    expect(await unknownControl.json()).toMatchObject({ error: { code: "unknown_control" } });

    const noCapability = await invoke("/api/devices/relay/capabilities/light/controls/turnOn");
    expect(noCapability.status).toBe(404);
    expect(await noCapability.json()).toMatchObject({ error: { code: "no_such_capability" } });

    const badKind = await invoke("/api/devices/relay/capabilities/toaster/controls/turnOn");
    expect(badKind.status).toBe(404);

    const badBody = await invoke("/api/devices/relay/capabilities/binarySwitch/controls/turnOn", { confirmed: "yes" });
    expect(badBody.status).toBe(400);

    const noReboot = await invoke("/api/devices/relay/reboot");
    expect(noReboot.status).toBe(409);
  });

  test("invokes a control by its device-level name, qualified only when two capabilities share it", async () => {
    const { app, json } = fixture();
    const invoke = (path: string, body: unknown = {}) => app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const relay = await (await json("/api/devices/relay")).json() as { controls: string[] };
    expect(relay.controls).toEqual(["turnOn", "turnOff", "toggle"]);

    const on = await invoke("/api/devices/relay/controls/turnOn");
    expect(on.status).toBe(200);
    expect((await on.json() as { object: { capabilities: { binarySwitch: { state: { value: string } } } } }).object.capabilities.binarySwitch.state.value).toBe("on");
    const qualified = await invoke("/api/devices/relay/controls/binarySwitch.toggle");
    expect(qualified.status).toBe(200);
    expect((await qualified.json() as { object: { capabilities: { binarySwitch: { state: { value: string } } } } }).object.capabilities.binarySwitch.state.value).toBe("off");

    const unknown = await invoke("/api/devices/relay/controls/explode");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: "unknown_control" } });
    const wrongCapability = await invoke("/api/devices/relay/controls/light.turnOn");
    expect(wrongCapability.status).toBe(404);
    expect((await invoke("/api/devices/relay/controls/turnOn", { confirmed: "yes" })).status).toBe(400);
    expect((await invoke("/api/devices/nope/controls/turnOn")).status).toBe(404);
  });
});
