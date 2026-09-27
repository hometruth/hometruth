import { expect, test, type Page } from "@playwright/test";
import { testPageContext } from "../../src/ui/test-context";
import { renderLightPage } from "../../src/ui/light-page";
import { lightSchema } from "../../src/schemas";
import type { RegisteredDevice } from "../../src/site";

const device: RegisteredDevice = {
  id: "hue-test", name: "Hue test", kind: "light", model: "hue-light", modelTitle: "Hue light", capabilities: ["light"],
  host: "10.77.0.29", page: "/lights/hue-test", schemaId: lightSchema.$id, enabled: true,
};
const node = `device/${device.id}`;
const html = renderLightPage({ ctx: testPageContext({ nonce: "test" }), device });

/**
 * Stands in for `GET /api/state/stream`: every (re)connection gets `hello`
 * plus one `state` frame built from the fixture's current document. The
 * response ends there, and `retry: 300` makes the browser reconnect at once,
 * so the page sees each change the fixture makes within a few hundred ms —
 * the same shape a live stream has, without holding a socket open.
 */
async function routeStream(page: Page, capabilities: () => unknown, version: () => number): Promise<void> {
  await page.route("**/api/state/stream**", (route) => {
    const now = new Date().toISOString();
    const record = { node, version: version(), value: { id: device.id, name: device.name, status: "online", capabilities: { light: capabilities() } }, observedAt: now, updatedAt: now };
    const frames = [
      `retry: 300`,
      `event: hello\ndata: ${JSON.stringify({ generation: "e2e", tier: "live", nodes: [node], keepaliveMs: 20_000 })}`,
      `event: state\ndata: ${JSON.stringify(record)}`,
    ];
    return route.fulfill({ status: 200, contentType: "text/event-stream", body: `${frames.join("\n\n")}\n\n` });
  });
}

test("color picker and temperature slider send selected values and use hardware bounds", async ({ page }) => {
  const writes: { path: string; body: unknown }[] = [];
  let color: string | undefined = "#ff8800";
  let kelvin: number | undefined;
  let version = 1;
  const actions = { turnOn: {}, turnOff: {}, setBrightness: { minimumPercent: 0, maximumPercent: 100 }, setColor: { formats: ["hex"] }, setColorTemperature: { minimumKelvin: 2000, maximumKelvin: 6535 } };
  const capabilities = () => ({ id: device.id, state: { availability: "online", observedAt: new Date().toISOString(), on: true, brightnessPercent: 45, ...(color ? { color } : {}), ...(kelvin ? { colorTemperatureKelvin: kelvin } : {}) }, actions });
  await page.route(`**${device.page}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await routeStream(page, capabilities, () => version);
  await page.route("**/api/devices/hue-test/capabilities/light/controls/*", (route) => {
    const request = route.request();
    const { value } = request.postDataJSON() as { value?: unknown };
    writes.push({ path: new URL(request.url()).pathname, body: value });
    if (request.url().endsWith("/setColor")) { color = value as string; kelvin = undefined; }
    if (request.url().endsWith("/setColorTemperature")) { kelvin = value as number; color = undefined; }
    version += 1;
    return route.fulfill({ json: { object: { id: device.id, capabilities: { light: capabilities() } } } });
  });
  await page.goto(device.page);
  const light = page.locator("ht-light");
  await expect(light.locator("[part~=value]")).toHaveText("On");
  await expect(light.locator("[part~=color]")).toBeVisible();
  await expect(light.locator("[part~=color]")).toHaveValue("#ff8800");
  await expect(light.locator("[part~=temperature]")).toHaveAttribute("min", "2000");
  await expect(light.locator("[part~=temperature]")).toHaveAttribute("max", "6535");
  await expect(light.locator("[part~=temperature-value]")).toHaveText("Color mode");
  await light.locator("[part~=color]").fill("#00ff00");
  await expect.poll(() => writes).toContainEqual({ path: "/api/devices/hue-test/capabilities/light/controls/setColor", body: "#00ff00" });
  await expect(light.locator("[part~=color]")).toHaveValue("#00ff00");
  await light.locator("[part~=temperature]").fill("2700");
  await light.locator("[part~=temperature]").dispatchEvent("change");
  await expect(light.locator("[part~=temperature-value]")).toHaveText("2,700 K");
  await expect.poll(() => writes).toContainEqual({ path: "/api/devices/hue-test/capabilities/light/controls/setColorTemperature", body: 2700 });
});

test("white-only lights hide unsupported controls", async ({ page }) => {
  const capabilities = () => ({ id: device.id, state: { availability: "online", observedAt: new Date().toISOString(), on: true, brightnessPercent: 50 }, actions: { turnOn: {}, turnOff: {}, setBrightness: { minimumPercent: 0, maximumPercent: 100 } } });
  await page.route(`**${device.page}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await routeStream(page, capabilities, () => 1);
  await page.goto(device.page);
  const light = page.locator("ht-light");
  await expect(light.locator("[part~=brightness-value]")).toHaveText("50%");
  await expect(light.locator("[part~=color-field]")).toBeHidden();
  await expect(light.locator("[part~=temperature-field]")).toBeHidden();
  await expect(light.locator("[data-action=toggle]")).toBeHidden();
  await expect(light.getByRole("button", { name: "On", exact: true })).toBeVisible();
});
