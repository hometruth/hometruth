import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { FALLINGWATER_CONFIG, createFallingwaterSnapshot } from "./showcase";
import { MODELS } from "../registry";
import { validators } from "../validation";
import { DemoState } from "./state";
import { createDemoFetch } from "./browser";
import { renderDemoPages } from "./export";

test("public showcase uses supported models with valid, credential-free synthetic configuration", () => {
  expect(validators.devicesConfig(FALLINGWATER_CONFIG)).toBe(true);
  expect(FALLINGWATER_CONFIG.rooms).toEqual(["Grounds", "Great room"]);
  expect(FALLINGWATER_CONFIG.devices).toHaveLength(36);
  const ajv = new Ajv2020({ strict: false });
  for (const entry of FALLINGWATER_CONFIG.devices!) {
    const model = MODELS.find(model => model.id === entry.model)!;
    expect(model, entry.model).toBeDefined();
    const validate = ajv.getSchema(model.configSchema.$id!) ?? ajv.compile(model.configSchema);
    expect(validate(entry.config), `${entry.id}: ${JSON.stringify(validate.errors)}`).toBe(true);
  }
  for (const room of FALLINGWATER_CONFIG.rooms!) expect(FALLINGWATER_CONFIG.devices!.some(device => device.room === room && device.model === "hue-light")).toBe(true);
  expect(JSON.stringify(FALLINGWATER_CONFIG)).not.toMatch(/password|token|privateKey|192\.168\./i);
});

test("showcase state is deterministic, varied, valid, and independently mutable", async () => {
  const first = createFallingwaterSnapshot(), second = createFallingwaterSnapshot();
  expect(first).toEqual(second);
  const temperatures = new Set<number>();
  for (const record of first.records.filter(record => record.node.startsWith("device/"))) {
    expect(validators.homeTruthObject(record.value), record.node).toBe(true);
    const sensors = (record.value as { sensors?: { id: string; state: { value: number } }[] }).sensors;
    const temperature = sensors?.find(sensor => sensor.id === "temperature");
    if (temperature) temperatures.add(temperature.state.value);
  }
  expect(temperatures.size).toBe(2);
  const request = createDemoFetch(new DemoState(first), "https://demo.example.invalid");
  const response = await request("/api/devices/demo-device-15/capabilities/light/controls/setBrightness", { method: "POST", body: '{"value":33}' });
  expect(response.ok).toBe(true);
  expect((await response.json()).object.capabilities.light.state.brightnessPercent).toBe(33);
  expect(createFallingwaterSnapshot()).toEqual(second);
  const pages = await renderDemoPages(second);
  expect(pages.has("/schemas/temperature-sensor")).toBe(true);
  expect(pages.has("/schemas/humidity-sensor")).toBe(true);
  expect(second.graph?.nodes.filter(node => node.kind === "sensor")).toHaveLength(7);
  expect(second.graph?.nodes.filter(node => node.kind === "tag")).toHaveLength(2);
});
