import { expect, test } from "@playwright/test";
import { testPageContext } from "../../src/ui/test-context";
import type { BinarySwitch, CameraDashboardModelContract, DeviceListResponse, HealthResponse } from "../../src/schemas";
import { renderCameraDashboardPage, type CameraDashboardModel } from "../../src/ui/dashboard";
import { testValidators } from "./validation";

test("lists the configured devices on the home page and links to their pages", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Devices · HomeTruth");
  const camera = page.getByRole("link", { name: /E2E pet camera/u });
  const relay = page.getByRole("link", { name: /E2E relay/u });
  await expect(camera).toHaveAttribute("href", "/cameras/e2e-pet-camera");
  await expect(relay).toHaveAttribute("href", "/switches/e2e-relay");
  await expect(page.getByText("TKENPRO 2K Pet Camera Treat Dispenser", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Shelly Plus 1", { exact: false }).first()).toBeVisible();
  await expect(relay.getByText(/Offline/u)).toBeVisible();

  await camera.click();
  await expect(page).toHaveURL(/\/cameras\/e2e-pet-camera$/u);
  await expect(page).toHaveTitle("E2E pet camera · HomeTruth");
});

test("renders the complete pet camera dashboard on the camera's page", async ({ page }) => {
  await page.goto("/cameras/e2e-pet-camera");

  await expect(page.locator("h1")).toHaveText("E2E pet camera");
  await page.getByText("Add or reconnect a camera", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Camera connection" })).toBeVisible();
  // Controls of a camera that has not been reached are grouped under "Unverified".
  await page.getByText("Unverified", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Discover locally" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Feeding", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Movement", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Advanced", exact: true })).toBeVisible();
  await expect(page.getByLabel("Camera username")).toHaveValue("admin");
});

