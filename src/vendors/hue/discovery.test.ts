import { expect, test } from "bun:test";
import { hueInventory } from "./discovery";
import type { HueResource } from "./resources";

const fixture: HueResource[] = [
  { id: "d1", type: "device", metadata: { name: "Lamp" } },
  { id: "l1", type: "light", owner: { rid: "d1", rtype: "device" }, color: { xy: { x: .3, y: .3 } }, color_temperature: { mirek: 250, mirek_valid: true, mirek_schema: { mirek_minimum: 153, mirek_maximum: 500 } } },
  { id: "d2", type: "device", metadata: { name: "Lamp" } },
  { id: "l2", type: "light", owner: { rid: "d2", rtype: "device" } },
  { id: "d3", type: "device", metadata: { name: "Motion" } },
  { id: "m1", type: "motion", owner: { rid: "d3", rtype: "device" } },
  { id: "t1", type: "temperature", owner: { rid: "d3", rtype: "device" } },
  { id: "d4", type: "device", metadata: { name: "Dial" } },
  ...[1, 2, 3, 4].map(n => ({ id: `b${n}`, type: "button", owner: { rid: "d4", rtype: "device" } })),
  { id: "bridge", type: "device", metadata: { name: "Bridge" } },
];
test("discovery joins services into physical devices and distinguishes white-only lamps", () => {
  const inventory = hueInventory(fixture);
  expect(inventory).toHaveLength(5);
  expect(inventory[0]?.entry?.config).toEqual({ lightId: "l1", color: true, colorTemperature: true, minimumKelvin: 2000, maximumKelvin: 6535 });
  expect(inventory[1]?.entry).toMatchObject({ id: "hue-lamp-2", config: { color: false, colorTemperature: false } });
  expect(inventory[2]?.entry?.model).toBe("hue-motion-sensor");
  expect(inventory[3]?.entry?.model).toBe("hue-switch");
  expect(inventory[4]?.entry).toBeUndefined();
});
test("repeat discovery preserves existing ids, names, and entertainment channels without duplicates", () => {
  const existing = [{ id: "mantle", name: "Custom", model: "hue-entertainment-light", config: { lightId: "l1", channel: 2 } }];
  const first = hueInventory(fixture, existing);
  expect(first[0]?.entry).toEqual(existing[0]);
  const configured = first.flatMap(r => r.entry ? [r.entry] : []);
  expect(hueInventory(fixture, configured).filter(r => r.entry && !r.configured)).toHaveLength(0);
});
