/** Public fiction: no installation inventory, real readings, or credentials. */
import type { DevicesConfig } from "../schemas";
import type { SceneDevicePresentation } from "../ui/scene-model";
import { createDemoSnapshot, type DemoSnapshot } from "./model";

const light = (id: string, name: string, room: string) => ({ id, name, room, model: "hue-light", config: { lightId: id, color: true, colorTemperature: true } });
const relay = (id: string, name: string, room: string) => ({ id, name, room, model: "shelly-plus-1", config: { host: `${id}.example.invalid` } });
const plug = (id: string, name: string) => ({ id, name, room: "Great room", model: "tplink-kasa-plug", config: { host: `${id}.example.invalid`, model: "KP115" } });
const camera = (id: string, name: string, room: string) => ({ id, name, room, model: "rtsp-camera", config: { host: `${id}.example.invalid`, path: "/synthetic" } });
const climate = (id: string, name: string, room: string, index: number) => ({ id, name, room, model: "govee-h5075", config: { peripheralId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` } });

/** Relay-driven fixtures are illustrated switches, not claims of native cover/fan support. */
export const FALLINGWATER_CONFIG: DevicesConfig = {
  schemaVersion: 2,
  rooms: ["Grounds", "Great room"],
  devices: [
    relay("waterfall", "Waterfall", "Grounds"),
    relay("gate", "Driveway gate", "Grounds"),
    relay("garage", "Garage door", "Grounds"),
    light("entry-light", "Entry lights", "Grounds"),
    light("garden-light", "Garden lights", "Grounds"),
    light("pool-light", "Pool lights", "Grounds"),
    { id: "irrigation-hub", name: "Irrigation hub", room: "Grounds", model: "rachio-controller", config: { deviceId: "synthetic-garden-controller" } },
    { id: "irrigation", name: "Sprinklers", room: "Grounds", model: "rachio-zone", config: { controller: "irrigation-hub", zoneNumber: 1, defaultMinutes: 10 } },
    camera("gate-camera", "Gate camera", "Grounds"),
    camera("entry-camera", "Entry camera", "Grounds"),
    { id: "entry-motion", name: "Entry motion", room: "Grounds", model: "hue-motion-sensor", config: { deviceId: "synthetic-entry-motion" } },
    { id: "solar", name: "Solar power", room: "Grounds", model: "enphase-envoy", config: { host: "solar.example.invalid" } },
    { id: "energy", name: "Energy meter", room: "Grounds", model: "tplink-kasa-energy-meter", config: { plug: "kettle" } },
    climate("outdoor-climate", "Outdoor climate", "Grounds", 1),
    light("pendant", "Pendant lights", "Great room"),
    light("floor-lamp", "Floor lamp", "Great room"),
    light("accent", "Accent lighting", "Great room"),
    plug("fan", "Ceiling fan"),
    plug("purifier", "Air purifier"),
    relay("blinds", "Window blinds", "Great room"),
    { id: "television", name: "Television", room: "Great room", model: "samsung-frame", config: { host: "television.example.invalid" } },
    { id: "speakers", name: "Speakers", room: "Great room", model: "sonos", config: { host: "speakers.example.invalid" } },
    plug("turntable", "Turntable"),
    { id: "vacuum-start", name: "Vacuum clean", room: "Great room", model: "roborock-vacuum-action", config: { vacuum: "vacuum", action: "start" } },
    { id: "vacuum-dock", name: "Vacuum dock", room: "Great room", model: "roborock-vacuum-action", config: { vacuum: "vacuum", action: "dock" } },
    { id: "vacuum", name: "Robot vacuum", room: "Great room", model: "roborock-vacuum", config: { host: "vacuum.example.invalid", duid: "SYNTHETICROBOT001" } },
    climate("room-climate", "Temperature & humidity", "Great room", 2),
    { id: "air-quality", name: "Air quality", room: "Great room", model: "airgradient-one", config: { host: "air-quality.example.invalid" } },
    { id: "presence", name: "Presence", room: "Great room", model: "aqara-presence-sensor-fp2", config: { host: "presence.example.invalid", port: 51826, homekitId: "02:00:00:00:00:01" } },
    { id: "window", name: "Window sensor", room: "Great room", model: "aqara-door-window-sensor", config: { hub: "sensor-hub", serialNumber: "SYNTHETIC-WINDOW-001" } },
    plug("coffee", "Coffee machine"),
    plug("kettle", "Kettle"),
    { id: "cooktop", name: "Cooktop lock", room: "Great room", model: "bosch-nitp060uc", config: { host: "cooktop.example.invalid" } },
    { id: "pet-camera", name: "Pet feeder", room: "Great room", model: "tkenpro-2k-pet-camera-treat-dispenser", config: { host: "pet-camera.example.invalid" } },
    { id: "sensor-hub", name: "Sensor bridge", room: "Great room", model: "aqara-hub-m2", config: { matterPeerId: "peer1" } },
    plug("pet-fountain", "Pet fountain"),
  ],
  deviceGroups: [
    { id: "all-lights", name: "All lights", asSwitch: true, criteria: { schemaId: "https://hometruth.ai/schemas/light" } },
    { id: "room-lights", name: "Room lights", room: "Great room", asSwitch: true, criteria: { room: "Great room", schemaId: "https://hometruth.ai/schemas/light" } },
  ],
};

export function createFallingwaterSnapshot(options: { basePath?: string } = {}): DemoSnapshot {
  const snapshot = createDemoSnapshot(FALLINGWATER_CONFIG, { ...options, includeNames: true });
  const entries = FALLINGWATER_CONFIG.devices!;
  const idOf = (id: string) => snapshot.devices[entries.findIndex(entry => entry.id === id)]!.id;
  const objectOf = (id: string) => snapshot.records.find(record => record.node === `device/${idOf(id)}`)!.value as any;
  const setState = (id: string, kind: string, values: Record<string, unknown>) => Object.assign(objectOf(id).capabilities[kind].state, values);
  for (const id of ["waterfall", "fan", "purifier", "pet-fountain"]) setState(id, "binarySwitch", { value: "on" });
  setState("television", "television", { power: "on", volumePercent: 18 });
  setState("speakers", "speaker", { playback: "paused", volumePercent: 30 });
  setState("presence", "occupancySensor", { occupied: true });
  for (const [id, temperature, humidity] of [["outdoor-climate", 26.2, 65], ["room-climate", 23.4, 51]] as const) {
    for (const sensor of objectOf(id).sensors ?? []) sensor.state.value = sensor.id === "temperature" ? temperature : sensor.id === "humidity" ? humidity : 93;
  }
  const readings = (id: string, values: { id: string; name: string; quantity: string; value: number; unit: string }[], detail?: string) => setState(id, "sensor", { sensors: values.map(value => ({ ...value, availability: "online", observedAt: snapshot.records[0]!.observedAt })), ...(detail ? { detail } : {}) });
  readings("irrigation-hub", [], "Ready");
  readings("air-quality", [{ id: "co2", name: "CO₂", quantity: "carbonDioxide", value: 620, unit: "ppm" }, { id: "pm2-5", name: "PM2.5", quantity: "particulateMatter2.5", value: 4, unit: "µg/m³" }]);
  readings("solar", [{ id: "production", name: "Production", quantity: "power", value: 3.6, unit: "kW" }]);
  readings("energy", [{ id: "power", name: "Power", quantity: "power", value: 184, unit: "W" }]);
  readings("vacuum", [{ id: "battery", name: "Battery", quantity: "battery", value: 88, unit: "%" }], "Docked");
  const bindings: Record<string, Partial<SceneDevicePresentation>> = {
    waterfall: { icon: "water", effect: "waterfall" }, gate: { icon: "gate", effect: "gate", onLabel: "Open", offLabel: "Closed" },
    garage: { icon: "garage", onLabel: "Open", offLabel: "Closed" }, fan: { icon: "fan", effect: "fan" },
    blinds: { icon: "blinds", effect: "blinds", onLabel: "Open", offLabel: "Closed" }, television: { icon: "tv", effect: "television" },
    purifier: { icon: "air" }, speakers: { icon: "speaker" }, turntable: { icon: "record" },
    "vacuum-start": { icon: "vacuum", effect: "vacuum-start", target: idOf("vacuum") },
    "vacuum-dock": { icon: "dock", effect: "vacuum-dock", target: idOf("vacuum") },
    vacuum: { icon: "vacuum" }, coffee: { icon: "coffee" }, kettle: { icon: "kettle" },
    cooktop: { icon: "cooktop" }, "pet-camera": { icon: "pet" }, "pet-fountain": { icon: "water" },
  };
  snapshot.presentation = { devices: Object.fromEntries(snapshot.devices.map((device, index) => [device.id, { scene: device.room === "Grounds" ? "house" : "room", icon: device.capabilities.includes("light") ? "light" : device.capabilities.includes("camera") ? "camera" : device.capabilities.includes("sensor") || device.sensors?.length ? "sensor" : "switch", ...bindings[entries[index]!.id] }])) };
  snapshot.homePath = "/";
  return snapshot;
}
