import { expect, test } from "@playwright/test";

test("Kindle retains the last snapshot on a failed refresh and recovers", async ({ page }) => {
  await page.setViewportSize({ width: 758, height: 850 });
  await page.goto("/kindle");
  await expect(page.locator("h1")).toHaveText("HomeTruth");
  const original = await page.locator("#board").innerHTML();
  await page.route("**/kindle?*fragment=1*", (route) => route.fulfill({ status: 503, body: "Unavailable" }));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#stale")).toBeVisible();
  expect(await page.locator("#board").innerHTML()).toBe(original);
  await page.unroute("**/kindle?*fragment=1*");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#stale")).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(758);
});

test("Kindle page works without JavaScript", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 758, height: 850 } });
  const page = await context.newPage();
  await page.goto(`${baseURL}/kindle`);
  await expect(page.locator("h1")).toHaveText("HomeTruth");
  await expect(page.locator("table tr").first()).toBeVisible();
  await context.close();
});

import { renderKindleBoard, renderKindlePage } from "../../src/ui/kindle-page";
import { testPageContext } from "../../src/ui/test-context";
import type { KindleConfig } from "../../src/kindle/config";
import type { KindleSnapshot } from "../../src/kindle/presentation";
import { kindleRasterImage, rasterizeCanvas } from "../../src/kindle/raster";

const fixtureConfig: KindleConfig = { version: 1, title: "HomeTruth", refreshSeconds: 60, rowsPerPage: 4, fontSize: 22, selection: "all", items: [] };

