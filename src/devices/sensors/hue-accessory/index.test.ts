import { expect, test } from "bun:test";
import { HueAccessorySource, HueAccessorySensor, HueMotionCapability } from "./index";
import { HueClipClient } from "../../../vendors/hue/clip-client";
import type { HueResource } from "../../../vendors/hue/resources";

function source(status: string, valid = true) {
  let calls = 0;
  const owner = { rid: "device", rtype: "device" };
  const data: HueResource[] = [
    { id: "device", type: "device" }, { id: "z", type: "zigbee_connectivity", owner, status },
    { id: "m", type: "motion", owner, enabled: true, motion: { motion: true, motion_valid: valid } },
    { id: "l", type: "light_level", owner, light: { light_level: 20001, light_level_valid: true } },
    { id: "p", type: "device_power", owner, power_state: { battery_level: 65, battery_state: "normal" } },
    { id: "b", type: "button", owner, metadata: { control_id: 1 }, button: { button_report: { event: "short_release", updated: "2026-09-09T12:00:00Z" } } },
  ];
  const clip = new HueClipClient({ host: "10.77.0.29", applicationKey: "test", fetch: async () => {
    calls++; return Response.json({ data, errors: [] });
  } });
  return { source: new HueAccessorySource(clip, "device"), calls: () => calls };
}
test("accessories expose validated motion, lux, battery, and timestamped last button events", async () => {
  const fixture = source("connected");
  const [sensor, motion] = await Promise.all([
    new HueAccessorySensor("sensor", fixture.source).describe(),
    new HueMotionCapability("motion", fixture.source).describe(),
  ]);
  expect(fixture.calls()).toBe(1);
  expect(motion.state).toMatchObject({ availability: "online", motion: true, illuminanceLux: 100, batteryPercent: 65 });
  expect(sensor.state.sensors.find(r => r.id === "b")).toMatchObject({ detail: "short release", observedAt: "2026-09-09T12:00:00Z" });
});
test("disconnected and invalid sensors never claim cached motion as current", async () => {
  const offline = source("disconnected");
  expect(await new HueMotionCapability("m", offline.source).state()).toEqual({ availability: "offline" });
  expect((await new HueAccessorySensor("s", offline.source).getState()).sensors.every(r => r.value === undefined)).toBe(true);
  const invalid = source("connected", false);
  expect(await new HueMotionCapability("m", invalid.source).state()).toEqual({ availability: "unknown" });
});