test("renders the switch element with its four actions and reports an unreachable relay", async ({ page }) => {
  await page.goto("/switches/e2e-relay");

  await expect(page).toHaveTitle("E2E relay · HomeTruth");
  // The element renders inside an open shadow root; role and part locators pierce it.
  const element = page.locator('ht-switch[node="device/e2e-relay"]');
  for (const name of ["On", "Off", "Toggle", "Refresh"]) {
    await expect(element.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(element.locator("[part~=value]")).toHaveText("Offline");
  await expect(element.locator("[part~=detail]")).toHaveText("Not reachable");
  await expect(element.locator("[part~=mark]")).toHaveAttribute("data-availability", "offline");
  await expect(page.getByRole("link", { name: "Devices", exact: true })).toHaveAttribute("href", "/");
});

test("keeps unavailable and high-impact controls safely disabled", async ({ page }) => {
  await page.goto("/cameras/e2e-pet-camera");

  await page.getByText("Unverified", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Dispense one treat" }).first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "Factory reset" })).toBeDisabled();
});

test("returns the health, device list, switch, and camera state contracts", async ({ request }) => {
  const healthResponse = await request.get("/api/health");
  const healthBody: unknown = await healthResponse.json();
  expect(healthResponse.status()).toBe(200);
  expect(healthResponse.headers()["cache-control"]).toBe("no-store");
  expect(testValidators.healthResponse(healthBody)).toBe(true);
  const health = healthBody as HealthResponse;
  expect(health.runtime.name).toBe("bun");

  const devicesResponse = await request.get("/api/devices");
  const devicesBody: unknown = await devicesResponse.json();
  expect(devicesResponse.status()).toBe(200);
  expect(testValidators.deviceListResponse(devicesBody)).toBe(true);
  const devices = devicesBody as DeviceListResponse;
  expect(devices.devices.map((device) => [device.id, device.kind, device.page])).toEqual([
    ["e2e-camera", "pet-camera", "/cameras/e2e-pet-camera"],
    ["e2e-relay", "binary-switch", "/switches/e2e-relay"],
    ["e2e-wyze", "camera", "/cameras/e2e-wyze-cam-v3"],
  ]);
  // e2e-wyze is "offline": its camera is unreachable and its motionSensor
  // capability reports "unknown" (no MQTT broker in test mode), which
  // combinedAvailability leaves out of the verdict.
  expect(devices.devices.map((device) => [device.id, device.availability])).toEqual([
    ["e2e-camera", "offline"],
    ["e2e-relay", "offline"],
    ["e2e-wyze", "offline"],
  ]);

  const switchResponse = await request.get("/api/switches/e2e-relay");
  const switchBody: unknown = await switchResponse.json();
  expect(switchResponse.status()).toBe(200);
  expect(testValidators.binarySwitch(switchBody)).toBe(true);
  expect((switchBody as BinarySwitch).state.availability).toBe("offline");

  const stateResponse = await request.get("/api/camera/state");
  const stateBody: unknown = await stateResponse.json();
  expect(stateResponse.status()).toBe(200);
  expect(testValidators.cameraDashboardModel(stateBody)).toBe(true);
  const state = stateBody as CameraDashboardModelContract;
  expect(state.setup.configured).toBe(false);
  expect(state.devices).toEqual([]);
});

test("rejects an invalid camera control request", async ({ request }) => {
  const response = await request.post("/api/camera/control", {
    data: { deviceId: "", capabilityId: "", value: true, extra: true },
  });
  const body = await response.json();

  expect(response.status()).toBe(400);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(testValidators.errorResponse(body)).toBe(true);
  expect(body.error.code).toBe("invalid_request");
});

test("dispenses one treat directly without a confirmation dialog", async ({ page }) => {
  const model: CameraDashboardModel = {
    setup: { configured: true, profile: "tkenpro" },
    discovery: { status: "ready", message: "Found 1 camera" },
    devices: [{
      id: "pet3t-direct-test",
      name: "Treat Cam",
      status: "online",
      stream: "unknown",
      snapshot: "unknown",
      capabilities: [{
        id: "feed.portions",
        category: "feeding",
        label: "Dispense treats",
        kind: "treat",
        availability: "available",
        min: 1,
        max: 10,
        confirmation: "confirm",
      }],
    }],
    selectedDeviceId: "pet3t-direct-test",
  };
  const requests: unknown[] = [];

  await page.route("http://hometruth.test/**", async (route) => {
    const request = route.request();
    if (new URL(request.url()).pathname === "/api/camera/control") {
      requests.push(request.postDataJSON());
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true, state: model }),
      });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: renderCameraDashboardPage({ ctx: testPageContext({ nonce: "e2e-nonce" }), model }),
    });
  });
  await page.goto("http://hometruth.test/");

  await page.getByRole("button", { name: "Dispense one treat" }).first().click();
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(requests).toEqual([{
    deviceId: "pet3t-direct-test",
    capabilityId: "feed.portions",
    value: 1,
    confirmed: true,
  }]);
});

test("renders the plain camera page for a Wyze Cam v3 that is not reachable", async ({ page, request }) => {
  await page.goto("/cameras/e2e-wyze-cam-v3");
  await expect(page).toHaveTitle(/E2E Wyze Cam v3/u);
  await expect(page.locator('[data-action="live"]')).toBeHidden();
  await expect(page.getByRole("button", { name: "Snapshot" })).toBeVisible();
  await expect(page.locator("#camera-status .status-text")).toHaveText(/Offline/u);

  const detail = await request.get("/api/devices/e2e-wyze");
  expect(detail.status()).toBe(200);
  const body = await detail.json() as { model: { id: string }; object: { status: string; capabilities: { camera?: { actions?: Record<string, unknown> }; motionSensor?: { state?: { availability?: string } } } } };
  expect(body.model.id).toBe("wyze-cam-v3");
  // Offline: the camera is offline and the motionSensor capability is a
  // legitimate "unknown" (no MQTT broker running in test mode), which says nothing.
  expect(body.object.status).toBe("offline");
  expect(body.object.capabilities.camera?.actions).toEqual({ snapshot: { mediaTypes: ["image/jpeg"] } });
  expect(body.object.capabilities.motionSensor?.state?.availability).toBe("unknown");

  const snapshot = await request.get("/api/cameras/e2e-wyze/snapshot");
  expect([502, 503]).toContain(snapshot.status());
  const missing = await request.get("/api/cameras/nope/snapshot");
  expect(missing.status()).toBe(404);
});