for (const layout of ["list", "canvas"] as const) test(`Kindle ${layout} switches update observed state and button commands are not retried`, async ({ page }) => {
  await page.clock.install();
  let on = false, presses = 0, writes = 0;
  const config: KindleConfig = layout === "list" ? fixtureConfig : { ...fixtureConfig, canvas: { width: 758, height: 1024, grid: 8, widgets: [
    { id: "desk", kind: "device", deviceId: "fixture", capability: "auto", mode: "auto", label: "", showLabel: true, x: 24, y: 24, width: 344, height: 400, fontSize: 24, align: "left", border: true },
  ] } };
  const snapshot = (): KindleSnapshot => ({ generatedAt: new Date().toISOString(), rows: [{ widgetId: "desk", deviceId: "fixture", label: "Desk controls", room: "Office", model: "Composite", availability: "online", missing: false, primitives: [
    { capability: "binarySwitch", label: "Switch", availability: "online", detail: on ? "On" : "Off", actions: [{ capability: "binarySwitch", control: "turnOn", label: "On", pressed: on }, { capability: "binarySwitch", control: "turnOff", label: "Off", pressed: !on }] },
    { capability: "button", label: "Button", availability: "unknown", detail: "Ready to press", actions: [{ capability: "button", control: "press", label: "Press" }] },
  ] }] });
  await page.route("**/api/kindle/images/*.png", route => route.fulfill({ contentType: "image/png", body: kindleRasterImage(new URL(route.request().url()).pathname.split('/').pop()!.slice(0, -4))! }));
  await page.route(/\/kindle(?:\?.*)?$/, async (route) => {
    const state = snapshot(), ctx = testPageContext();
    const frame = config.canvas ? await rasterizeCanvas(config.canvas, state, ctx) : undefined;
    const options = { ctx, config, snapshot: state, frame };
    const fragment = new URL(route.request().url()).searchParams.has("fragment");
    return route.fulfill({ contentType: "text/html", headers: { "X-HomeTruth-Kindle": "1" }, body: fragment ? renderKindleBoard(options) : renderKindlePage(options) });
  });
  await page.route("**/api/devices/fixture/capabilities/**", (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({});
    if (route.request().url().endsWith("/press")) { presses++; return route.fulfill({ status: 503, body: "Uncertain" }); }
    writes++; on = route.request().url().endsWith("/turnOn");
    return route.fulfill({ contentType: "application/json", body: "{}" });
  });
  await page.goto("/kindle");
  await page.getByRole("button", { name: "On", exact: true }).click();
  await expect(page.getByRole("button", { name: "On", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(writes).toBe(1);
  await page.getByRole("button", { name: "Press", exact: true }).click();
  await expect(page.locator("#feedback")).toContainText("Could not confirm");
  await page.clock.fastForward(120000);
  expect(presses).toBe(1);
});

test("raster canvas fits short viewports, keeps edge controls aligned, and preserves the last image on failure", async ({ page }) => {
  let presses = 0, failImage = false;
  const config: KindleConfig = { ...fixtureConfig, canvas: { width: 758, height: 1024, grid: 8, widgets: [
    { id: "edge", kind: "device", deviceId: "fixture", capability: "button", mode: "auto", label: "Door bell", showLabel: true, x: 500, y: 880, width: 240, height: 144, fontSize: 20, align: "left", border: true },
  ] } };
  const snapshot: KindleSnapshot = { generatedAt: new Date().toISOString(), rows: [{ widgetId: "edge", deviceId: "fixture", label: "Door bell", room: "", model: "Button", availability: "online", missing: false, primitives: [
    { capability: "button", label: "Button", availability: "online", detail: "Ready to press", actions: [{ capability: "button", control: "press", label: "Press" }] },
  ] }] };
  const ctx = testPageContext(), frame = await rasterizeCanvas(config.canvas!, snapshot, ctx);
  await page.route("**/api/kindle/images/*.png", route => failImage ? route.fulfill({ status: 503, body: "Unavailable" }) : route.fulfill({ contentType: "image/png", body: kindleRasterImage(frame.imageUrl.split('/').pop()!.slice(0, -4))! }));
  await page.route(/\/kindle(?:\?.*)?$/, route => {
    const options = { ctx, config, snapshot, frame: failImage ? { ...frame, imageUrl: '/api/kindle/images/unavailable.png' } : frame };
    return route.fulfill({ contentType: "text/html", headers: { "X-HomeTruth-Kindle": "1" }, body: new URL(route.request().url()).searchParams.has('fragment') ? renderKindleBoard(options) : renderKindlePage(options) });
  });
  await page.route("**/api/devices/fixture/capabilities/button/controls/press", route => { presses++; return route.fulfill({ contentType: 'application/json', body: '{}' }); });
  await page.goto('/kindle');
  for (const viewport of [{ width: 758, height: 850 }, { width: 375, height: 550 }, { width: 1024, height: 600 }]) {
    await page.setViewportSize(viewport);
    const press = page.getByRole('button', { name: 'Press', exact: true });
    await expect(press).toBeEnabled();
    const canvas = await page.locator('#kindle-canvas').boundingBox(), hit = await press.boundingBox(), toolbar = await page.locator('#kindle-toolbar').boundingBox();
    expect(canvas!.width).toBeLessThanOrEqual(viewport.width);
    expect(canvas!.y + canvas!.height).toBeLessThanOrEqual(toolbar!.y);
    expect(hit!.x + hit!.width).toBeLessThanOrEqual(canvas!.x + canvas!.width);
    expect(hit!.y + hit!.height).toBeLessThanOrEqual(canvas!.y + canvas!.height);
    const control = frame.widgets[0]!.controls[0]!, scale = canvas!.width / frame.width;
    expect(hit!.x).toBeCloseTo(canvas!.x + (500 + control.x) * scale, 1);
    expect(hit!.y).toBeCloseTo(canvas!.y + (880 + control.y) * scale, 1);
    const before = presses;
    await page.mouse.click(hit!.x + hit!.width / 2, hit!.y + hit!.height / 2);
    await expect.poll(() => presses).toBe(before + 1);
    await expect(press).toBeEnabled();
  }
  const previous = await page.locator('#board').innerHTML();
  failImage = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#stale')).toBeVisible();
  // Disabled controls are the only mutation allowed in the preserved board.
  expect(await page.locator('.raster-image').getAttribute('src')).toBe(frame.imageUrl);
  expect((await page.locator('#board').innerHTML()).replace(/ disabled=""/g, '')).toBe(previous);
  await expect(page.getByRole('button', { name: 'Press', exact: true })).toBeDisabled();
  expect(presses).toBe(3);
  failImage = false;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('#stale')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Press', exact: true })).toBeEnabled();
});

test("configure, reorder, save and reload the Kindle view with an embedded preview", async ({ page, request }) => {
  const original = await (await request.get("/api/kindle/config")).json();
  try {
    await page.goto("/kindle/settings");
    await expect(page.getByRole("heading", { name: "Kindle view", exact: true })).toBeVisible();
    await page.getByLabel("Title", { exact: true }).fill("Kitchen dashboard");
    await page.getByRole("combobox", { name: "Contents", exact: true }).selectOption("custom");
    await page.locator("#kindle-add-device").selectOption("e2e-relay");
    await page.getByRole("button", { name: "Add item", exact: true }).click();
    await page.locator("#kindle-items [data-field=capability]").selectOption("binarySwitch");
    await page.locator("#kindle-items [data-field=mode]").selectOption("status");
    await page.locator("#kindle-items [data-field=label]").fill("Kitchen switch");
    await page.locator("#kindle-add-device").selectOption("e2e-camera");
    await page.getByRole("button", { name: "Add item", exact: true }).click();
    await page.getByRole("button", { name: "Move up", exact: true }).last().click();
    await page.getByRole("button", { name: "Save and update preview", exact: true }).click();
    await expect(page.locator("#settings-feedback")).toContainText("Saved.");
    const frame = page.frameLocator("#kindle-preview");
    await expect(frame.locator("h1")).toHaveText("Kitchen dashboard");
    await expect(frame.getByText("Preview · controls disabled", { exact: true })).toBeVisible();
    await expect(frame.locator("[data-kindle-action]:enabled")).toHaveCount(0);
    await page.reload();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Kitchen dashboard");
    await expect(page.locator("#kindle-items [data-field=deviceId]").first()).toHaveValue("e2e-camera");
    await expect(page.locator("#kindle-items [data-field=label]").last()).toHaveValue("Kitchen switch");
    const saved = await (await request.get("/api/kindle/config")).json();
    expect(saved.config.items[1].mode).toBe("status");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  } finally {
    if (!page.isClosed()) {
      const current = await (await request.get("/api/kindle/config")).json();
      await request.put("/api/kindle/config", { data: { config: original.config, revision: current.revision } });
    }
  }
});

test("design a dashboard, drag and resize widgets, undo changes, then save and reopen it", async ({ page, request }) => {
  const original = await (await request.get("/api/kindle/config")).json();
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  let commands = 0;
  await page.route("**/api/devices/*/capabilities/*/controls/*", route => { commands++; return route.abort(); });
  try {
    await page.setViewportSize({ width: 1500, height: 1100 });
    await page.goto("/kindle/designer");
    await expect(page.getByRole("heading", { name: "Dashboard designer", exact: true })).toBeVisible();
    await expect(page.locator("[data-overlay]").first()).toBeVisible();
    await page.getByRole("button", { name: "Clear canvas", exact: true }).click();
    await expect(page.locator("[data-overlay]")).toHaveCount(0);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.locator("[data-overlay]").first()).toBeVisible();
    await page.getByRole("button", { name: "Clear canvas", exact: true }).click();
    await page.locator('[data-add-kind="text"]').click();
    await page.locator('#design-properties [data-property="text"]').fill("Our home");
    await page.locator('#design-properties [data-property="text"]').press("Tab");
    await expect(page.locator("#design-render .raster-description").filter({ hasText: "Our home" })).toHaveText("Our home");
    await page.getByRole("button", { name: "Add E2E relay", exact: true }).click();
    for (const [property, value] of [["x","32"],["y","200"],["width","280"],["height","200"]]) {
      const input = page.locator('#design-properties [data-property="' + property + '"]');
      await input.fill(value!); await input.press("Tab");
    }
    const move = page.getByRole("button", { name: "Select E2E relay", exact: true });
    const start = await move.boundingBox(); expect(start).not.toBeNull();
    await page.mouse.move(start!.x + 30, start!.y + 30); await page.mouse.down();
    await page.mouse.move(start!.x + 70, start!.y + 62, { steps: 5 }); await page.mouse.up();
    expect(Number(await page.locator('[data-property="x"]').inputValue())).toBeGreaterThan(32);
    const resize = await page.getByRole("button", { name: "Resize E2E relay", exact: true }).boundingBox();
    await page.mouse.move(resize!.x + 12, resize!.y + 12); await page.mouse.down();
    await page.mouse.move(resize!.x + 60, resize!.y + 48, { steps: 5 }); await page.mouse.up();
    expect(Number(await page.locator('[data-property="width"]').inputValue())).toBeGreaterThan(280);
    const x = Number(await page.locator('[data-property="x"]').inputValue());
    await move.focus(); await page.keyboard.press("ArrowRight");
    await expect(page.locator('[data-property="x"]')).toHaveValue(String(x + 8));
    await page.getByRole("button", { name: "Duplicate", exact: true }).click();
    await expect(page.locator("[data-overlay]")).toHaveCount(3);
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.locator("[data-overlay]")).toHaveCount(2);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.locator("[data-overlay]")).toHaveCount(3);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await expect(page.locator("[data-overlay]")).toHaveCount(2);
    await page.locator('[data-add-kind="clock"]').click();
    await page.locator('[data-add-kind="rule"]').click();
    const beforeSave = await (await request.get("/api/kindle/config")).json();
    expect(beforeSave.revision).toBe(original.revision);
    await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
    await expect(page.locator("#design-feedback")).toContainText("Dashboard saved");
    const saved = await (await request.get("/api/kindle/config")).json();
    expect(saved.config.canvas.widgets).toHaveLength(4);
    const device = saved.config.canvas.widgets.find((w: { kind: string }) => w.kind === "device");
    await page.reload();
    await expect(page.locator("[data-overlay]")).toHaveCount(4);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.setViewportSize({ width: 1500, height: 1100 });
    await page.locator('#design-zoom').selectOption('1');
    const widgetImage = () => page.locator('#canvas-widget-' + device.id).screenshot();
    const previewPixels = await widgetImage();
    await page.evaluate(() => { document.documentElement.dataset.theme = 'swiss'; document.documentElement.dataset.scheme = 'dark'; });
    expect((await widgetImage()).equals(previewPixels)).toBe(true);
    await page.goto("/kindle?preview=1");
    await expect(page.locator(".raster-description").filter({ hasText: "Our home" })).toHaveText("Our home");
    const rect = await page.locator('#canvas-widget-' + device.id).boundingBox();
    const canvasRect = await page.locator('#kindle-canvas').boundingBox();
    expect(rect!.width).toBe(device.width); expect(rect!.height).toBe(device.height);
    expect(rect!.x).toBe(canvasRect!.x + device.x); expect(rect!.y).toBe(canvasRect!.y + device.y);
    expect((await widgetImage()).equals(previewPixels)).toBe(true);
    expect(commands).toBe(0); expect(errors).toEqual([]);
  } finally {
    if (!page.isClosed()) {
      const latest = await (await request.get("/api/kindle/config")).json();
      await request.put("/api/kindle/config", { data: { config: original.config, revision: latest.revision } });
    }
  }
});
