import { test, expect } from "@playwright/test";
import { testPageContext } from "../../src/ui/test-context";
import { renderSensorPage } from "../../src/ui/sensor-page";
import type { RegisteredDevice } from "../../src/site";

const device: RegisteredDevice = {
  id: "test-presence", name: "Office presence", kind: "sensor", model: "aqara-presence-sensor-fp2",
  modelTitle: "Aqara Presence Sensor FP2", capabilities: ["occupancySensor"], host: "10.77.0.2",
  page: "/devices/test-presence", schemaId: "https://hometruth.ai/schemas/occupancy-sensor", enabled: true,
};

test("Aqara page distinguishes missing pairing, live zones, and failed reads", async ({ page }) => {
  let state: Record<string, unknown> = { availability: "unknown", detail: "Pairing required" };
  let fail = false;
  await page.clock.install();
  await page.route("http://hometruth.test/**", async (route) => {
    if (new URL(route.request().url()).pathname.startsWith("/api/")) {
      await route.fulfill({ status: fail ? 503 : 200, contentType: "application/json", body: JSON.stringify({ object: { capabilities: { occupancySensor: { state } } } }) });
    } else await route.fulfill({ contentType: "text/html", body: renderSensorPage({ ctx: testPageContext({ nonce: "test" }), device }) });
  });
  await page.goto("http://hometruth.test/devices/test-presence");
  await expect(page.locator("#state-label")).toHaveText("Pairing required");
  await expect(page.locator("#pair-code")).toBeVisible();
  await expect(page.locator("#sensor-details")).toBeEmpty();
  state = { availability: "online", occupied: true, observedAt: "2026-09-09T12:00:00Z", illuminanceLux: 42,
    zones: [{ name: "Desk <script>", occupied: true }, { name: "Doorway", occupied: false }] };
  await page.clock.fastForward(5100);
  await expect(page.locator("#state-label")).toHaveText("Connected");
  await expect(page.getByText("Desk <script>", { exact: true })).toBeVisible();
  await expect(page.getByText("42 lx", { exact: true })).toBeVisible();
  await expect(page.locator("#pair-code")).toBeHidden();
  fail = true;
  await page.clock.fastForward(5100);
  await expect(page.getByText("Connection unavailable", { exact: true })).toBeVisible();
  await expect(page.locator("#sensor-details")).toBeEmpty();
});

test("Aqara pairing submits to the local endpoint and clears the input", async ({ page }) => {
  let submitted: unknown;
  await page.route("http://hometruth.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/pair")) {
      submitted = route.request().postDataJSON();
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { message: "Already paired in Apple Home" } }) });
    } else if (path.startsWith("/api/")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ object: { capabilities: { occupancySensor: { state: { availability: "unknown", detail: "Pairing required" } } } } }) });
    } else await route.fulfill({ contentType: "text/html", body: renderSensorPage({ ctx: testPageContext({ nonce: "test" }), device }) });
  });
  await page.goto("http://hometruth.test/devices/test-presence");
  await page.getByLabel("HomeKit code").fill("111-22-333");
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.locator("#pair-feedback")).toHaveText("Already paired in Apple Home");
  await expect(page.getByLabel("HomeKit code")).toHaveValue("");
  expect(submitted).toEqual({ pin: "111-22-333" });
});
