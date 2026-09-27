import { test, expect } from "@playwright/test";
import { testPageContext } from "../../src/ui/test-context";
import { renderSensorPage } from "../../src/ui/sensor-page";
import type { RegisteredDevice } from "../../src/site";

test("AirGradient renders readings, missing sensors, and disconnects without stale values", async ({ page }) => {
  let offline = false;
  let warming = false;
  const device: RegisteredDevice = {
    id: "airgradient", name: "AirGradient ONE", kind: "sensor", model: "airgradient-one",
    modelTitle: "AirGradient ONE", capabilities: ["sensor"], host: "10.77.0.80",
    page: "/devices/airgradient", schemaId: "https://hometruth.ai/schemas/sensor", enabled: true,
  };
  const readings = [
    { name: "CO₂", value: 733, unit: "ppm" },
    { name: "Temperature", value: 26.68, unit: "°C" },
    { name: "Humidity", value: 41.07, unit: "%" },
    { name: "PM1", value: 0, unit: "µg/m³" },
    { name: "PM2.5", value: 3.1, unit: "µg/m³" },
    { name: "PM10", value: 0, unit: "µg/m³" },
    { name: "VOC", value: 183.58, unit: "index" },
    { name: "NOx", value: 1, unit: "index" },
  ];
  await page.clock.install();
  await page.route("http://hometruth.test/**", async (route) => {
    if (new URL(route.request().url()).pathname.startsWith("/api/")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ object: { capabilities: { sensor: { state: {
        availability: offline ? "offline" : warming ? "degraded" : "online",
        detail: offline ? "Connection unavailable" : warming ? "Some sensors are warming up or have no valid reading" : undefined,
        observedAt: offline ? undefined : "2026-09-09T12:00:00Z",
        sensors: readings.map((reading) => ({ ...reading, availability: offline || (warming && reading.name === "VOC") ? "unknown" : "online" })),
      } } } } }) });
    } else {
      await route.fulfill({ contentType: "text/html", body: renderSensorPage({ ctx: testPageContext({ nonce: "test" }), device }) });
    }
  });
  await page.goto("http://hometruth.test/devices/airgradient");
  await expect(page.locator("#state-label")).toHaveText("Connected");
  await expect(page.locator("#sensor-details dd")).toHaveCount(8);
  await expect(page.getByText("733 ppm", { exact: true })).toBeVisible();
  await expect(page.getByText("3.1 µg/m³", { exact: true })).toBeVisible();
  await expect(page.getByText("26.68 °C", { exact: true })).toBeVisible();
  await expect(page.locator("#pairing")).toHaveCount(0);
  warming = true;
  await page.clock.fastForward(5100);
  await expect(page.locator("#state-label")).toContainText("warming up");
  await expect(page.locator("#sensor-details dt:has-text('VOC') + dd")).toHaveText("Unavailable");
  await expect(page.getByText("733 ppm", { exact: true })).toBeVisible();
  offline = true;
  await page.clock.fastForward(5100);
  await expect(page.locator("#state-label")).toHaveText("Connection unavailable");
  await expect(page.locator("#sensor-details dd", { hasText: "Unavailable" })).toHaveCount(8);
  await expect(page.getByText("733 ppm", { exact: true })).toHaveCount(0);
  offline = false;
  warming = false;
  await page.clock.fastForward(5100);
  await expect(page.locator("#state-label")).toHaveText("Connected");
  await expect(page.getByText("733 ppm", { exact: true })).toBeVisible();
});
