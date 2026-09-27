import { expect, test } from "bun:test";
import { HueLightCapability } from "./index";
import { HueClipClient } from "../../../vendors/hue/clip-client";

test("white-only lights expose brightness without color, temperature, or a fabricated Kelvin state", async () => {
  const clip = new HueClipClient({ host: "10.77.0.29", applicationKey: "test", fetch: async () => Response.json({ data: [{ id: "white-resource", type: "light", on: { on: true }, dimming: { brightness: 60 } }], errors: [] }) });
  const light = new HueLightCapability({ id: "white", lightId: "white-resource", clip, color: false, colorTemperature: false });
  const doc = await light.describe();
  expect(doc.actions?.setBrightness).toBeDefined();
  expect(doc.actions?.setColor).toBeUndefined();
  expect(doc.actions?.setColorTemperature).toBeUndefined();
  expect(doc.state.colorTemperatureKelvin).toBeUndefined();
  expect(light.controlIds).not.toContain("setColorTemperature");
  await expect(light.setColorTemperature(4000)).rejects.toThrow();
});
test("bridge connectivity takes precedence over cached light state", async () => {
  const clip = new HueClipClient({ host: "10.77.0.29", applicationKey: "test", fetch: async () => Response.json({ data: [
    { id: "z", type: "zigbee_connectivity", owner: { rid: "device" }, status: "connectivity_issue" },
    { id: "resource", type: "light", owner: { rid: "device" }, on: { on: true }, dimming: { brightness: 100 } },
  ], errors: [] }) });
  const doc = await new HueLightCapability({ id: "offline", lightId: "resource", clip }).describe();
  expect(doc.state.availability).toBe("offline");
  expect(doc.state.on).toBeUndefined();
});
