import { describe, expect, test } from "bun:test";
import { SHELLY_PLUS_1 } from "./devices/switches/shelly-plus-1";
import { TkenproPet3T, type TkenproCameraLink } from "./devices/treat-dispensers/tkenpro-2k-pet-camera-treat-dispenser";
import type { Availability } from "./models/capability";
import { BinarySwitch, type BinarySwitchState } from "./models/binary-switch";
import { Device, type DeviceIdentity } from "./models/device";
import { EventLog, type ServiceEvent } from "./models/event-log";
import { Service, type ServiceStatus } from "./models/service";
import { MODELS } from "./registry";
import { binarySwitchSchema, petTreatDispenserCameraSchema } from "./schemas";
import { Site, devicePagePath, summaryDetail } from "./site";
import type { CameraDashboardModel, CameraDeviceView } from "./ui/dashboard";
import { validators } from "./validation";

class MemorySwitch extends BinarySwitch {
  constructor(id: string, private state: BinarySwitchState = "off", private readonly broken = false) {
    super(id);
  }
  async turnOn(): Promise<void> { this.state = "on"; }
  async turnOff(): Promise<void> { this.state = "off"; }
  async toggle(): Promise<void> { this.state = this.state === "on" ? "off" : "on"; }
  async getState(): Promise<BinarySwitchState> {
    if (this.broken) throw new Error("no link");
    return this.state;
  }
}

class SwitchDevice extends Device<{ host: string }> {
  readonly model = SHELLY_PLUS_1;
  readonly capabilities;
  constructor(id: string, name: string, relay: BinarySwitch, host = "10.77.0.228") {
    super(id, name, { host });
    this.capabilities = { binarySwitch: relay };
  }
  async probe(): Promise<DeviceIdentity> { return {}; }
}

function cameraView(overrides: Partial<CameraDeviceView>): CameraDeviceView {
  return {
    id: "100000001",
    name: "100000001",
    host: "10.78.0.147",
    model: "Pet 3T",
    firmware: "5.7.3",
    status: "online",
    stream: "available",
    snapshot: "available",
    capabilities: [],
    ...overrides,
  };
}

/** A camera link whose discovered devices are whatever the test says. */
function cameraLink(views: CameraDeviceView[]): TkenproCameraLink {
  const model: CameraDashboardModel = {
    setup: { configured: false, profile: null },
    discovery: { status: "idle" },
    devices: views,
    selectedDeviceId: views[0]?.id ?? null,
  };
  return {
    state: () => model,
    async control() { return undefined; },
    async ptz() { return undefined; },
    async rebootCamera() { return undefined; },
  };
}

function site(views: CameraDeviceView[] = []): { site: Site } {
  return {
    site: new Site([
      new TkenproPet3T({ id: "kitchen", name: "Kitchen pet camera" }, { host: "10.78.0.147" }, cameraLink(views)),
      new SwitchDevice("relay", "Porch relay", new MemorySwitch("relay", "on")),
      new SwitchDevice("shed", "shed", new MemorySwitch("shed", "off", true), "10.77.0.229"),
    ]),
  };
}

