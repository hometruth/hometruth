import type { FromSchema } from "json-schema-to-ts";
import { Capability } from "./capability";
import { sensorCollectionSchema, occupancySensorSchema, contactSensorSchema, hubSchema } from "./sensor-schemas";
import { validators } from "../validation";

export type OccupancyDocument = FromSchema<typeof occupancySensorSchema>;
export type ContactDocument = FromSchema<typeof contactSensorSchema>;
export type HubDocument = FromSchema<typeof hubSchema>;
export type SensorCollectionDocument = FromSchema<typeof sensorCollectionSchema>;
export type SensorCollectionState = SensorCollectionDocument["state"];
export type SensorCollectionReading = SensorCollectionState["sensors"][number];

/** Presence, contact, and hub status are observations; getState never changes hardware. */
abstract class ReadOnlySensor<T extends { id: string; state: unknown; actions: unknown }> extends Capability<T> {
  readonly controlIds = ["getState"] as const;
  readonly methods = ["getState"] as const;
  abstract getState(): Promise<T["state"]>;
  protected abstract valid(value: unknown): boolean;
  override async describe(): Promise<T> {
    const result = { id: this.id, state: await this.getState(), actions: {} };
    if (!this.valid(result)) throw new Error(`Invalid ${this.kind} observation`);
    return result as T;
  }
  override async invoke(controlId: string): Promise<unknown> {
    if (controlId !== "getState") return this.unknownControl(controlId);
    return this.getState();
  }
}

/** A collection of named measurements belonging to one physical device. */
export abstract class SensorCollection extends ReadOnlySensor<SensorCollectionDocument> {
  readonly kind = "sensor" as const;
  /** Identities known from the model, independent of readings or connectivity. */
  readonly inventory: readonly { readonly id: string; readonly name: string }[] = [];
  protected valid(value: unknown): boolean { return validators.sensorCollection(value); }
}

export abstract class OccupancySensor extends ReadOnlySensor<OccupancyDocument> {
  readonly kind = "occupancySensor" as const;
  protected valid(value: unknown): boolean { return validators.occupancySensor(value); }
}
export abstract class ContactSensor extends ReadOnlySensor<ContactDocument> {
  readonly kind = "contactSensor" as const;
  protected valid(value: unknown): boolean { return validators.contactSensor(value); }
}
export abstract class Hub extends ReadOnlySensor<HubDocument> {
  readonly kind = "hub" as const;
  protected valid(value: unknown): boolean { return validators.hub(value); }
}
