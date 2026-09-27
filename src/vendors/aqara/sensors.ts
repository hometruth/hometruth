import { OccupancySensor, ContactSensor, Hub, type OccupancyDocument, type ContactDocument, type HubDocument } from "../../models/sensors";
import { accessoryInfo, batteryPercent, binary, characteristic, hapType, sensorAvailable } from "../../protocols/homekit/snapshot";
import type { AqaraSource } from "./connection";
import { matterAccessories, matterValue } from "../../protocols/matter/snapshot";

export class AqaraOccupancy extends OccupancySensor {
  constructor(id: string, private readonly source: AqaraSource) { super(id); }
  async getState(): Promise<OccupancyDocument["state"]> {
    const connection = await this.source.read();
    if (connection.availability !== "online") return connection;
    if ("matter" in connection) return { availability: "degraded", detail: "FP2 requires its direct HomeKit connection" };
    const { snapshot } = connection;
    const zones = snapshot.accessories.flatMap((accessory) => accessory.services.filter((s) => hapType(s.type) === "86").map((s) => {
      const occupied = sensorAvailable(s) ? binary(characteristic(s, "71")) : undefined;
      const name = characteristic(s, "23");
      return {
        id: `${accessory.aid}.${s.iid}`,
        name: typeof name === "string" ? name : accessoryInfo(accessory).name ?? `Zone ${s.iid}`,
        availability: occupied === undefined ? "unknown" as const : "online" as const,
        ...(occupied !== undefined ? { occupied } : {}),
      };
    }));
    if (!zones.length) return { availability: "degraded", detail: "No occupancy sensors exposed by this accessory" };
    const complete = zones.every((z) => z.occupied !== undefined);
    // An unavailable zone can never make the room appear empty.
    const occupied = zones.some((z) => z.occupied === true) ? true : complete ? false : undefined;
    const light = snapshot.accessories.flatMap((a) => a.services).filter((s) => hapType(s.type) === "84" && sensorAvailable(s)).map((s) => characteristic(s, "6B"))
      .find((v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0);
    return {
      availability: complete ? "online" : "degraded", observedAt: snapshot.observedAt, zones,
      ...(occupied !== undefined ? { occupied } : {}), ...(light !== undefined ? { illuminanceLux: light } : {}),
      ...(!complete ? { detail: "One or more zones are unavailable" } : {}),
    };
  }
}

export class AqaraContact extends ContactSensor {
  constructor(id: string, private readonly source: AqaraSource, readonly serialNumber: string) { super(id); }
  async getState(): Promise<ContactDocument["state"]> {
    const connection = await this.source.read();
    if (connection.availability !== "online") return connection;
    if ("matter" in connection) {
      const { matter } = connection;
      const matches = matterAccessories(matter).filter(a => a.serialNumber?.toLowerCase() === this.serialNumber.toLowerCase());
      if (matches.length !== 1) return { availability: "degraded", detail: "Contact sensor not uniquely identified on the hub" };
      const endpoint = Number(matches[0]!.id);
      const closed = matterValue(matter, endpoint, 0x45, 0);
      if (matterValue(matter, endpoint, 0x39, 17) !== true || typeof closed !== "boolean") {
        return { availability: "degraded", detail: "Contact sensor reading unavailable" };
      }
      // Matter Contact Sensor: Boolean State true means closed; battery is in half-percent units.
      const battery = matterValue(matter, endpoint, 0x2f, 12);
      return { availability: "online", open: !closed, observedAt: matter.observedAt,
        ...(typeof battery === "number" && Number.isInteger(battery) && battery >= 0 && battery <= 200 ? { batteryPercent: battery / 2 } : {}) };
    }
    const { snapshot } = connection;
    const matches = snapshot.accessories.filter((a) => accessoryInfo(a).serialNumber?.toLowerCase() === this.serialNumber.toLowerCase());
    if (matches.length !== 1) return { availability: "degraded", detail: "Contact sensor not uniquely identified on the hub" };
    const accessory = matches[0]!;
    const services = accessory.services.filter((s) => hapType(s.type) === "80");
    if (services.length !== 1) return { availability: "degraded", detail: "Contact sensor service not uniquely identified" };
    const sensor = services[0]!;
    const open = sensorAvailable(sensor) ? binary(characteristic(sensor, "6A")) : undefined;
    if (open === undefined) return { availability: "degraded", detail: "Contact sensor reading unavailable" };
    const battery = batteryPercent(accessory);
    const tampered = binary(characteristic(sensor, "7A"));
    return {
      availability: "online", open, observedAt: snapshot.observedAt,
      ...(battery !== undefined ? { batteryPercent: battery } : {}), ...(tampered !== undefined ? { tampered } : {}),
    };
  }
}

export interface DiscoveredContactSensor { serialNumber: string; name: string; model?: string }

/** Bridged accessories the hub already reports as contact sensors, regardless of whether HomeTruth has a device for them yet. */
export async function discoverContactSensors(source: AqaraSource): Promise<DiscoveredContactSensor[]> {
  const connection = await source.read();
  if (connection.availability !== "online") return [];
  if ("matter" in connection) {
    const { matter } = connection;
    return matterAccessories(matter)
      .filter((accessory) => matter.attributes.some((a) => a.endpoint === Number(accessory.id) && a.cluster === 0x45))
      .flatMap((accessory) => accessory.serialNumber ? [{ serialNumber: accessory.serialNumber, name: accessory.name, ...(accessory.model ? { model: accessory.model } : {}) }] : []);
  }
  const { snapshot } = connection;
  return snapshot.accessories
    .flatMap((a) => {
      const contact = a.services.find((s) => hapType(s.type) === "80");
      if (a.aid === 1 || !contact) return [];
      const info = accessoryInfo(a);
      if (!info.serialNumber) return [];
      // Aqara leaves the accessory-level Name as the generic product name; the contact service's own Name carries the room-assigned one.
      const serviceName = characteristic(contact, "23");
      const name = typeof serviceName === "string" ? serviceName : info.name ?? `Accessory ${a.aid}`;
      return [{ serialNumber: info.serialNumber, name, ...(info.model ? { model: info.model } : {}) }];
    });
}

export class AqaraHubStatus extends Hub {
  constructor(id: string, private readonly source: AqaraSource) { super(id); }
  async getState(): Promise<HubDocument["state"]> {
    const connection = await this.source.read();
    if (connection.availability !== "online") return connection;
    if ("matter" in connection) return { availability: "online", observedAt: connection.matter.observedAt, accessories: matterAccessories(connection.matter) };
    const { snapshot } = connection;
    const accessories = snapshot.accessories.filter((a) => a.aid !== 1).map((a) => {
      const info = accessoryInfo(a);
      return { id: String(a.aid), name: info.name ?? `Accessory ${a.aid}`, ...(info.model ? { model: info.model } : {}), ...(info.serialNumber ? { serialNumber: info.serialNumber } : {}) };
    });
    const security = snapshot.accessories.find((a) => a.aid === 1)?.services.find((s) => hapType(s.type) === "7E");
    const mode = security ? characteristic(security, "66") : undefined;
    const securityState = typeof mode === "number" ? (["stay", "away", "night", "disarmed", "triggered"] as const)[mode] : undefined;
    return { availability: "online", observedAt: snapshot.observedAt, accessories, ...(securityState ? { securityState } : {}) };
  }
}
