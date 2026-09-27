import { expect, test } from "bun:test";
import { GoveeReceiver } from "./receiver";

test("receiver routes real advertisements by peripheral, rejects garbage, and clears them on adapter loss", async () => {
  let now = 1000;
  const receiver = new GoveeReceiver(() => now);
  const frame = { type: "advertisement", peripheralId: "00000000-0000-0000-0000-000000000001", name: "GVH5075_ABCD", manufacturerData: "88ec000447996400" };
  receiver.ingest(JSON.stringify(frame));
  expect(receiver.discovered()).toEqual([]);
  receiver.ingest('{"type":"status","state":"scanning"}');
  receiver.ingest(JSON.stringify(frame));
  receiver.ingest("bad json");
  receiver.ingest("x".repeat(4097));
  receiver.ingest(JSON.stringify({ ...frame, name: "GVH5072_ABCD" }));
  expect(receiver.discovered()).toHaveLength(1);
  expect(receiver.discovered()[0]).toMatchObject({ receivedAt: 1000, temperatureC: 28 });
  now = 2000;
  receiver.ingest(JSON.stringify({ ...frame, manufacturerData: "88ec000000000000" }));
  expect(receiver.discovered()[0]).toMatchObject({ receivedAt: 2000, temperatureC: 0, batteryPercent: 0 });
  receiver.ingest('{"type":"status","state":"poweredOff"}');
  expect(receiver.discovered()).toEqual([]);
  receiver.ingest('{"type":"status","state":"scanning"}');
  receiver.ingest(JSON.stringify(frame));
  expect(receiver.discovered()).toHaveLength(1);
  await receiver.close();
  expect(receiver.snapshot(frame.peripheralId)).toMatchObject({ scanning: false });
});
