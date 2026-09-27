import type { FromSchema } from "json-schema-to-ts";
import { batterySensorSchema, humiditySensorSchema, temperatureSensorSchema, sensorDefinition, sensorSchema } from "./sensor-schemas";
import { describeValidationErrors, validators } from "../validation";

export type SensorDefinition = FromSchema<typeof sensorDefinition>;
export type TemperatureSensorDocument = FromSchema<typeof temperatureSensorSchema>;
export type HumiditySensorDocument = FromSchema<typeof humiditySensorSchema>;
export type BatterySensorDocument = FromSchema<typeof batterySensorSchema>;
export type SensorDocument = FromSchema<typeof sensorSchema, { references: [typeof temperatureSensorSchema, typeof humiditySensorSchema, typeof batterySensorSchema] }>;
export type SensorState = SensorDocument["state"];

/** A single observation source. A device owns as many instances of each type as it needs. */
export abstract class Sensor<Doc extends SensorDocument = SensorDocument> {
  abstract readonly schemaId: Doc["schemaId"];
  abstract readonly kind: Doc["kind"];
  abstract readonly unit: Doc["unit"];

  constructor(readonly id: string, readonly name: string) {}
  abstract getState(): Promise<Doc["state"]>;

  async describe(): Promise<Doc> {
    const document = { id: this.id, name: this.name, schemaId: this.schemaId, kind: this.kind, unit: this.unit, state: await this.getState() };
    if (!validators.sensor(document)) throw new Error(`Invalid sensor ${this.id}: ${describeValidationErrors(validators.sensor.errors)}`);
    return document as Doc;
  }
}

export abstract class TemperatureSensor extends Sensor<TemperatureSensorDocument> {
  readonly schemaId = temperatureSensorSchema.$id;
  readonly kind = "temperature" as const;
  readonly unit = "°C" as const;
}

export abstract class HumiditySensor extends Sensor<HumiditySensorDocument> {
  readonly schemaId = humiditySensorSchema.$id;
  readonly kind = "humidity" as const;
  readonly unit = "%" as const;
}

export abstract class BatterySensor extends Sensor<BatterySensorDocument> {
  readonly schemaId = batterySensorSchema.$id;
  readonly kind = "battery" as const;
  readonly unit = "%" as const;
}
