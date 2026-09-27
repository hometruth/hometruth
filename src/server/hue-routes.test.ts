import { expect, test } from "bun:test";
import { createApp } from "./app";
import { Site } from "../site";
import { HueLight } from "../devices/lights/hue-light";
import { HueClipClient } from "../vendors/hue/clip-client";
import type { HueEntertainmentSession } from "../vendors/hue/entertainment-session";

test("Hue control routes return readable bridge errors and send native temperature writes", async () => {
  const writes: unknown[] = [];
  const clip = new HueClipClient({ host: "10.77.0.29", applicationKey: "test", fetch: async (_url, init) => {
    if (init?.method === "PUT") writes.push(JSON.parse(String(init.body)));
    return Response.json({ data: [{ id: "resource", type: "light", on: { on: true }, dimming: { brightness: 50 }, color_temperature: { mirek: 370, mirek_valid: true, mirek_schema: { mirek_minimum: 153, mirek_maximum: 500 } } }], errors: [] });
  } });
  const device = new HueLight({ id: "hue", name: "Hue" }, { lightId: "resource", color: true, colorTemperature: true }, { hue: { clip, session: {} as HueEntertainmentSession } });
  const app = createApp(undefined, new Site([device]));
  const post = (path: string, value: unknown) => app.request(`http://localhost/api/lights/hue/${path}`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify(value) });
  const invalid = await post("color-temperature", { kelvin: 7000 });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ error: { code: "hue_protocol" } });
  const response = await post("color-temperature", { kelvin: 2700 });
  expect(response.status).toBe(200);
  expect(writes).toEqual([{ color_temperature: { mirek: 370 } }]);
  expect(await response.json()).toMatchObject({ state: { colorTemperatureKelvin: 2703 } });
});
