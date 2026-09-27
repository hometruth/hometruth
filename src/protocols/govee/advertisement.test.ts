import { describe, expect, test } from "bun:test";
import { decodeH5075, parseH5075Advertisement } from "./advertisement";

describe("Govee H5075 broadcasts", () => {
  test("decodes documented and captured CoreBluetooth packets, including concatenated iBeacon", () => {
    expect(decodeH5075(Buffer.from("88ec00037da96400", "hex"))).toEqual({ temperatureC: 22.8, humidityPercent: 77.7, batteryPercent: 100, sensorError: false });
    for (const hex of ["88ec000447996400", "88ec0004479964004c000215494e54454c4c495f524f434b535f48575075f2ff0c"]) {
      expect(decodeH5075(Buffer.from(hex, "hex"))).toEqual({ temperatureC: 28, humidityPercent: 47.3, batteryPercent: 100, sensorError: false });
    }
  });

  test("handles freezing temperatures, zero battery, and sensor errors without inventing values", () => {
    const packet = Buffer.from("88ec000000000000", "hex");
    packet.writeUIntBE(0x800000 | 54321, 3, 3);
    expect(decodeH5075(packet)).toEqual({ temperatureC: -5.4, humidityPercent: 32.1, batteryPercent: 0, sensorError: false });
    packet[6] = 0x80 | 75;
    expect(decodeH5075(packet)).toEqual({ batteryPercent: 75, sensorError: true });
    packet[6] = 100;
    packet.writeUIntBE(1_010_500, 3, 3);
    expect(decodeH5075(packet)).toEqual({ batteryPercent: 100, sensorError: true });
  });

  test("rejects truncated, unrelated, corrupt, and falsely named advertisements", () => {
    for (const hex of ["", "88ec", "88ec0004479964", "4c00000447996400", "88ec000447997f00", "88ec00044799640000", "88ec000447996400" + "00".repeat(25)]) {
      expect(decodeH5075(Buffer.from(hex, "hex"))).toBeUndefined();
    }
    const frame = { type: "advertisement", peripheralId: "00000000-0000-0000-0000-000000000001", name: "GVH5075_ABCD", manufacturerData: "88ec000447996400", rssi: -45 };
    expect(parseH5075Advertisement(frame, 1000)).toMatchObject({ temperatureC: 28, receivedAt: 1000, rssi: -45 });
    for (const change of [{ name: "GVH5072_ABCD" }, { peripheralId: "anything" }, { manufacturerData: "88ec0004479964gg" }, { type: "status" }]) {
      expect(parseH5075Advertisement({ ...frame, ...change }, 1000)).toBeUndefined();
    }
    expect(parseH5075Advertisement({ ...frame, rssi: 127 }, 1000)?.rssi).toBeUndefined();
  });
});
