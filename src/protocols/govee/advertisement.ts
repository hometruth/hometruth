export interface GoveeMeasurement {
  temperatureC?: number;
  humidityPercent?: number;
  batteryPercent: number;
  sensorError: boolean;
}

/** CoreBluetooth includes the little-endian manufacturer ID in these eight bytes.
 * Wire format: https://github.com/Heckie75/govee-h5075-thermo-hygrometer/blob/main/API.md
 * Error flag: https://github.com/Bluetooth-Devices/govee-ble/blob/main/src/govee_ble/parser.py
 */
export function decodeH5075(data: Uint8Array): GoveeMeasurement | undefined {
  // CoreBluetooth can concatenate the scan response with the 25-byte
  // INTELLI_ROCKS iBeacon payload. Accept that observed variant explicitly.
  if (data.length === 33 && Buffer.from(data.subarray(8, 12)).equals(Buffer.from("4c000215", "hex"))
    && Buffer.from(data.subarray(12, 25)).toString("ascii") === "INTELLI_ROCKS") data = data.subarray(0, 8);
  if (data.length !== 8 || data[0] !== 0x88 || data[1] !== 0xec) return undefined;
  const packed = (data[3]! << 16) | (data[4]! << 8) | data[5]!;
  const magnitude = packed & 0x7fffff;
  const temperatureC = Math.trunc(magnitude / 1000) / 10 * (packed & 0x800000 ? -1 : 1);
  const humidityPercent = (magnitude % 1000) / 10;
  const batteryPercent = data[6]! & 0x7f;
  if (batteryPercent > 100) return undefined;
  const sensorError = !!(data[6]! & 0x80) || temperatureC < -40 || temperatureC > 100;
  return { batteryPercent, sensorError, ...(!sensorError ? { temperatureC, humidityPercent } : {}) };
}

export const H5075_NAME_PATTERN = "^(GV|Govee_)H5075_[0-9A-Fa-f]{4}$";
export const PERIPHERAL_ID_PATTERN = "^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$";

export interface GoveeAdvertisement extends GoveeMeasurement {
  peripheralId: string;
  name: string;
  rssi?: number;
  receivedAt: number;
}

export function parseH5075Advertisement(value: unknown, receivedAt: number): GoveeAdvertisement | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  if (data.type !== "advertisement" || typeof data.name !== "string" || !new RegExp(H5075_NAME_PATTERN).test(data.name)
    || typeof data.peripheralId !== "string" || !new RegExp(PERIPHERAL_ID_PATTERN).test(data.peripheralId)
    || typeof data.manufacturerData !== "string" || !/^(?:[0-9a-f]{16}|[0-9a-f]{66})$/iu.test(data.manufacturerData)
    || !Number.isFinite(receivedAt)) return undefined;
  const measurement = decodeH5075(Buffer.from(data.manufacturerData, "hex"));
  if (!measurement) return undefined;
  return { ...measurement, peripheralId: data.peripheralId.toUpperCase(), name: data.name, receivedAt,
    ...(typeof data.rssi === "number" && Number.isInteger(data.rssi) && data.rssi >= -127 && data.rssi <= 20 ? { rssi: data.rssi } : {}) };
}