describe("Site", () => {
  test("provisions room metadata and combines saved rooms with device assignments", () => {
    const site = Site.fromConfig({ schemaVersion: 2, rooms: ["Empty Room", "Kitchen"], devices: [
      { id: "relay", model: "shelly-plus-1", room: "Kitchen", config: { host: "10.77.0.2" } },
      { id: "relay2", model: "shelly-plus-1", room: "Office", config: { host: "10.77.0.3" } },
    ] });
    expect(site.rooms).toEqual(["Empty Room", "Kitchen", "Office"]);
    expect(site.get("relay")?.room).toBe("Kitchen");
    expect(site.list()[1]?.room).toBe("Office");
  });

  test("keeps the configured MAC as stable network identity", () => {
    const home = Site.fromConfig({
      schemaVersion: 2,
      devices: [{
        id: "relay",
        mac: "AA:BB:CC:DD:EE:FF",
        model: "shelly-plus-1",
        config: { host: "10.77.0.228" },
      }],
    }, {}, undefined, [SHELLY_PLUS_1]);
    expect(home.macAddressOf("relay")).toBe("aa:bb:cc:dd:ee:ff");
  });

  test("lists every device with its model, capabilities, page, and object schema", async () => {
    const { site: home } = site();
    expect(home.list().map((device) => [device.id, device.kind, device.model, device.capabilities, device.page, device.schemaId])).toEqual([
      ["kitchen", "pet-camera", "tkenpro-2k-pet-camera-treat-dispenser", ["camera", "treatDispenser", "motionSensor"], "/cameras/kitchen-pet-camera", petTreatDispenserCameraSchema.$id],
      ["relay", "binary-switch", "shelly-plus-1", ["binarySwitch"], "/switches/porch-relay", binarySwitchSchema.$id],
      ["shed", "binary-switch", "shelly-plus-1", ["binarySwitch"], "/switches/shed", binarySwitchSchema.$id],
    ]);
    expect(home.list().map((device) => device.name)).toEqual(["Kitchen pet camera", "Porch relay", "shed"]);
    expect(devicePagePath("a b/c")).toBe("/devices/a%20b%2Fc");
    expect(home.view("missing")).toBeUndefined();
  });

  test("rejects two devices with one id", () => {
    expect(() => new Site([
      new SwitchDevice("same", "a", new MemorySwitch("same")),
      new SwitchDevice("same", "b", new MemorySwitch("same")),
    ])).toThrow(/more than once/u);
  });

  test("resolves devices by id and narrows them by class", async () => {
    const { site: home } = site();
    expect(home.get("relay")?.capability("binarySwitch")).toBeInstanceOf(BinarySwitch);
    expect(home.get("kitchen")?.capability("binarySwitch")).toBeUndefined();
    expect(home.as("kitchen", TkenproPet3T)).toBeInstanceOf(TkenproPet3T);
    expect(home.as("relay", TkenproPet3T)).toBeUndefined();
    expect(home.ofModel(TkenproPet3T).map((device) => device.id)).toEqual(["kitchen"]);
  });

  test("enumerates every model with its config schema", async () => {
    const { site: home } = site();
    const models = home.modelList();
    expect(validators.modelListResponse(models)).toBe(true);
    expect(models.models.map((model) => [model.id, model.capabilities])).toEqual(
      MODELS.map((model) => [model.id, [...model.capabilities]]),
    );
    expect(models.models.every((model) => model.connectionTypes.length > 0)).toBe(true);
    expect(models.models.find((model) => model.id === "airgradient-one")?.connectionTypes).toEqual(["direct-local"]);
    expect(models.models[0]?.configSchema).toHaveProperty("properties.host");
  });

  test("matches a configured camera to the discovered device at its host, preferring online", async () => {
    const { site: home } = site([
      cameraView({ id: "meari-local-1", name: "Local pet camera", status: "offline", capabilities: [] }),
      cameraView({ id: "100000001" }),
      cameraView({ id: "other", host: "10.78.0.64" }),
    ]);
    const camera = home.as("kitchen", TkenproPet3T)!;
    expect(camera.view()?.id).toBe("100000001");
    const page = camera.pageModel();
    expect(page.devices.map((device) => device.id)).toEqual(["100000001"]);
    expect(page.devices[0]?.name).toBe("Kitchen pet camera");
    expect(page.selectedDeviceId).toBe("100000001");
    expect(validators.cameraDashboardModel(page)).toBe(true);

    const object = await camera.describe();
    expect(validators.petTreatDispenserCamera(object)).toBe(true);
    expect(object).toMatchObject({ status: "online", model: "Pet 3T", firmwareVersion: "5.7.3", serialNumber: "100000001" });
  });

  test("shows an undiscovered camera as offline on its own page without inventing controls", async () => {
    const { site: home } = site();
    const page = home.as("kitchen", TkenproPet3T)!.pageModel();
    expect(page.devices).toHaveLength(1);
    expect(page.devices[0]).toMatchObject({ id: "kitchen", name: "Kitchen pet camera", host: "10.78.0.147", status: "offline" });
    expect(page.selectedDeviceId).toBe("kitchen");
    expect(validators.cameraDashboardModel(page)).toBe(true);
  });

  test("summarizes every device from its own document", async () => {
    const before = await site().site.summaries();
    expect(validators.deviceListResponse(before)).toBe(true);
    expect(before.devices.map((device) => [device.id, device.availability, device.detail])).toEqual([
      ["kitchen", "offline", "Not discovered yet"],
      ["relay", "online", "On"],
      ["shed", "offline", "Not reachable"],
    ]);
    const after = await site([cameraView({})]).site.summaries();
    expect(after.devices[0]).toMatchObject({ id: "kitchen", availability: "online", detail: "Pet 3T, firmware 5.7.3", model: "tkenpro-2k-pet-camera-treat-dispenser" });
  });

  test("a device without a network host does not break the whole device list", async () => {
    const result = await new Site([
      new SwitchDevice("virtual", "Virtual relay", new MemorySwitch("virtual"), ""),
    ]).summaries();
    expect(validators.deviceListResponse(result)).toBe(true);
    expect(result.devices[0]).toMatchObject({ id: "virtual", host: "", availability: "online" });
  });

  test("summaryDetail reads each capability's state", () => {
    const base = { schemaVersion: 1 as const, id: "x", name: "x", status: "online" as const, capabilities: {} };
    expect(summaryDetail({ ...base, capabilities: { light: { id: "l", state: { availability: "online", on: true, brightnessPercent: 40, colorTemperatureKelvin: 4000 }, actions: {} } } } as never)).toBe("On · 40% · 4000K");
    expect(summaryDetail({ ...base, capabilities: { infraredBlaster: { id: "i", state: { availability: "online" }, channels: [], actions: {} } } } as never)).toBe("Ready");
  });
});

