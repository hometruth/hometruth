import { expect, test } from "@playwright/test";
import type { KindleConfig, DeviceWidget } from "../../src/kindle/config";
import type { KindleElement } from "../../src/kindle/elements";
import type { KindleSnapshot } from "../../src/kindle/presentation";
import { kindleRasterImage, rasterizeCanvas } from "../../src/kindle/raster";
import { renderKindleDesigner } from "../../src/ui/kindle-designer";
import { renderKindleBoard, renderKindlePage } from "../../src/ui/kindle-page";
import { rasterLayoutCss, renderRasterCanvas } from "../../src/ui/kindle-raster";
import { testPageContext } from "../../src/ui/test-context";

test("Find Element searches all widgets and inventory, and group widgets survive save and control the group", async ({ page }, info) => {
  const elements: KindleElement[] = [
    { id: "primary-bath", source: "device", name: "Individual switch", model: "lutron-caseta", modelTitle: "Lutron Caséta switch", room: "Kitchen", capabilities: ["binarySwitch"], page: "/switches/individual-switch" },
    { id: "fan-1", source: "device", name: "Exhaust Fan", model: "lutron-caseta", modelTitle: "Lutron Caséta switch", capabilities: ["binarySwitch"], page: "/switches/exhaust-fan" },
    { id: "primary-bath", source: "group", name: "Primary Bath", model: "device-group", modelTitle: "Group", room: "Master Bathroom", capabilities: ["binarySwitch"], page: "/groups/primary-bath" },
  ];
  let config: KindleConfig = { version: 1, title: "HomeTruth", refreshSeconds: 60, rowsPerPage: 4, fontSize: 22, selection: "all", items: [], canvas: { width: 758, height: 1024, grid: 8, widgets: [] } };
  let revision = "initial", on = false, writes = 0;
  const commands: string[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const snapshot = (config: KindleConfig): KindleSnapshot => ({ generatedAt: "2026-09-12T12:00:00Z", rows: config.canvas!.widgets.filter((w): w is DeviceWidget => w.kind === "device").map(w => {
    const element = elements.find(element => element.id === w.deviceId && element.source === (w.source ?? "device"))!;
    return { widgetId: w.id, deviceId: w.deviceId, source: element.source, label: element.name, room: element.room ?? "", model: element.modelTitle, availability: "online", missing: false, primitives: [{ capability: "binarySwitch", label: "Switch", availability: "online", detail: on ? "On" : "Mixed", actions: [
      { capability: "binarySwitch", control: "turnOn", label: "On", ...(on ? { pressed: true } : {}), url: "/api/device-groups/primary-bath/controls/power.turnOn" },
      { capability: "binarySwitch", control: "turnOff", label: "Off", ...(on ? { pressed: false } : {}), url: "/api/device-groups/primary-bath/controls/power.turnOff" },
    ] }] };
  }) });
  await page.route("**/api/kindle/images/*.png", route => route.fulfill({ contentType: "image/png", body: kindleRasterImage(new URL(route.request().url()).pathname.split("/").pop()!.slice(0, -4))! }));
  await page.route("**/kindle/designer", async route => {
    const ctx = testPageContext(), frame = await rasterizeCanvas(config.canvas!, snapshot(config), ctx);
    await route.fulfill({ contentType: "text/html", body: renderKindleDesigner({ ctx, settings: { config: { ...config, canvas: config.canvas! }, revision }, elements, snapshot: { generatedAt: new Date().toISOString(), rows: [] }, savedCanvas: true }) });
  });
  await page.route("**/api/kindle/preview", async route => {
    const draft = route.request().postDataJSON() as KindleConfig, ctx = testPageContext();
    const frame = await rasterizeCanvas(draft.canvas!, snapshot(draft), ctx);
    await route.fulfill({ json: { html: renderRasterCanvas(draft.canvas!, frame), css: rasterLayoutCss(draft.canvas!, frame), frame } });
  });
  await page.route("**/api/kindle/config", async route => {
    expect(route.request().method()).toBe("PUT");
    config = route.request().postDataJSON().config; revision = "saved"; writes++;
    await route.fulfill({ json: { config, revision } });
  });
  await page.route(/\/kindle(?:\?.*)?$/, async route => {
    const ctx = testPageContext(), state = snapshot(config), frame = await rasterizeCanvas(config.canvas!, state, ctx);
    const options = { ctx, config, snapshot: state, frame };
    await route.fulfill({ contentType: "text/html", headers: { "X-HomeTruth-Kindle": "1" }, body: new URL(route.request().url()).searchParams.has("fragment") ? renderKindleBoard(options) : renderKindlePage(options) });
  });
  await page.route("**/api/device-groups/primary-bath/controls/*", async route => {
    commands.push(new URL(route.request().url()).pathname);
    expect(route.request().postDataJSON()).toEqual({});
    if (route.request().url().endsWith("turnOn")) { on = true; await route.fulfill({ json: { ok: true } }); }
    else await route.fulfill({ json: { ok: false, results: [{ id: "fan-1", ok: false }] } });
  });
  await page.setViewportSize({ width: 1500, height: 1100 });
  await page.goto("/kindle/designer");
  const search = page.getByLabel("Find Element", { exact: true });
  const visible = page.locator("[data-add-element]:visible");
  await search.fill("  BÁTH Primary  ");
  await expect(visible).toHaveCount(2); // The individual device also matches through its ID.
  await expect(page.getByRole("button", { name: "Add Primary Bath", exact: true })).toBeVisible();
  await search.fill("master bathroom");
  await expect(visible).toHaveCount(1);
  await search.fill("primary-bath");
  await expect(visible).toHaveCount(2);
  await search.fill("caseta kitchen");
  await expect(visible).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Add Individual switch", exact: true })).toBeVisible();
  await search.fill("fan-1");
  await expect(page.getByRole("button", { name: "Add Exhaust Fan", exact: true })).toBeVisible();
  await search.fill("clock");
  await expect(visible).toHaveCount(0);
  await expect(page.locator('[data-add-kind="clock"]')).toBeVisible();
  await expect(page.locator('[data-add-kind="text"]')).toBeHidden();
  await search.fill("missing-element");
  await expect(page.getByText("No matching elements.", { exact: true })).toBeVisible();
  await search.fill("group switch");
  await page.getByRole("button", { name: "Add Primary Bath", exact: true }).click();
  await expect(page.getByRole("button", { name: "Select Primary Bath", exact: true })).toBeVisible();
  await expect(page.locator('[data-property="deviceId"]')).toHaveValue("group/primary-bath");
  await expect(page.getByRole("link", { name: "Open element", exact: true })).toHaveAttribute("href", "/groups/primary-bath");
  await page.locator('[data-property="deviceId"]').selectOption("primary-bath");
  await expect(page.getByRole("link", { name: "Open element", exact: true })).toHaveAttribute("href", "/switches/individual-switch");
  await page.locator('[data-property="deviceId"]').selectOption("group/primary-bath");
  await expect(page.locator("#design-render .raster-description")).toContainText("Primary Bath");
  await expect(page.locator("#design-render [data-kindle-action]:enabled")).toHaveCount(0);
  expect(commands).toEqual([]); expect(writes).toBe(0);
  await page.screenshot({ path: info.outputPath("find-element-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  await expect(page.locator("#design-feedback")).toContainText("Dashboard saved");
  expect(config.canvas!.widgets[0]).toMatchObject({ source: "group", deviceId: "primary-bath" });
  await page.reload();
  await expect(page.getByRole("button", { name: "Select Primary Bath", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await search.fill("Primary Bath group");
  await expect(visible).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("find-element-mobile.png"), fullPage: true });
  await page.goto("/kindle");
  await page.getByRole("button", { name: "On", exact: true }).click();
  await expect(page.getByRole("button", { name: "On", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Off", exact: true }).click();
  await expect(page.locator("#feedback")).toContainText("Could not confirm");
  expect(commands).toEqual(["/api/device-groups/primary-bath/controls/power.turnOn", "/api/device-groups/primary-bath/controls/power.turnOff"]);
  expect(errors).toEqual([]);
});