class FakeService extends Service {
  private readonly log = new EventLog();
  private availability: Availability = "online";

  constructor(id: string, title: string) {
    super(id, title);
    this.log.record("started", `${title} started`);
  }

  setOffline(): void {
    this.availability = "offline";
  }

  publish(type: string, message: string): void {
    this.log.record(type, message, type === "client_connected" ? { data: { clientId: "cam" } } : {});
  }

  override status(): ServiceStatus {
    return { availability: this.availability, detail: this.availability === "online" ? "Running" : "Stopped" };
  }

  override events(limit?: number): readonly ServiceEvent[] {
    return this.log.recent(limit);
  }

  override subscribe(listener: (event: ServiceEvent) => void): () => void {
    return this.log.subscribe(listener);
  }
}

describe("Site services", () => {
  test("lists a service passed in via SiteServices, with its status and page", () => {
    const service = new FakeService("mqtt-broker", "MQTT broker");
    const registered = new Site([], MODELS, new Map(), [service]);
    expect(registered.listServices()).toEqual([{ id: "mqtt-broker", title: "MQTT broker", health: { status: "unknown", detail: "Not checked yet", checkedAt: null }, availability: "online", detail: "Running", page: "/services/mqtt-broker", actions: [], endpoints: [] }]);
    service.setOffline();
    expect(registered.listServices()[0]).toMatchObject({ availability: "offline", detail: "Stopped" });
  });

  test("getService and serviceEvents resolve by id; an unknown id is undefined", () => {
    const service = new FakeService("mqtt-broker", "MQTT broker");
    service.publish("client_connected", 'Client "cam" connected');
    const registered = new Site([], MODELS, new Map(), [service]);
    expect(registered.getService("mqtt-broker")).toBe(service);
    expect(registered.getService("nope")).toBeUndefined();
    expect(registered.serviceEvents("mqtt-broker")?.map((event) => event.type)).toEqual(["client_connected", "started"]);
    expect(registered.serviceEvents("mqtt-broker", 1)).toHaveLength(1);
    expect(registered.serviceEvents("nope")).toBeUndefined();
  });

  test("Site.fromConfig picks Service instances out of a SiteServices bag and ignores non-Service values", () => {
    const service = new FakeService("mqtt-broker", "MQTT broker");
    const built = Site.fromConfig({ schemaVersion: 2, devices: [] }, { mqttBroker: service as never, tkenpro: { cameraService: {} as never } });
    expect(built.services).toEqual([service]);
  });

  test("a site with no services returns an empty list", () => {
    expect(site().site.listServices()).toEqual([]);
  });
});
